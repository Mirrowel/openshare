# Upstream reports — drafted, not yet filed

Findings in **our vendored/dependency code that are actually upstream bugs**, written up as standalone reports. The owner publishes these himself — nothing here has been filed yet.

| Report | Target | Status | One-line summary |
|---|---|---|---|
| [`opencode-session-ui-missing-i18n-key-ui-tool-todos.md`](opencode-session-ui-missing-i18n-key-ui-tool-todos.md) | opencode session-ui (v2 kit) | drafted | `ui.tool.todos` locale key is undefined while sibling keys exist — todos rows print the raw key when reached through the tool renderer |
| [`solid-js-cleannode-reentrant-disposal-crash.md`](solid-js-cleannode-reentrant-disposal-crash.md) | solid-js | drafted | `cleanNode` walks `owned`/`cleanups` with live loops — a re-entrant disposal nulls the arrays mid-walk and the flush dies on `null[i]` (we vendor a snapshot-loop patch; opencode itself ships a `patch-package` for the same defect) |
| [`opencode-v118-session-diff-is-a-silent-stub.md`](opencode-v118-session-diff-is-a-silent-stub.md) | opencode v1.18 host | drafted | `client.session.diff()` is a hardcoded `return []` — every consumer of the public diff API silently gets nothing, and the `session.diff` event only fires on revert/compaction |

Each report is self-contained: the defect, source evidence, reproduction, and a suggested fix. If a report gets filed and fixed upstream, note it here and drop the corresponding local fork when the fix reaches our vendored copies.
