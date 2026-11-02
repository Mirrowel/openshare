// Matrix driver — fast by construction:
//  - ONE long-lived wrangler worker shared by the reuse-eligible suites
//    (regression / manual / tui-flow / v2) via OPENSHARE_TEST_WORKER_URL
//  - suites run in two PARALLEL waves with disjoint port ranges (suite-lib
//    reads OPENSHARE_*_PORT), so wall-clock = slowest suite, not the sum
//  - auth + enroll + fanout keep their own workers (they assert global
//    user/token counts or need two isolated backends) on their own ports
import { mkdtempSync, mkdirSync, cpSync, existsSync, rmSync } from "node:fs"
import net from "node:net"
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
// manual shards REUSE the shared worker (plain startWorker, no vars):
// nothing in them purges or asserts global state, and each drops a
// ~10s wrangler boot. tui-flow is NOT reuse (its purge empties the
// backend) - see its own worker boot.
const manualShard = (shard, base) => suite(`manual-${shard}`, base, true, { OPENSHARE_MANUAL_SHARD: shard })
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
    // NOT reuse: this suite purges the whole backend, so it runs on its
    // own worker (the matrix reuse env would otherwise point it - and its
    // port sweep - at the shared 8789 instance, killing it for everyone)
    suite("tui-flow-tests", 8890, false),
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

// CI runners can hold arbitrary localhost ports (the first hosted-runner
// run met a service on 8789 and the shared worker died on EADDRINUSE).
// Probe the planned block and slide the WHOLE scheme until it is free -
// every port reaches the suites through env, so one offset covers all.
const portFree = (port) =>
  new Promise((resolveFree) => {
    const probe = net.createServer()
    probe.once("error", () => resolveFree(false))
    probe.once("listening", () => probe.close(() => resolveFree(true)))
    probe.listen(port, "127.0.0.1")
  })
const plannedPorts = (offset) =>
  active.flat().flatMap((s) => [Number(s.env.OPENSHARE_WORKER_PORT), Number(s.env.OPENSHARE_SERVE_PORT), Number(s.env.OPENSHARE_LLM_PORT)]).concat(SHARED).map((p) => p + offset)
let offset = 0
while (!(await Promise.all(plannedPorts(offset).map(portFree))).every(Boolean) && offset < 2000) offset += 400
if (offset) {
  console.log(`[matrix] planned port block busy; sliding everything by ${offset}`)
  for (const w of active) for (const s of w) {
    s.env.OPENSHARE_WORKER_PORT = String(Number(s.env.OPENSHARE_WORKER_PORT) + offset)
    s.env.OPENSHARE_SERVE_PORT = String(Number(s.env.OPENSHARE_SERVE_PORT) + offset)
    s.env.OPENSHARE_LLM_PORT = String(Number(s.env.OPENSHARE_LLM_PORT) + offset)
  }
}
const sharedPort = SHARED + offset

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
    // the runner's own bind is the only oracle for a busy port (probes
    // can disagree with workerd's socket options), so a failed BIND
    // slides the shared worker and retries on the next block. Any other
    // failure (workerd cannot start on this machine) aborts immediately
    // with the full wrangler output - sliding cannot help it
    for (let tries = 0; tries < 4 && !worker; tries++) {
      const tryPort = sharedPort + tries * 40
      try {
        worker = await lib.startWorker(sandbox, { port: tryPort })
      } catch (error) {
        if (!/could not bind/.test(String(error.message))) {
          console.error(`[matrix] shared worker boot failed on ${tryPort} (not a port conflict; aborting):`)
          console.error(error)
          throw error
        }
        console.log(`[matrix] shared worker boot failed on ${tryPort}: bind conflict, sliding`)
      }
    }
    if (!worker) throw new Error("shared worker boot failed on every port block")
    for (const w of active) {
      for (const s of w) {
        if (s.reuse) {
          s.env.OPENSHARE_TEST_WORKER_URL = worker.url
          s.env.OPENSHARE_WORKER_PORT = String(worker.port)
        }
      }
    }
  }
  let failed = null
  const timings = []
  // Bounded scheduler: launching every suite at once oversubscribes the
  // machine. Suites run longest-first through a fixed-size window; 6
  // measured fastest on the 12-logical-core box (4 serialized the queue
  // tail, 13 thrashed) once the manual shards stopped booting their own
  // workers and the enroll teardown stopped killing a foreign port.
  const costs = {
    "manual-allmode": 70,
    "fanout-tests": 70,
    "manual-core": 60,
    "auth-tests": 60,
    "enroll-b": 75,
    "enroll-a": 60,
    "enroll-public": 50,
    "regression-tests": 50,
    "tui-flow-tests": 55,
    "manual-engine1": 10,
    "manual-engine2": 9,
    "big-tests": 18,
    "v2-mock-tests": 35,
  }
  const queue = active.flat().sort((a, b) => (costs[b.name] ?? 30) - (costs[a.name] ?? 30))
  const limit = Math.max(1, Number(process.env.OPENSHARE_MATRIX_CONCURRENCY) || 6)
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
  // budgets sit above observed run-to-run variance so a hit means a real
  // regression, not a busy box: typical waves are ~55-75s quick /
  // ~130-160s full (real-host suites inflate ~1.5-2x in-wave vs solo).
  // OSH_MATRIX_BUDGET_S overrides (0 disables) for one-off diagnostics.
  const budget = Number(process.env.OSH_MATRIX_BUDGET_S ?? (requested.length ? 90 : 165))
  if (budget > 0 && waveS > budget) {
    console.error(`[matrix] BUDGET EXCEEDED: wave ${waveS.toFixed(1)}s > ${budget}s budget - trim suites or move coverage to on-demand runs`)
    process.exitCode = 1
  }
  process.exitCode = failed ? 1 : process.exitCode
} finally {
  if (worker?.kill) worker.kill()
  await new Promise((resolve) => setTimeout(resolve, 300))
}
