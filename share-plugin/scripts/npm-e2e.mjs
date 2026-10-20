// ON-DEMAND (never in the default suite): proves the PUBLISHED npm package
// works end to end. `opencode run` resolves the plugin by bare npm spec
// (registry install, not a file:// path), a local wrangler worker receives
// the share, and the run's transcript lands on the worker complete.
// Usage: node scripts/npm-e2e.mjs  (from share-plugin/)
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const lib = await import("./suite-lib.mjs")
const suiteDir = mkdtempSync(join(tmpdir(), "openshare-npm-e2e-"))
const sandbox = join(suiteDir, "sandbox")
const project = join(sandbox, "project")
mkdirSync(project, { recursive: true })
const urlFile = join(sandbox, "share-url.txt")

const watchdog = setTimeout(() => {
  console.error("WATCHDOG: npm-e2e exceeded 8 minutes — aborting")
  process.exit(124)
}, 8 * 60 * 1000)

const worker = await lib.startWorker(suiteDir)
try {
  // config: the plugin referenced ONLY by npm spec — the acceptance path
  // that used to 404 before the package was published
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugin: ["@mirrowel/opencode-openshare"],
    provider: {
      mock: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `http://127.0.0.1:${lib.LLM_PORT}/v1`, apiKey: "mock" },
        models: { "mock-1": { name: "mock-1" } },
      },
    },
  }
  const configPath = join(sandbox, "opencode.json")
  writeFileSync(configPath, JSON.stringify(config, null, 2))

  mkdirSync(join(sandbox, "xdg"), { recursive: true })
  mkdirSync(join(sandbox, "xdg-data"), { recursive: true })
  // warm the provider tree once (first instance init pays an npm install)
  const warm = spawnSync("opencode", ["serve", "--port", "8793", "--hostname", "127.0.0.1"], {
    cwd: project,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(sandbox, "xdg"),
      XDG_DATA_HOME: join(sandbox, "xdg-data"),
      XDG_STATE_HOME: join(sandbox, "xdg-state-warm"),
      OPENCODE_CONFIG: configPath,
    },
    shell: process.platform === "win32",
    stdio: "ignore",
    timeout: 120000,
  })
  if (warm.status !== 0 && warm.status !== null) {
    // serve runs until killed; a timeout kill is the expected outcome
  }
  await lib.startMockLLM()

  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(sandbox, "xdg"),
    XDG_DATA_HOME: join(sandbox, "xdg-data"),
    XDG_STATE_HOME: join(sandbox, "xdg-state"),
    OPENCODE_CONFIG: configPath,
    OPENSHARE_WORKER_URL: `http://127.0.0.1:${lib.WORKER_PORT}`,
    OPENSHARE_CREATE_TOKEN: lib.CREATE_TOKEN,
    OPENSHARE_URL_FILE: urlFile,
    OPENSHARE_SPOOL_DIR: join(sandbox, "spool"),
    OPENSHARE_DEBOUNCE_MS: "300",
    OPENSHARE_COMPLETED_DELAY_MS: "300",
  }
  const run = spawnSync("opencode", ["run", "share me: list three colors"], {
    cwd: project,
    env,
    shell: process.platform === "win32",
    encoding: "utf8",
    timeout: 300000,
  })
  const out = `${run.stdout ?? ""}\n${run.stderr ?? ""}`
  const modeLine = out.split("\n").find((l) => l.includes("share mode"))
  console.log(`mode line: ${modeLine ?? "(none)"}`)

  const url = await lib.waitFor(() => {
    try {
      const text = readFileSync(urlFile, "utf8").trim()
      return text ? text.split("\n").at(-1) : undefined
    } catch {
      return undefined
    }
  }, "urlFile line", 120000)
  const id = url.split("/").pop()
  const body = await lib.waitFor(async () => {
    const r = await fetch(`${worker.url}/api/share/${id}/data`)
    if (!r.ok) return undefined
    const parsed = await r.json()
    const msgs = (parsed.data ?? []).filter((i) => i.type === "message")
    return parsed.status === "completed" && msgs.length >= 2 ? parsed : undefined
  }, "share completed with transcript", 120000)

let exitCode = 0
try {
  const url = await lib.waitFor(() => {
    try {
      const text = readFileSync(urlFile, "utf8").trim()
      return text ? text.split("\n").at(-1) : undefined
    } catch {
      return undefined
    }
  }, "urlFile line", 120000)
  const id = url.split("/").pop()
  const body = await lib.waitFor(async () => {
    const r = await fetch(`${worker.url}/api/share/${id}/data`, { signal: AbortSignal.timeout(8000) })
    if (!r.ok) return undefined
    const parsed = await r.json()
    const msgs = (parsed.data ?? []).filter((i) => i.type === "message")
    return parsed.status === "completed" && msgs.length >= 2 ? parsed : undefined
  }, "share completed with transcript", 120000)

  console.log(`PASS npm-e2e: registry-installed plugin shared end to end`)
  console.log(`  share ${id}: ${body.data.length} items, status=${body.status}`)
  console.log(`  url: ${url}`)
} catch (error) {
  console.error(`FAIL npm-e2e: ${error.message}`)
  console.error(`suite dir kept: ${suiteDir}`)
  exitCode = 1
} finally {
  clearTimeout(watchdog)
  try {
    worker.kill()
  } catch {}
  // hard-kill anything still holding the pipes: a survived wrangler keeps
  // the stdio descriptors open and the parent shell waits forever
  lib.killWranglerSuites(lib.WORKER_PORT)
}
process.exit(exitCode)
