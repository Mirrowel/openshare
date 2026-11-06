#!/usr/bin/env bash
# Decide whether this release should publish to npm. Only some parts of the
# repo ship to npm, so a release caused by other parts must skip the publish
# (hollow-publish guard). Emits GitHub Actions outputs:
#   changed=true|false   plugin-relevant commits since the last npm publish
# Exits 0 always (a "no" is a decision, not a failure).
#
# Runs from the repo root with a full clone (fetch-depth: 0).
set -euo pipefail
cd "$(dirname "$0")/../.."

# shellcheck source=kit-lib.sh
. .github/scripts/kit-lib.sh

if [ "${NPM_FORCE:-false}" = "true" ] || [ "$NPM_GATE" != "on" ]; then
  echo "changed=true" | tee -a "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi

ref="$(git rev-parse -q --verify refs/tags/npm-latest || true)"
if [ -z "$ref" ]; then
  echo "changed=true" | tee -a "${GITHUB_OUTPUT:-/dev/null}" # first release: nothing published yet
  exit 0
fi

# A stable promotion can carry zero plugin changes since the last dev
# publish yet still need npm: the version number itself is new and the
# dist-tag must move. When the computed release version is not on the
# registry, publish regardless of what changed - skipping here stranded
# stable releases while `latest` pointed at the previous line.
# RELEASE_VERSION is the computed release version (workflow env);
# NPM_PKG_DIR is the package that ships to npm (repo-root relative).
if [ -n "${RELEASE_VERSION:-}" ] && [ -n "${NPM_PKG_DIR:-}" ] \
  && [ -f "$NPM_PKG_DIR/package.json" ] \
  && ! npm view "$(node -p "require('./$NPM_PKG_DIR/package.json').name")@${RELEASE_VERSION}" version >/dev/null 2>&1; then
  echo "changed=true" | tee -a "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi

# The release stamp rewrites every MANIFESTS file (version carriers), so a
# The release stamp rewrites every MANIFESTS file AND every lockfile's
# "version" fields, so path-level filtering alone would count every
# stamped release as an npm change (the gate publishes forever). A
# lockfile counts only when its diff carries lines beyond version
# fields - a real dependency move always does.
stamp_only_lock() {
  git diff "$ref..HEAD" -- "$1" | awk '
    /^[+-][^+-]/ { if ($0 !~ /"version"/) { real = 1; exit } }
    END { exit real ? 0 : 1 }'
  # awk 0 = has non-version hunks = real change; invert to "stamp only"
  [ $? -ne 0 ]
}

changed=false
while IFS= read -r p; do
  [ -z "$p" ] && continue
  skip_one=false
  for m in $MANIFESTS; do
    [ "$p" = "$m" ] && { skip_one=true; break; }
  done
  [ "$skip_one" = true ] && continue
  case "$p" in
    */package-lock.json|*/npm-shrinkwrap.json)
      if kit_path_matches "$p" "$NPM_RE" && ! stamp_only_lock "$p"; then
        changed=true
        break
      fi
      continue
      ;;
  esac
  if kit_path_matches "$p" "$NPM_RE"; then
    changed=true
    break
  fi
done < <(git diff --name-only "$ref..HEAD")

echo "changed=$changed" | tee -a "${GITHUB_OUTPUT:-/dev/null}"
