# Upstream bug report: `cleanNode` walks `node.owned` / `node.cleanups` with live loops — re-entrant disposal crashes the whole reactive flush with `Cannot read properties of null`

**Target repository:** `solidjs/solid` (solid-js 1.9.15; the pattern exists across dist builds)
**Status:** Draft report — publish when ready (owner publishes findings himself)
**Independent corroboration:** opencode (anomalyco/opencode) hit the same defect and ships
`patches/solid-js@1.9.10.patch` for it — see "Prior art" below.

---

## Summary

`cleanNode` in solid-js iterates `node.owned` and `node.cleanups` **while other code in the
same walk can null those arrays**. If any cleanup (or any disposal triggered transitively by
one) disposes an owner that is *higher in the same walk*, Solid nulls
`node.owned` / `node.cleanups` mid-loop, and the loop's next iteration reads a property of
`null`. The resulting `TypeError` propagates up through `updateComputation` → the effect
flush, **aborting the entire reactive flush** — every effect that had not run yet in that
batch simply never runs, and the UI silently freezes in a half-updated state.

## The unguarded loops (solid-js 1.9.15, `dist/solid.js`)

```js
function cleanNode(node) {
  // ...
  if (node.cleanups) {
    for (i = node.cleanups.length - 1; i >= 0; i--) node.cleanups[i]();  // (A)
    node.cleanups = null;
  } else if (node.owned) {
    for (i = node.owned.length - 1; i >= 0; i--) cleanNode(node.owned[i]); // (B)
    node.owned = null;
  }
  // ...
}
```

Both loops hold a **live reference** and both the loop body (A: an arbitrary user callback)
and the recursion (B: `cleanNode` on children, which may run `node.cleanups[i]()` for a
shared ancestor) can re-enter `cleanNode` for an owner that is an ancestor of `node`.
Re-entrant disposal is legal Solid usage — `createRoot` roots do not auto-dispose, and
applications that manage root lifecycles inside reactive effects dispose owners whose
cleanup arrays are shared with the outer walk.

## Real-world failure (live-caught)

In [OpenShare's share viewer](https://github.com/Mirrowel/OpenShare) (Solid 1.9.15, a
virtualized transcript with per-row `createRoot` roots disposed from inside effects):

```
Uncaught TypeError: Cannot read properties of null (reading '0')
    at zs (solid.js)          // cleanNode's owned/cleanups loop
    at Gl (solid.js)          // updateComputation -> cleanNode
    at Dh (solid.js)          // run effect
    at ir (solid.js)          // batch
    at O5 (solid.js)          // writeSignal - effect flush runs synchronously
                              //        inside the batch the writer opened
```

Observed blast radius (2026-10-24, production-like session):

- Every data update (`setItems` inside a batch) died inside the flush; statements after the
  write (`setRev`, `setStatus`) **never ran** — the status badge stayed at its initial
  `"waiting"` value while the transcript rendered.
- All event handlers attached by effects that had not yet flushed were never registered —
  the page looked perfect but clicks did nothing.
- The varying crash index (`'0'`, `'2'`, …) across identical repros confirms a *mid-walk
  nulling* rather than one bad callback — no user callback ever threw.

## Prior art: opencode hit the same thing

The opencode repository ships `patches/solid-js@1.9.10.patch` (from PR
"fix(app): guard reentrant Solid cleanup" #39261), guarding the same loops in
`dist/dev.cjs`, `dist/dev.js`, `dist/solid.cjs`, `dist/solid.js` and the server builds:

```diff
   } else if (node.owned) {
-    for (i = node.owned.length - 1; i >= 0; i--) cleanNode(node.owned[i]);
+    const owned = node.owned;
     node.owned = null;
+    for (i = owned.length - 1; i >= 0; i--) cleanNode(owned[i]);
   }
   if (node.cleanups) {
-    for (i = node.cleanups.length - 1; i >= 0; i--) node.cleanups[i]();
+    const cleanups = node.cleanups;
     node.cleanups = null;
+    for (i = cleanups.length - 1; i >= 0; i--) cleanups[i]();
   }
```

Two independent applications (opencode, OpenShare) have now patched this class of crash
downstream — the pattern is reachable in ordinary application graphs, not exotic misuse.

## Suggested fix

In `cleanNode` (all dist builds; source `packages/solid/src/reactivity.ts`):

1. Null (or `delete`) the field **before** iterating it, as opencode's patch does — a
   re-entrant call then sees the cleared state and cannot double-dispose; or
2. Snapshot the array before the loop (`const owned = node.owned; for (...) cleanNode(owned[i])`).

Both are behavior-identical for every non-re-entrant walk; option 1 additionally makes
double-disposal a no-op instead of a crash. The same treatment applies to the `node.tOwned`
loop inside the `Transition` branch (present in the client builds).

## Workaround we ship

We vendor solid-js with snapshot-loop guards applied by
[`scripts/vendor-solid.mjs`](../share-viewer/scripts/vendor-solid.mjs), wired through a
vite `resolve.alias` (`solid-js` → the vendored copy) so `node_modules` stays pristine.
Version-pinned to 1.9.15; the vendoring script throws if the upstream build changes shape,
so a Solid release that fixes or moves `cleanNode` surfaces loudly at regeneration time.
