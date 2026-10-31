#!/usr/bin/env bash
set -euo pipefail

# Lifted from agent-variants' release workflow (family pattern, kept
# structurally aligned). OpenShare adaptation: the package lives in
# share-plugin/ inside a monorepo — resolve it from the script location
# (.github/scripts/ -> repo root -> share-plugin/) instead of assuming the
# package sits at the repo root like agent-variants.
#
# Versioning model
# ----------------
# AUTO releases (git pushes) are grunt work only: conventional commits pick
# none/patch/minor, and a computed MAJOR is demoted to minor (clamp below at
# conventional_bump_since). An auto release can therefore never open a new
# x.0.0 line and never move more than one 0.x step from the last stable
# (0.3.1 -> at most 0.4.0 on breaking/feat, 0.3.2 on fixes).
# x.0.0 versions (1.0.0 = the hand-set "stable out" release, 2.0.0, ...) are
# milestones only a human sets, through the manual levers below.
#
# MANUAL versioning - how to set the version by hand:
#   1. Persistent pin: write the next version into the repo-root VERSION
#      file (by hand, or via `node .github/scripts/next-version.mjs 1.2.3`
#      / `minor` / `major` / `patch`). Semver-smart comparison against the
#      latest stable tag: strictly higher = EXACT PIN, that version
#      releases regardless of what the commits would compute (holding a
#      fix round at 0.2.1 under a feat-heavy range); equal or lower is
#      inert (auto-computes). The pin is self-consuming - once that version
#      ships, VERSION == latest tag and auto versioning resumes; the
#      release stamp rewrites VERSION back to a record after each release.
#   2. One-shot exact version: dispatch the Release workflow with
#      target_version=x.y.z - stable and prerelease releases both use exactly
#      that version for that run.
#   3. One-shot bump override: dispatch with version_bump=major|minor|patch|
#      none - an explicit human choice, so "major" is honored as-is (not
#      clamped like computed majors).
#
# Kit config (.github/scripts/release-kit.conf): STABLE_BRANCHES (which
# branches release to `latest`; every other branch is a development channel
# stacking `-<branch>.N` per push), MAX_BUMP (highest AUTOMATIC bump,
# default minor - an auto release can never open a new x.0.0 line; manual
# designations bypass it), RELEASE_GATE, PROTECTED_BRANCHES.

PKG_DIR="$(cd "$(dirname "$0")/../.." && pwd)/share-plugin"
cd "$PKG_DIR"

kit_conf="$(cd .. && pwd)/.github/scripts/release-kit.conf"
STABLE_BRANCHES="main master"
MAX_BUMP="minor"
if [ -f "$kit_conf" ]; then
  # shellcheck disable=SC1090
  . "$kit_conf"
fi
# path-filter helpers (RELEASE_PATHS / NPM_PATHS from the conf); sourced
# from the conf's directory because this script cd'd into PKG_DIR already
KIT_CONF="$kit_conf"
# shellcheck disable=SC1091
. "$(dirname "$kit_conf")/kit-paths.sh"

# stable-branch membership: latest channel or development channel
is_stable_branch() {
  local needle="$1" item
  for item in $STABLE_BRANCHES; do
    [ "$item" = "$needle" ] && return 0
  done
  return 1
}

# clamp an automatic bump to MAX_BUMP (manual dispatch bumps bypass)
clamp_auto_bump() {
  local bump="$1"
  case "$MAX_BUMP:$bump" in
    patch:minor|patch:major) echo patch ;;
    minor:major) echo minor ;;
    *) echo "$bump" ;;
  esac
}

semver_sort() {
  sort -V
}

semver_max() {
  printf '%s\n' "$@" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+' | semver_sort | tail -n 1
}

bump_version() {
  local version="$1"
  local bump="$2"
  local major minor patch
  IFS='.' read -r major minor patch <<< "$version"
  case "$bump" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    patch) echo "$major.$minor.$((patch + 1))" ;;
    none) echo "$major.$minor.$patch" ;;
    *) echo "Unsupported bump: $bump" >&2; exit 1 ;;
  esac
}

latest_stable_tag() {
  git tag --merged HEAD --list 'v[0-9]*.[0-9]*.[0-9]*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | semver_sort | tail -n 1 || true
}

latest_channel_tag() {
  local channel="$1"
  git tag --merged HEAD --list "v[0-9]*.[0-9]*.[0-9]*-$channel.*" | semver_sort | tail -n 1 || true
}

