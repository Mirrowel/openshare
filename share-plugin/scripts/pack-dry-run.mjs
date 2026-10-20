import { existsSync, unlinkSync } from "node:fs"
import { spawnSync } from "node:child_process"

const npmCli = process.env.npm_execpath
const executable = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm"
const args = npmCli ? [npmCli, "pack", "--dry-run", "--json"] : ["pack", "--dry-run", "--json"]
const result = spawnSync(executable, args, {
  encoding: "utf8",
  shell: false,
})

if (result.stderr) process.stderr.write(result.stderr)
if (result.status !== 0) {
  if (result.stdout) process.stdout.write(result.stdout)
  process.exit(result.status ?? 1)
}

const packs = JSON.parse(result.stdout)
const pack = Array.isArray(packs) ? packs[0] : Object.values(packs)[0]
if (!pack || !Array.isArray(pack.files)) {
  throw new Error("npm pack returned an unsupported JSON result")
}
const files = new Set(pack.files.map((file) => file.path))
const required = [
  "dist/server.js",
  "dist/tui.js",
  "dist/config.js",
  "dist/core.js",
  "dist/v2-server.js",
  "src/tui.tsx",
  "src/config.ts",
  "src/core.ts",
  "ci/openshare.js",
  "openshare.config.json",
  "tsconfig.json",
  "LICENSE",
  "README.md",
]

const missing = required.filter((file) => !files.has(file))
if (missing.length > 0) {
  throw new Error(`Package dry-run is missing required file(s): ${missing.join(", ")}`)
}

const forbidden = [...files].filter(
  (file) => /(\.release\.json|openshare\.local\.json|reference\/|scripts\/|HANDOFF)/.test(file),
)
if (forbidden.length > 0) {
  throw new Error(`Package dry-run must not ship: ${forbidden.join(", ")}`)
}

if (pack.filename && existsSync(pack.filename)) {
  unlinkSync(pack.filename)
}

console.log(`package dry-run passed (${pack.files.length} files, ${pack.filename})`)
