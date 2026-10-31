#!/usr/bin/env node
// Copies .githooks/pre-push into .git/hooks/ (idempotent). Runs from the
// `prepare` lifecycle of every package manifest, so any npm/bun install in
// the repo installs the hook - no manual step for contributors. Safe next
// to a global hooksPath: the standard global-hook pattern chains into
// .git/hooks/pre-push after its own checks.
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

let repo = ""
try {
  repo = execSync("git rev-parse --show-toplevel", { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).toString().trim()
} catch {
  process.exit(0) // not a git checkout (exported source tree) - nothing to install
}
const src = join(repo, ".githooks", "pre-push")
const hooksDir = join(repo, ".git", "hooks")
mkdirSync(hooksDir, { recursive: true })
const dst = join(hooksDir, "pre-push")
try {
  if (readFileSync(dst, "utf8") === readFileSync(src, "utf8")) process.exit(0)
} catch {
  // absent - install below
}
copyFileSync(src, dst)
try {
  chmodSync(dst, 0o755) // git requires the exec bit on POSIX; no-op on Windows
} catch {}
// stderr, never stdout: `npm pack --json` parses stdout as JSON and any
// prepare output corrupts it
console.error("[install-hooks] installed .githooks/pre-push -> .git/hooks/pre-push")
