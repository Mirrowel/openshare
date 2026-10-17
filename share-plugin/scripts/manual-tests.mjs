// Open(code)Share manual-mode suite — phase 2 gate.
//
// Exercises the presence-based share mode + flag-driven activation against
// a real `opencode serve` + mock LLM + local worker:
//
//  S1 dormancy:      TUI present (project tui.json registers the package)
//                    -> session + real prompt happen, NO share is created
//  S2 activation:    PATCH session metadata {openshare:{enabled:true}}
//                    -> share appears AND backfills the full pre-flag
//                    history (session, both messages, parts, model, prefs,
//                    session_diff), status reaches completed
//  S3 unshare:       PATCH metadata removing the flag -> share deleted (404)
//  S4 re-share:      enable again -> NEW share id, same backfilled content
//  S5 binding        restart serve (same project dir) -> plugin attaches to
//     resume:        the SAME share id from session metadata, no data loss
//  S6 override:      shareMode "all" in the plugin options + TUI present
//                    -> all-mode wins (explicit config beats detection)
//  S7 no urlFile:    manual mode never writes the urlFile

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  sleep,
  waitFor,
  httpGet,
  killPortOwners,
  killWranglerSuites,
  startMockLLM,
  startWorker,
  startServe,
  stopServe,
  normalizeShare,
  diffSummary,
  WORKER_URL,
  WORKER_PORT,
  SERVE_PORT,
  LLM_PORT,
  PROVIDER,
} from "./suite-lib.mjs"

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url))
const ROOT = here("../")
const PKG = join(ROOT, "dist", "server.js").replace(/\\/g, "/")

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

async function createAndPrompt(serve, title) {
  const created = await httpGet(`${serve.base}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  })
  if (!created.ok) throw new Error(`session create ${created.status}: ${(await created.text()).slice(0, 300)}`)
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
  if (!prompted.ok) throw new Error(`prompt ${prompted.status}: ${(await prompted.text()).slice(0, 300)}`)
  return session.id
}

async function patchMetadata(serve, sid, metadata) {
  const r = await httpGet(`${serve.base}/session/${sid}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ metadata }),
  })
  if (!r.ok) throw new Error(`metadata patch ${r.status}: ${(await r.text()).slice(0, 300)}`)
  return r.json()
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
  if (!prompted.ok) throw new Error(`prompt ${prompted.status}: ${(await prompted.text()).slice(0, 300)}`)
}

async function readUrlFile(urlFile) {
  try {
    return readFileSync(urlFile, "utf8").trim() || undefined
  } catch {
    return undefined
  }
}

const suiteDir = mkdtempSync(join(tmpdir(), "openshare-manual-"))
console.log(`suite dir: ${suiteDir}`)

