// Build the `master` viewer beside the current one so both can be compared
// on the same share from the same worker.
//
//   node scripts/build-legacy.mjs            (uses ../.legacy-master worktree)
//   OPENSHARE_LEGACY_SRC=<path> node ...     (use an existing checkout)
//
// Output: dist/legacy.html + the legacy bundle's hashed assets copied into
// dist/assets (hashes cannot collide with the current build). The worker
// serves legacy.html for page requests carrying ?legacy (sticky cookie).
// Temporary comparison tooling: delete dist/legacy.html and the copied
// assets, or simply rebuild dist, to remove it.
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = fileURLToPath(new URL("..", import.meta.url))
const dist = join(here, "dist")
const worktree = process.env.OPENSHARE_LEGACY_SRC || resolve(here, "..", "..", ".legacy-master")

if (!existsSync(join(worktree, "share-viewer", "package.json"))) {
  console.error(`build-legacy: no master checkout at ${worktree}`)
  console.error("  git worktree add .legacy-master master")
  process.exit(1)
}

const legacyViewer = join(worktree, "share-viewer")
console.log(`build-legacy: building ${legacyViewer}`)
if (!existsSync(join(legacyViewer, "node_modules"))) {
  execFileSync("bun", ["install"], { cwd: legacyViewer, stdio: "inherit", shell: true })
}
execFileSync("npm", ["run", "build"], { cwd: legacyViewer, stdio: "inherit", shell: true })

const legacyDist = join(legacyViewer, "dist")
const assets = join(dist, "assets")
mkdirSync(assets, { recursive: true })

// hashed names only: both builds emit index-<hash>.js/css and friends
let copied = 0
for (const file of readdirSync(join(legacyDist, "assets"))) {
  copyFileSync(join(legacyDist, "assets", file), join(assets, file))
  copied++
}

// the index must not carry og: tags or branding - served verbatim
writeFileSync(join(dist, "legacy.html"), readFileSync(join(legacyDist, "index.html")))
console.log(`build-legacy: dist/legacy.html + ${copied} assets`)
