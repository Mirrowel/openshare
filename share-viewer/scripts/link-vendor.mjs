// Link the vendored @opencode packages into node_modules as
// symlinks/junctions instead of bun-managed file: dependency copies.
//
// WHY: bun installs file: dependencies as ISOLATED copies with their own
// nested node_modules, so shared deps (effect, katex, @pierre/diffs) end up
// duplicated between the root tree and the copy's nested tree. Two module
// instances of the same package split identity: a theme registered through
// one @pierre/diffs copy is invisible to the other ("No valid theme loader
// registered"), and effect's Match across two copies throws "exhaustive:
// absurd". Every file-card body dies on such a deploy.
//
// A symlink/junction resolves to the REAL vendor/ path (vite and tsc
// realpath-resolve), every bare import of a shared dep walks up to the
// ROOT node_modules — one instance of everything, always. npm (Docker)
// behaves this way natively; this script gives bun the same layout.
//
// Idempotent; runs as part of `npm run vendor` (after bun install) and
// at the head of `npm run build`.
import { existsSync, lstatSync, rmSync, symlinkSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const NM = join(ROOT, "node_modules", "@opencode")
const LINKS = [
  ["session-ui", "session-ui-v2"],
  ["ui", "ui-v2"],
  ["client", "client-v2"],
  ["util", "util-v2"],
  ["patchmark", "patchmark-v2"],
]

let failures = 0
for (const [name, dir] of LINKS) {
  const target = join(ROOT, "vendor", dir)
  if (!existsSync(target)) continue // patchmark and friends are optional
  const link = join(NM, name)
  try {
    let mustRelink = true
    if (existsSync(link)) {
      const st = lstatSync(link)
      if (st.isSymbolicLink()) {
        mustRelink = false // already a link (junctions report as symlinks)
      } else if (st.isDirectory()) {
        // a bun file:-copy or leftover nested tree — replace with a link
        rmSync(link, { recursive: true, force: true })
      }
    }
    if (mustRelink || !existsSync(link)) {
      symlinkSync(target, link, "junction")
      console.log(`[link-vendor] ${name} -> vendor/${dir}`)
    }
  } catch (e) {
    failures++
    console.error(`[link-vendor] FAILED ${name}: ${e?.message ?? e}`)
  }
}

// guard: a nested duplicate of a SHARED package under a vendored tree
// reintroduces the split-identity bug class — fail loudly instead of
// shipping a two-instance bundle
for (const entry of readdirSync(NM, { withFileTypes: true })) {
  const nested = join(NM, entry.name, "node_modules")
  if (!existsSync(nested)) continue
  const pkgs = readdirSync(nested).filter((p) => p !== ".bin")
  if (pkgs.length > 0) {
    failures++
    console.error(`[link-vendor] nested duplicate packages under @opencode/${entry.name}: ${pkgs.join(", ")} — remove ${nested} and reinstall`)
  }
}
process.exit(failures > 0 ? 1 : 0)
