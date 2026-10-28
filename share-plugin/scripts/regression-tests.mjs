// Open(code)Share regression suite — phase 1 parity gate.
//
// Proves the built artifacts behave identically through the real
// production path:
//   1. openshare.js                   (the new standalone bundle)
//   2. dist/server.js                 (the package server entry)
//
// Method: REAL production path, no shortcuts — a local `wrangler dev`
// worker, a mock OpenAI-compatible provider (so a real `opencode serve`
// instance runs a real prompt pipeline: session created, user+assistant
// messages, text part, status busy/idle), OPENCODE_CONFIG one-file plugin
// config, sandbox spool/urlFile via env. Each variant drives the same
// lifecycle; each share's /data is compared (normalized) across variants.
//
// Lifecycle per variant:
//   POST /session                      -> session.created  (plugin creates share)
//   POST /session/:id/message          -> messages, parts, status busy/idle
//   (poll worker /data until status=completed)
//   DELETE /session/:id                -> session.deleted  (plugin deletes share)
//   (poll worker /data -> 404)

import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
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

const WATCHDOG_MS = 9 * 60 * 1000
const watchdog = setTimeout(() => {
  console.error("WATCHDOG: suite exceeded hard time limit — aborting")
  process.exit(124)
}, WATCHDOG_MS)

async function runVariant(variant, suiteDir) {
  const sandbox = join(suiteDir, variant.name)
  const projectDir = join(sandbox, "project")
  mkdirSync(projectDir, { recursive: true })

  const serve = await startServe(variant, sandbox, projectDir)
  const urlFile = join(sandbox, "share-url.txt")
  try {
    const created = await httpGet(`${serve.base}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "parity check" }),
    })
    if (!created.ok) throw new Error(`[${variant.name}] session create ${created.status}: ${(await created.text()).slice(0, 300)}`)
    const session = await created.json()
    const sid = session.id

    const shareUrl = await waitFor(() => {
      try {
        const content = readFileSync(urlFile, "utf8").trim()
        return content || undefined
      } catch {
        return undefined
      }
    }, `[${variant.name}] urlFile (share created)`)
    const shareId = shareUrl.split("/").pop()

    const prompted = await httpGet(`${serve.base}/session/${sid}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: { providerID: PROVIDER.id, modelID: PROVIDER.model },
        parts: [{ type: "text", text: "suite: hello, please respond briefly" }],
      }),
      timeoutMs: 60000,
    })
    if (!prompted.ok) throw new Error(`[${variant.name}] prompt ${prompted.status}: ${(await prompted.text()).slice(0, 300)}`)

    const body = await waitFor(async () => {
      const r = await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)
      if (!r.ok) throw new Error(`data fetch ${r.status}`)
      const parsed = await r.json()
      const hasContent = (parsed.data ?? []).some(
        (i) => i.type === "message" && i.data?.type === "assistant" && Array.isArray(i.data?.content) && i.data.content.length > 0,
      )
      if (parsed.status === "completed" && hasContent) return parsed
      return undefined
    }, `[${variant.name}] share completed`)

    // redaction: the binding (with the write secret) must never reach viewers
    const withBinding = (body.data ?? []).filter((i) => i.data?.metadata && "openshare" in i.data.metadata)
    if (withBinding.length) throw new Error(`[${variant.name}] metadata binding leaked into share data (${withBinding.length} items)`)

    const removed = await httpGet(`${serve.base}/session/${sid}`, { method: "DELETE" })
    if (!removed.ok) throw new Error(`[${variant.name}] session delete ${removed.status}`)
    await waitFor(async () => {
      const r = await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)
      return r.status === 404 || r.status === 410
    }, `[${variant.name}] share removed after session delete`)

    const spoolQueue = join(sandbox, "spool", `${sid}.queue.jsonl`)
    return {
      name: variant.name,
      sid,
      shareId,
      normalized: normalizeShare(body, sandbox),
      spoolCleared: !existsSync(spoolQueue) || readFileSync(spoolQueue, "utf8").trim() === "",
      sandbox,
    }
  } finally {
    await stopServe(serve);
  }
}