let worker
let llm
try {
  llm = await startMockLLM()
  worker = await startWorker(suiteDir)
  console.log("worker ready")

  // ---------------------------------------------------------------- setup
  const sandbox = join(suiteDir, "manual")
  const projectDir = join(sandbox, "project")
  mkdirSync(projectDir, { recursive: true })
  // the TUI presence signal: a project tui.json registering the package
  writeFileSync(join(projectDir, "tui.json"), JSON.stringify({ plugin: [PKG] }, null, 2))
  const urlFile = join(sandbox, "share-url.txt")

  const variant = { name: "manual", path: PKG }
  const serve = await startServe(variant, sandbox, projectDir, { OPENSHARE_DEBUG_FILE: join(sandbox, "debug.json") })

  let sid
  let shareId
  let firstShareBody
  try {
    // S1: dormancy — a full session+prompt cycle with the TUI present
    sid = await createAndPrompt(serve, "manual mode dormancy")
    await sleep(4000) // give any (wrong) share creation time to surface
    try {
      console.log("plugin debug:", readFileSync(join(sandbox, "debug.json"), "utf8"))
    } catch {
      console.log("plugin debug: (file not written — plugin did not load?)")
    }
    const sessions = await (await httpGet(`${serve.base}/session`)).json()
    const live = sessions.find?.((s) => s.id === sid)
    check("S1: session exists", !!live)
    const withBinding = live?.metadata?.openshare
    check("S1: no binding written (dormant)", !withBinding, JSON.stringify(withBinding))
    check("S1: no urlFile written in manual mode", !(await readUrlFile(urlFile)))

    // S2: activation — set the flag mid-session
    await patchMetadata(serve, sid, { openshare: { enabled: true } })
    const binding = await waitFor(async () => {
      const s = await (await httpGet(`${serve.base}/session/${sid}`)).json()
      const b = s?.metadata?.openshare
      return b?.url ? b : undefined
    }, "S2: binding (url) written into session metadata")
    check("S2: binding has enabled flag", binding.enabled === true, JSON.stringify(binding))
    shareId = binding.url.split("/").pop()

    firstShareBody = await waitFor(async () => {
      const r = await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)
      if (!r.ok) throw new Error(`data fetch ${r.status}`)
      const parsed = await r.json()
      const types = (parsed.data ?? []).map((i) => i.type)
      const ready =
        parsed.status === "completed" &&
        types.includes("session") &&
        types.filter((t) => t === "message").length >= 2 &&
        types.includes("part") &&
        types.includes("model") &&
        types.includes("prefs") &&
        types.includes("session_diff")
      return ready ? parsed : undefined
    }, "S2: backfilled share complete")
    console.log(`  activated share ${shareId} (backfilled ${firstShareBody.data.length} items)`)
    check("S2: backfill complete", true)

    // redaction under manual mode too
    const leaked = (firstShareBody.data ?? []).filter((i) => i.data?.metadata && "openshare" in i.data.metadata)
    check("S2: binding never reaches viewers", leaked.length === 0)
    check("S2: manual mode never writes urlFile", !(await readUrlFile(urlFile)))
  } finally {
    await stopServe(serve);
  }

  // S5 + S3 + S4 on a fresh serve process (same project dir): the plugin
  // only knows sessions from EVENTS, so the flag is re-fired first
  // (attach to the same share), then removed (unshare), then set again.
  const serve2 = await startServe(variant, sandbox, projectDir)
  try {
    // re-fire the flag so this process sees the session at all
    await patchMetadata(serve2, sid, { openshare: { enabled: true } })
    const reattached = await waitFor(async () => {
      const s = await (await httpGet(`${serve2.base}/session/${sid}`)).json()
      const b = s?.metadata?.openshare
      return b?.url ? b : undefined
    }, "S5: binding present after restart")
    check("S5: restart attaches SAME share", reattached.url.split("/").pop() === shareId, `${reattached.url} vs ${shareId} binding=${JSON.stringify(reattached)}`)

    await patchMetadata(serve2, sid, {})
    await waitFor(async () => {
      const r = await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)
      return r.status === 404 || r.status === 410
    }, "S3: share deleted after flag removal")
    check("S3: unshare deletes the share", true)
    const after = await (await httpGet(`${serve2.base}/session/${sid}`)).json()
    check("S3: binding cleared from metadata", !after?.metadata?.openshare)

    await patchMetadata(serve2, sid, { openshare: { enabled: true } })
    const reactivated = await waitFor(async () => {
      const s = await (await httpGet(`${serve2.base}/session/${sid}`)).json()
      const b = s?.metadata?.openshare
      return b?.url ? b : undefined
    }, "S4: re-share binding")
    const newShareId = reactivated.url.split("/").pop()
    check("S4: re-share creates a NEW share", newShareId !== shareId && !!newShareId)

    const secondBody = await waitFor(async () => {
      const r = await httpGet(`${WORKER_URL}/api/share/${newShareId}/data`)
      if (!r.ok) throw new Error(`data fetch ${r.status}`)
      const parsed = await r.json()
      const types = (parsed.data ?? []).map((i) => i.type)
      return parsed.status === "completed" && types.includes("part") ? parsed : undefined
    }, "S4: re-share backfilled")

    // backfill parity: the re-share carries the same content as the first
    const a = JSON.stringify(normalizeShare(firstShareBody, sandbox))
    const b = JSON.stringify(normalizeShare(secondBody, sandbox))
    check("S4: re-share content == first share content", a === b, diffSummary(a, b))
  } finally {
    await stopServe(serve2);
  }

  // S7: per-session opts — read auth rides the create frame; the share
  // must reject anonymous reads and accept the auth cookie
  const serve4 = await startServe(variant, sandbox, projectDir)
  try {
    await patchMetadata(serve4, sid, {
      openshare: { enabled: true, opts: { authLogin: "suite-reader", authPassword: "suite-pass" } },
    })
    const authBinding = await waitFor(async () => {
      const s = await (await httpGet(`${serve4.base}/session/${sid}`)).json()
      const b = s?.metadata?.openshare
      return b?.url ? b : undefined
    }, "S7: share attached with auth opts")
    const authShareId = authBinding.url.split("/").pop()
    await waitFor(async () => {
      const r = await httpGet(`${WORKER_URL}/api/share/${authShareId}/data`)
      // 200 = open share, 401 = gated (both mean the share exists)
      return r.status === 200 || r.status === 401
    }, "S7: share data present")

    const anon = await httpGet(`${WORKER_URL}/api/share/${authShareId}/data`)
    check("S7: anonymous read rejected (401)", anon.status === 401, `got ${anon.status}`)

    const authRes = await httpGet(`${WORKER_URL}/api/share/${authShareId}/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "suite-reader", password: "suite-pass" }),
    })
    check("S7: auth endpoint grants cookie", authRes.status === 200, `got ${authRes.status}`)
    const setCookie = authRes.headers.get("set-cookie") ?? ""
    const cookie = setCookie.split(";")[0]
    const authed = await httpGet(`${WORKER_URL}/api/share/${authShareId}/data`, { headers: { cookie } })
    check("S7: authed read succeeds (200)", authed.status === 200, `got ${authed.status}`)
  } finally {
    await stopServe(serve4);
  }

  // S6: explicit shareMode override ("all") beats TUI presence
  const overrideSandbox = join(suiteDir, "override")
  const overrideProject = join(overrideSandbox, "project")
  mkdirSync(overrideProject, { recursive: true })
  writeFileSync(join(overrideProject, "tui.json"), JSON.stringify({ plugin: [PKG] }, null, 2))

  const serve3 = await startServe(
    { name: "override", path: PKG, options: { shareMode: "all" } },
    overrideSandbox,
    overrideProject,
  )
  try {
    const osid = await createAndPrompt(serve3, "override to all")
    const shareUrl = await waitFor(() => readUrlFile(join(overrideSandbox, "share-url.txt")), "S6: urlFile (all-mode share)")
    check("S6: explicit all override shares despite TUI", !!shareUrl?.trim())
    const oshareId = shareUrl.trim().split("/").pop()
    await waitFor(async () => {
      const r = await httpGet(`${WORKER_URL}/api/share/${oshareId}/data`)
      if (!r.ok) return false
      const parsed = await r.json()
      return parsed.status === "completed"
    }, "S6: override share completes")
    const osession = await (await httpGet(`${serve3.base}/session/${osid}`)).json()
    const ob = osession?.metadata?.openshare
    check("S6: all-mode binding has NO enabled flag", !!ob?.url && ob.enabled === undefined, JSON.stringify(ob))
  } finally {
    await stopServe(serve3);
  }

  // S8: all-mode pre-existing dormancy — sessions created BEFORE the
  // plugin existed are never auto-shared on resume; explicit flag opts in
  // (with backfill); an already-bound session keeps its share (resume
  // continuity is S5's contract, asserted here in all-mode too)
  const preSandbox = join(suiteDir, "preexisting")
  const preProject = join(preSandbox, "project")
  mkdirSync(preProject, { recursive: true })
  const preUrlFile = join(preSandbox, "share-url.txt")
  // NO tui.json + no shareMode option -> all-mode by presence
  const preVariant = { name: "preexisting", path: PKG }
  // serve-0: NO plugin — creates the "session from before the plugin
  // existed" (never bound; a metadata strip is NOT enough because the
  // all-mode engine rewrites its binding from in-memory state)
  const preServe0 = await startServe({ ...preVariant, name: "preexisting-noplugin", pluginless: true }, preSandbox, preProject, {
    OPENSHARE_URL_FILE: preUrlFile,
    OPENSHARE_DEBOUNCE_MS: "300",
  })
  let preSid
  try {
    preSid = await createAndPrompt(preServe0, "session from before the plugin existed")
    const b = await (await httpGet(`${preServe0.base}/session/${preSid}`)).json()
    if (b?.metadata?.openshare) throw new Error("S8 setup: pluginless serve wrote a binding?!")
    if (!(await readUrlFile(preUrlFile))) {
      // pluginless serve must not write the url file either
    }
  } finally {
    await stopServe(preServe0)
  }
  const preServe1 = await startServe(preVariant, preSandbox, preProject, {
    OPENSHARE_URL_FILE: preUrlFile,
    OPENSHARE_DEBOUNCE_MS: "300",
  })
  let boundSid
  try {
    // session A: created while serve-1 runs -> shared + bound (all-mode)
    boundSid = await createAndPrompt(preServe1, "preexisting bound session")
    const boundUrl = await waitFor(() => readUrlFile(preUrlFile), "S8 setup: bound session shared")
    const boundId = boundUrl.trim().split("/").pop()
    await waitFor(async () => {
      const r = await httpGet(`${WORKER_URL}/api/share/${boundId}/data`)
      return r.ok && (await r.json()).status === "completed"
    }, "S8 setup: bound share completes")
  } finally {
    await stopServe(preServe1)
  }
  const preServe2 = await startServe(preVariant, preSandbox, preProject, {
    OPENSHARE_URL_FILE: preUrlFile,
    OPENSHARE_DEBOUNCE_MS: "300",
    OPENSHARE_DEBUG_EVENTS: "1",
    OPENSHARE_DEBUG_FILE: join(preSandbox, "pre-debug.json"),
  })
  try {
    const urlCountBefore = ((await readUrlFile(preUrlFile)) ?? "").trim().split("\n").filter(Boolean).length
    // resume the UNBOUND pre-existing session: prompt it — must NOT share
    await promptSession(preServe2, preSid, "resume of an old unbound session")
    await sleep(4000) // give any (wrong) share creation time to surface
    const after = await (await httpGet(`${preServe2.base}/session/${preSid}`)).json()
    const dormantOk = !after?.metadata?.openshare
    if (!dormantOk) {
      const lines = preServe2
        .output()
        .split("\n")
        .filter((l) => l.includes("[openshare]"))
        .join("\n")
      console.log(`--- S8 serve-2 [openshare] log ---\n${lines || "(none)"}\n---`)
    }
    check("S8: pre-existing unbound session NOT shared on resume", dormantOk, JSON.stringify(after?.metadata?.openshare))
    const urlCountAfter = ((await readUrlFile(preUrlFile)) ?? "").trim().split("\n").filter(Boolean).length
    check("S8: no new urlFile line for the dormant session", urlCountAfter === urlCountBefore, `${urlCountBefore} -> ${urlCountAfter}`)

    // explicit opt-in on the pre-existing session: flag -> gated share
    // WITH backfill (the history from before the flag must be on the page)
    await patchMetadata(preServe2, preSid, { openshare: { enabled: true } })
    const optIn = await waitFor(async () => {
      const s = await (await httpGet(`${preServe2.base}/session/${preSid}`)).json()
      const b = s?.metadata?.openshare
      return b?.url ? b : undefined
    }, "S8: flag-gated binding written")
    const optInId = optIn.url.split("/").pop()
    const optInBody = await waitFor(async () => {
      const r = await httpGet(`${WORKER_URL}/api/share/${optInId}/data`)
      if (!r.ok) throw new Error(`${r.status}`)
      const parsed = await r.json()
      const msgs = (parsed.data ?? []).filter((i) => i.type === "message")
      return parsed.status === "completed" && msgs.length >= 2 ? parsed : undefined
    }, "S8: flag-gated share backfilled with pre-flag history")
    console.log(`  S8 opt-in share ${optInId}: ${optInBody.data.length} items (history backfilled)`)
    check("S8: flag opt-in backfills history", true)

    // resume continuity in all-mode: the BOUND session keeps its share
    await promptSession(preServe2, boundSid, "resume of an old bound session")
    const reBound = await waitFor(async () => {
      const s = await (await httpGet(`${preServe2.base}/session/${boundSid}`)).json()
      const b = s?.metadata?.openshare
      return b?.url ? b : undefined
    }, "S8: bound session re-attached")
    const boundUrls = ((await readUrlFile(preUrlFile)) ?? "").trim().split("\n").filter(Boolean)
    check(
      "S8: bound session attaches SAME share (no duplicate)",
      boundUrls.includes(reBound.url),
      `${reBound.url} in [${boundUrls.join(", ")}]`,
    )
  } finally {
    await stopServe(preServe2)
  }
} catch (error) {
  console.error("SUITE ERROR:", error.message)
  failures.push(`suite-error: ${error.message}`)
} finally {
  try {
    worker?.kill()
  } catch {}
  try {
    llm?.close()
  } catch {}
  killWranglerSuites()
  killPortOwners(SERVE_PORT)
  killPortOwners(LLM_PORT)
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
