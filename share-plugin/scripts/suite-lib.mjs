// Shared machinery for the Open(code)Share plugin suites. See
// regression-tests.mjs / manual-tests.mjs for the actual scenarios.
//
// Everything here is timeout-guarded: fetches abort after 8s (unless
// overridden), spawned processes are killed as trees synchronously, stale
// port owners are swept before binds, and callers own a global watchdog.

import { spawn, execSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url))
const ROOT = here("../") // share-plugin/

const WORKER_PORT = 8789
const LLM_PORT = 8791
const SERVE_PORT = 8793
const WORKER_URL = `http://127.0.0.1:${WORKER_PORT}`
const CREATE_TOKEN = "suite-create-token"
const TIMEOUT_MS = 120000
const PROVIDER = { id: "mock", model: "mock-1" }

function dirname(p) {
  return p.replace(/[\\/][^\\/]+[\\/]?$/, "") || "."
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const httpGet = async (url, init = {}) => {
  return fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 8000) })
}

function killPortOwners(port) {
  if (process.platform !== "win32") return
  try {
    const out = execSync(
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -join ','`,
      { shell: "powershell", timeout: 10000 },
    )
      .toString()
      .trim()
    for (const pid of out.split(",").filter(Boolean)) {
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { shell: true, timeout: 10000, stdio: "ignore" })
      } catch {}
    }
  } catch {}
}

/** Kills leftover suite wrangler supervisors. A survived supervisor
 * respawns workerd children on the port forever; killing the listener
 * alone never ends it (empirically: probe run left PID behind, every
 * later suite dead-listened). Matches the wrangler cli process by
 * command line. */
function killWranglerSuites(port = WORKER_PORT) {
  if (process.platform !== "win32") return
  try {
    const out = execSync(
      `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*wrangler*dev*--port ${port}*" } | Select-Object -ExpandProperty ProcessId) -join ','`,
      { shell: "powershell", timeout: 15000 },
    )
      .toString()
      .trim()
    for (const pid of out.split(",").filter(Boolean)) {
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { shell: true, timeout: 15000, stdio: "ignore" })
      } catch {}
    }
  } catch {}
  killPortOwners(port)
}

async function waitFor(fn, label, timeout = TIMEOUT_MS) {
  const start = Date.now()
  let lastError
  while (Date.now() - start < timeout) {
    try {
      const value = await fn()
      if (value !== undefined && value !== null && value !== false) return value
    } catch (error) {
      lastError = error
    }
    await sleep(500)
  }
  throw new Error(`timeout waiting for ${label}${lastError ? ` (last: ${lastError.message})` : ""}`)
}

