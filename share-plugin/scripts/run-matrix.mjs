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
// no args = the full matrix.
//
// Quick-gate backend swap: the curated run is the LOCAL DEV LOOP, so
// auth-tests rides the portable Bun server there (boots in ~2s, no
// wrangler). The full matrix keeps wrangler - the production runtime -
// so workerd/KV/DO parity is checked before every push.
const QUICK_ENV = { "auth-tests": { OPENSHARE_BACKEND: "bun" } }
const active = requested.length
  ? [waves.flatMap((w) => w).filter((s) => requested.includes(s.name)).map((s) => ({ ...s, env: { ...s.env, ...(QUICK_ENV[s.name] ?? {}) } }))]
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
  // machine (suites spawn workers + opencode serves; everything then
  // inflates 20-60% and the wall grows). Suites run longest-first through
  // a fixed-size window; 4 measured fastest (6 thrashes, 2-3 stretches
  // into more sequential batches).
  const costs = {
    "manual-allmode": 110,
    "fanout-tests": 105,
    "manual-core": 60,
    "auth-tests": 60,
    "enroll-a": 55,
    "enroll-b": 55,
    "enroll-public": 53,
    "regression-tests": 50,
    "tui-flow-tests": 45,
    "manual-engine1": 25,
    "manual-engine2": 20,
    "big-tests": 18,
    "v2-mock-tests": 14,
  }
  const queue = active.flat().sort((a, b) => (costs[b.name] ?? 30) - (costs[a.name] ?? 30))
  const limit = Math.max(1, Number(process.env.OPENSHARE_MATRIX_CONCURRENCY) || 4)
  const running = new Set()
  const tWave = performance.now()
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
  const totalS = (performance.now() - t0) / 1000
  const waveS = (performance.now() - tWave) / 1000
  console.log(`[matrix] wave ${waveS.toFixed(1)}s (all suites) · total ${totalS.toFixed(1)}s (incl. warm-up)`)
  // Wall-clock budget on the WAVE span (pre-warm and worker boot are
  // environment noise, not suite cost): every test is a perpetual tax, so
  // growth must pay for itself by deleting/merging time elsewhere. The
  // full-matrix number is load-sensitive (same config spans 186-223s
  // depending on ambient machine load) - treat a budget hit as "measure
  // again on a quiet box" before trimming. OSH_MATRIX_BUDGET_S overrides
  // (0 disables) for one-off diagnostics.
  const budget = Number(process.env.OSH_MATRIX_BUDGET_S ?? (requested.length ? 80 : 200))
  if (budget > 0 && waveS > budget) {
    console.error(`[matrix] BUDGET EXCEEDED: wave ${waveS.toFixed(1)}s > ${budget}s budget - trim suites or move coverage to on-demand runs`)
    process.exitCode = 1
  }
  process.exitCode = failed ? 1 : process.exitCode
} finally {
  if (worker?.kill) worker.kill()
  await new Promise((resolve) => setTimeout(resolve, 300))
}
