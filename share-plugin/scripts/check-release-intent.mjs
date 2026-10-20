#!/usr/bin/env node
import { isStableVersion, parseVersion, readJson } from "./release-lib.mjs"

const fail = (message) => {
  console.error(message)
  process.exit(1)
}

const intent = readJson(".release.json")
if (!intent.next || typeof intent.next !== "string") fail('.release.json must contain a string "next" version.')

try {
  parseVersion(intent.next)
  if (!isStableVersion(intent.next)) fail(".release.json next must be a stable version without prerelease suffix.")
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}

const pkg = readJson("package.json")
if (pkg.version !== intent.next) fail(`package.json version (${pkg.version}) must match .release.json next (${intent.next}).`)

const lock = readJson("package-lock.json")
if (lock.version !== intent.next) fail(`package-lock.json version (${lock.version}) must match .release.json next (${intent.next}).`)
if (lock.packages?.[""]?.version !== intent.next) {
  fail(`package-lock root package version (${lock.packages?.[""]?.version}) must match .release.json next (${intent.next}).`)
}

console.log(`Release intent is consistent at ${intent.next}`)
