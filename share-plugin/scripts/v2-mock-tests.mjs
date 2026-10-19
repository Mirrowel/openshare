// OpenShare v2 server adapter tests — a scripted mock v2 plugin host.
//
// Verifies createV2ServerSetup() end-to-end against the real worker:
//   V1 manual mode: package declares oc-plugin tui -> sessions dormant
//      until the metadata flag event, then share + backfill with CONVERTED
//      v1 items (v2 flat messages -> message + parts)
//   V2 live content: fine-grained text/step events drive debounced
//      re-syncs through the engine (streaming text lands, idle completes)
//   V3 delete: session.deleted removes the share
//   V4 status seeding: activation of an idle session -> completed

import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { sleep, waitFor, httpGet, killPortOwners, bindingUrlOf,
  killWranglerSuites, startWorker, WORKER_URL, WORKER_PORT,
} from "./suite-lib.mjs"

const distUrl = (name) => new URL(`../dist/${name}`, import.meta.url).href

const WATCHDOG_MS = 6 * 60 * 1000
const watchdog = setTimeout(() => {
  console.error("WATCHDOG: suite exceeded hard time limit — aborting")
  process.exit(124)
}, WATCHDOG_MS)

const failures = []
const check = (label, ok, detail) => {
  if (ok) console.log(`PASS ${label}`)
  else {
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`)
    failures.push(label)
  }
}

const sleepAsync = sleep

// --- a scripted v2 host -----------------------------------------------------------

function makeMockV2Host() {
  const SID = "ses_v2mock_0001"
  const MSG_USER = "msg_v2mock_u1"
  const MSG_ASSISTANT = "msg_v2mock_a1"

  const now = () => Date.now()
  const store = {
    sessions: new Map(),
    messages: new Map(), // sessionID -> V2Message[]
    updates: [], // recorded session.update calls
  }

  const sessionInfo = () => ({
    id: SID,
    slug: "v2-mock",
    projectID: "global",
    directory: "/mock/project",
    parentID: undefined,
    title: "v2 mock session",
    agent: "build",
    model: { providerID: "mockv2", id: "v2model", variant: undefined },
    version: "2.0.0-beta",
    metadata: {},
    time: { created: now() - 60000, updated: now() },
  })

  const userMessage = () => ({
    id: MSG_USER,
    type: "user",
    time: { created: now() - 50000 },
    text: "v2 mock prompt",
  })

  const assistantMessage = (text) => ({
    id: MSG_ASSISTANT,
    type: "assistant",
    agent: "build",
    model: { providerID: "mockv2", id: "v2model" },
    time: { created: now() - 49000, completed: text === "done" ? now() : undefined },
    content: [
      { type: "text", text },
      {
        type: "tool",
        id: "tool_v2mock_1",
        name: "read",
        state: { status: "completed", input: { path: "/mock/file" }, output: [{ type: "text", text: "file body" }] },
      },
    ],
  })

  const event = (type, data) => ({ id: `evt_${type}_${now()}`, created: now(), type, durable: { aggregateID: SID, seq: 1, version: 1 }, data: { sessionID: SID, ...data } })

  const scripted = [] // {delayMs, event | () => event}
  const script = (delayMs, evt) => scripted.push({ delayMs, evt })

  const context = {
    options: {},
    app: { name: "opencode", version: "2.0.0-beta" },
    event: {
      async *subscribe() {
        for (const step of scripted) {
          await sleepAsync(step.delayMs)
          const evt = typeof step.evt === "function" ? await step.evt() : step.evt
          yield evt
        }
        // keep the stream open while assertions run
        await sleepAsync(30000)
      },
    },
    client: {
      session: {
        async get({ sessionID }) {
          const stored = store.sessions.get(sessionID)
          if (!stored) throw new Error("not found")
          return { ...stored, metadata: { ...(stored.metadata ?? {}) } }
        },
        async update(input) {
          store.updates.push(input)
          const stored = store.sessions.get(input.sessionID)
          if (input.metadata) stored.metadata = { ...input.metadata }
          return undefined
        },
        async list() {
          return { data: [...store.sessions.values()], cursor: { next: null } }
        },
        async diff() {
          return { files: [] }
        },
      },
      message: {
        async list({ sessionID }) {
          return { data: store.messages.get(sessionID) ?? [], cursor: { next: null } }
        },
      },
    },
  }

  return { SID, MSG_USER, MSG_ASSISTANT, store, sessionInfo, userMessage, assistantMessage, event, script, context }
}

// --- run --------------------------------------------------------------------------

const suiteDir = mkdtempSync(join(tmpdir(), "openshare-v2-"))
mkdirSync(suiteDir, { recursive: true })
console.log(`suite dir: ${suiteDir}`)

process.env.OPENSHARE_WORKER_URL = WORKER_URL
process.env.OPENSHARE_CREATE_TOKEN = "suite-create-token"
process.env.OPENSHARE_DEBOUNCE_MS = "200"
process.env.OPENSHARE_COMPLETED_DELAY_MS = "300"

let worker
try {
  worker = await startWorker(suiteDir)
  console.log("worker ready")

  const { createV2ServerSetup } = await import(distUrl("v2-server.js"))
  const mock = makeMockV2Host()

  // seed the session BEFORE any events (pre-existing content)
  mock.store.sessions.set(mock.SID, { ...mock.sessionInfo(), metadata: {} })
  mock.store.messages.set(mock.SID, [mock.userMessage(), mock.assistantMessage("initial partial")])

  // script: created -> (dormant) -> flag via metadata (store mutated, then
  // event) -> step runs -> text grows -> step ends -> delete
  const flagMetadata = { openshare: { enabled: true } }
  mock.script(200, mock.event("session.created"))
  mock.script(600, mock.event("session.metadata.updated", { metadata: flagMetadata }))
  mock.script(900, async () => {
    mock.store.sessions.get(mock.SID).metadata = { ...flagMetadata }
    return mock.event("session.metadata.updated", { metadata: flagMetadata })
  })
  mock.script(400, mock.event("session.step.started"))
  mock.script(600, async () => {
    mock.store.messages.set(mock.SID, [mock.userMessage(), mock.assistantMessage("grown text")])
    return mock.event("session.text.ended")
  })
  mock.script(600, mock.event("session.step.ended"))
  mock.script(4000, mock.event("session.deleted"))

  const dispose = await createV2ServerSetup()(mock.context)

  // dormancy: no share, no binding write before the flag
  await sleepAsync(900)
  check("V1: dormant before the flag event (no binding write)", mock.store.updates.length === 0, JSON.stringify(mock.store.updates))

  // flag -> share + backfill with converted items
  const bindingUpdate = await waitFor(() => mock.store.updates.find((u) => bindingUrlOf(u.metadata?.openshare)), "V1: binding written into session metadata")
  const shareId = bindingUrlOf(bindingUpdate.metadata.openshare).split("/").pop()

  const body = await waitFor(async () => {
    const r = await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)
    if (!r.ok) throw new Error(`${r.status}`)
    const parsed = await r.json()
    const types = (parsed.data ?? []).map((i) => i.type)
    const hasPart = types.includes("part")
    return hasPart && types.includes("message") && types.includes("session") ? parsed : undefined
  }, "V1: backfilled share with converted items")

  const items = body.data
  const messages = items.filter((i) => i.type === "message")
  const parts = items.filter((i) => i.type === "part")
  check("V1: user message converted", messages.some((m) => m.data?.role === "user" && m.data?.text === "v2 mock prompt"))
  check("V1: assistant message converted", messages.some((m) => m.data?.role === "assistant" && m.data?.model?.providerID === "mockv2"))
  check("V1: text part converted", parts.some((p) => p.data?.type === "text" && p.data?.text === "initial partial"))
  const toolPart = parts.find((p) => p.data?.type === "tool")
  check("V1: tool part converted with state", toolPart?.data?.tool === "read" && toolPart?.data?.state?.status === "completed" && toolPart?.data?.state?.output === "file body", JSON.stringify(toolPart?.data?.state))
  check("V1: model item present (session model fallback)", items.some((i) => i.type === "model"))

  // live content: grown text lands via the debounced re-sync
  await waitFor(async () => {
    const r = await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)
    if (!r.ok) return false
    const parsed = await r.json()
    return (parsed.data ?? []).some((p) => p.type === "part" && p.data?.text === "grown text")
  }, "V2: streamed text lands in the share")

  // idle -> completed
  await waitFor(async () => {
    const r = await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)
    if (!r.ok) return false
    return (await r.json()).status === "completed"
  }, "V2: step end -> completed status")

  // delete -> share gone
  await waitFor(async () => {
    const r = await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)
    return r.status === 404 || r.status === 410
  }, "V3: share deleted after session.deleted")

  await dispose?.()
} catch (error) {
  console.error("SUITE ERROR:", error.message)
  failures.push(`suite-error: ${error.message}`)
} finally {
  try {
    worker?.kill()
  } catch {}
  killWranglerSuites()
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s) — suite FAILED`)
  console.error(`suite dir kept for inspection: ${suiteDir}`)
  clearTimeout(watchdog)
  process.exit(1)
}
console.log("\nall checks passed")
rmSync(suiteDir, { recursive: true, force: true })
clearTimeout(watchdog)
process.exit(0)