latest_prerelease_base() {
  git tag --merged HEAD --list 'v[0-9]*.[0-9]*.[0-9]*-*' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-(dev|alpha|beta|rc|canary)\.[0-9]+$' \
    | sed -E 's/^v([0-9]+\.[0-9]+\.[0-9]+)-.*/\1/' \
    | semver_sort \
    | tail -n 1 || true
}

tag_points_at_head() {
  local tag="$1"
  [ -n "$tag" ] && [ "$(git rev-list -n 1 "$tag" 2>/dev/null || true)" = "$(git rev-parse HEAD)" ]
}

release_relevant_changes() {
  local previous_tag="$1"
  local changed_files
  # paths are repo-root-relative, so run git from the monorepo root
  # (PKG_DIR/..) even though the script cd'd into the package dir
  if [ -n "$previous_tag" ]; then
    changed_files="$(git -C .. diff --name-only "$previous_tag..HEAD")"
  else
    changed_files="$(git -C .. ls-tree -r --name-only HEAD)"
  fi

  printf '%s\n' "$changed_files" | kit_any_match "$RELEASE_RE"
}

conventional_bump_since() {
  local tag="$1"
  local range="HEAD"
  if [ -n "$tag" ]; then
    range="$tag..HEAD"
  fi
  local log
  log="$(git log "$range" --format='%s%n%b%n---END---' 2>/dev/null || true)"
  if printf '%s\n' "$log" | grep -E 'BREAKING CHANGE:|^[a-zA-Z]+(\([^)]*\))?!:' > /dev/null; then
    echo major
    return
  fi
  if printf '%s\n' "$log" | grep -E '^feat(\([^)]*\))?:' > /dev/null; then
    echo minor
    return
  fi
  if printf '%s\n' "$log" | grep -E '^(fix|perf)(\([^)]*\))?:' > /dev/null; then
    echo patch
    return
  fi
  echo none
}

next_prerelease_number() {
  local package_name="$1"
  local base_version="$2"
  local channel="$3"
  local npm_latest
  local git_latest
  npm_latest="$(npm view "$package_name" versions --json 2>/dev/null | node -e '
    const fs = require("node:fs")
    const versions = JSON.parse(fs.readFileSync(0, "utf8") || "[]")
    const base = process.argv[1]
    const channel = process.argv[2]
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const re = new RegExp(`^${escaped}-${channel}\\.(\\d+)$`)
    const latest = versions
      .map((version) => re.exec(version)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b)
      .at(-1)
    console.log(latest ?? 0)
  ' "$base_version" "$channel")"
  git_latest="$(git tag --merged HEAD --list "v$base_version-$channel.*" \
    | sed -E "s/^v${base_version//./\.}-$channel\.([0-9]+)$/\1/" \
    | grep -E '^[0-9]+$' \
    | sort -n \
    | tail -n 1 || true)"
  echo "$(( (${npm_latest:-0} > ${git_latest:-0} ? ${npm_latest:-0} : ${git_latest:-0}) + 1 ))"
}

validate_stable_version() {
  local version="$1"
  if ! printf '%s\n' "$version" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' > /dev/null; then
    echo "Expected a stable semver version, got: $version" >&2
    exit 1
  fi
}

package_name="$(node -p "require('./package.json').name")"
# VERSION file (repo root): absent or non-semver content is simply inert
intent_version="0.0.0"
if [ -f ../VERSION ]; then
  candidate_version="$(tr -d '[:space:]' < ../VERSION)"
  if printf '%s\n' "$candidate_version" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' > /dev/null; then
    intent_version="$candidate_version"
  fi
fi

branch="${RELEASE_BRANCH:-main}"
channel="${RELEASE_CHANNEL:-}"
if [ -z "$channel" ]; then
  if is_stable_branch "$branch"; then
    channel="latest"
  else
    channel="$branch"
  fi
fi

case "$channel" in
  latest|dev|alpha|beta|rc|canary) ;;
  *) echo "Unsupported release channel: $channel" >&2; exit 1 ;;
esac

target_version="${TARGET_VERSION:-}"
if [ -n "$target_version" ]; then
  validate_stable_version "$target_version"
fi

version_bump="${VERSION_BUMP:-auto}"
case "$version_bump" in
  auto|none|patch|minor|major) ;;
  *) echo "Unsupported version bump: $version_bump" >&2; exit 1 ;;