function spawnTree(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  })
  const kill = () => {
    if (child.exitCode !== null) return
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /PID ${child.pid} /T /F`, { shell: true, timeout: 15000, stdio: "ignore" })
        child.kill()
      } else child.kill("SIGKILL")
    } catch {
      try {
        child.kill()
      } catch {}
    }
  }
  return { child, kill }
}

// --- mock OpenAI-compatible LLM ----------------------------------------------

function startMockLLM() {
  const server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: [{ id: PROVIDER.model, object: "model", owned_by: "suite" }] }))
      return
    }
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-suite",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: PROVIDER.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
      res.write(chunk({ role: "assistant", content: "" }))
      res.write(chunk({ content: "suite reply: parity check complete" }))
      res.write(chunk({}, "stop"))
      res.write("data: [DONE]\n\n")
      res.end()
      return
    }
    res.writeHead(404)
    res.end("not found")
  })
  return new Promise((resolve) => server.listen(LLM_PORT, "127.0.0.1", () => resolve(server)))
}

// --- wrangler dev ---------------------------------------------------------------

async function startWorker(suiteDir) {
  const attempt = async () => {
    killWranglerSuites() // leftover supervisors respawn workerd forever; sweep first
    const assetsDir = join(suiteDir, "assets")
    mkdirSync(assetsDir, { recursive: true })
    writeFileSync(join(assetsDir, "index.html"), "<!doctype html><title>openshare suite stub</title>\n")

    const configPath = join(suiteDir, "wrangler.suite.toml")
    const original = readFileSync(join(dirname(ROOT), "share-worker", "wrangler.toml"), "utf8")
    const config = original
      .replace('name = "openshare-worker"', 'name = "openshare-worker-suite"')
      .replace('main = "worker.js"', `main = ${JSON.stringify(join(dirname(ROOT), "share-worker", "worker.js").replace(/\\/g, "/"))}`)
      .replace(/directory = "\.\.\/share-viewer\/dist"/, `directory = ${JSON.stringify(assetsDir.replace(/\\/g, "/"))}`)
    writeFileSync(configPath, config)

    const { child, kill } = spawnTree(
      "npx",
      ["wrangler", "dev", "--config", configPath, "--port", String(WORKER_PORT), "--ip", "127.0.0.1", "--var", `CREATE_TOKEN:${CREATE_TOKEN}`],
      { cwd: join(dirname(ROOT), "share-worker") },
    )
    let output = ""
    child.stdout.on("data", (d) => (output += d))
    child.stderr.on("data", (d) => (output += d))
    const fail = async (error) => {
      kill()
      await sleep(1500)
      killPortOwners(WORKER_PORT)
      return new Error(`${error.message}\n--- wrangler output ---\n${output.slice(-4000)}`)
    }
    try {
      await waitFor(async () => {
        try {
          return (await httpGet(`${WORKER_URL}/health`)).ok
        } catch {
          return false
        }
      }, "wrangler dev /health", 90000)
    } catch (error) {
      // workerd children sometimes survive the tree-kill and re-bind the
      // port late; one full sweep + fresh retry resolves it
      throw await fail(error)
    }
    return { kill, output: () => output }
  }

  try {
    return await attempt()
  } catch (error) {
    return await attempt()
  }
}

/** Resolves when nothing listens on the port (or after timeout). */
async function waitForPortFree(port, timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    let listening = false
    try {
      const out = execSync(
        `@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).Count`,
        { shell: "powershell", timeout: 10000 },
      )
        .toString()
        .trim()
      listening = Number(out) > 0
    } catch {}
    if (!listening) return true
    await sleep(500)
  }
  return false
}

// --- opencode serve --------------------------------------------------------------

function opencodeConfig(variant, sandbox, extra = {}) {
  const pluginEntry = variant.options ? [variant.path.replace(/\\/g, "/"), variant.options] : variant.path.replace(/\\/g, "/")
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      plugin: [pluginEntry],
      provider: {
        mock: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `http://127.0.0.1:${LLM_PORT}/v1`, apiKey: "mock" },
          models: { [PROVIDER.model]: { name: "Mock 1" } },
        },
      },
      model: `${PROVIDER.id}/${PROVIDER.model}`,
      ...extra,
    },
    null,
    2,
  )
}

function openShareEnv(sandbox, extra = {}) {
  return {
    ...process.env,
    OPENSHARE_WORKER_URL: WORKER_URL,
    OPENSHARE_CREATE_TOKEN: CREATE_TOKEN,
    OPENSHARE_URL_FILE: join(sandbox, "share-url.txt"),
    OPENSHARE_SPOOL_DIR: join(sandbox, "spool"),
    OPENSHARE_DEBOUNCE_MS: "300",
    ...extra,
  }
}

async function startServe(variant, sandbox, projectDir, extraEnv = {}) {
  killPortOwners(SERVE_PORT)
  const configPath = join(sandbox, "opencode.json")
  writeFileSync(configPath, opencodeConfig(variant, sandbox))
  // hermetic: opencode MERGES the global config's plugins with
  // OPENCODE_CONFIG (empirically proven) — redirect XDG_CONFIG_HOME so the
  // machine's global registrations (including this very package) stay out
  mkdirSync(join(sandbox, "xdg"), { recursive: true })

  const { child, kill } = spawnTree("opencode", ["serve", "--port", String(SERVE_PORT), "--hostname", "127.0.0.1"], {
    cwd: projectDir,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(sandbox, "xdg"),
      OPENCODE_CONFIG: configPath,
      ...openShareEnv(sandbox),
      ...extraEnv,
    },
  })
  let output = ""
  child.stdout.on("data", (d) => (output += d))
  child.stderr.on("data", (d) => (output += d))
  const base = `http://127.0.0.1:${SERVE_PORT}`
  await waitFor(async () => {
    try {
      return (await httpGet(`${base}/config`)).ok
    } catch {
      return false
    }
  }, `[${variant.name}] opencode serve`, 60000).catch(async (error) => {
    kill()
    killPortOwners(SERVE_PORT)
    await waitForPortFree(SERVE_PORT)
    throw new Error(`[${variant.name}] serve failed: ${error.message}\n--- serve output ---\n${output.slice(-4000)}`)
  })
  return { base, kill, output: () => output, configPath }
}

