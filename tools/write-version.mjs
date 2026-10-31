#!/usr/bin/env node
// Writes <target>/version.json from git so every deploy/build embeds the
// release it was cut from. Source of truth is the release tags (created by
// the Release workflow); the repo carries no committed version number.
//
//   node tools/write-version.mjs share-worker
//
// Fields: version = nearest release tag ("v0.2.1"), rev = short sha,
// full = exact `git describe` ("v0.2.1-59-gb82360b", "-dirty" when the
// tree has local changes). Falls back to "dev" outside a git checkout so
// raw builds never fail on this.
import { execSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const target = process.argv[2]
if (!target) {
  console.error("usage: node tools/write-version.mjs <target-dir>")
  process.exit(1)
}
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function git(args) {
  return execSync(`git ${args}`, { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim()
}

let version = "dev"
let rev = ""
let full = "dev"
try {
  full = git("describe --tags --always --dirty")
  version = full.replace(/-\d+-g[0-9a-f]+(-dirty)?$/, "")
  rev = git("rev-parse --short HEAD")
} catch {
  // no git (or no tags) — keep the dev fallback
}

const out = join(repoRoot, target, "version.json")
writeFileSync(out, JSON.stringify({ version, rev, full }, null, 2) + "\n", "utf8")
console.log(`[write-version] ${target}/version.json -> ${full}`)
