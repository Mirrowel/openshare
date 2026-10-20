#!/usr/bin/env node
import { bumpVersion, isStableVersion, parseVersion, readJson, updatePackageVersion, writeJson } from "./release-lib.mjs"

const input = process.argv[2]
if (!input) {
  console.error("Usage: npm run release:intent -- <version|patch|minor|major>")
  process.exit(1)
}

const current = readJson("package.json").version
const next = ["patch", "minor", "major"].includes(input) ? bumpVersion(current, input) : input

try {
  parseVersion(next)
  if (!isStableVersion(next)) throw new Error("Release intent must be a stable version without prerelease suffix.")
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

writeJson(".release.json", { next })
updatePackageVersion(next)
console.log(`Release intent set to ${next}`)
