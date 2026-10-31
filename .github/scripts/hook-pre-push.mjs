#!/usr/bin/env node
// pre-push release stamp. Runs from .git/hooks/pre-push (installed by
// install-hooks.mjs). For every pushed ref that lands on a STABLE branch
// with unpushed commits, computes what the release workflow would compute
// (same script, same inputs) and stamps VERSION + the package manifests
// BEFORE the push - so the pushed tip already carries its release version
// and CI never needs to write back (no rebase for the pusher).
//
// VERSION pin semantics live inside compute-version.sh: a strictly-higher
// VERSION pins the release (the stamp then writes that same value back);
// equal or lower is inert and the predicted version becomes the record.
//
// Fail-closed: any error aborts the push (an unstamped push would ship a
// release whose tag tree carries a stale version). Pushes of development
// branches and non-branch refs pass through untouched.
import { execSync, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

function git(args, opts = {}) {
  return execSync(`git ${args}`, { encoding: "utf8", windowsHide: true, ...opts }).toString()
}

// resolveGitBash(): on Windows, plain "bash" may resolve to the WSL stub
// (System32\bash.exe), which is a different, possibly absent environment.
// Prefer the bash shipped with Git.
function resolveGitBash() {
  if (process.platform !== "win32") return "bash"
  const candidates = []
  for (const root of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA && process.env.LOCALAPPDATA + "\\Programs"]) {
    if (root) candidates.push(root + "\\Git\\bin\\bash.exe")
  }
  for (const c of candidates) {
    try {
      if (readFileSync(c)) return c
    } catch {}
  }
  return "bash.exe"
}

const repo = git("rev-parse --show-toplevel").trim()
const kitConf = readFileSync(join(repo, ".github/scripts/release-kit.conf"), "utf8")
const stable = (kitConf.match(/^STABLE_BRANCHES="([^"]*)"/m)?.[1] ?? "main master").split(/\s+/)
const manifests = (kitConf.match(/^MANIFESTS="([^"]*)"/m)?.[1] ?? "package.json").trim().split(/\s+/)

let input = ""
try {
  input = readFileSync(0, "utf8")
} catch {
  // no stdin (manual run) - nothing to do
  process.exit(0)
}

for (const line of input.split("\n")) {
  if (!line.trim()) continue
  const [localRef, localSha, , remoteSha] = line.split(/\s+/)
  if (!localRef?.startsWith("refs/heads/")) continue
  const branch = localRef.slice("refs/heads/".length)
  if (!stable.includes(branch)) continue
  if (remoteSha === "0".repeat(40)) continue // new branch: no prior range to guard
  if (localSha === remoteSha) continue // already pushed

  // stamping commits on the current checkout; when a different branch is
  // checked out (pushing main:main from a dev worktree), skip - the CI
  // write-back covers the tip instead of misplacing a release commit
  const headBranch = git("rev-parse --abbrev-ref HEAD").trim()
  if (headBranch !== branch) {
    console.error(`[pre-push] ${branch} is pushed from a detached context (HEAD is ${headBranch}) - skipping the release stamp; CI stamps the tip.`)
    continue
  }

  const compute = spawnSync(
    resolveGitBash(),
    [join(repo, ".github/scripts/compute-version.sh")],
    // cwd = repo root: the script resolves its own package dir, so the same
    // hook file works for root-package and monorepo layouts alike
    // REQUIRE_RELEVANT_CHANGES: docs-only stable pushes must not create a
    // release commit the workflow (paths-filtered) would never honor
    { cwd: repo, env: { ...process.env, RELEASE_BRANCH: branch, REQUIRE_RELEVANT_CHANGES: "true", GITHUB_OUTPUT: "" }, encoding: "utf8" },
  )
  if (compute.status !== 0) {
    console.error("[pre-push] compute-version.sh failed - aborting push (fail-closed):")
    console.error(compute.stderr || compute.stdout)
    process.exit(1)
  }
  const out = Object.fromEntries(
    compute.stdout
      .split("\n")
      .filter((l) => /^[a-z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  )
  if (out.should_release !== "true") continue

  // git resolved the pushed ref before this hook ran, so mutating HEAD now
  // cannot affect THIS push (an amend would ship the unstamped commit and
  // diverge the branch). Instead: create the release commit locally and
  // reject the push - the next push ships it. One extra push on stable
  // releases only; dev branches never pause.
  // Stamped state must be read from the COMMIT, never the worktree: an
  // uncommitted stamp must not fool the guard. The marker is VERSION (the
  // release record), NOT the manifests: dev branches legitimately carry
  // line-version manifests before any release, so a merged tip with
  // manifests == version is still unstamped when VERSION lags. A missing
  // VERSION (branch predates the kit) counts as unstamped.
  let committedVersion = ""
  try {
    committedVersion = git(`show ${localSha}:VERSION`).trim()
  } catch {}
  if (committedVersion === out.version) continue // already stamped - pass through

  const stamp = spawnSync(process.execPath, [join(repo, ".github/scripts/release-stamp.mjs"), out.version], {
    cwd: repo,
    encoding: "utf8",
  })
  if (stamp.status !== 0) {
    console.error("[pre-push] stamp failed - aborting push (fail-closed):")
    console.error(stamp.stderr || stamp.stdout)
    process.exit(1)
  }

  try {
    git(`add VERSION ${manifests.join(" ")}`)
    git(`commit -m "release: ${out.version}"`)
  } catch (e) {
    console.error("[pre-push] release commit failed - aborting push (fail-closed):")
    console.error(e.stderr?.toString() || e.message)
    process.exit(1)
  }
  // leave a clean worktree (line-ending filters can report residuals)
  try {
    git(`checkout -- VERSION ${manifests.join(" ")}`)
  } catch {}
  console.error("")
  console.error(`[pre-push] release ${out.version} committed locally - push again to ship it.`)
  console.error(`[pre-push] (git cannot alter a push already in flight; the release commit must ride the next push)`)
  process.exit(1)
}
process.exit(0)
