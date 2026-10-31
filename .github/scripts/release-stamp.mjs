#!/usr/bin/env node
// Stamp a release version into the repo: the root VERSION file and every
// package manifest the kit maintains. Used by the release workflow
// (authoritative, after publish) and by `release-kit.sh stage` (optional
// local pre-stamp). Idempotent: writing the same version is a no-op in git
// terms.
//
// VERSION discipline: manifest-carrying repos record the BASE version in
// VERSION (0.3.0, not 0.3.0-dev.7 - the prerelease suffix is an iteration
// of the base, never a base line, and pin comparisons read base-vs-base);
// repos whose VERSION is the sole carrier (no MANIFESTS) record the full
// version there. Manifests always carry the full released version.
//
//   node .github/scripts/release-stamp.mjs <version>
import { execSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repo = execSync("git rev-parse --show-toplevel", { windowsHide: true }).toString().trim()
const version = process.argv[2]
if (!/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/.test(version ?? "")) {
  console.error(`[release-stamp] expected a version, got: ${version}`)
  process.exit(1)
}
const base = version.replace(/(-[a-z0-9.]+)$/, "")

// openshare layout comes from the kit config MANIFESTS list; every kit
// repo (single-package or monorepo) adapts by config alone. An empty
// MANIFESTS makes VERSION the sole carrier (full version recorded there).
const conf = readFileSync(join(repo, ".github/scripts/release-kit.conf"), "utf8")
const manifests = ((conf.match(/^MANIFESTS="([^"]*)"/m)?.[1] ?? "package.json").trim().split(/\s+/)).filter(Boolean)

// two phases: validate and render everything first, then write - a failure
// never leaves a half-stamped tree
const versionFileValue = manifests.length > 0 ? base : version
const writes = [[join(repo, "VERSION"), versionFileValue + "\n"]]
for (const rel of manifests) {
  const file = join(repo, rel)
  try {
    let raw = readFileSync(file, "utf8")
    const eol = raw.includes("\r\n") ? "\r\n" : "\n"
    raw = raw.replace(/\r\n/g, "\n")
    const pkg = JSON.parse(raw)
    if (pkg.version === version) continue
    pkg.version = version
    // keep each file's own line endings so a stamp never dirties the worktree
    writes.push([file, (JSON.stringify(pkg, null, 2) + "\n").replace(/\n/g, eol)])
  } catch {
    console.error(`[release-stamp] cannot stamp ${rel}`)
    process.exit(1)
  }
}
for (const [file, body] of writes) writeFileSync(file, body, "utf8")
console.log(`[release-stamp] VERSION${manifests.length > 0 ? ` (base ${versionFileValue})` : ` (${versionFileValue})`} + ${manifests.length} manifests -> ${version}`)
