#!/usr/bin/env node
// Writes <target>/version.json so every deploy/build embeds its release
// version from the files it ships with. The target's package manifest is
// the source of truth (stamped by the release kit at every release);
// git only contributes the commit sha and is never required.
//
//   node tools/write-version.mjs share-worker
//
// Fields: version = manifest version ("0.3.0"), date = build date
// (YYYY-MM-DD), rev = short sha ("" without git),
// full = "0.3.0 · 2026-10-31 · abc1234" (parts dropped when absent),
// "unknown" when no manifest exists.
import { execSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const target = process.argv[2]
if (!target) {
  console.error("usage: node tools/write-version.mjs <target-dir>")
  process.exit(1)
}
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

let version = "unknown"
try {
  version = JSON.parse(readFileSync(join(repoRoot, target, "package.json"), "utf8")).version ?? "unknown"
} catch {}

const date = new Date().toISOString().slice(0, 10)
let rev = ""
try {
  rev = execSync("git rev-parse --short HEAD", { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim()
} catch {}

const full = [version, date, rev].filter(Boolean).join(" · ") || "unknown"

mkdirSync(join(repoRoot, target), { recursive: true })
writeFileSync(join(repoRoot, target, "version.json"), JSON.stringify({ version, date, rev, full }, null, 2) + "\n", "utf8")
console.log(`[write-version] ${target}: ${full}`)
