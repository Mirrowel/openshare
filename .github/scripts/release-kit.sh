#!/usr/bin/env bash
set -euo pipefail

# The release kit's single command surface. Versioning is CI-automatic:
# pushes release, and the workflow writes the released version back to the
# branch (VERSION + manifests) after publishing. Nothing here needs to run
# locally for routine releases - these are the manual levers:
#
#   release-kit.sh            CI mode: full version computation. Env
#                             contract unchanged (RELEASE_BRANCH, TARGET_VERSION,
#                             VERSION_BUMP, FORCE_RELEASE, REQUIRE_RELEVANT_CHANGES,
#                             DRY_RUN, GITHUB_OUTPUT) - what the Release
#                             workflow invokes.
#   release-kit.sh check      What would the next push release? Prints branch,
#                             channel, relevance, computed version, the pin
#                             state, and the npm publish decision. No side
#                             effects.
#   release-kit.sh next X     Designate the next version: an exact base version
#                             (1.2.3) or a bump word (major|minor|patch)
#                             derived from this branch's current line. Writes
#                             the repo-root VERSION file (pin semantics in
#                             compute-version.sh; equal or lower than the
#                             branch line is inert).
#   release-kit.sh stage      Optional local pre-stamp: create the release
#                             commit on the tip so the version ships inside
#                             your own push (the CI write-back then no-ops).
#                             No-op when nothing is due or already staged.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
cmd="${1:-compute}"

# shellcheck source=kit-lib.sh
. "$DIR/kit-lib.sh"

manifests_list() {
  printf '%s\n' "$MANIFESTS" | tr ' ' '\n' | grep -v '^$' || true
}

compute_dry() {
  # compute contract: runs from the package dir; returns key=value lines.
  # stderr flows through so an unsupported channel or a broken compute
  # surfaces its reason instead of a bare exit code.
  local branch="$1"
  (
    cd "$REPO"
    RELEASE_BRANCH="$branch" GITHUB_OUTPUT=/dev/null bash "$DIR/compute-version.sh"
  )
}

field() { printf '%s\n' "$1" | sed -n "s/^$2=//p"; }

case "$cmd" in
compute)
  exec bash "$DIR/compute-version.sh"
  ;;

check)
  branch="$(git -C "$REPO" branch --show-current)"
  branch="${branch:-HEAD}"
  out="$(compute_dry "$branch")"
  version="$(field "$out" version)"
  branch_base="$(field "$out" branch_base)"
  intent_base="$(field "$out" intent_base)"
  should="$(field "$out" should_release)"
  relevant="$(field "$out" release_relevant)"
  channel="$(field "$out" channel)"
  npm_out="$(cd "$REPO" && bash "$DIR/npm-changed.sh" 2>/dev/null | sed -n 's/^changed=//p' || true)"
  version_file="$(tr -d '[:space:]' < "$REPO/VERSION" 2>/dev/null || printf 'absent')"
  if [ "$intent_base" != "0.0.0" ] && [ "$intent_base" != "$branch_base" ]; then
    pin_state="pin LIVE (next release on this branch is exactly $intent_base)"
  elif [ "$intent_base" = "0.0.0" ]; then
    pin_state="none"
  else
    pin_state="record only (equals the branch line)"
  fi
  echo "branch:        $branch"
  echo "channel:       $channel (line $branch_base)"
  echo "VERSION file:  $version_file -> $pin_state"
  if [ "$should" = "true" ]; then
    echo "next release:  $version  (releasable changes: $relevant)"
  else
    echo "next release:  none pending - nothing releasable since the last release tag"
  fi
  echo "npm publish:   ${npm_out:-unknown} for the next release (plugin-relevant changes since the last publish)"
  ;;

next)
  shift
  arg="${1:-}"
  if [ -z "$arg" ]; then
    echo "usage: release-kit.sh next <1.2.3|major|minor|patch>" >&2
    exit 1
  fi
  branch="$(git -C "$REPO" branch --show-current)"
  branch="${branch:-HEAD}"
  line="$(branch_base_version)"
  # branch_base_version classifies by the CURRENT branch, same as compute
  if printf '%s\n' "$arg" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.]+)?$' > /dev/null; then
    if printf '%s\n' "$arg" | grep -E '-' > /dev/null; then
      echo "note: prerelease suffixes are iterations, not bases - recording the base" >&2
    fi
    target="$(base_of "$arg")"
  else
    case "$arg" in
      major|minor|patch) target="$(bump_version "$line" "$arg")" ;;
      *) echo "expected a version or major|minor|patch, got: $arg" >&2; exit 1 ;;
    esac
  fi
  printf '%s\n' "$target" > "$REPO/VERSION"
  if [ "$(printf '%s\n%s\n' "$line" "$target" | semver_sort | tail -n 1)" = "$target" ] && [ "$target" != "$line" ]; then
    echo "VERSION -> $target  (branch line $line: LIVE pin - next release on this branch uses it)"
  else
    echo "VERSION -> $target  (branch line $line: inert until above it - auto versioning continues)"
  fi
  ;;

stage)
  branch="$(git -C "$REPO" branch --show-current)"
  branch="${branch:-HEAD}"
  out="$(compute_dry "$branch")"
  should="$(field "$out" should_release)"
  version="$(field "$out" version)"
  if [ "$should" != "true" ]; then
    echo "nothing to release on $branch - push directly"
    exit 0
  fi
  # staged marker: the primary manifest already carries the computed
  # version (full, with suffix) on the tip - the same comparison the CI
  # write-back uses, so a staged tip makes write-back a no-op
  primary="$(manifests_list | head -n 1)"
  if [ -n "$primary" ]; then
    tip_version="$(git -C "$REPO" show "HEAD:$primary" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version??"")}catch{console.log("")}})' || true)"
    if [ "$tip_version" = "$version" ]; then
      echo "already staged: $version is on the tip - push to ship it"
      exit 0
    fi
  fi
  node "$DIR/release-stamp.mjs" "$version"
  # refresh tracked build artifacts that embed the version (openshare's ci
  # bundle); without this a staged release ships a tarball whose bundle
  # diverges from the branch, because a staged tip makes the CI write-back
  # (which normally commits the rebuilt bundle) a no-op
  if [ -f "$REPO/share-plugin/ci/openshare.js" ] && [ -d "$REPO/share-plugin/node_modules" ]; then
    (cd "$REPO/share-plugin" && npm run build >/dev/null 2>&1) || echo "note: package build failed - tracked artifacts may lag the stamp" >&2
  fi
  git -C "$REPO" add VERSION $(manifests_list | tr '\n' ' ') share-plugin/ci/openshare.js 2>/dev/null || git -C "$REPO" add VERSION $(manifests_list | tr '\n' ' ')
  if ! git -C "$REPO" commit -m "release: $version"; then
    # roll the stamp back: an aborted staging must not leave a dirty tree
    git -C "$REPO" checkout -- VERSION $(manifests_list | tr '\n' ' ') 2>/dev/null || true
    echo "stage failed: could not create the release commit (user.name/email set?)" >&2
    exit 1
  fi
  # leave a clean worktree (line-ending filters can report residuals)
  git -C "$REPO" checkout -- . 2>/dev/null || true
  echo "staged release $version on the tip - push to ship it"
  ;;

*)
  echo "usage: release-kit.sh [compute|check|next <version|bump>|stage]" >&2
  exit 1
  ;;
esac
