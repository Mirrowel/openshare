# Shared release-kit path matching. Sourced by compute-version.sh,
# npm-changed.sh, and generate-release-notes.sh; keeps path-filter behavior
# identical everywhere. Patterns are repo-root-relative globs where ** spans
# directories and * stays inside one segment, mirroring the GitHub Actions
# paths filter syntax.

# Release kit config (release-kit.conf) holds the canonical pattern lists:
#   RELEASE_PATHS  changes here justify a release (workflow trigger filter)
#   NPM_PATHS      changes here justify an npm publish (skip hollow publishes)
#   NPM_GATE       off = always publish on release (single-package repos)

kit_paths_conf="${KIT_CONF:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-kit.conf}"

# shellcheck source=release-kit.conf
[ -f "$kit_paths_conf" ] && . "$kit_paths_conf"

RELEASE_PATHS="${RELEASE_PATHS:-}"
NPM_PATHS="${NPM_PATHS:-}"
NPM_GATE="${NPM_GATE:-off}"

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

# True when any stdin line (a file list) matches. One process total.
#   git diff --name-only A..B | kit_any_match "$NPM_RE"
kit_any_match() {
  [ -n "$1" ] || return 1
  grep -qE "^($1)$"
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
