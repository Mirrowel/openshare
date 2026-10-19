// Shared machinery for the Open(code)Share plugin suites. See
// regression-tests.mjs / manual-tests.mjs for the actual scenarios.
//
// Everything here is timeout-guarded: fetches abort after 8s (unless
// overridden), spawned processes are killed as trees synchronously, stale
// port owners are swept before binds, and callers own a global watchdog.

import { spawn, execSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
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
  // 30s default: a fresh sandbox's first request spins the instance,
  // including provider-npm resolution — 8s aborted mid-init (live-caught)
  return fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 30000) })
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

// Behavior markers embedded in the prompt text:
//   "RETRY_ONCE" -> the FIRST completion request containing the marker
//                   answers 429 (with retry-after) once, then streams
//                   normally — exercises opencode's real retry path
//   "FAIL_HARD"  -> every request containing the marker answers 500 —
//                   the run dies, exercising session.error -> share error
const retryOnce = new Set()

function startMockLLM() {
  const server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: [{ id: PROVIDER.model, object: "model", owned_by: "suite" }] }))
      return
    }
    if (req.url === "/v1/chat/completions") {
      let body = ""
      req.on("data", (d) => (body += d))
      req.on("end", () => {
        let marker = ""
        try {
          const text = JSON.stringify(JSON.parse(body))
          if (text.includes("RETRY_ONCE")) marker = "RETRY_ONCE"
          if (text.includes("FAIL_HARD")) marker = "FAIL_HARD"
        } catch {}
        if (marker === "FAIL_HARD") {
          res.writeHead(500, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: { message: "suite: hard failure injected" } }))
          return
        }
        if (marker === "RETRY_ONCE" && retryOnce.size === 0) {
          // exactly one injected 429 ever: the first marked request
          retryOnce.add(marker)
          res.writeHead(429, { "content-type": "application/json", "retry-after": "1" })
          res.end(JSON.stringify({ error: { message: "suite: rate limited (injected)" } }))
          return
        }
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
      })
      return
    }
    res.writeHead(404)
    res.end("not found")
  })
  return new Promise((resolve) => server.listen(LLM_PORT, "127.0.0.1", () => resolve(server)))
}

// --- wrangler dev ---------------------------------------------------------------

async function startWorker(suiteDir, opts = {}) {
  const port = Number(opts.port) > 0 ? Number(opts.port) : WORKER_PORT
  const url = `http://127.0.0.1:${port}`
  const extraVars = Object.entries(opts.vars ?? {}).flatMap(([k, v]) => ["--var", `${k}:${v}`])
  const attempt = async () => {
    killWranglerSuites(port) // leftover supervisors respawn workerd forever; sweep first
    const assetsDir = join(suiteDir, "assets")
    mkdirSync(assetsDir, { recursive: true })
    writeFileSync(join(assetsDir, "index.html"), "<!doctype html><title>openshare suite stub</title>\n")

    const configPath = join(suiteDir, opts.configSuffix ? `wrangler.suite.${opts.configSuffix}.toml` : "wrangler.suite.toml")
    const original = readFileSync(join(dirname(ROOT), "share-worker", "wrangler.toml"), "utf8")
    const config = original
      .replace('name = "openshare-worker"', 'name = "openshare-worker-suite"')
      .replace('main = "worker.js"', `main = ${JSON.stringify(join(dirname(ROOT), "share-worker", "worker.js").replace(/\\/g, "/"))}`)
      .replace(/directory = "\.\.\/share-viewer\/dist"/, `directory = ${JSON.stringify(assetsDir.replace(/\\/g, "/"))}`)
    writeFileSync(configPath, config)

    const { child, kill } = spawnTree(
      "npx",
      ["wrangler", "dev", "--config", configPath, "--port", String(port), "--ip", "127.0.0.1",
        // isolated local state: two suite workers (e.g. private + public
        // auth modes) sharing the default .wrangler/state are literally
        // the same store — KV + DOs collide across ports (live-caught in
        // S14: the "public" worker answered with the private one's users)
        "--persist-to", join(suiteDir, `wrangler-state-${opts.configSuffix ?? "main"}`),
        "--var", `CREATE_TOKEN:${CREATE_TOKEN}`,
        // suite-tuned server policy: TURN mode forced (wrangler dev runs
        // on workerd, so auto would resolve persistent — the suites
        // simulate the VPS deployment shape), fast turn lifecycle +
        // finalize for S11/S12, low debounce floor so the suites' 300ms
        // cadence survives the server clamp
        "--var", "SOCKET_POLICY:turn",
        "--var", "TURN_GRACE_MS:2000",
        "--var", "FINALIZE_AFTER_MS:4000",
        "--var", "DEBOUNCE_MIN_MS:100",
        ...extraVars],
      { cwd: join(dirname(ROOT), "share-worker") },
    )
    let output = ""
    child.stdout.on("data", (d) => (output += d))
    child.stderr.on("data", (d) => (output += d))
    const fail = async (error) => {
      kill()
      await sleep(1500)
      killPortOwners(port)
      return new Error(`${error.message}\n--- wrangler output ---\n${output.slice(-4000)}`)
    }
    try {
      await waitFor(async () => {
        try {
          return (await httpGet(`${url}/health`)).ok
        } catch {
          return false
        }
      }, "wrangler dev /health", 90000)
    } catch (error) {
      // workerd children sometimes survive the tree-kill and re-bind the
      // port late; one full sweep + fresh retry resolves it
      throw await fail(error)
    }
    return { kill, output: () => output, url, port }
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

/** Resolves when the port can actually be BOUND again. Listener-based
 * checks miss TIME_WAIT sockets: Windows keeps them after a kill, and a
 * spawned `opencode serve --port N` then silently bumps to N+1 instead of
 * failing — which orphans every subsequent probe on N. A real bind probe
 * is the only reliable signal. */
import net from "node:net"
import { cpSync } from "node:fs"
let startServeSeq = 0
// opencode installs the config's provider npm packages into
// XDG_CONFIG_HOME/opencode/node_modules on first instance init — a fresh
// sandbox pays a full npm install (~70s live-measured after the 1.18.31
// update). The first serve warms it once; every later serve copies the
// warmed tree in.
let warmedConfigOpencode = null
function portBindable(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once("error", () => resolve(false))
    srv.once("listening", () => srv.close(() => resolve(true)))
    srv.listen(port, "127.0.0.1")
  })
}
async function waitForPortBindable(port, timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await portBindable(port)) return true
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
      ...(variant.pluginless ? {} : { plugin: [pluginEntry] }),
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
    // fast completed debounce for the suites (S10 overrides this to test
    // the debounce semantics at a realistic delay)
    OPENSHARE_COMPLETED_DELAY_MS: "300",
    ...extra,
  }
}

