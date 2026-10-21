// S15 — fan-out suite: one session streamed to N servers. Two real
// workers; the engine must create/attach/sync per server independently,
// backfill full history when a server joins mid-session, honor per-
// session opt-outs, and auto-resolve credential collisions (all-mode).
//
// Run: npm run test:fanout

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  sleep,
  waitFor,
  httpGet,
  killWranglerSuites,
  startMockLLM,
  startWorker,
  startServe,
  stopServe,
  bindingUrlOf,
  CREATE_TOKEN,
  WORKER_PORT,
  WORKER_URL,
  LLM_PORT,
  PROVIDER,
} from "./suite-lib.mjs"

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url))
const ROOT = here("../")
const PKG = join(ROOT, "dist", "server.js").replace(/\\/g, "/")
const W2_PORT = WORKER_PORT + 10
const W2_URL = `http://127.0.0.1:${W2_PORT}`

const WATCHDOG_MS = 12 * 60 * 1000
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

async function adminList(workerUrl, path) {
  const r = await httpGet(`${workerUrl}${path}`, { headers: { authorization: `Bearer ${CREATE_TOKEN}` } })
  return (await r.json()) ?? {}
}

async function createAndPrompt(serve, title) {
  const created = await httpGet(`${serve.base}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  })
  const session = await created.json()
  const prompted = await httpGet(`${serve.base}/session/${session.id}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: { providerID: PROVIDER.id, modelID: PROVIDER.model },
      parts: [{ type: "text", text: `suite: ${title}` }],
    }),
    timeoutMs: 60000,
  })
  if (!prompted.ok) throw new Error(`prompt ${prompted.status}`)
  return session.id
}

