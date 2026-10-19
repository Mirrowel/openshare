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
import { spawn } from "node:child_process"
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
  bindingUrlOf,
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

/** Poll the worker /data until the predicate passes on the parsed body. */
async function waitForShareData(shareId, predicate, label) {
  return waitFor(async () => {
    const r = await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)
    if (!r.ok) return undefined
    const parsed = await r.json()
    return predicate(parsed) ?? undefined
  }, label, 45000)
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
  console.log("probe: pre-startServe")
  const serve = await startServe(variant, sandbox, projectDir, { OPENSHARE_DEBUG_FILE: join(sandbox, "debug.json") })
  console.log("probe: post-startServe")

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
    // stderr policy: manual mode (TUI present) -> errors only; the
    // informational announce lines must never appear
    check("S1: no info announce lines on stderr (manual mode)", !/\[openshare\] (live:|url file:|share mode:)/.test(serve.output()), serve.output().split("\n").filter((l) => l.includes("[openshare]")).slice(0, 3).join(" | "))

    // S2: activation — set the flag mid-session
    await patchMetadata(serve, sid, { openshare: { enabled: true } })
    const binding = await waitFor(async () => {
      const s = await (await httpGet(`${serve.base}/session/${sid}`)).json()
      const b = s?.metadata?.openshare
      return bindingUrlOf(b) ? b : undefined
    }, "S2: binding (url) written into session metadata")
    check("S2: binding has enabled flag", binding.enabled === true, JSON.stringify(binding))
    shareId = bindingUrlOf(binding).split("/").pop()

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
      return bindingUrlOf(b) ? b : undefined
    }, "S5: binding present after restart")
    check("S5: restart attaches SAME share", bindingUrlOf(reattached).split("/").pop() === shareId, `${bindingUrlOf(reattached)} vs ${shareId} binding=${JSON.stringify(reattached)}`)

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
      return bindingUrlOf(b) ? b : undefined
    }, "S4: re-share binding")
    const newShareId = bindingUrlOf(reactivated).split("/").pop()
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
      return bindingUrlOf(b) ? b : undefined
    }, "S7: share attached with auth opts")
    const authShareId = bindingUrlOf(authBinding).split("/").pop()
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
    // Since the live-caught consent-on-shared-session fix, bindings are
    // enabled:true in BOTH modes (live <=> url && enabled !== false).
    check("S6: all-mode binding carries enabled:true", !!bindingUrlOf(ob) && ob.enabled === true, JSON.stringify(ob))
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
      return bindingUrlOf(b) ? b : undefined
    }, "S8: flag-gated binding written")
    const optInId = bindingUrlOf(optIn).split("/").pop()
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
      return bindingUrlOf(b) ? b : undefined
    }, "S8: bound session re-attached")
    const reBoundUrl = bindingUrlOf(reBound)
    const boundUrls = ((await readUrlFile(preUrlFile)) ?? "").trim().split("\n").filter(Boolean)
    check(
      "S8: bound session attaches SAME share (no duplicate)",
      boundUrls.includes(reBoundUrl),
      `${reBoundUrl} in [${boundUrls.join(", ")}]`,
    )
  } finally {
    await stopServe(preServe2)
  }

  // S9: undo tombstones — revert marks (viewer hides), the NEXT prompt
  // hard-deletes the reverted range (message.removed / part.removed).
  // The share must PHYSICALLY drop those items: without tombstones the
  // upsert-only worker keeps them and they reappear when the marker
  // clears (live-caught in production 2026-10-18).
  {
    const s9Sandbox = join(suiteDir, "undo")
    const s9Project = join(s9Sandbox, "project")
    mkdirSync(s9Project, { recursive: true })
    const s9UrlFile = join(s9Sandbox, "share-url.txt")
    const s9Env = { OPENSHARE_URL_FILE: s9UrlFile }
    if (process.env.S9_DEBUG) s9Env.OPENSHARE_DEBUG_EVENTS = "1"
    const s9Serve = await startServe({ name: "undo", path: PKG }, s9Sandbox, s9Project, s9Env)
    async function s9Body() {
      const s9sid = await createAndPrompt(s9Serve, "undo turn one")
      await promptSession(s9Serve, s9sid, "undo turn two")
      const s9url = (await waitFor(() => readUrlFile(s9UrlFile), "S9: share created")).trim().split("\n").at(-1)
      const s9id = s9url.split("/").pop()
      await waitForShareData(s9id, (parsed) => {
        const msgs = parsed.data.filter((i) => i.type === "message")
        return parsed.status === "completed" && msgs.length >= 4 ? parsed : undefined
      }, "S9: both turns shared")

      // undo the second turn: revert to its user message
      const messages = await (await httpGet(`${s9Serve.base}/session/${s9sid}/message`)).json()
      const flat = messages.map((m) => m.info ?? m)
      const users = flat.filter((m) => m.role === "user").map((m) => m.id)
      const beforeIds = flat.map((m) => m.id)
      const turn2User = users.at(-1)
      const revRes = await httpGet(`${s9Serve.base}/session/${s9sid}/revert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageID: turn2User }),
        timeoutMs: 30000,
      })
      if (!revRes.ok) throw new Error(`S9 revert ${revRes.status}: ${(await revRes.text()).slice(0, 200)}`)
      const marked = await waitForShareData(s9id, (parsed) => {
        const session = parsed.data.find((i) => i.type === "session")
        return session?.data?.revert?.messageID ? session : undefined
      }, "S9: revert marker visible on the share (viewer hides)")
      check("S9: revert marker on the share", !!marked)

      // re-prompt: cleanup hard-deletes the range; tombstones must purge.
      // (the purge lands with or before the new USER message: cleanup runs
      // before the new prompt persists, so waiting for the new user id
      // guarantees the tombstones have been applied too)
      await promptSession(s9Serve, s9sid, "after undo")
      const purged = await waitForShareData(s9id, (parsed) => {
        const msgs = parsed.data.filter((i) => i.type === "message")
        const newUsers = msgs.filter((i) => i.data.role === "user" && !beforeIds.includes(i.data.id))
        return newUsers.length ? parsed : undefined
      }, "S9: new turn visible (tombstones settled)")
      const afterIds = purged.data.filter((i) => i.type === "message").map((i) => i.data.id)
      const afterParts = purged.data.filter((i) => i.type === "part").map((i) => i.data.messageID)
      // the removed range: everything from the revert point onward
      const removedIds = flat.slice(flat.findIndex((m) => m.id === turn2User)).map((m) => m.id)
      check(
        "S9: reverted user message purged from the share",
        !afterIds.includes(turn2User),
        `messages still present: ${JSON.stringify(afterIds)}`,
      )
      check(
        "S9: reverted turn's parts purged",
        !afterParts.some((mid) => removedIds.includes(mid)),
        `parts of removed messages still present`,
      )
      const sessionAfter = purged.data.find((i) => i.type === "session")
      check("S9: revert marker cleared after re-prompt", !sessionAfter?.data?.revert)
      // first turn survived the purge
      check("S9: kept turn's message still present", afterIds.includes(users[0]))

      // multi-undo: two fresh turns, revert to the FIRST of them, re-prompt
      await promptSession(s9Serve, s9sid, "multi undo A")
      await promptSession(s9Serve, s9sid, "multi undo B")
      const messages2 = await (await httpGet(`${s9Serve.base}/session/${s9sid}/message`)).json()
      const flat2 = messages2.map((m) => m.info ?? m)
      const users2 = flat2.filter((m) => m.role === "user").map((m) => m.id)
      const multiTarget = users2.at(-2) // "multi undo A"
      // everything from the revert point onward gets hard-deleted
      const rangeIds = flat2.slice(flat2.findIndex((m) => m.id === multiTarget)).map((m) => m.id)
      const rev2 = await httpGet(`${s9Serve.base}/session/${s9sid}/revert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageID: multiTarget }),
        timeoutMs: 30000,
      })
      if (!rev2.ok) throw new Error(`S9 multi revert ${rev2.status}: ${(await rev2.text()).slice(0, 200)}`)
      await promptSession(s9Serve, s9sid, "after multi undo")
      const purged2 = await waitForShareData(s9id, (parsed) => {
        const msgs = parsed.data.filter((i) => i.type === "message").map((i) => i.data.id)
        const newUsers = parsed.data.filter((i) => i.type === "message" && i.data.role === "user" && !rangeIds.includes(i.data.id) && !beforeIds.includes(i.data.id))
        return newUsers.length && !msgs.some((id) => rangeIds.includes(id)) ? parsed : undefined
      }, "S9: multi-undo range purged (both turns)")
      const finalIds = purged2.data.filter((i) => i.type === "message").map((i) => i.data.id)
      check("S9: multi-undo: entire reverted range gone", !finalIds.some((id) => rangeIds.includes(id)))
      check("S9: multi-undo: kept history intact", finalIds.includes(users[0]))
    }
    try {
      await s9Body()
    } catch (error) {
      const lines = s9Serve
        .output()
        .split("\n")
        .filter((l) => l.includes("[openshare]") || l.includes("removed"))
        .join("\n")
      console.log(`--- S9 serve [openshare] log ---\n${lines || "(none)"}\n---`)
      throw error
    } finally {
      await stopServe(s9Serve)
    }
  }
  // S10: completed debounce — idle between sequential prompts must NOT
  // flip the share to completed instantly (8s delay here); a genuinely
  // finished session settles to completed after the window; a killed
  // process (dispose) flushes the pending completed immediately.
  {
    const stSandbox = join(suiteDir, "status")
    const stProject = join(stSandbox, "project")
    mkdirSync(stProject, { recursive: true })
    const stUrlFile = join(stSandbox, "share-url.txt")
    const stServe = await startServe({ name: "status", path: PKG }, stSandbox, stProject, {
      OPENSHARE_URL_FILE: stUrlFile,
      OPENSHARE_COMPLETED_DELAY_MS: "8000",
    })
    try {
      const stsid = await createAndPrompt(stServe, "status debounce")
      const sturl = (await waitFor(() => readUrlFile(stUrlFile), "S10: share created")).trim().split("\n").at(-1)
      const stid = sturl.split("/").pop()
      // wait for the assistant response to land, then check the status is
      // still live well inside the 8s window
      await waitForShareData(stid, (parsed) => {
        const parts = parsed.data.filter((i) => i.type === "part")
        return parts.length >= 2 ? parsed : undefined
      }, "S10: response parts synced")
      await sleep(1500)
      const mid = await (await httpGet(`${WORKER_URL}/api/share/${stid}/data`)).json()
      check("S10: status still live inside the debounce window", mid.status === "live", `status=${mid.status}`)
      const done = await waitForShareData(stid, (parsed) => (parsed.status === "completed" ? parsed : undefined), "S10: completed after the window (8s)")
      check("S10: settles to completed after the delay", done.status === "completed")

      // dispose-flush: a GRACEFUL process exit while the 8s pending timer
      // is armed must still land the final completed (the `opencode run`
      // CI contract — a hard kill never runs dispose, so this drives a
      // real run to natural exit)
      const runSid = await new Promise((resolve, reject) => {
        const child = spawn("opencode", ["run", "-m", "mock/mock-1", "--message", "dispose flush probe"], {
          cwd: stProject,
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            XDG_CONFIG_HOME: join(stSandbox, "xdg"),
            XDG_DATA_HOME: join(stSandbox, "xdg-data"),
            XDG_STATE_HOME: join(stSandbox, "xdg-state-run"),
            OPENCODE_CONFIG: join(stSandbox, "opencode.json"),
            OPENSHARE_WORKER_URL: WORKER_URL,
            OPENSHARE_CREATE_TOKEN: "suite-create-token",
            OPENSHARE_URL_FILE: stUrlFile,
            OPENSHARE_SPOOL_DIR: join(stSandbox, "spool"),
            OPENSHARE_DEBOUNCE_MS: "300",
            OPENSHARE_COMPLETED_DELAY_MS: "8000",
          },
        })
        let err = ""
        child.stdout.on("data", (d) => (err += d))
        child.stderr.on("data", (d) => (err += d))
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`run exit ${code}: ${err.slice(-300)}`))))
        child.on("error", reject)
      })
      const runUrl = (await waitFor(() => readUrlFile(stUrlFile), "S10: run share url written")).trim().split("\n").at(-1)
      const runId = runUrl.split("/").pop()
      const flushed = await waitForShareData(runId, (parsed) => (parsed.status === "completed" ? parsed : undefined), "S10: dispose flushed pending completed (graceful run exit)")
      check("S10: graceful run exit still lands final completed despite the delay", flushed.status === "completed")

      // idle-flush latency + real retry + terminal error run AFTER the
      // stServe probes below (a second serve rebinds the port and would
      // kill stServe); ordering documented here, blocks follow.

      // real retry path: mock LLM answers 429 once (retry-after 1s);
      // opencode recovers -> the share must end completed, NOT error
      // (recovered retries are forgiven by the next busy)
      const linesBeforeRetry = ((await readUrlFile(stUrlFile)) ?? "").trim().split("\n").filter(Boolean).length
      await createAndPrompt(stServe, "transient probe RETRY_ONCE").catch(() => {})
      const retryUrl = (
        await waitFor(async () => {
          const lines = ((await readUrlFile(stUrlFile)) ?? "").trim().split("\n").filter(Boolean)
          return lines.length > linesBeforeRetry ? lines.at(-1) : undefined
        }, "S10: retry share url")
      )
      const retryId = retryUrl.split("/").pop()
      const retried = await waitForShareData(retryId, (parsed) => (parsed.status === "completed" ? parsed : undefined), "S10: recovered retry ends completed")
      check("S10: recovered 429 retry -> completed (not error)", retried.status === "completed", `status=${retried.status}`)

      // terminal error path: mock LLM hard-fails every request; opencode
      // retries with backoff (~68s for 5 attempts) and the turn dies as
      // an assistant message with finish:"error" (a 200, not session.error
      // — live-caught); the share must still say error
      const linesBeforeFail = ((await readUrlFile(stUrlFile)) ?? "").trim().split("\n").filter(Boolean).length
      {
        const created = await httpGet(`${stServe.base}/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "doomed" }),
        })
        const doomed = await created.json()
        await httpGet(`${stServe.base}/session/${doomed.id}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: { providerID: PROVIDER.id, modelID: PROVIDER.model },
            parts: [{ type: "text", text: "suite: doomed probe FAIL_HARD" }],
          }),
          timeoutMs: 150000,
        }).catch(() => {})
      }
      const failUrl = (
        await waitFor(async () => {
          const lines = ((await readUrlFile(stUrlFile)) ?? "").trim().split("\n").filter(Boolean)
          return lines.length > linesBeforeFail ? lines.at(-1) : undefined
        }, "S10: fail share url")
      )
      const failId = failUrl.split("/").pop()
      const failed = await waitForShareData(failId, (parsed) => (parsed.status === "error" ? parsed : undefined), "S10: hard failure ends error")
      check("S10: terminal failure -> error status", failed.status === "error", `status=${failed.status}`)
    } finally {
      await stopServe(stServe)
    }

    // idle-flush latency: with a LONG sync interval (8s) the turn-end
    // batch must still land within ~3s of the prompt returning — the
    // idle flush, not the interval, delivers turn ends (own serve: the
    // port rebind kills the previous one, so this runs last)
    {
      const latSandbox = join(suiteDir, "latency")
      const latProject = join(latSandbox, "project")
      mkdirSync(latProject, { recursive: true })
      const latUrlFile = join(latSandbox, "share-url.txt")
      const latServe = await startServe({ name: "latency", path: PKG }, latSandbox, latProject, {
        OPENSHARE_URL_FILE: latUrlFile,
        OPENSHARE_DEBOUNCE_MS: "8000",
        OPENSHARE_COMPLETED_DELAY_MS: "300",
      })
      try {
        await createAndPrompt(latServe, "latency probe")
        const latUrl = (await waitFor(() => readUrlFile(latUrlFile), "S10: latency share url")).trim().split("\n").at(-1)
        const latId = latUrl.split("/").pop()
        const t0 = Date.now()
        await waitForShareData(latId, (parsed) => {
          const msgs = parsed.data.filter((i) => i.type === "message" && i.data?.role === "user")
          return msgs.length ? parsed : undefined
        }, "S10: turn-end content visible")
        const latency = Date.now() - t0
        check("S10: turn-end content flushed immediately (<3s despite 8s interval)", latency < 3000, `${latency}ms`)
      } finally {
        await stopServe(latServe)
      }
    }
  }

  // S11: turn-scoped sockets (suite worker: 127.0.0.1 -> auto -> turn,
  // TURN_GRACE_MS=2000): settle -> grace -> clean drop; the next prompt
  // reconnects on demand and nothing is lost
  {
    const s11Sandbox = join(suiteDir, "turn")
    const s11Project = join(s11Sandbox, "project")
    mkdirSync(s11Project, { recursive: true })
    const s11UrlFile = join(s11Sandbox, "share-url.txt")
    const s11Env = { OPENSHARE_URL_FILE: s11UrlFile, OPENSHARE_DEBUG_EVENTS: "1" }
    const s11Serve = await startServe({ name: "turn", path: PKG }, s11Sandbox, s11Project, s11Env)
    try {
      const sid = await createAndPrompt(s11Serve, "turn lifecycle probe")
      const url = (await waitFor(() => readUrlFile(s11UrlFile), "S11: share created")).trim().split("\n").at(-1)
      const id = url.split("/").pop()
      await waitForShareData(id, (parsed) => (parsed.status === "completed" ? parsed : undefined), "S11: turn settled (completed)")
      // grace is 2s; wait past it for the deliberate drop
      await waitFor(() => (s11Serve.output().includes("turn: drop socket (turn end)") ? true : undefined), "S11: socket dropped after grace")
      check("S11: socket dropped after settle+grace", true)
      // next turn: reconnect on demand, content + live status must return
      await promptSession(s11Serve, sid, "turn two after drop")
      const revived = await waitForShareData(id, (parsed) => {
        // v1.18 message info carries no .text (it lives in parts); count
        // user messages: turn two means a SECOND user message
        const users = parsed.data.filter((i) => i.type === "message" && i.data?.role === "user")
        return users.length >= 2 ? parsed : undefined
      }, "S11: post-drop turn content landed (reconnect)")
      check("S11: post-drop turn content landed", !!revived)
      const done2 = await waitForShareData(id, (parsed) => (parsed.status === "completed" ? parsed : undefined), "S11: second turn settles too")
      check("S11: second turn settles completed", done2.status === "completed")
    } finally {
      await stopServe(s11Serve)
    }
  }

  // S12: worker finalize — plugin socket dies WITHOUT goodbye (kill, crash):
  // after FINALIZE_AFTER_MS (4s in the suite) the share settles "interrupted";
  // a completed share is never touched
  {
    const ws = new WebSocket(`ws://127.0.0.1:8789/api/ws?token=suite-create-token`)
    const opened = await new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true })
      ws.addEventListener("error", () => reject(new Error("S12 ws open failed")), { once: true })
    })
    const init = await new Promise((resolve, reject) => {
      ws.addEventListener("message", (ev) => resolve(JSON.parse(String(ev.data))), { once: true })
      ws.send(JSON.stringify({ op: "init", create: { sessionID: "ses_s12_finalize", ttlDays: 1 } }))
      setTimeout(() => reject(new Error("S12 init timeout")), 10000)
    })
    check("S12: raw ws share created", init.ok === true)
    const syncAck = await new Promise((resolve, reject) => {
      ws.addEventListener("message", (ev) => resolve(JSON.parse(String(ev.data))), { once: true })
      ws.send(JSON.stringify({ op: "sync", items: [{ type: "session", data: { id: "ses_s12_finalize" } }], status: "live" }))
      setTimeout(() => reject(new Error("S12 sync timeout")), 10000)
    })
    check("S12: live sync acked", syncAck.op === "ack")
    ws.close() // NO delete: vanish like a killed process
    const fin = await waitForShareData(init.id, (parsed) => (parsed.status === "interrupted" ? parsed : undefined), "S12: share finalized to interrupted")
    check("S12: no-goodbye death -> interrupted", fin.status === "interrupted")
    // cleanup
    await httpGet(`${WORKER_URL}/api/share/${init.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: init.secret }) })
  }
} catch (error) {
  console.error("SUITE ERROR:", error.message)
  console.error(error.stack?.split("\n").slice(0, 6).join("\n"))
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
