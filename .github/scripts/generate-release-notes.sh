#!/usr/bin/env bash
set -euo pipefail

# Lifted from agent-variants' release workflow (family pattern). OpenShare
# adaptation: runs with share-plugin/ as cwd (package metadata) while the
# cliff config lives at the repo root.

repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
version="${RELEASE_VERSION:?RELEASE_VERSION is required}"
tag="${RELEASE_TAG:?RELEASE_TAG is required}"
previous_tag="${PREVIOUS_TAG:-}"
channel="${RELEASE_CHANNEL:?RELEASE_CHANNEL is required}"
npm_tag="${NPM_TAG:?NPM_TAG is required}"
npm_published="${NPM_PUBLISHED:-false}"
prerelease="${PRERELEASE:-false}"
commit_sha="${GITHUB_SHA:?GITHUB_SHA is required}"
workspace="${GITHUB_WORKSPACE:-$(git rev-parse --show-toplevel)}"
# Manual release notes (dispatch input): when set, they REPLACE the
# generated commit list; the header (package table, install) and the
# footer (links) stay.
release_notes="${RELEASE_NOTES:-}"

range="HEAD"
if [ -n "$previous_tag" ]; then
  range="$previous_tag..HEAD"
fi

generate_changelog() {
  if [ -z "$previous_tag" ]; then
    cat > changes.md <<'EOF'
### Initial Release

This is the first release for this channel.
EOF
    return
  fi

  git-cliff --config "$workspace/.github/cliff.toml" --github-repo "$repo" --output changes.md "$range"
}

normalize_changelog() {
  # Stable releases can include prerelease tags inside the compare range. git-cliff
  # renders one section per tag, which can repeat groups like CI/Maintenance.
  # Merge those repeated groups into one deterministic changelog while preserving
  # git-cliff's rendered commit text and full conventional subjects.
  if [ -z "$previous_tag" ]; then
    return 0
  fi

  local tmp raw current_group
  tmp="$(mktemp -d)"
  raw="$tmp/raw.md"
  current_group="other"
  cp changes.md "$raw"

  local groups=(
    "breaking|Breaking Changes"
    "features|Features"
    "fixes|Fixes"
    "performance|Performance"
    "refactoring|Refactoring"
    "documentation|Documentation"
    "tests|Tests"
    "ci|CI"
    "build|Build"
    "maintenance|Maintenance"
    "other|Other Changes"
  )

  for group in "${groups[@]}"; do
    : > "$tmp/${group%%|*}.md"
  done

  while IFS= read -r line; do
    if [[ "$line" =~ ^##[[:space:]] ]]; then
      continue
    fi
    if [[ "$line" =~ ^###[[:space:]](.+)$ ]]; then
      case "${BASH_REMATCH[1]}" in
        "Breaking Changes") current_group="breaking" ;;
        "Features") current_group="features" ;;
        "Fixes") current_group="fixes" ;;
        "Performance") current_group="performance" ;;
        "Refactoring") current_group="refactoring" ;;
        "Documentation") current_group="documentation" ;;
        "Tests") current_group="tests" ;;
        "CI") current_group="ci" ;;
        "Build") current_group="build" ;;
        "Maintenance") current_group="maintenance" ;;
        *) current_group="other" ;;
      esac
      continue
    fi
    if [[ "$line" == "- "* ]]; then
      local sha timestamp
      sha="$(printf '%s\n' "$line" | sed -n 's|.*commit/\([a-f0-9]\{40\}\).*|\1|p')"
      timestamp=""
      if [ -n "$sha" ]; then
        timestamp="$(git show -s --format=%cI "$sha" 2>/dev/null || true)"
      fi
      printf '%s\t%s\n' "$timestamp" "$line" >> "$tmp/$current_group.md"
    fi
  done < "$raw"

  : > changes.md
  local wrote=false
  for group in "${groups[@]}"; do
    local key="${group%%|*}"
    local title="${group#*|}"
    if [ -s "$tmp/$key.md" ]; then
      wrote=true
      {
        echo "### $title"
        sort -r "$tmp/$key.md" | cut -f2-
        echo
      } >> changes.md
    fi
  done

  if [ "$wrote" != "true" ]; then
    echo "No notable changes." > changes.md
  fi
  rm -rf "$tmp"
}