/** Kills a serve instance and waits for the port to actually free (a
 * half-dead predecessor races its successor's session events). */
async function stopServe(serve) {
  serve.kill()
  await waitForPortFree(SERVE_PORT, 30000)
  await sleep(500)
}

// --- share data normalization ------------------------------------------------------

function normalizeItem(item, sandboxRoot) {
  const clone = JSON.parse(JSON.stringify(item))
  const strip = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return
    delete value.time
    if (value.metadata) delete value.metadata.openshare
    if ("slug" in value) delete value.slug // random word pair per session
    if ("path" in value && typeof value.path === "string") delete value.path // relative sandbox path per variant
    for (const key of Object.keys(value)) {
      if (typeof value[key] === "object") strip(value[key])
    }
  }
  strip(clone)
  if (sandboxRoot) {
    const forms = [sandboxRoot, sandboxRoot.replace(/\\/g, "/")]
    const neutralize = (v) => {
      if (typeof v === "string") {
        let out = v
        for (const form of forms) out = out.split(form).join("<sandbox>")
        return out
      }
      if (!v || typeof v !== "object") return v
      if (Array.isArray(v)) return v.map(neutralize)
      const out = {}
      for (const [key, entry] of Object.entries(v)) out[key] = neutralize(entry)
      return out
    }
    return neutralize(clone)
  }
  return clone
}

// run-generated ids (ses_/msg_/prt_ + timestamp) differ per run —
// canonicalize them (lexicographic sort within prefix = chronological) so
// structurally identical shares compare equal
const ID_PATTERN = /^(ses|msg|prt)_[A-Za-z0-9]+$/

function canonicalizeIds(value) {
  const found = new Set()
  const collect = (v) => {
    if (typeof v === "string") {
      if (ID_PATTERN.test(v)) found.add(v)
      return
    }
    if (!v || typeof v !== "object") return
    for (const entry of Array.isArray(v) ? v : Object.values(v)) collect(entry)
  }
  collect(value)
  const byPrefix = { ses: [], msg: [], prt: [] }
  for (const id of found) byPrefix[id.slice(0, 3)].push(id)
  const map = new Map()
  for (const prefix of ["ses", "msg", "prt"]) {
    byPrefix[prefix].sort()
    byPrefix[prefix].forEach((id, index) => map.set(id, `${prefix.toUpperCase()}_${index + 1}`))
  }
  const apply = (v) => {
    if (typeof v === "string") return map.get(v) ?? v
    if (!v || typeof v !== "object") return v
    if (Array.isArray(v)) return v.map(apply)
    const out = {}
    for (const [key, entry] of Object.entries(v)) out[key] = apply(entry)
    return out
  }
  return apply(value)
}

function normalizeShare(body, sandboxRoot) {
  const items = (body.data ?? []).map((i) => canonicalizeIds(normalizeItem(i, sandboxRoot)))
  items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return { status: body.status, items }
}

function diffSummary(a, b) {
  if (a === b) return ""
  const pa = JSON.parse(a)
  const pb = JSON.parse(b)
  const diffs = []
  if (pa.status !== pb.status) diffs.push(`status ${pa.status} != ${pb.status}`)
  const la = pa.items.map((i) => JSON.stringify(i))
  const lb = pb.items.map((i) => JSON.stringify(i))
  for (const item of la) if (!lb.includes(item)) diffs.push(`only in A: ${item.slice(0, 160)}`)
  for (const item of lb) if (!la.includes(item)) diffs.push(`only in B: ${item.slice(0, 160)}`)
  return diffs.slice(0, 5).join(" | ")
}

export {
  sleep,
  waitFor,
  spawnTree,
  httpGet,
  killPortOwners,
  killWranglerSuites,
  waitForPortFree,
  startMockLLM,
  startWorker,
  startServe,
  stopServe,
  normalizeItem,
  canonicalizeIds,
  normalizeShare,
  diffSummary,
  dirname,
  WORKER_PORT,
  LLM_PORT,
  SERVE_PORT,
  WORKER_URL,
  CREATE_TOKEN,
  PROVIDER,
}
