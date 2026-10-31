# Shared release-kit library: path matching + semver/tag helpers + channel
# classification. Sourced by compute-version.sh, release-kit.sh,
# npm-changed.sh, and generate-release-notes.sh; one home per behavior so
# entry points can never drift apart. Patterns are repo-root-relative globs
# where ** spans directories and * stays inside one segment, mirroring the
# GitHub Actions paths filter syntax.

# Release kit config (release-kit.conf) holds the canonical pattern lists:
#   RELEASE_PATHS  changes here justify a release (workflow trigger filter)
#   NPM_PATHS      changes here justify an npm publish (skip hollow publishes)
#   NPM_GATE       off = always publish on release (single-package repos)
# plus STABLE_BRANCHES / MANIFESTS / MAX_BUMP / channels.

kit_paths_conf="${KIT_CONF:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-kit.conf}"

# shellcheck source=release-kit.conf
[ -f "$kit_paths_conf" ] && . "$kit_paths_conf"

RELEASE_PATHS="${RELEASE_PATHS:-}"
NPM_PATHS="${NPM_PATHS:-}"
NPM_GATE="${NPM_GATE:-off}"
STABLE_BRANCHES="${STABLE_BRANCHES:-main master}"
KIT_CHANNELS="${KIT_CHANNELS:-latest dev alpha beta rc canary}"

# ---------------------------------------------------------------------------
# semver helpers

semver_sort() {
  sort -V
}

# Max of the arguments, ignoring non-semver entries. Entries may carry
# prerelease suffixes; sort -V orders them below their own base (0.3.0-dev.7
# < 0.3.0), so callers comparing BASES must strip first (base_of).
semver_max() {
  printf '%s\n' "$@" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+' | semver_sort | tail -n 1
}

# The base version of a possibly-suffixed semver: 0.3.0-dev.7 -> 0.3.0.
# The prerelease suffix is an iteration of the base (the version that ships
# when the channel merges to a stable branch), never a base itself. Every
# pin/bump comparison goes through this so a full version in VERSION (valid
# for repos whose VERSION is the sole carrier) can never be read as a new
# base line.
base_of() {
  printf '%s\n' "$1" | sed -E 's/^([0-9]+\.[0-9]+\.[0-9]+)-.*/\1/'
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

# ---------------------------------------------------------------------------
# tag walkers (branch-scoped: --merged HEAD only sees this branch's history)

latest_stable_tag() {
  git tag --merged HEAD --list 'v[0-9]*.[0-9]*.[0-9]*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | semver_sort | tail -n 1 || true
}

latest_channel_tag() {
  local channel="$1"
  git tag --merged HEAD --list "v[0-9]*.[0-9]*.[0-9]*-$channel.*" | semver_sort | tail -n 1 || true
}

# Highest prerelease BASE among prerelease tags merged to this branch,
# suffix-stripped. Bases converge to the highest line on merge (promotion
# semantics); they never fork per channel.
latest_prerelease_base() {
  git tag --merged HEAD --list 'v[0-9]*.[0-9]*.[0-9]*-*' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-(dev|alpha|beta|rc|canary)\.[0-9]+$' \
    | sed -E 's/^v([0-9]+\.[0-9]+\.[0-9]+)-.*/\1/' \
    | semver_sort \
    | tail -n 1 || true
}

# The version line this branch is currently on: stable branches sit on the
# latest stable tag; development channels iterate on the highest base already
# running there (or the stable they forked from).
branch_base_version() {
  local stable_tag stable_version
  stable_tag="$(latest_stable_tag)"
  stable_version="0.0.0"
  if [ -n "$stable_tag" ]; then
    stable_version="${stable_tag#v}"
  fi
  if is_stable_branch "$(git branch --show-current 2>/dev/null || printf 'HEAD')"; then
    printf '%s\n' "$stable_version"
    return
  fi
  local pre_base
  pre_base="$(latest_prerelease_base)"
  printf '%s\n' "$(semver_max "$pre_base" "$stable_version")"
}

# ---------------------------------------------------------------------------
# channels

is_stable_branch() {
  local needle="$1" item
  for item in $STABLE_BRANCHES; do
    [ "$needle" = "$item" ] && return 0
  done
  return 1
}

# ---------------------------------------------------------------------------
# path matching

# Translate one glob into an ERE fragment. Escapes metachars, then ** -> .*
# and * -> [^/]*. Pipe delimiter: replacements contain slashes. The class
# lists ] first (POSIX: backslash is no escape inside a bracket class).
_kit_translate() {
  printf '%s\n' "$1" | sed -e 's/[]\*+?^$(){}.[|]/\\&/g' -e 's|\\\*\\\*|.*|g' -e 's|\\\*|[^/]*|g'
}

# Compile a pattern list into one anchored alternation. Called once per
# source, so the process cost is bounded by the pattern count. Globbing is
# disabled while word-splitting the list: an unquoted ** would otherwise
# expand against the filesystem when the cwd is the repo root.
#   RELEASE_RE="$(_kit_compile "$RELEASE_PATHS")"
_kit_compile() {
  local p out="" had_noglob=1
  case $- in *f*) had_noglob=0 ;; esac
  set -f
  for p in $1; do
    out="${out:+$out|}$(_kit_translate "$p")"
  done
  [ "$had_noglob" = 1 ] && set +f
  printf '%s' "$out"
}

RELEASE_RE="$(_kit_compile "$RELEASE_PATHS")"
NPM_RE="$(_kit_compile "$NPM_PATHS")"

# True when the repo-root-relative path matches a compiled list.
#   kit_path_matches "share-plugin/src/x.ts" "$RELEASE_RE"
kit_path_matches() {
  [ -n "$2" ] || return 1
  printf '%s\n' "$1" | grep -qE "^($2)$"
}

# True when any stdin line (a file list) matches. Implemented with a
# full-read awk, never grep -q: grep -q exits on first match and SIGPIPEs
# every upstream writer, and under `set -o pipefail` a large file list
# (a real diff can exceed the pipe buffer) would flip a match into a
# pipeline failure - silently suppressing the match. The pattern travels
# via ENVIRON, not -v: -v unescapes backslashes and would corrupt the
# compiled ERE's escaped dots.
kit_any_match() {
  [ -n "$1" ] || return 1
  KIT_RE="$1" awk '$0 ~ "^(" ENVIRON["KIT_RE"] ")$" { found = 1 } END { exit found ? 0 : 1 }'
}

# Print which part a file belongs to; empty for root-level files (docs,
# workflows). Single-package repos set KIT_DEFAULT_PART in the conf so their
# files map to one part instead of "none". Always exits 0: callers run under
# set -e and an unmatched file is a normal case, not a failure.
kit_part_of() {
  case "$1" in
    share-plugin/*) echo "plugin" ;;
    share-worker/*) echo "worker" ;;
    share-server/*) echo "server" ;;
    share-viewer/*) echo "viewer" ;;
    tools/*) echo "tools" ;;
    website/*) echo "website" ;;
    *) if [ -n "${KIT_DEFAULT_PART:-}" ]; then echo "$KIT_DEFAULT_PART"; fi ;;
  esac
  return 0
}
