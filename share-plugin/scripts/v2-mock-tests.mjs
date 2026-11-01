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

import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { sleep, waitFor, httpGet, killPortOwners, bindingUrlOf,
  killWranglerSuites, startWorker, startBunServer, CREATE_TOKEN, WORKER_URL, WORKER_PORT,
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
  // stable creation stamps: a message's identity must not change between
  // store re-sets — real hosts keep time.created fixed per message id, and
  // the enqueue-dedupe rev check relies on re-feeds hashing identically
  const T_USER = now() - 50000
  const T_ASSISTANT = now() - 49000
  const T_COMPACTION = now() - 30000
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
    time: { created: T_USER },
    text: "v2 mock prompt",
  })

  // second user prompt: queued mid-turn (the inbox scenario). Its row
  // EXISTS in the store while queued — mirroring the v2 host persisting
  // the message at inbox-enqueue time — but the share must not see it
  // until inbox.delivered fires.
  const T_USER2 = now() - 20000
  const MSG_USER2 = "msg_v2mock_u2"
  const MSG_USER3 = "msg_v2mock_u3"
  const queuedUserMessage = (id, text, t) => ({
    id,
    type: "user",
    time: { created: t },
    text,
  })

  const assistantMessage = (text) => ({
    id: MSG_ASSISTANT,
    type: "assistant",
    agent: "build",
    model: { providerID: "mockv2", id: "v2model" },
    time: { created: T_ASSISTANT, completed: text === "done" ? T_ASSISTANT : undefined },
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

  // v2 compaction is a first-class message — must pass through verbatim
  // (the old v1 converter silently dropped type:"compaction")
  const MSG_COMPACTION = "msg_v2mock_compaction"
  const compactionMessage = () => ({
    id: MSG_COMPACTION,
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary: "v2 mock checkpoint: the session was compacted",
    recent: "",
    time: { created: T_COMPACTION },
  })

  const event = (type, data) => ({ id: `evt_${type}_${now()}`, created: now(), type, durable: { aggregateID: SID, seq: 1, version: 1 }, data: { sessionID: SID, ...data } })

  const scripted = [] // {delayMs, event | () => event}
  const script = (delayMs, evt) => scripted.push({ delayMs, evt })
  // live emissions: the test body emits events mid-flight (rev-stability
  // probes, the final delete) instead of pre-scripting everything — the
  // generator drains the queue around each scripted step and forever after
  const live = []
  const emit = (evt) => live.push(evt)

  const context = {
    options: {},
    app: { name: "opencode", version: "2.0.0-beta" },
    event: {
      async *subscribe() {
        for (const step of scripted) {
          await sleepAsync(step.delayMs)
          while (live.length) yield live.shift()
          const evt = typeof step.evt === "function" ? await step.evt() : step.evt
          yield evt
        }
        while (true) {
          if (live.length) yield live.shift()
          else await sleepAsync(50)
        }
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

  return { SID, MSG_USER, MSG_ASSISTANT, MSG_COMPACTION, MSG_USER2, MSG_USER3, T_USER2, store, sessionInfo, userMessage, queuedUserMessage, assistantMessage, compactionMessage, event, script, emit, context }
}

// --- run --------------------------------------------------------------------------

const suiteDir = mkdtempSync(join(tmpdir(), "openshare-v2-"))
mkdirSync(suiteDir, { recursive: true })
console.log(`suite dir: ${suiteDir}`)

process.env.OPENSHARE_WORKER_URL = WORKER_URL
process.env.OPENSHARE_CREATE_TOKEN = "suite-create-token"
process.env.OPENSHARE_DEBOUNCE_MS = "200"
process.env.OPENSHARE_COMPLETED_DELAY_MS = "300"
// binding-write coalescer: the multi-remote section asserts the SETTLED
// two-server binding; the default 30s window would dominate suite time
process.env.OPENSHARE_BINDING_WRITE_MS = "1500"
// pinned spool dir: the suite asserts the spool lifecycle (files written
// while live, cleared on session delete)
process.env.OPENSHARE_SPOOL_DIR = join(suiteDir, "spool")

let worker
let bunWorker, bunRestarted
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
  mock.script(400, async () => {
    // compaction lands mid-stream: native v2 compaction message + event
    mock.store.messages.get(mock.SID).push(mock.compactionMessage())
    return mock.event("session.compaction.ended", { summary: "v2 mock checkpoint: the session was compacted" })
  })
  mock.script(400, mock.event("session.step.started"))
  mock.script(600, async () => {
    mock.store.messages.set(mock.SID, [mock.userMessage(), mock.assistantMessage("grown text"), mock.compactionMessage()])
    return mock.event("session.text.ended")
  })
  mock.script(600, mock.event("session.step.ended"))
  // NOTE: no scripted session.deleted — the test body emits it live at the
  // very end (after the rev-stability and spool assertions)

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
    const hasContent = (parsed.data ?? []).some((i) => i.type === "message" && Array.isArray(i.data?.content))
    return hasContent && types.includes("message") && types.includes("session") ? parsed : undefined
  }, "V1: backfilled share with v2 messages")

  const items = body.data
  const messages = items.filter((i) => i.type === "message")
  check("V1: envelope version is v2", body.v === 2, JSON.stringify({ v: body.v }))
  // user text passes through verbatim (the old converter emitted
  // parts:[] — v2 prompts were invisible on shares)
  check("V1: user message text passed through", messages.some((m) => m.data?.type === "user" && m.data?.text === "v2 mock prompt"), JSON.stringify(messages.map((m) => m.data?.type)))
  check("V1: assistant message passed through", messages.some((m) => m.data?.type === "assistant" && m.data?.model?.providerID === "mockv2"))
  const assistant = messages.find((m) => m.data?.type === "assistant")
  const contentText = (assistant?.data?.content ?? []).find((c) => c?.type === "text")
  const contentTool = (assistant?.data?.content ?? []).find((c) => c?.type === "tool")
  check("V1: assistant content embedded", contentText?.text === "initial partial", JSON.stringify(contentText))
  check("V1: tool content embedded with state", contentTool?.name === "read" && contentTool?.state?.status === "completed", JSON.stringify(contentTool?.state))
  // live compaction: the compaction.ended event triggers a re-sync that
  // must carry the native compaction message (refresh lands after the
  // flag-time backfill)
  const compactionArrived = await waitFor(async () => {
    const r = await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)
    if (!r.ok) return false
    const parsed = await r.json()
    return (parsed.data ?? []).some((m) => m.type === "message" && m.data?.type === "compaction" && m.data?.status === "completed" && String(m.data?.summary ?? "").includes("v2 mock checkpoint")) ? parsed : false
  }, "V1: compaction message passed through")
  check("V1: compaction message passed through", !!compactionArrived, "no compaction message on the share")
  check("V1: model item present (session model fallback)", items.some((i) => i.type === "model"))
  // Wave 3 data-inventory split: the session item never carries the
  // machine-local directory (the mock session HAS one), and the public
  // /data envelope exposes no machine path at all - pmeta stays in the
  // private block, which an ungated share never serves
  {
    const sess = items.find((i) => i.type === "session" && i.data?.id === mock.SID)
    check("V4: session item carries no directory", sess && !("directory" in (sess.data ?? {})), JSON.stringify(sess?.data ?? null).slice(0, 160))
    const flatAll = JSON.stringify(body)
    check("V4a public envelope leaks no machine path", !flatAll.includes("/mock/project") && !flatAll.includes('"pmeta"'), flatAll.slice(0, 200))
  }

  // live content: grown text lands via the debounced re-sync
  await waitFor(async () => {
    const r = await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)
    if (!r.ok) return false
    const parsed = await r.json()
    return (parsed.data ?? []).some((m) => m.type === "message" && (m.data?.content ?? []).some((c) => c?.type === "text" && c?.text === "grown text"))
  }, "V2: streamed text lands in the share")

  // spool lifecycle (1/2): while the session is live the per-server spool
  // pair exists (meta written after the handshake, queue after flushes)
  {
    const spoolFiles = readdirSync(process.env.OPENSHARE_SPOOL_DIR).filter((f) => f.startsWith(mock.SID))
    check("V2: spool files exist while live", spoolFiles.length > 0, JSON.stringify(spoolFiles))
  }

  // enqueue dedupe: repeated refreshes with an UNCHANGED store must not
  // bump the share rev. The v2 adapter re-feeds the whole transcript on
  // every refresh; without the engine-side content dedupe each one
  // re-emitted it — rev churn, storage rewrites, every viewer refolding.
  // (Settle first: a brand-new read-tool message earns ONE deterministic
  // re-enqueue when the lineStart stamp lands after its first flush —
  // bounded, once-ever, not churn.)
  await sleepAsync(1000)
  const revAfterGrow = (await (await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)).json()).rev
  mock.emit(mock.event("session.metadata.updated", { metadata: { openshare: { enabled: true } } }))
  mock.emit(mock.event("session.metadata.updated", { metadata: { openshare: { enabled: true } } }))
  await sleepAsync(1600) // past the 400ms refresh debounce + flush
  const revAfterRefresh = (await (await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)).json()).rev
  check("V2: unchanged refresh does not bump rev (enqueue dedupe)", revAfterRefresh === revAfterGrow, `${revAfterGrow} -> ${revAfterRefresh}`)

  // and the dedupe must not block REAL content: grow once more
  mock.store.messages.set(mock.SID, [mock.userMessage(), mock.assistantMessage("grown twice"), mock.compactionMessage()])
  mock.emit(mock.event("session.text.ended"))
  await waitFor(async () => {
    const r = await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)
    if (!r.ok) return false
    const parsed = await r.json()
    return (parsed.data ?? []).some((m) => m.type === "message" && (m.data?.content ?? []).some((c) => c?.type === "text" && c?.text === "grown twice"))
  }, "V2: real change still lands through the dedupe")
  const revAfterChange = (await (await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)).json()).rev
  check("V2: real change bumps rev", revAfterChange > revAfterGrow, `${revAfterGrow} -> ${revAfterChange}`)

  // Wave 3 engine-level: secret-bearing content on an UNGATED share - the
  // redaction pass at enqueue must strip the token before any transport
  mock.store.messages.get(mock.SID).push(mock.assistantMessage("rotated to ghp_" + "z".repeat(36) + " ok"))
  mock.emit(mock.event("session.text.ended"))
  const redactedOk = await waitFor(async () => {
    const r = await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)
    if (!r.ok) return false
    const parsed = await r.json()
    const flat = JSON.stringify(parsed.data ?? [])
    return flat.includes("[redacted:gh-token]") && !flat.includes("ghp_zzz") ? parsed : false
  }, "V3: redaction marker lands, token never does")
  check("V3: ungated share redacts tokens at enqueue", !!redactedOk, "token leaked or marker missing")

  // inbox queue semantics: the host persists the queued prompt's message
  // row mid-turn; the share must NOT surface it until delivered.
  {
    mock.store.messages.get(mock.SID).push(mock.queuedUserMessage(mock.MSG_USER2, "queued prompt", mock.T_USER2))
    mock.emit(mock.event("session.inbox.enqueued", { inboxID: mock.MSG_USER2, item: { delivery: "queue" } }))
    mock.emit(mock.event("session.text.ended")) // mid-turn refresh runs with U2 in the store
    await sleepAsync(1500) // past the refresh debounce + flush
    const dataMid = await (await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)).json()
    const u2Early = (dataMid.data ?? []).some((m) => m.type === "message" && m.data?.id === mock.MSG_USER2)
    check("V2: queued prompt held off the share", !u2Early, "the queued user message surfaced before delivery")

    // delivered: the turn starts — the prompt appears
    mock.emit(mock.event("session.inbox.delivered", { inboxID: mock.MSG_USER2 }))
    await waitFor(async () => {
      const r = await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)
      if (!r.ok) return false
      const parsed = await r.json()
      return (parsed.data ?? []).some((m) => m.type === "message" && m.data?.id === mock.MSG_USER2)
    }, "V2: delivered prompt appears on the share")

    // cancelled: a queued-then-cancelled prompt must NEVER surface
    mock.store.messages.get(mock.SID).push(mock.queuedUserMessage(mock.MSG_USER3, "cancelled prompt", Date.now()))
    mock.emit(mock.event("session.inbox.enqueued", { inboxID: mock.MSG_USER3, item: { delivery: "queue" } }))
    mock.emit(mock.event("session.text.ended"))
    await sleepAsync(1200)
    mock.emit(mock.event("session.inbox.cancelled", { inboxID: mock.MSG_USER3 }))
    mock.emit(mock.event("session.text.ended"))
    await sleepAsync(1500)
    const dataEnd = await (await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)).json()
    const u3Seen = (dataEnd.data ?? []).some((m) => m.type === "message" && m.data?.id === mock.MSG_USER3)
    check("V2: cancelled queued prompt never surfaces", !u3Seen, "the cancelled prompt leaked to the share")
  }

  // idle -> completed
  await waitFor(async () => {
    const r = await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)
    if (!r.ok) return false
    return (await r.json()).status === "completed"
  }, "V2: step end -> completed status")

  // delete -> share gone (live-emitted, after all mid-flight assertions)
  mock.emit(mock.event("session.deleted"))
  await waitFor(async () => {
    const r = await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)
    return r.status === 404 || r.status === 410
  }, "V3: share deleted after session.deleted")

  // spool lifecycle (2/2): session delete clears the spool pair (plus the
  // legacy single-server files) — nothing may replay a dead session
  await sleepAsync(300)
  {
    const spoolFiles = readdirSync(process.env.OPENSHARE_SPOOL_DIR).filter((f) => f.startsWith(mock.SID))
    check("V2: spool cleared on session delete", spoolFiles.length === 0, JSON.stringify(spoolFiles))
  }

  await dispose?.()

  // --- multi-remote engine-edge: two remotes on the scripted bus -----------
  // fanout-tests drives the same engine through REAL opencode serves;
  // this lane adds the cases a real turn cannot cheaply hit: a full
  // outage of ONE remote mid-session (spool accumulates, restart with
  // the same db must replay and converge) and an opt-out delivered as a
  // metadata EVENT (the v2 adapter's retirement path - the e2e suite
  // drives it through the host's metadata PATCH).
  // Engine fact this section is shaped around: the FIRST binding write
  // is immediate, later ones are 30s-debounced - so share discovery
  // reads the ADMIN lists (content is live within seconds), and only
  // the opt-out mutation waits on the settled binding.
  const B2_PORT = WORKER_PORT + 10
  const B2_URL = `http://127.0.0.1:${B2_PORT}`
  bunWorker = await startBunServer(suiteDir, { port: B2_PORT, name: "v2fan", createToken: CREATE_TOKEN })
  const adminShares = async (base) =>
    ((await (await httpGet(`${base}/api/admin/shares`, { headers: { authorization: `Bearer ${CREATE_TOKEN}` } })).json()) ?? { shares: [] }).shares
  const mock2 = makeMockV2Host()
  mock2.context.options = {
    servers: {
      [WORKER_URL]: { token: CREATE_TOKEN, active: true },
      [B2_URL]: { token: CREATE_TOKEN, active: true },
    },
  }
  mock2.store.sessions.set(mock2.SID, { ...mock2.sessionInfo(), metadata: {} })
  mock2.store.messages.set(mock2.SID, [mock2.userMessage(), mock2.assistantMessage("multi initial")])
  mock2.script(200, mock2.event("session.created"))
  mock2.script(400, async () => {
    const flag = { openshare: { enabled: true } }
    mock2.store.sessions.get(mock2.SID).metadata = { ...flag }
    return mock2.event("session.metadata.updated", { metadata: flag })
  })
  const dispose2 = await createV2ServerSetup()(mock2.context)

  // M1: both remotes create and carry identical content
  const pair = await waitFor(async () => {
    const s1 = (await adminShares(WORKER_URL)).filter((s) => s.sessionID === mock2.SID)
    const s2 = (await adminShares(B2_URL)).filter((s) => s.sessionID === mock2.SID)
    return s1.length === 1 && s2.length === 1 ? [s1[0].id, s2[0].id] : undefined
  }, "M1: one share per remote for the session", 45000)
  const [shareW1, shareB2] = pair
  const bothBodies = await waitFor(async () => {
    const r1 = await httpGet(`${WORKER_URL}/api/share/${shareW1}/data`)
    const r2 = await httpGet(`${B2_URL}/api/share/${shareB2}/data`)
    if (!r1.ok || !r2.ok) return false
    const p1 = await r1.json()
    const p2 = await r2.json()
    const text = (p) => (p.data ?? []).some((m) => m.type === "message" && (m.data?.content ?? []).some((c) => c?.type === "text" && c?.text === "multi initial"))
    return text(p1) && text(p2) ? [p1, p2] : false
  }, "M1: content on both remotes")
  check("M1: two-remote create parity (scripted bus)", JSON.stringify(bothBodies[0].data.map((i) => i.type)) === JSON.stringify(bothBodies[1].data.map((i) => i.type)))

  // M2: one remote goes DOWN mid-session; the survivor keeps receiving,
  // the dead remote's spool accumulates; restart on the same db replays
  // and converges - no loss, no dupe churn
  bunWorker.kill()
  killPortOwners(B2_PORT)
  mock2.store.messages.set(mock2.SID, [mock2.userMessage(), mock2.assistantMessage("outage growth")])
  mock2.emit(mock2.event("session.text.ended"))
  await waitFor(async () => {
    const r = await httpGet(`${WORKER_URL}/api/share/${shareW1}/data`)
    if (!r.ok) return false
    const p = await r.json()
    return (p.data ?? []).some((m) => m.type === "message" && (m.data?.content ?? []).some((c) => c?.type === "text" && c?.text === "outage growth"))
  }, "M2: survivor received the change while the other remote was down")
  bunRestarted = await startBunServer(suiteDir, { port: B2_PORT, name: "v2fan", createToken: CREATE_TOKEN, keepDb: true })
  const caughtUp = await waitFor(async () => {
    const r = await httpGet(`${B2_URL}/api/share/${shareB2}/data`)
    if (!r.ok) return false
    const p = await r.json()
    return (p.data ?? []).some((m) => m.type === "message" && (m.data?.content ?? []).some((c) => c?.type === "text" && c?.text === "outage growth")) ? p : false
  }, "M2: restarted remote caught up", 60000)
  const w1Now = await (await httpGet(`${WORKER_URL}/api/share/${shareW1}/data`)).json()
  check("M2: outage spool replays on reconnect (parity, no dupe churn)",
    JSON.stringify(caughtUp.data.map((i) => i.type)) === JSON.stringify(w1Now.data.map((i) => i.type)),
    `${caughtUp.data.length} vs ${w1Now.data.length}`)

  // M3: per-remote opt-out through a metadata EVENT (the v2 adapter's
  // retirement path). Needs the settled two-server binding - the
  // debounced write lands within ~30s of the second remote's init-ok,
  // which the M1/M2 phases above comfortably cover.
  const bind2 = await waitFor(() => {
    const b = mock2.store.sessions.get(mock2.SID)?.metadata?.openshare
    return bindingUrlOf(b?.servers?.[WORKER_URL]) && bindingUrlOf(b?.servers?.[B2_URL]) ? b : undefined
  }, "M3 precondition: settled binding carries both remotes", 45000)
  const currentBinding = JSON.parse(JSON.stringify(bind2))
  currentBinding.servers[B2_URL] = { ...currentBinding.servers[B2_URL], optedOut: true }
  mock2.store.sessions.get(mock2.SID).metadata = { openshare: currentBinding }
  mock2.emit(mock2.event("session.metadata.updated", { metadata: { openshare: currentBinding } }))
  const revB2AtOptOut = caughtUp.rev
  mock2.store.messages.set(mock2.SID, [mock2.userMessage(), mock2.assistantMessage("post opt-out growth")])
  mock2.emit(mock2.event("session.text.ended"))
  await waitFor(async () => {
    const r = await httpGet(`${WORKER_URL}/api/share/${shareW1}/data`)
    if (!r.ok) return false
    const p = await r.json()
    return (p.data ?? []).some((m) => m.type === "message" && (m.data?.content ?? []).some((c) => c?.type === "text" && c?.text === "post opt-out growth"))
  }, "M3: survivor still receives content")
  await sleepAsync(2000) // grace: with a 200ms debounce a broken retirement would have synced by now
  const b2After = await (await httpGet(`${B2_URL}/api/share/${shareB2}/data`)).json()
  const b2HasPost = JSON.stringify(b2After).includes("post opt-out growth")
  check("M3: opted-out remote gets nothing more (share stays as-is)", !b2HasPost && b2After.rev === revB2AtOptOut, `rev ${revB2AtOptOut} -> ${b2After.rev}`)

  await dispose2?.()
} catch (error) {
  console.error("SUITE ERROR:", error.message)
  failures.push(`suite-error: ${error.message}`)
} finally {
  try {
    worker?.kill()
  } catch {}
  try { bunWorker?.kill?.() } catch {}
  try { bunRestarted?.kill?.() } catch {}
  killPortOwners(WORKER_PORT + 10)
  if (!process.env.OPENSHARE_TEST_WORKER_URL) killWranglerSuites() // matrix reuse: don't kill the shared worker
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