async function startServe(variant, sandbox, projectDir, extraEnv = {}) {
  killPortOwners(SERVE_PORT)
  const configPath = join(sandbox, "opencode.json")
  writeFileSync(configPath, opencodeConfig(variant, sandbox))
  // hermetic, in three dimensions (all three are required — learned the
  // hard way: XDG_CONFIG_HOME alone still lands test sessions in the
  // machine-wide session DB at the data root, flooding the user's TUI
  // browser with sessions whose dead project configs load zombie plugins):
  //  - XDG_CONFIG_HOME: opencode MERGES the global config's plugins with
  //    OPENCODE_CONFIG — keeps the machine's registrations out
  //  - XDG_DATA_HOME: v1.18 keeps ALL sessions in one SQLite at the data
  //    root — keeps test sessions in the disposable sandbox
  //  - XDG_STATE_HOME: per-serve unique dir. The state home carries the
  //    instance lock (locks/<hash>.lock with heartbeat): a sequentially
  //    restarted serve sees the KILLED predecessor's stale lock as live
  //    and silently binds port+1 — every probe on the pinned port then
  //    times out. Unique state dirs sidestep the stale-lock bump; the
  //    port is additionally bind-probed before each spawn.
  const serveSeq = ++startServeSeq
  mkdirSync(join(sandbox, "xdg"), { recursive: true })
  mkdirSync(join(sandbox, "xdg-data"), { recursive: true })
  if (warmedConfigOpencode) {
    try {
      cpSync(warmedConfigOpencode, join(sandbox, "xdg", "opencode"), { recursive: true })
    } catch {}
  }
  const stateDir = join(sandbox, `xdg-state-${serveSeq}`)
  mkdirSync(stateDir, { recursive: true })
  if (!(await waitForPortBindable(SERVE_PORT, 30000))) {
    throw new Error(`[${variant.name}] port ${SERVE_PORT} not bindable before spawn`)
  }

  const { child, kill } = spawnTree("opencode", ["serve", "--port", String(SERVE_PORT), "--hostname", "127.0.0.1"], {
    cwd: projectDir,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(sandbox, "xdg"),
      XDG_DATA_HOME: join(sandbox, "xdg-data"),
      XDG_STATE_HOME: stateDir,
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
      // /health (NOT /config): 1.18.31 requires the workspace routing
      // query on /config — bare /config stopped answering ok after an
      // opencode auto-update (live-caught: every serve spawn "timed out"
      // while the server was up and fine)
      return (await httpGet(`${base}/health`)).ok
    } catch {
      return false
    }
  }, `[${variant.name}] opencode serve`, 60000).catch(async (error) => {
    kill()
    killPortOwners(SERVE_PORT)
    await waitForPortFree(SERVE_PORT)
    throw new Error(`[${variant.name}] serve failed: ${error.message}\n--- serve output ---\n${output.slice(-4000)}`)
  })
  // warm-up: the FIRST request spins the instance (provider npm install
  // into the fresh config home, ~70s on 1.18.31) — pay it here with a
  // long budget so the tests' normal timeouts stay tight. GET (list):
  // triggers init WITHOUT creating a session the plugin would share
  await httpGet(`${base}/session`, { timeoutMs: 150000 }).catch(() => {})
  if (!warmedConfigOpencode) {
    const warmed = join(sandbox, "xdg", "opencode")
    if (existsSync(join(warmed, "node_modules"))) warmedConfigOpencode = warmed
  }
  return { base, kill, output: () => output, configPath }
}

/** Kills a serve instance and waits for the port to actually free (a
 * half-dead predecessor races its successor's session events). */
async function stopServe(serve) {
  serve.kill()
  await waitForPortBindable(SERVE_PORT, 30000)
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
