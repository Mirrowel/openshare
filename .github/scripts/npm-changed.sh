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

# The release stamp rewrites every MANIFESTS file (version carriers), so a
# stamped-only diff must not count as a plugin change: filter the manifest
# paths out. Real dependency changes always pair with the lockfile, which the
# stamp never touches.
manifest_filter=""
for m in $MANIFESTS; do
  manifest_filter="${manifest_filter:+$manifest_filter|}^$m$"
done

changed=false
if git diff --name-only "$ref..HEAD" | grep -vE "$manifest_filter" | kit_any_match "$NPM_RE"; then
  changed=true
fi

echo "changed=$changed" | tee -a "${GITHUB_OUTPUT:-/dev/null}"