resolve_author_placeholders() {
  if ! grep -qE '\[\[[a-f0-9]{40}\|' changes.md 2>/dev/null; then
    return
  fi

  if [ -n "$previous_tag" ]; then
    author_map="$(gh api "repos/$repo/compare/$previous_tag...$commit_sha" --jq '[.commits[] | {sha: .sha, username: .author.login}] | map(select(.username != null))' 2>/dev/null || echo '[]')"
    while read -r entry; do
      [ -z "$entry" ] && continue
      sha="$(printf '%s' "$entry" | jq -r '.sha')"
      username="$(printf '%s' "$entry" | jq -r '.username')"
      [ -z "$sha" ] || [ -z "$username" ] || [ "$username" = "null" ] && continue
      sed -i "s|\[\[$sha[^]]*\]\]|@$username|g" changes.md
    done < <(printf '%s' "$author_map" | jq -c '.[]' 2>/dev/null || true)
  fi

  remaining="$(grep -oE '\[\[[a-f0-9]{40}\|[^]]*\]\]' changes.md 2>/dev/null || true)"
  while read -r placeholder; do
    [ -z "$placeholder" ] && continue
    sha="$(printf '%s' "$placeholder" | sed 's/\[\[\([^|]*\)|.*/\1/')"
    username="$(gh api "repos/$repo/commits/$sha" --jq '.author.login // empty' 2>/dev/null || true)"
    if [ -n "$username" ]; then
      sed -i "s|\[\[$sha[^]]*\]\]|@$username|g" changes.md
    fi
  done <<< "$remaining"

  remaining="$(grep -oE '\[\[[a-f0-9]{40}\|[^]]*\]\]' changes.md 2>/dev/null || true)"
  while read -r placeholder; do
    [ -z "$placeholder" ] && continue
    sha="$(printf '%s' "$placeholder" | sed 's/\[\[[^|]*|\([^|]*\)|.*/\1/')"
    email="$(printf '%s' "$placeholder" | sed 's/\[\[[^|]*|\([^|]*\)|.*/\1/')"
    name="$(printf '%s' "$placeholder" | sed 's/\[\[[^|]*|[^|]*|\([^]]*\)\]\]/\1/')"
    username=""
    if [[ "$email" =~ ^[0-9]+\+([^@]+)@users\.noreply\.github\.com$ ]]; then
      username="${BASH_REMATCH[1]}"
    elif [[ "$email" =~ ^([^@+\[]+)@users\.noreply\.github\.com$ ]]; then
      username="${BASH_REMATCH[1]}"
    fi
    if [ -n "$username" ]; then
      sed -i "s|\[\[$sha[^]]*\]\]|@$username|g" changes.md
    else
      sed -i "s|\[\[$sha[^]]*\]\]|$name|g" changes.md
    fi
  done <<< "$remaining"
}

collect_pr_numbers() {
  git log "$range" --format='%H%x09%s' 2>/dev/null | while IFS=$'\t' read -r sha subject; do
    printf '%s\n' "$subject" | grep -oE 'Merge pull request #[0-9]+|#[0-9]+' | grep -oE '[0-9]+' || true
    gh api graphql \
      -f owner="${repo%%/*}" \
      -f name="${repo#*/}" \
      -f oid="$sha" \
      -f query='query($owner:String!, $name:String!, $oid:GitObjectID!) { repository(owner:$owner, name:$name) { object(oid:$oid) { ... on Commit { associatedPullRequests(first: 10) { nodes { number } } } } } }' \
      --jq '.data.repository.object.associatedPullRequests.nodes[].number' 2>/dev/null || true
  done | sort -n | uniq
}

generate_community_section() {
  pr_numbers="$(collect_pr_numbers)"
  if [ -z "$pr_numbers" ]; then
    return
  fi

  {
    echo "### Community Contributions"
    echo
    echo "Thank you to our community contributors!"
    echo
    while read -r pr; do
      [ -z "$pr" ] && continue
      pr_json="$(gh api "repos/$repo/pulls/$pr" 2>/dev/null || true)"
      [ -z "$pr_json" ] && continue
      title="$(printf '%s' "$pr_json" | jq -r '.title // empty')"
      author="$(printf '%s' "$pr_json" | jq -r '.user.login // empty')"
      url="$(printf '%s' "$pr_json" | jq -r '.html_url // empty')"
      [ -z "$title" ] || [ -z "$author" ] || [ -z "$url" ] && continue
      echo "- $title ([#$pr]($url)) by @$author"
    done <<< "$pr_numbers"
    echo
  } > community.md
}

if [ -n "$release_notes" ]; then
  printf '%s\n' "$release_notes" > changes.md
else
  generate_changelog
  normalize_changelog
  resolve_author_placeholders
  generate_community_section
fi

package_name="$(node -p "require('./package.json').name")"
install="opencode plugin ${package_name}@latest --global"
if [ "$npm_tag" != "latest" ]; then
  install="opencode plugin ${package_name}@$npm_tag --global"
fi

# Parts changed since the previous tag: the release covers the whole system,
# so the notes name which parts moved instead of implying npm-only changes.
# Resolved from the script's own location / the git toplevel so it works from
# any cwd (package subdir or repo root).
notes_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git rev-parse --show-toplevel)"
# shellcheck source=kit-lib.sh
. "$notes_dir/kit-lib.sh"
parts_changed=""
if [ -n "$previous_tag" ] && git -C "$repo_root" rev-parse -q --verify "refs/tags/$previous_tag" >/dev/null 2>&1; then
  range_files="$(git -C "$repo_root" diff --name-only "$previous_tag..HEAD")"
