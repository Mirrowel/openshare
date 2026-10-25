// Vendor solid-js with the cleanNode double-clean hardening.
//
// WHY: Solid's cleanNode walks node.owned / node.cleanups with live loops:
//   for (i = node.owned.length - 1; ...) cleanNode(node.owned[i]);
//   for (i = node.cleanups.length - 1; ...) node.cleanups[i]();
// A re-entrant disposal (a cleanup that disposes an owner higher in the
// same walk - legitimate in our graph: manually-disposed row roots inside
// reactive effects) NULLS those arrays mid-loop and the next iteration
// reads null[i] -> "Cannot read properties of null (reading 'N')" which
// aborts the whole reactive flush. Live-caught 2026-10-24: every data tick
// died inside updateComputation->cleanNode, leaving the page half-updated
// (status badge stuck at its initial value, tool rows dead to clicks)
// while tick() silently swallowed the throw.
//
// The fix snapshots the arrays before iterating (6 lines, behavior-
// identical for every non-reentrant walk). Upstream issue material:
// re-entrant disposal is legal Solid usage; the unguarded loops are not.
//
// TWO patched variants are written:
//   vendor/solid/solid.js — from dist/solid.js (the build variant)
//   vendor/solid/dev.js   — from dist/dev.js (the dev-server variant:
//                           unminified, dev warnings, readable stack traces)
// vite.config.ts picks by command (serve -> dev.js, build -> solid.js) so
// node_modules stays pristine in both.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = join(ROOT, "vendor", "solid")

const fail = (what) => {
  throw new Error(`vendor-solid: ${what} anchor missing - solid-js version drifted`)
}

function patch(source, label) {
  const nl = source.includes("\r\n") ? "\r\n" : "\n"
  let s = source
  if (!s.includes("openshare hardening: re-entrant disposal")) {
    const A = [
      "  if (node.cleanups) {",
      "    for (i = node.cleanups.length - 1; i >= 0; i--) node.cleanups[i]();",
      "    node.cleanups = null;",
    ].join(nl)
    const B = [
      "  if (node.cleanups) {",
      "    // openshare hardening: re-entrant disposal may null this array mid-loop",
      "    const cleanups = node.cleanups;",
      "    for (i = cleanups.length - 1; i >= 0; i--) cleanups[i]();",
      "    node.cleanups = null;",
    ].join(nl)
    if (!s.includes(A)) fail(`cleanups loop (${label})`)
    s = s.replace(A, B)

    const C = [
      "  } else if (node.owned) {",
      "    for (i = node.owned.length - 1; i >= 0; i--) cleanNode(node.owned[i]);",
      "    node.owned = null;",
    ].join(nl)
    const D = [
      "  } else if (node.owned) {",
      "    // openshare hardening: re-entrant disposal may null this array mid-loop",
      "    const owned = node.owned;",
      "    for (i = owned.length - 1; i >= 0; i--) cleanNode(owned[i]);",
      "    node.owned = null;",
    ].join(nl)
    if (!s.includes(C)) fail(`owned loop (${label})`)
    s = s.replace(C, D)
  }
  return s
}

mkdirSync(OUT_DIR, { recursive: true })

const build = patch(readFileSync(join(ROOT, "node_modules", "solid-js", "dist", "solid.js"), "utf8"), "solid.js")
writeFileSync(join(OUT_DIR, "solid.js"), build)
console.log("vendor/solid/solid.js written", build.length, "bytes")

const dev = patch(readFileSync(join(ROOT, "node_modules", "solid-js", "dist", "dev.js"), "utf8"), "dev.js")
writeFileSync(join(OUT_DIR, "dev.js"), dev)
console.log("vendor/solid/dev.js written", dev.length, "bytes")

writeFileSync(
  join(OUT_DIR, "SOLID-SOURCE.txt"),
  `patched from node_modules/solid-js/dist/{solid,dev}.js
fix: cleanNode snapshot loops (re-entrant disposal nulls owned/cleanups mid-walk)
see scripts/vendor-solid.mjs
`,
)