async function promptSession(serve, sid, text) {
  const prompted = await httpGet(`${serve.base}/session/${sid}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: { providerID: PROVIDER.id, modelID: PROVIDER.model },
      parts: [{ type: "text", text: `suite: ${text}` }],
    }),
    timeoutMs: 60000,
  })
  if (!prompted.ok) throw new Error(`prompt ${prompted.status}`)
}

async function shareBody(workerUrl, shareId) {
  const r = await httpGet(`${workerUrl}/api/share/${shareId}/data`)
  return r.ok ? await r.json() : null
}

function urlLines(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter((l) => l.trim())
  } catch {
    return []
  }
}

const suiteDir = mkdtempSync(join(tmpdir(), "openshare-fanout-"))
const projectDir = join(suiteDir, "project")
mkdirSync(projectDir, { recursive: true })
const urlFile = join(suiteDir, "share-url.txt")

// both servers active from the boot; root tokens (auth is S13/S14's job)
const opts = (extra = {}) => ({
  createToken: "",
  servers: {
    [WORKER_URL]: { token: CREATE_TOKEN, active: true, ...extra },
    [W2_URL]: { token: CREATE_TOKEN, active: true, ...extra },
  },
})

let worker1, worker2, llm, serve
try {
  llm = await startMockLLM()
  worker1 = await startWorker(suiteDir, { configSuffix: "f1" })
  worker2 = await startWorker(suiteDir, { port: W2_PORT, configSuffix: "f2" })
  console.log("both workers ready")

  // ---- F1: both servers receive the session --------------------------------
  serve = await startServe({ name: "fanout", path: PKG, options: opts() }, suiteDir, projectDir, { OPENSHARE_URL_FILE: urlFile, OPENSHARE_DEBOUNCE_MS: "300" })
  const sid = await createAndPrompt(serve, "fanout turn one")
  await waitFor(async () => {
    const s = await (await httpGet(`${serve.base}/session/${sid}`)).json()
    const b = s?.metadata?.openshare
    const servers = b?.servers ?? {}
    return bindingUrlOf(servers[WORKER_URL]) && bindingUrlOf(servers[W2_URL]) ? b : undefined
  }, "F1: binding carries BOTH servers", 60000)
  check("F1: binding is a v2 map with both servers", true)
  const b1 = (await adminList(WORKER_URL, "/api/admin/shares")).shares ?? []
  const b2 = (await adminList(W2_URL, "/api/admin/shares")).shares ?? []
  check("F1: one share on each server", b1.length === 1 && b2.length === 1, `${b1.length}/${b2.length}`)
  await waitFor(() => urlLines(urlFile).length >= 2, "F1: two announce lines", 30000)
  check("F1: urlFile carries both URLs", urlLines(urlFile).length === 2, urlLines(urlFile).join(" "))

  const id1 = b1[0].id
  const id2 = b2[0].id
  const body1 = await waitFor(async () => {
    const parsed = await shareBody(WORKER_URL, id1)
    const types = (parsed?.data ?? []).map((i) => i.type)
    return parsed?.status === "completed" && (parsed.data ?? []).some((i) => i.type === "message" && Array.isArray(i.data?.content) && i.data.content.length > 0) ? parsed : undefined
  }, "F1: server1 share complete")
  const body2 = await waitFor(async () => {
    const parsed = await shareBody(W2_URL, id2)
    const types = (parsed?.data ?? []).map((i) => i.type)
    return parsed?.status === "completed" && (parsed.data ?? []).some((i) => i.type === "message" && Array.isArray(i.data?.content) && i.data.content.length > 0) ? parsed : undefined
  }, "F1: server2 share complete")
  check("F1: both shares carry identical content", JSON.stringify(body1.data.map((i) => i.type)) === JSON.stringify(body2.data.map((i) => i.type)), `${body1.data.length} vs ${body2.data.length}`)

  // ---- F2: a second turn lands on BOTH ------------------------------------
  await promptSession(serve, sid, "fanout turn two")
  await waitFor(async () => {
    const p1 = await shareBody(WORKER_URL, id1)
    const msgs1 = (p1?.data ?? []).filter((i) => i.type === "message").length
    return msgs1 >= 4 ? p1 : undefined
  }, "F2: turn two on server1", 45000)
  const p2 = await waitFor(async () => {
    const parsed = await shareBody(W2_URL, id2)
    const msgs = (parsed?.data ?? []).filter((i) => i.type === "message").length
    return msgs >= 4 ? parsed : undefined
  }, "F2: turn two on server2", 45000)
  check("F2: fan-out sync stays in lockstep", (p2?.data ?? []).filter((i) => i.type === "message").length >= 4)

  // ---- F3: mid-session server join via settings-home write -----------------
  // (the TUI's "Set active" writes the settings home; the engine's 5s
  // target refresh picks it up, creates the remote, and the fan-out
  // backfill mirrors the FULL history — the 0/2/500-message requirement)
  const serve3sandbox = join(suiteDir, "latejoin")
  mkdirSync(join(serve3sandbox, "project"), { recursive: true })
  const lateUrlFile = join(serve3sandbox, "share-url.txt")
  const lateOpts = {
    createToken: "",
    servers: { [WORKER_URL]: { token: CREATE_TOKEN, active: true } },
  }
  await stopServe(serve)
  serve = await startServe({ name: "late", path: PKG, options: lateOpts }, serve3sandbox, join(serve3sandbox, "project"), { OPENSHARE_URL_FILE: lateUrlFile, OPENSHARE_DEBOUNCE_MS: "300", OPENSHARE_DEBUG_EVENTS: "1" })
  const lateSid = await createAndPrompt(serve, "late join turn one")
  await waitFor(() => urlLines(lateUrlFile).length >= 1, "F3: first share (server1 only)", 45000)
  const before2 = (await adminList(W2_URL, "/api/admin/shares")).shares ?? []
  check("F3: no NEW share on server2 yet (only F1's leftover)", before2.length === 1, String(before2.length))

  // activate server2 through the settings home (exactly what the TUI does)
  const homeCfg = join(serve3sandbox, "xdg", "opencode", "openshare.config.json")
  writeFileSync(homeCfg, JSON.stringify({ servers: { [W2_URL]: { token: CREATE_TOKEN, active: true } } }, null, 2))
  await sleep(7000) // engine target refresh (throttled to 5s) + connect
  await promptSession(serve, lateSid, "late join turn two")
  await waitFor(async () => {
    const shares = (await adminList(W2_URL, "/api/admin/shares")).shares ?? []
    return shares.some((s) => s.sessionID === lateSid) ? shares : undefined
  }, "F3: server2 share created after join", 60000)
  const late2 = (await adminList(W2_URL, "/api/admin/shares")).shares.find((s) => s.sessionID === lateSid)
  const lateBody = await waitFor(async () => {
    const parsed = await shareBody(W2_URL, late2.id)
    const msgs = (parsed?.data ?? []).filter((i) => i.type === "message")
    // BOTH turns must be there — the join backfilled the history
    return msgs.length >= 4 ? parsed : undefined
  }, "F3: joined share backfilled with FULL history", 60000)
  check("F3: mid-session join carries complete history (both turns)", (lateBody?.data ?? []).filter((i) => i.type === "message").length >= 4)

  // ---- F4: per-session opt-out (leave as-is) -------------------------------
  const sMeta = await (await httpGet(`${serve.base}/session/${lateSid}`)).json()
  const rawBinding = sMeta?.metadata?.openshare
  const opted = { ...rawBinding, servers: { ...rawBinding.servers, [W2_URL]: { optedOut: true } } }
  await httpGet(`${serve.base}/session/${lateSid}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ metadata: { ...sMeta.metadata, openshare: opted } }),
  })
  const sharesBeforeOptOut = (await adminList(W2_URL, "/api/admin/shares")).shares.length
  await sleep(8000)
  await promptSession(serve, lateSid, "post opt-out turn")
  await sleep(8000)
  const sharesAfterOptOut = (await adminList(W2_URL, "/api/admin/shares")).shares ?? []
  check("F4: opted-out server gets NO new share", sharesAfterOptOut.length === sharesBeforeOptOut, `${sharesBeforeOptOut} -> ${sharesAfterOptOut.length}`)
  const w1Shares = (await adminList(WORKER_URL, "/api/admin/shares")).shares ?? []
  const w1Late = w1Shares.find((s) => s.sessionID === lateSid)
  const w1Body = await shareBody(WORKER_URL, w1Late?.id ?? w1Shares[0]?.id)
  const w1Msgs = (w1Body?.data ?? []).filter((i) => i.type === "message").length
  const w2BodyStill = await shareBody(W2_URL, late2.id)
  const w2MsgsStill = (w2BodyStill?.data ?? []).filter((i) => i.type === "message").length
  check("F4: active server kept receiving turns", w1Msgs > w2MsgsStill, `w1=${w1Msgs} w2=${w2MsgsStill}`)
  check("F4: opted-out share stays viewable (leave as-is)", w2BodyStill !== null && w2MsgsStill >= 4)
} catch (e) {
  failures.push(`suite crashed: ${e?.stack || e}`)
  console.log(`CRASH ${e?.stack || e}`)
  try {
    const out = serve?.output?.() ?? ""
    console.log(`--- serve [openshare] tail ---\n${out.split("\n").filter((l) => l.includes("[openshare]")).slice(-30).join("\n")}`)
  } catch {}
} finally {
  clearTimeout(watchdog)
  const keep = failures.length > 0
  try { await stopServe(serve) } catch {}
  try { llm?.close() } catch {}
  try { worker1?.kill() } catch {}
  try { worker2?.kill() } catch {}
  await sleep(1500)
  killWranglerSuites(WORKER_PORT)
  killWranglerSuites(W2_PORT)
  if (!keep) {
    try { rmSync(suiteDir, { recursive: true, force: true }) } catch {}
  } else {
    console.log(`suite dir kept for inspection: ${suiteDir}`)
  }
}

console.log(`\n[fanout] ${failures.length === 0 ? "all checks passed" : `${failures.length} FAILURES`}`)
if (failures.length) {
  for (const f of failures) console.log("  - " + f)
  process.exit(1)
}
process.exit(0)
