#!/usr/bin/env node
// Designate the next release version. Writes the repo-root VERSION file
// (pin semantics in compute-version.sh: strictly higher than the latest
// stable tag pins the next release exactly; equal or lower is inert).
//
//   node .github/scripts/next-version.mjs 1.2.3   exact designation
//   node .github/scripts/next-version.mjs minor   bump word, derives the
//                                                 number from the latest
//                                                 stable tag
import { execSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const repo = execSync("git rev-parse --show-toplevel", { windowsHide: true }).toString().trim()
const arg = process.argv[2]

function latestStable() {
  const tags = execSync('git tag --list "v[0-9]*.[0-9]*.[0-9]*"', { encoding: "utf8", windowsHide: true })
    .split("\n")
    .map((t) => t.replace(/^v/, ""))
    .filter((t) => /^\d+\.\d+\.\d+$/.test(t))
  // semver compare (numeric per segment), not string sort
  tags.sort((a, b) => {
    const [a1, a2, a3] = a.split(".").map(Number)
    const [b1, b2, b3] = b.split(".").map(Number)
    return b1 - a1 || b2 - a2 || b3 - a3
  })
  return tags[0]
}

let version = arg
if (arg === "major" || arg === "minor" || arg === "patch") {
  const base = latestStable()
  if (!base) {
    console.error("[next-version] no stable tag found - pass an explicit version")
    process.exit(1)
  }
  const [x, y, z] = base.split(".").map(Number)
  version = arg === "major" ? `${x + 1}.0.0` : arg === "minor" ? `${x}.${y + 1}.0` : `${x}.${y}.${z + 1}`
}
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error(`[next-version] expected a version or bump word (major|minor|patch), got: ${arg}`)
  process.exit(1)
}

const latest = latestStable()
if (latest) {
  const [vx, vy, vz] = version.split(".").map(Number)
  const [lx, ly, lz] = latest.split(".").map(Number)
  if (vx < lx || (vx === lx && (vy < ly || (vy === ly && vz <= lz)))) {
    console.error(`[next-version] WARNING: ${version} is not higher than the latest stable ${latest} - this VERSION is inert (auto-computing stays in effect)`)
  }
}

writeFileSync(join(repo, "VERSION"), version + "\n", "utf8")
console.log(`[next-version] VERSION -> ${version}${latest ? ` (latest stable tag: ${latest})` : ""}`)
