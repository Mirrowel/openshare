# VENDOR.md — the vendored opencode kit

This document explains what `vendor/` is, why it exists, how the pin works,
and what every patch does. If you are updating the kit or reviewing a vendor
diff, start here.

## What vendoring is (and why we do it)

The share viewer is built on opencode's own v2 UI packages
(`@opencode/session-ui`, `@opencode/ui`, `@opencode/client`, `@opencode/util`,
plus `patchmark` and a patched `solid-js`). They are not npm-installable at
the revisions we need, and we must change their behavior in a number of
places (grouping, timestamps, agent labels, offline snapshots...). You cannot
patch an npm package, so the source is **copied into `share-viewer/vendor/`
and patched here**.

Think of `vendor/` as a **pinned dependency**: like a version number in
package.json, except we hold the files. It is committed, it builds as-is,
and releases never touch upstream. `npm run build` and `npm ci` (Docker)
never run the vendor script.

## The pin

`scripts/vendor-v2.mjs` holds a `PIN` — one exact commit sha of
`anomalyco/opencode`'s `dev` branch. The script **downloads exactly that
commit** from GitHub (codeload tarball) into a scratch cache
(`%LOCALAPPDATA%/openshare/vendor-src/<sha>`), regenerates `vendor/`, and
**deletes the cache again on success** (kept only when the port throws, for
debugging; older pins are always removed). The ambient opencode checkout on
a dev machine is never read implicitly.

- `OPENSHARE_BETA_SRC=<checkout>` overrides the download — for working
  against a local checkout at a specific rev. This is the only way a local
  clone is involved.
- `OPENSHARE_VENDOR_KEEP_CACHE=1` keeps the download after a successful run.
- `vendor/V2-SOURCE.txt` records the last regeneration.

## Updating (the ritual)

1. `node scripts/vendor-v2.mjs --check` — dry-runs the whole port against
   the PIN into a temp dir. Every patch either re-applies or the script
   **throws at the exact drifted spot**. Run it after bumping the PIN to get
   the work list.
2. Bump the `PIN` ref in the script to the target commit.
3. Fix whatever the check names (adapt anchors, never delete a fork silently).
4. `npm run vendor` (regenerates, links, `bun install`). The script then
   **compares root package.json pins against the vendored catalog and fails
   naming mismatches** — the vendored packages resolve peers from the root
   tree (they are junctioned into node_modules), so a stale root pin silently
   changes kit behavior (this exact class blanked every code card's syntax
   coloring once). Bump what it names.
5. Verify: `npm run typecheck`, `npm run build`, behavior probe on a real
   share (file cards colored, diffs paint, subagent page, conversation view),
   the tool gallery renders all states, snapshot offline boot.
6. **Compare visually**: the deployed viewer can serve a second build under
   `/legacy/...` (see `scripts/build-legacy.mjs` and the worker's `/legacy`
   route). After an update, eyeball the new build against the old one on the
   same share before calling it done.

Regularity is by need, not calendar: bump when something wanted lands
upstream, or every month or two otherwise.

## Why solid-js is vendored too

`scripts/vendor-solid.mjs` writes two patched solid builds (`vendor/solid/`)
whose `cleanNode` snapshots the `owned`/`cleanups` arrays before walking
them. Re-entrant disposal (legal Solid usage, present in our virtualized row
graph) nulls those arrays mid-walk; the unguarded loops then throw
`Cannot read properties of null`, which aborts the whole reactive flush and
half-updates the page. `vite.config.ts` picks dev vs build variant;
`node_modules` stays pristine.

## Constraints that bite (all live-caught)

- **Forks must be encoded in the script.** Editing `vendor/` by hand is
  silently reverted on the next regen.
- **Fork order matters.** A package is copied at one point in the script and
  forks for its files must run AFTER that copy (the highlight-theme fork once
  sat before the `ui` copyTree and edited a stale file that was then
  overwritten).
- **Guard tokens must be unique to the definition.** The agent-colors block
  once guarded on the function NAME, which an earlier fork's usage line had
  already inserted — the definition never landed and the build broke.
- **Import vendored code only by package specifier** (`@opencode/session-ui/...`),
  never by relative path into `vendor/` — vite sees two module ids and every
  context lookup throws. Vendored files must not import from `../src/` for
  the same reason (the agent-color registry lives inside the vendored file).
- **bun copies `file:` deps** — that is why `scripts/link-vendor.mjs`
  junctions the packages into `node_modules/@opencode/*` and the root pins
  shared deps (effect, katex, solid-js, dompurify, `@pierre/*`) at the
  vendored catalog versions.