esac

stable_tag="$(latest_stable_tag)"
prerelease_line="$(latest_prerelease_base)"
stable_version="0.0.0"
if [ -n "$stable_tag" ]; then
  stable_version="${stable_tag#v}"
fi

if [ "$version_bump" = "auto" ]; then
  bump="$(conventional_bump_since "$stable_tag")"
  # Computed bumps clamp to MAX_BUMP (default minor: an auto release never
  # opens a new x.0.0 line and never moves more than one 0.x step from the
  # last stable). x.0.0 versions are milestones a human sets via the
  # VERSION pin or dispatch inputs, which bypass this clamp.
  bump="$(clamp_auto_bump "$bump")"
else
  bump="$version_bump"
fi

# Stable releases promote the highest prerelease base. If dev published
# 0.5.0-dev.N, merging dev to main must release at least 0.5.0 even if the
# merge commit range would otherwise infer a smaller conventional-commit bump.
# (A fresh dev branch synced to main derives its base the same way:
# stable + MAX_BUMP, or the VERSION pin when one is set.)
stable_candidate="$(semver_max "$prerelease_line" "$(bump_version "$stable_version" "$bump")")"
prerelease_default_bump="$MAX_BUMP"
prerelease_base="$(semver_max "$prerelease_line" "$(bump_version "$stable_version" "$prerelease_default_bump")")"

force_release="${FORCE_RELEASE:-false}"
require_relevant_changes="${REQUIRE_RELEVANT_CHANGES:-false}"
if [ -n "$target_version" ]; then
  stable_candidate="$target_version"
  prerelease_base="$target_version"
fi

# Manual pin (VERSION file): a value strictly above the latest stable tag
# pins the release EXACTLY, overriding the computed bump - it can hold the
# line DOWN when commits alone (feat/breaking range) would bump higher.
# Equal or lower is inert (no floor). Self-consuming: once the pinned
# version ships, latest == VERSION and auto versioning resumes. A one-shot
# TARGET_VERSION still wins.
if [ -z "$target_version" ] && [ "$intent_version" != "$stable_version" ] \
  && [ "$(printf '%s\n%s\n' "$stable_version" "$intent_version" | semver_sort | tail -n 1)" = "$intent_version" ]; then
  stable_candidate="$intent_version"
  prerelease_base="$intent_version"
fi

prerelease="false"
latest="true"
npm_tag="$channel"
base_version="$stable_candidate"
should_release="false"

if [ "$channel" != "latest" ]; then
  prerelease="true"
  latest="false"
  base_version="$prerelease_base"
  previous_tag="$(latest_channel_tag "$channel")"
  if tag_points_at_head "$previous_tag"; then
    version="${previous_tag#v}"
    tag="$previous_tag"
    should_release="false"
  else
    prerelease_number="$(next_prerelease_number "$package_name" "$base_version" "$channel")"
    version="$base_version-$channel.$prerelease_number"
    tag="v$version"
    should_release="true"
  fi
  if [ -z "$previous_tag" ]; then
    previous_tag="$stable_tag"
  fi
else
  version="$stable_candidate"
  tag="v$version"
  previous_tag="$stable_tag"
  if [ "$force_release" = "true" ] || [ -n "$target_version" ] || [ "$(printf '%s\n%s\n' "$stable_version" "$stable_candidate" | semver_sort | tail -n 1)" != "$stable_version" ]; then
    should_release="true"
  fi
fi

release_relevant="true"
if [ "$require_relevant_changes" = "true" ] && [ "$force_release" != "true" ]; then
  release_relevant="false"
  if release_relevant_changes "$previous_tag"; then
    release_relevant="true"
  fi
  if [ "$release_relevant" != "true" ]; then
    should_release="false"
  fi
fi

{
  echo "branch=$branch"
  echo "channel=$channel"
  echo "npm_tag=$npm_tag"
  echo "version=$version"
  echo "base_version=$base_version"
  echo "tag=$tag"
  echo "previous_tag=$previous_tag"
  echo "prerelease_line=$prerelease_line"
  echo "release_relevant=$release_relevant"
  echo "prerelease=$prerelease"
  echo "latest=$latest"
  echo "should_release=$should_release"
  echo "bump=$bump"
} | tee -a "${GITHUB_OUTPUT:-/dev/null}"