const suiteDir = mkdtempSync(join(tmpdir(), "openshare-suite-"))
console.log(`suite dir: ${suiteDir}`)

let worker
let llm
const failures = []
try {
  llm = await startMockLLM()
  console.log(`mock llm ready`)
  worker = await startWorker(suiteDir)
  console.log("worker ready")

  const variants = [
    { name: "standalone", path: join(ROOT, "ci", "openshare.js") },
    { name: "package", path: join(ROOT, "dist", "server.js") },
    // the owner's install mode: the package DIRECTORY via file:// URL —
    // proves directory resolution lands on dist/server.js, never the ci file
    { name: "package-dir", path: new URL("../", import.meta.url).href.replace(/\/$/, "") },
  ]

  const results = []
  for (const variant of variants) {
    const onDisk = variant.path.startsWith("file://") ? fileURLToPath(variant.path) : variant.path
    if (!existsSync(onDisk)) throw new Error(`variant ${variant.name} missing: ${variant.path}`)
    console.log(`running variant: ${variant.name}`)
    const result = await runVariant(variant, suiteDir)
    results.push(result)
    console.log(`  share ${result.shareId} status=${result.normalized.status} items=${result.normalized.items.map((i) => i.type).join(",")}`)
  }

  const check = (label, ok, detail) => {
    if (ok) console.log(`PASS ${label}`)
    else {
      console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`)
      failures.push(label)
    }
  }

  for (const result of results) {
    const types = result.normalized.items.map((i) => i.type)
    check(`${result.name}: session item`, types.includes("session"))
    check(`${result.name}: user+assistant messages`, types.filter((t) => t === "message").length >= 2)
    check(`${result.name}: assistant content embedded`, result.normalized.items.some((i) => i.type === "message" && Array.isArray(i?.data?.content)))
    check(`${result.name}: model item`, types.includes("model"))
    check(`${result.name}: status completed`, result.normalized.status === "completed", `got ${result.normalized.status}`)
    check(`${result.name}: spool queue cleared`, result.spoolCleared)
  }

  // Parity is VALUE parity: JSON key order is viewer-irrelevant (the
  // fold reads fields), and opencode's own event payloads carry no
  // stable key order between message.updated generations (a late update
  // recomputes e.g. `summary`; which generation an engine last stored
  // depends on flush timing). Compare canonically (keys sorted), and on
  // mismatch ALSO show the raw-order diff for diagnosis.
  const stable = (value) => {
    const sort = (v) => {
      if (Array.isArray(v)) return v.map(sort)
      if (v && typeof v === "object") {
        return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]))
      }
      return v
    }
    return JSON.stringify(sort(value))
  }
  const [standalone, pkg, pkgDir] = results.map((r) => stable(r.normalized))
  check("parity: package == standalone", pkg === standalone, diffSummary(standalone, pkg))
  check("parity: package-dir (file:// URL) == standalone", pkgDir === standalone, diffSummary(standalone, pkgDir))
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
  if (!process.env.OPENSHARE_TEST_WORKER_URL) killWranglerSuites() // matrix reuse: don't kill the shared worker
  killPortOwners(SERVE_PORT)
  killPortOwners(LLM_PORT)
}

// contract shape gate (pure): the tombstone item must carry sessionID —
// viewers key messages as message/<sessionID>/<id>; an unstamped del
// misses the key and undone turns resurrect on the live page
try {
  const { messageTombstone } = await import(
    pathToFileURL(join(here(".."), "dist", "contract.js")).href
  )
  const t = messageTombstone("ses_shape", "msg_x")
  const ok =
    t.del === true && t.type === "message" && !!t.sessionID &&
    `message/${t.sessionID}/${t.data.id}` === "message/ses_shape/msg_x"
  console.log(`${ok ? "PASS" : "FAIL"} contract: tombstone keys like the viewer derives it`)
  if (!ok) failures.push("contract: tombstone shape")
} catch (e) {
  console.log("FAIL contract: messageTombstone importable from dist:", String(e.message || e))
  failures.push("contract: messageTombstone import")
}


// config unit gate (pure): OPENSHARE_CONFIG_JSON sits between files and
// per-key env; urlFileFormat is a known enum; meta caps apply. These run
// in-process against dist/config.js with env vars set and restored.
try {
  const cfgmod = await import(pathToFileURL(join(here(".."), "dist", "config.js")).href)
  const { loadConfig } = cfgmod
  const saved = { ...process.env }
  const sandboxDir = mkdtempSync(join(tmpdir(), "osh-cfg-"))
  const pluginDir = join(sandboxDir, "plugin")
  mkdirSync(pluginDir, { recursive: true })
  // hermetic: dist config reads the real settings home otherwise
  // (suite rule - importing dist with env effects requires XDG redirect)
  process.env.XDG_CONFIG_HOME = join(sandboxDir, "xdg")
  mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true })
  try {
    // no config anywhere: CONFIG_JSON supplies everything
    process.env.OPENSHARE_WORKER_URL = ""
    process.env.OPENSHARE_CONFIG_JSON = JSON.stringify({
      workerUrl: "https://cfgjson.example",
      urlFileFormat: "json",
      meta: { run: "r-${OSH_TEST_RUN}", keep: "x" },
    })
    process.env.OSH_TEST_RUN = "42"
    let cfg = loadConfig(pluginDir)
    let ok =
      cfg.workerUrl === "https://cfgjson.example" &&
      cfg.urlFileFormat === "json" &&
      cfg.meta?.run === "r-${OSH_TEST_RUN}" && // interpolation is engine-side (metaFor); the loader keeps the literal
      cfg.meta?.keep === "x"
    console.log(`${ok ? "PASS" : "FAIL"} config: CONFIG_JSON supplies full config object`)
    if (!ok) failures.push("config: CONFIG_JSON load")
    // per-key env BEATS CONFIG_JSON
    process.env.OPENSHARE_WORKER_URL = "https://env-wins.example"
    cfg = loadConfig(pluginDir)
    ok = cfg.workerUrl === "https://env-wins.example"
    console.log(`${ok ? "PASS" : "FAIL"} config: specific env var beats CONFIG_JSON`)
    if (!ok) failures.push("config: CONFIG_JSON precedence")
    // malformed CONFIG_JSON must not throw and must not clear prior layers
    process.env.OPENSHARE_WORKER_URL = ""
    process.env.OPENSHARE_CONFIG_JSON = "{broken"
    cfg = loadConfig(pluginDir)
    ok = cfg.workerUrl === "" // nothing else configured
    console.log(`${ok ? "PASS" : "FAIL"} config: malformed CONFIG_JSON tolerated`)
    if (!ok) failures.push("config: CONFIG_JSON malformed")
    // urlFileFormat env enum
    process.env.OPENSHARE_CONFIG_JSON = ""
    process.env.OPENSHARE_URL_FILE_FORMAT = "json"
    cfg = loadConfig(pluginDir)
    ok = cfg.urlFileFormat === "json"
    delete process.env.OPENSHARE_URL_FILE_FORMAT
    process.env.OPENSHARE_URL_FILE_FORMAT = "bogus"
    cfg = loadConfig(pluginDir)
    ok = ok && cfg.urlFileFormat === "url" // bogus value ignored, default stays
    console.log(`${ok ? "PASS" : "FAIL"} config: urlFileFormat enum honored`)
    if (!ok) failures.push("config: urlFileFormat")
    // meta caps: non-string values dropped, over-long dropped
    process.env.OPENSHARE_URL_FILE_FORMAT = ""
    process.env.OPENSHARE_CONFIG_JSON = JSON.stringify({ meta: { good: "v", bad: 5, long: "y".repeat(501) } })
    cfg = loadConfig(pluginDir)
    ok = cfg.meta && cfg.meta.good === "v" && cfg.meta.bad === undefined && cfg.meta.long === undefined
    console.log(`${ok ? "PASS" : "FAIL"} config: meta normalization caps`)
    if (!ok) failures.push("config: meta caps")
  } finally {
    for (const k of Object.keys(saved)) process.env[k] = saved[k]
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    rmSync(sandboxDir, { recursive: true, force: true })
  }
} catch (e) {
  console.log("FAIL config unit block:", String(e.message || e))
  failures.push("config: unit block crashed")
}

// Wave 3 redaction (pure): detectors fire, markers are stable, user
// rules extend, tildization is display-only, and CLEAN items pass
// through zero-copy.
try {
  const { redactItem, activeRules, tildePath } = await import(
    pathToFileURL(join(here(".."), "dist", "redact.js")).href
  )
  const home = process.platform === "win32" ? "C:\\Users\\someone" : "/home/someone"
  const rules = activeRules(["PROJECT_\\d+_CODE"])
  const mk = (text) => ({ type: "message", data: { id: "m1", role: "user", content: [{ type: "text", text }] } })
  const withSecrets = {
    type: "message",
    data: {
      id: "m1", role: "user",
      content: [{ type: "text", text: `deploy with ghp_${"a".repeat(36)} and AKIA1234567890ABCDEF. API_KEY=live-secret-99. The PROJECT_42_CODE is internal.` }],
    },
    // path FIELDS tildize (prose paths deliberately do not)
    file: `${home}\\proj\\a.ts`,
  }
  const pass = redactItem(withSecrets, { rules, home, enabled: true })
  const flat = JSON.stringify(pass.item)
  const okR =
    pass.item !== withSecrets && // deep-cloned, host object untouched
    flat.includes("[redacted:gh-token]") &&
    flat.includes("[redacted:aws-key]") &&
    flat.includes("[redacted:env-secret]") &&
    flat.includes("[redacted:user]") && // config regex rule fired
    flat.includes("~/proj/a.ts") && // path FIELD tildized
    !flat.includes("AKIA1234567890ABCDEF") &&
    !flat.includes("live-secret-99") &&
    JSON.stringify(withSecrets).includes("AKIA1234567890ABCDEF") && // original intact
    JSON.stringify(withSecrets).includes("live-secret-99")
  console.log(`${okR ? "PASS" : "FAIL"} redact: detectors + user rules + tildization`)
  if (!okR) failures.push("redact: detectors")
  const hitKinds = pass.hits.map((h) => h.kind)
  const okS = hitKinds.includes("gh-token") && hitKinds.includes("user") && pass.hits.length >= 3
  console.log(`${okS ? "PASS" : "FAIL"} redact: hit ledger carries samples (${hitKinds.join(",")})`)
  if (!okS) failures.push("redact: ledger")
  const clean = mk("just normal text about files and paths")
  const passClean = redactItem(clean, { rules, home, enabled: true })
  const okZ = passClean.item === clean && passClean.hits.length === 0
  console.log(`${okZ ? "PASS" : "FAIL"} redact: clean item zero-copy`)
  if (!okZ) failures.push("redact: zero-copy")
  const gated = redactItem(withSecrets, { rules, home, enabled: false })
  const okG = JSON.stringify(gated.item).includes("AKIA1234567890ABCDEF") && gated.item.file === undefined ? true : JSON.stringify(gated.item).includes("AKIA1234567890ABCDEF")
  console.log(`${okG ? "PASS" : "FAIL"} redact: gated shares keep verbatim`)
  if (!okG) failures.push("redact: gated verbatim")
  const okT = tildePath(home + "/x/y.txt", home).startsWith("~") && tildePath("/elsewhere/z", home) === "/elsewhere/z"
  console.log(`${okT ? "PASS" : "FAIL"} redact: tildePath boundaries`)
  if (!okT) failures.push("redact: tilde")
} catch (e) {
  console.log("FAIL redact block:", String(e.message || e))
  failures.push("redact: block crashed")
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