- **`npm install` deletes the junctions.** Any npm/npx install inside
  `share-viewer` replaces `node_modules/@opencode/*`, and every vendored
  import then fails typecheck and build. Re-run `node scripts/link-vendor.mjs`
  after any install, or use `bun install`.

## Patch catalogue

Every fork below is a block in `scripts/vendor-v2.mjs` that either applies
idempotently or throws "upstream drifted". Files are under
`vendor/session-ui-v2/src/` unless noted.

### Projection & timeline

- **projection.ts — per-assistant-message grouping**: upstream grouped a
  whole turn's tools into one block; ours groups per assistant message with
  a message-id merge guard, adds the `message` spacing category (the break
  between two messages), and projects todos/compaction/agent-switch rows
  that the app otherwise drops.
- **session-timeline-row.tsx — spacing union**: forwards the `message`
  category so the row renderer can break between messages; keeps upstream's
  padding classes (our unlayered CSS keys on `data-timeline-spacing`).
- **timeline-row / message-content.tsx — stamps**: prompt timestamps are
  absolute 24-hour values from the host clock (`__oshStamp`), not the kit's
  "3 minutes ago" relatives; the header toggle switches the whole session to
  the reader's timezone (src/timefmt.ts).
- **message-content.tsx — markdown fallback is paragraph-shaped** so the
  plain-text-to-rich swap does not reflow; reasoning rows render through the
  kit's live Thinking machinery.

### Tools (tool-renderer.tsx and friends)

- **File-change tools never merge** (edit/write/patch each render their own
  card; the merged `CurrentFileToolGroup` showed one aggregate row with
  broken expansion).
- **Reads no longer merge inside a context group** and keep their own
  renderer so their output can expand.
- **Grouped glob/grep/list rows expand** (upstream renders them as static
  rows with no collapsible); subtitles move to our renderers for path
  relativization and match counts.
- **Grouped task rows label the agent that actually ran**
  (`metadata.agent`, rank-joined plugin-side; `taskAgentName` honors the
  input's agent).
- **Per-agent colors**: explore blue, general dark red, then ten distinct
  hues in first-use order, generated past ten so no two types ever share one;
  exposed to CSS as `--osh-agent` on the task card, with `data-running`
  driving the sweep animation.
- **Unregistered tools fall back** to the catch-all output card
  (`state["*"]`), so ctx_*/MCP tools render instead of nothing.
- **Generic fallback title**: bold name plus compact args for unknown tools.
- **Shell card** carries `data-osh-out`/grip attributes so the shared
  output-surface behavior (drag-resize, clipped fade) can find it.

### pierre / rendering engine
- **Markdown parses in-page offline**: snapshot files run from `file://`,
  where `new Worker` cannot start, so the markdown worker module has a
  main-thread copy (`components/markdown.worker-main.ts`, generated) driven
  through a Worker-shaped shim. Prose renders like the live page. pierre is
  NOT shimmed: its worker modules are large and the main-thread path
  allocated gigabytes, so snapshot file bodies render as plain numbered
  text instead (see `src/tool-overrides.tsx`).
- **Calmer word emphasis inside diffs**: rewritten lines painted as
  saturated bands at 0.4 alpha; ours is 0.3 dark / 0.16 light.
- **Default theme names are aliases of our palette** (`pierre/index.ts`):
  a worker bundle can evaluate its module graph twice in dev (vite serves
  the entry and a plain copy under different URLs), leaving a copy that
  renders with the library default `pierre-dark`/`pierre-light` and throws
  "Theme ... has not been resolved" on every task. Registering those names
  as aliases of the OpenCode theme and initializing the pool with them
  means every copy resolves; the palette is unchanged.
- **Token palette (ui-v2 highlight-theme.tsx)**: the new tokenizer maps
  punctuation/property/heading differently than the old TextMate scopes;
  mapped back so code colors match the shiki-era reader (runs AFTER the ui
  copyTree — see ordering constraint above).

### Misc

- **ui.tool.todos locale key** is merged in the viewer's own dictionary
  (src/entry.tsx), not forked — recorded here because the report is an
  upstream bug we carry a workaround for.
- A handful of upstream type bugs are `@ts-nocheck`-suppressed at the top of
  the named files (narrowed unions beta-side), listed in the script.

## The legacy comparison build

`scripts/build-legacy.mjs` copies a second, older viewer build into `dist/`
(`legacy.html` + hashed assets) and the worker serves it under `/legacy/...`
paths. It exists for exactly the update ritual above: eyeball the same share
in both builds. It is NOT part of normal deploys; remove it when the
comparison window closes.