else
  range_files="$(git -C "$repo_root" ls-tree -r --name-only HEAD)"
fi
while IFS= read -r f; do
  [ -z "$f" ] && continue
  part="$(kit_part_of "$f")"
  [ -z "$part" ] && continue
  case " $parts_changed " in *" $part "*) ;; *) parts_changed="$parts_changed $part" ;; esac
done <<< "$range_files"
parts_changed="${parts_changed# }"
[ -z "$parts_changed" ] && parts_changed="none (docs or tooling only)"
npm_line="npm: not published (no plugin changes since the last published version)"
if [ "$npm_published" = "true" ]; then
  npm_line="npm: published as $package_name@$version"
fi

experimental_note=""
if [ "$prerelease" = "true" ]; then
  experimental_note="$(cat <<EOF
> [!WARNING]
> This is a prerelease from the \`$channel\` channel. It may contain incomplete or unstable changes.
>
> Use the exact version \`$version\` when reporting issues.

EOF
)"
fi

compare_url=""
if [ -n "$previous_tag" ]; then
  compare_url="https://github.com/$repo/compare/$previous_tag...$tag"
fi

: > release-notes.md
if [ -n "$experimental_note" ]; then
  printf '%s\n\n' "$experimental_note" >> release-notes.md
fi

cat >> release-notes.md <<EOF
## Package

| Field | Value |
| ----- | ----- |
| Version | \`$version\` |
| npm tag | \`$npm_tag\` |
| Channel | \`$channel\` |
| Commit | [\`${commit_sha:0:7}\`](https://github.com/$repo/commit/$commit_sha) |

## Install

\`\`\`sh
$install
\`\`\`

## Scope

**Parts changed:** $parts_changed
**$npm_line**

## What's Changed

$(cat changes.md)

EOF

if [ -z "$release_notes" ] && [ -s community.md ]; then
  cat community.md >> release-notes.md
fi

cat >> release-notes.md <<EOF
## Links

- [npm package](https://www.npmjs.com/package/${package_name})
- [Repository](https://github.com/$repo)
- [Issues](https://github.com/$repo/issues)
EOF

if [ -n "$compare_url" ]; then
  echo "- [Full changelog]($compare_url)" >> release-notes.md
fi
