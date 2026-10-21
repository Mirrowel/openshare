// Matrix driver — fast by construction:
//  - ONE long-lived wrangler worker shared by the reuse-eligible suites
//    (regression / manual / tui-flow / v2) via OPENSHARE_TEST_WORKER_URL
//  - suites run in two PARALLEL waves with disjoint port ranges (suite-lib
//    reads OPENSHARE_*_PORT), so wall-clock = slowest suite, not the sum
//  - auth + enroll + fanout keep their own workers (they assert global
//    user/token counts or need two isolated backends) on their own ports
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
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
const waves = [
  // wave 1 — the heavy engine suites, concurrently (manual is three
  // parallel shards; wall = slowest shard, not the serial sum)
  [
    manualShard("core", 8970),
    manualShard("allmode", 8930),
    manualShard("engine", 8950),
    suite("enroll-tests", 8810, false),
    suite("fanout-tests", 8830, false),
  ],
  // wave 2 — auth + parity + TUI + v2 + big-session
  [suite("auth-tests", 8850, false), suite("regression-tests", 8870, true), suite("tui-flow-tests", 8890, true), suite("v2-mock-tests", 8910, true), suite("big-tests", 8930, true)],
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
    const child = spawn(process.execPath, [join("scripts", `${s.name.startsWith("manual-") ? "manual-tests" : s.name}.mjs`)], {
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
  for (const wave of active) {
    const results = await Promise.all(wave.map(runSuite))
    for (const result of results) {
      timings.push(result)
      if (result.code !== 0 && !failed) failed = result
    }
    if (failed) break
  }
  console.log("\n[matrix] suite timings:")
  for (const t of timings) console.log(`  ${t.name}: ${t.seconds}s (${t.code === 0 ? "ok" : "FAILED"})`)
  console.log(`[matrix] total ${((performance.now() - t0) / 1000).toFixed(1)}s`)
  process.exitCode = failed ? 1 : 0
} finally {
  if (worker?.kill) worker.kill()
  await new Promise((resolve) => setTimeout(resolve, 300))
}
