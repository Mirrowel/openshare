// Matrix driver — fast by construction:
//  - ONE long-lived wrangler worker shared by the reuse-eligible suites
//    (regression / manual / tui-flow / v2) via OPENSHARE_TEST_WORKER_URL
//  - suites run in two PARALLEL waves with disjoint port ranges (suite-lib
//    reads OPENSHARE_*_PORT), so wall-clock = slowest suite, not the sum
//  - auth + enroll + fanout keep their own workers (they assert global
//    user/token counts or need two isolated backends) on their own ports
import { mkdtempSync, mkdirSync, cpSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, execFileSync } from "node:child_process"
import { performance } from "node:perf_hooks"

// Port bases 20 apart; within a suite: worker(+0), serve(+4), llm(+6),
// second worker (+10) — all derived from the suite-lib constants.
const suite = (name, base, reuse, extraEnv = {}) => ({
  name,
  reuse,
  env: {
    OPENSHARE_WORKER_PORT: String(base),
    OPENSHARE_SERVE_PORT: String(base + 4),
    OPENSHARE_LLM_PORT: String(base + 6),
    ...extraEnv,
  },
})

const SHARED = 8789 // the shared matrix worker's port
const manualShard = (shard, base) => suite(`manual-${shard}`, base, false, { OPENSHARE_MANUAL_SHARD: shard })
const enrollShard = (shard, base) => suite(`enroll-${shard}`, base, false, { OPENSHARE_ENROLL_SHARD: shard })
// Every suite in ONE wave: each owns a disjoint port block, so the wall
// clock is the slowest single suite instead of the sum of two halves.
// big-tests keeps its OWN worker on its own ports (3000-item syncs would
// monopolize the shared isolate and stall the reuse suites' handshakes).
const waves = [
  [
    manualShard("core", 8970),
    manualShard("allmode", 8930),
    manualShard("engine1", 8950),
    manualShard("engine2", 9010),
    enrollShard("a", 8810),
    enrollShard("b", 9030),
    enrollShard("public", 9070),
    suite("fanout-tests", 8830, false),
    suite("auth-tests", 8850, false),
    suite("regression-tests", 9110, true),
    suite("tui-flow-tests", 8890, true),
    suite("v2-mock-tests", 8910, true),
    suite("big-tests", 8990, false),
  ],
]

const requested = process.argv.slice(2)
// Explicit args = a curated one-wave run (npm run test:quick uses this);
// no args = the full two-wave matrix.
const active = requested.length
  ? [waves.flatMap((w) => w).filter((s) => requested.includes(s.name))]
  : waves
const needsShared = active.some((w) => w.some((s) => s.reuse))

const lib = await import("./suite-lib.mjs")
const sandbox = mkdtempSync(join(tmpdir(), "openshare-matrix-"))
let worker = null
const t0 = performance.now()

const runSuite = (s) =>
  new Promise((resolve) => {
    const start = performance.now()
    const file = s.name.startsWith("manual-") ? "manual-tests" : s.name.startsWith("enroll-") ? "enroll-tests" : s.name
    const child = spawn(process.execPath, [join("scripts", `${file}.mjs`)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...s.env },
    })
    child.stdout.on("data", (d) => process.stdout.write(`[${s.name}] ${d}`))
    child.stderr.on("data", (d) => process.stderr.write(`[${s.name}] ${d}`))
    child.on("close", (code) => {
      const seconds = ((performance.now() - start) / 1000).toFixed(1)
      console.log(`[matrix] ${s.name} ${code === 0 ? "ok" : "FAILED"} (${seconds}s)`)
      resolve({ name: s.name, seconds, code })
    })
  })

try {
  // Provider-config pre-warm: opencode installs the config's provider npm
  // package into XDG_CONFIG_HOME/opencode/node_modules on the first
  // instance init. Paid per SUITE PROCESS it means ten parallel npm
  // installs; paid once per opencode version it is a directory copy.
  // Cache key = `opencode --version`; stale caches fall away on update.
  let warmedConfig
  try {
    const version = execFileSync("opencode", ["--version"], { encoding: "utf8", timeout: 30000 }).trim().replace(/[^\w.-]/g, "")
    const cacheDir = join(tmpdir(), "opencode", "osh-provider-cache", version)
    if (!existsSync(join(cacheDir, "node_modules"))) {
      const warmDir = join(tmpdir(), "opencode", "osh-warm")
      if (warmDir.startsWith(tmpdir()) && existsSync(warmDir)) rmSync(warmDir, { recursive: true, force: true })
      mkdirSync(warmDir, { recursive: true })
      const warm = await lib.startServe({ name: "warm", path: "", pluginless: true }, warmDir, warmDir, {})
      await lib.stopServe(warm)
      mkdirSync(join(tmpdir(), "opencode", "osh-provider-cache"), { recursive: true })
      cpSync(join(warmDir, "xdg", "opencode"), cacheDir, { recursive: true })
    }
    warmedConfig = cacheDir
    console.log(`[matrix] provider cache: ${cacheDir}`)
  } catch (e) {
    console.log(`[matrix] provider pre-warm skipped: ${e.message}`)
  }
  if (needsShared) {
    worker = await lib.startWorker(sandbox, { port: SHARED })
    for (const w of active) {
      for (const s of w) {
        if (s.reuse) {
          s.env.OPENSHARE_TEST_WORKER_URL = worker.url
          s.env.OPENSHARE_WORKER_PORT = String(SHARED)
        }
      }
    }
  }
  let failed = null
  const timings = []
  // Bounded scheduler: launching every suite at once oversubscribes the
  // machine (13 suites spawn ~40 processes; serves then time out and the
  // wall grows). Suites run longest-first through a fixed-size window.
  const costs = {
    "manual-core": 55,
    "manual-allmode": 60,
    "manual-engine1": 30,
    "manual-engine2": 30,
    "enroll-a": 35,
    "enroll-b": 45,
    "enroll-public": 35,
    "fanout-tests": 55,
    "auth-tests": 50,
    "regression-tests": 35,
    "tui-flow-tests": 45,
    "v2-mock-tests": 14,
    "big-tests": 30,
  }
  const queue = active.flat().sort((a, b) => (costs[b.name] ?? 30) - (costs[a.name] ?? 30))
  const limit = Math.max(1, Number(process.env.OPENSHARE_MATRIX_CONCURRENCY) || 6)
  const running = new Set()
  await new Promise((resolve) => {
    const pump = () => {
      if (failed || !queue.length) {
        if (!running.size) resolve()
        return
      }
      while (!failed && running.size < limit && queue.length) {
        const s = queue.shift()
        const env = warmedConfig ? { ...s.env, OPENSHARE_WARMED_CONFIG: warmedConfig } : s.env
        const task = runSuite({ ...s, env }).then((result) => {
          running.delete(task)
          timings.push(result)
          if (result.code !== 0 && !failed) failed = result
          pump()
        })
        running.add(task)
      }
    }
    pump()
  })
  console.log("\n[matrix] suite timings:")
  for (const t of timings) console.log(`  ${t.name}: ${t.seconds}s (${t.code === 0 ? "ok" : "FAILED"})`)
  console.log(`[matrix] total ${((performance.now() - t0) / 1000).toFixed(1)}s`)
  process.exitCode = failed ? 1 : 0
} finally {
  if (worker?.kill) worker.kill()
  await new Promise((resolve) => setTimeout(resolve, 300))
}
