#!/usr/bin/env node
// kit:check - verify the release-kit files stay in sync across the family
// (openshare is canonical). Two invariants:
//   1. universal files byte-identical everywhere (listed in IDENTICAL)
//   2. each repo's workflow paths: trigger equals its conf RELEASE_PATHS
// Repo-adapted files (compute-version.sh, release-kit.conf, release.yml)
// differ by design; the path sync covers their shared contract.
//
//   node tools/kit-check.mjs [repo-dir ...]
import { readFileSync } from "node:fs"
import { join } from "node:path"

const OSH = "C:\\Projects\\OC Plugins\\openshare"
const DEFAULTS = [
  "C:\\Projects\\OC Plugins\\agent-variants",
  "C:\\Projects\\OC Plugins\\subagent-explorer",
  "C:\\Projects\\OC Plugins\\opencode-config-studio",
]
const repos = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS

// files that must match byte-for-byte everywhere
const IDENTICAL = [
  ".github/scripts/generate-release-notes.sh",
  ".github/scripts/release-stamp.mjs",
  ".github/scripts/release-kit.sh",
  ".github/scripts/kit-lib.sh",
  ".github/scripts/npm-changed.sh",
  ".github/workflows/cleanup-releases.yml",
]

// files the kit no longer ships (local stamping is retired; CI write-back
// and the release-kit.sh levers replace them)
const MUST_NOT_EXIST = [
  ".github/scripts/hook-pre-push.mjs",
  ".github/scripts/install-hooks.mjs",
  ".github/scripts/next-version.mjs",
  ".github/scripts/kit-paths.sh",
  ".githooks/pre-push",
]

// parse `KEY="a b c"` from a release-kit.conf
function confList(conf, key) {
  const m = conf.match(new RegExp(`^${key}="([^"]*)"`, "m"))
  return m ? m[1].split(/\s+/).filter(Boolean) : null
}

// parse the workflow's push `paths:` entries (indented dashes after paths:)
function workflowPaths(wf) {
  const m = wf.match(/^\s{4}paths:\n((?:\s+- .+\n?)+)/m)
  if (!m) return null
  return m[1].split("\n").filter((l) => /^\s+- /.test(l)).map((l) => l.replace(/^\s+- /, "").trim())
}

function checkPathSync(label, repo) {
  const conf = readFileSync(join(repo, ".github/scripts/release-kit.conf"), "utf8")
  const wf = readFileSync(join(repo, ".github/workflows/release.yml"), "utf8")
  const declared = confList(conf, "RELEASE_PATHS")
  const trigger = workflowPaths(wf)
  if (!declared || !trigger) {
    console.log(`DRIFT ${label}: RELEASE_PATHS or workflow paths: block unreadable`)
    return 1
  }
  const a = [...declared].sort().join("\n")
  const b = [...trigger].sort().join("\n")
  if (a !== b) {
    console.log(`DRIFT ${label}: workflow paths trigger != conf RELEASE_PATHS`)
    for (const p of declared.filter((p) => !trigger.includes(p))) console.log(`  conf-only: ${p}`)
    for (const p of trigger.filter((p) => !declared.includes(p))) console.log(`  workflow-only: ${p}`)
    return 1
  }
  return 0
}

let failures = checkPathSync("openshare", OSH)
for (const repo of repos) {
  const name = repo.replaceAll("\\", "/").split("/").pop()
  for (const rel of IDENTICAL) {
    const a = readFileSync(join(OSH, rel), "utf8")
    let b
    try {
      b = readFileSync(join(repo, rel), "utf8")
    } catch {
      console.log(`DRIFT ${name}: ${rel} missing`)
      failures++
      continue
    }
    if (a.replaceAll("\r\n", "\n") !== b.replaceAll("\r\n", "\n")) {
      console.log(`DRIFT ${name}: ${rel} differs from openshare`)
      failures++
    }
  }
  for (const rel of MUST_NOT_EXIST) {
    try {
      readFileSync(join(repo, rel))
      console.log(`DRIFT ${name}: ${rel} exists but the kit retired it`)
      failures++
    } catch {}
  }
  failures += checkPathSync(name, repo)
}
console.log(failures === 0 ? `kit-check: ${repos.length + 1} repo(s) clean` : `kit-check: ${failures} drift(s)`)
process.exit(failures === 0 ? 0 : 1)
