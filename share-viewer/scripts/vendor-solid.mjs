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
// The patched copy is wired through vite.config.ts resolve.alias
// ("solid-js" -> vendor/solid/solid.js) so node_modules stays pristine.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = join(ROOT, "node_modules", "solid-js", "dist", "solid.js")
const OUT_DIR = join(ROOT, "vendor", "solid")
const OUT = join(OUT_DIR, "solid.js")

let s = readFileSync(SRC, "utf8")
const nl = s.includes("\r\n") ? "\r\n" : "\n"

const fail = (what) => {
  throw new Error(`vendor-solid: ${what} anchor missing - solid-js version drifted`)
}

// already patched? (idempotent)
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
  if (!s.includes(A)) fail("cleanups loop")
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
  if (!s.includes(C)) fail("owned loop")
  s = s.replace(C, D)
}

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT, s)
writeFileSync(
  join(OUT_DIR, "SOLID-SOURCE.txt"),
  `patched from node_modules/solid-js/dist/solid.js\nfix: cleanNode snapshot loops (re-entrant disposal nulls owned/cleanups mid-walk)\nsee scripts/vendor-solid.mjs\n`,
)
console.log("vendor/solid/solid.js written", s.length, "bytes")
