// Open(code)Share regression suite — phase 1 parity gate.
//
// Proves the built artifacts behave like the legacy single-file plugin:
//   1. reference/openshare.legacy.js  (the original, byte-preserved)
//   2. openshare.js                   (the new standalone bundle)
//   3. dist/server.js                 (the package server entry)
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
      if (parsed.status === "completed" && (parsed.data ?? []).some((i) => i.type === "part")) return parsed
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
    { name: "legacy", path: join(ROOT, "reference", "openshare.legacy.js") },
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
    check(`${result.name}: text part`, types.includes("part"))
    check(`${result.name}: model item`, types.includes("model"))
    check(`${result.name}: prefs item`, types.includes("prefs"))
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
  const [legacy, standalone, pkg] = results.map((r) => stable(r.normalized))
  check("parity: standalone == legacy", standalone === legacy, diffSummary(legacy, standalone))
  check("parity: package == legacy", pkg === legacy, diffSummary(legacy, pkg))
  const dirResult = results[3] ? stable(results[3].normalized) : ""
  check("parity: package-dir (file:// URL) == legacy", dirResult === legacy, diffSummary(legacy, dirResult))
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
