// Bounded workerd sanity boot for CI: proves wrangler dev can actually
// start on this runner before the matrix spends minutes on it. Fails with
// the full wrangler output tail (the stall-at-"Starting local server"
// class prints its real cause only inside workerd's stderr).
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const port = Number(process.argv[2]) || 9189
const lib = await import("./suite-lib.mjs")
const dir = mkdtempSync(join(tmpdir(), "openshare-ci-smoke-"))
try {
  const worker = await lib.startWorker(dir, { port })
  const health = await lib.httpGet(`${worker.url}/health`)
  console.log(`[ci-smoke] worker up on ${worker.url} (/health ${health.status})`)
  await worker.kill()
} catch (error) {
  console.error(`[ci-smoke] workerd/wrangler failed to boot on this runner:`)
  console.error(error)
  process.exitCode = 1
}
// kill() on Linux reaps only the npx wrapper; orphaned esbuild/workerd
// grandchildren keep the stdio pipes open and the event loop never drains,
// so the step hangs to its timeout. Exit hard.
setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref()
