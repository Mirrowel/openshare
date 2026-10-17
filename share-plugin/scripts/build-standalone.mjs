// Bundles the server plugin into the single-file `ci/openshare.js`. The
// standalone is the CI artifact: dependency-free, same behavior as
// dist/server.js (same code, one file), config file resolved next to it
// (ci/openshare.config.json). Kept OUT of the package root on purpose: a
// directory plugin spec (`file:///…/share-plugin`) must only ever resolve
// the package. `WebSocket` and `fetch` are Node >= 22 globals.

import { build } from "bun"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url))

const banner = readFileSync(here("../src/banner.txt"), "utf8")

const result = await build({
  entrypoints: [here("../src/server.ts")],
  target: "node",
  format: "esm",
  outdir: here("../.standalone-out"),
  minify: false,
})

if (!result.success) {
  console.error("[build-standalone] bundle failed", result.logs)
  process.exit(1)
}

const body = readFileSync(here("../.standalone-out/server.js"), "utf8")
const target = here("../ci/openshare.js")
writeFileSync(target, banner + body, "utf8")
rmSync(here("../.standalone-out"), { recursive: true, force: true })
console.log(`[build-standalone] wrote ${target} (${body.length} bytes + banner)`)
