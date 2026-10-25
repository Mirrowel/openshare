# Upstream bug report: `session.diff` is a hardcoded stub returning `[]` unconditionally — silent data loss behind a public API

**Target repository:** `anomalyco/opencode` (v1.18 line)
**Status:** Draft report — publish when ready (owner publishes findings himself)
**Verified against:** the v1.18 checkout at `c:\tools\opencode` (current stable line at the time of writing)

---

## Summary

`Session.diff` — exposed through the SDK (`client.session.diff`) and the HTTP API
(route identifier `session.diff`) — is implemented as a **stub that ignores its
input and always returns an empty array**:

```ts
// packages/opencode/src/session/session.ts (around line 823)
const diff = Effect.fn("Session.diff")(function* (sessionID: SessionID) {
  void sessionID
  return [] as Snapshot.FileDiff[]
})
```

`void sessionID` — the parameter is explicitly discarded. Every caller gets `[]`
for every session, always, with no error and no indication that the data is
unavailable.

## Why it matters

- The **deprecated native share** (`share/share-next.ts:277,296`) syncs
  `{ type: "session_diff", data: diffs }` from this call — so the native share
  page's file-diff view has been silently empty for every v1.18 user.
- The `session.diff` **event** only fires from `session/revert.ts:78` (after an
  undo) and `session/summary.ts:114` (compaction, publishing `[]`) — there is no
  event when a file is actually edited, so consumers cannot work around the
  stub by listening.
- The session **summary** (the other diff carrier, `info.summary.diffs`) is
  never populated by edits either — the only caller of `setSummary`
  (`summary.ts:106`) writes zeros.

Net effect: on v1.18 there is **no functioning way** to obtain a session's
changed-files diff through the public API surface, while every consumer-facing
path pretends it works (typed result, no error).

## Suggested fix

Either implement `Session.diff` (from the session's `session_diff` storage /
snapshot machinery — `revert.ts:77` already writes that storage key, so a read
path exists), or make the stub honest: throw a typed "not implemented" error so
consumers can detect and degrade visibly instead of receiving silent empty
data.

## What we did downstream

Our share viewer ([OpenShare](https://github.com/Mirrowel/OpenShare)) briefly
shipped a diff review panel; after discovering this stub we removed the feature
entirely (a correct cumulative diff would require shipping full file contents,
which we rejected on privacy). The v2 line's `session.diff` (typed
`FileDiffInfo[]`) looks real — this report concerns the v1.18 line only.
