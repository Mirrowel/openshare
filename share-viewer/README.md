# Open(code)Share viewer

The share page your viewers open — built on the vendored **opencode v2 component kit** (`@opencode/session-ui` v2 + `@opencode/ui`), speaking the OpenShare protocol. One build serves two jobs: **live** pages on the share worker, and **local** snapshots via the export tool. Same rendering, same views, same settings either way.

## How it runs

- **Live** — the share worker serves this build as static assets (`share-worker/wrangler.toml` → `[assets] directory = "../share-viewer/dist"`). Pages live at `/s/<id>` and subagent sub-pages at `/s/<id>/<N>` (numbered by first task appearance; SPA routing; `/api/*`, `/health`, and `/branding` are passed to the worker first). One `GET /api/share/:id/data` loads the share, then a hibernating WebSocket streams plugin syncs (`{op:"frame", status, rev, items}`); if the socket can't connect, it falls back to 5-second polling and re-attaches when the socket returns — viewers never need to refresh. Traffic stays minimal while it does: an unchanged rev answers an empty frame (~200 bytes, poll and socket alike), a reconnect fetches only what it missed (delta first frames), and a silently-dead socket heals on tab refocus instead of freezing the page. A prompt queued behind a running turn appears the moment the host persists it (mirroring the host); on v2 hosts it appears when the model actually starts on it.
- **Local** — `tools/view-export.py` serves this same build on localhost with the session injected inline (`window.__MIRROBOT_SNAPSHOT__`): an exported session renders exactly like a live share, no server, no network beyond localhost.

## Data contract

Everything renders one shape: the share `Data[]` items — the same items the plugin streams, the worker stores, and the export tool injects. Items merge client-side **by key** (identity-preserving smart sync: a no-op frame returns the same containers, unchanged items keep their folded objects and rendered components, so expansion state and scroll position survive every update); `del` tombstones remove undone work; the fold re-runs on every frame so the revert pointer (carried on the session item, `info.revert`) keeps undone turns folded exactly like opencode's own session view.

## Status badges

`live` → `completed` / `error` (set by the plugin on turn settle; the next busy flips live again), `interrupted` (the plugin vanished without goodbye — the worker finalizes after the grace window), `gone` (deleted or TTL-expired — the page says so, final).

## What the page does

- **Eleven views, one base** — classic and reader in the standard chrome plus nine full-page skins (terminal, casefile, blueprint, cinema, timeline, letterpress, atlas, teletype, grove). Every skin is a reskin of the shared base — data, paging, search, settings, virtualization come from the SDK ([`src/views/README.md`](src/views/README.md) is the contract; a complete view is one file, ~30 lines).
- **Virtualization everywhere** — continuous mode windows rows as you scroll (`src/timeline-v2.tsx`), paged mode windows inside a giant turn, and the composed skins window two-level (sections + entries, `src/section-window.tsx`). Multi-thousand-message shares cost the same DOM as small ones.
- **Prompt rail** — a floating pill beside the transcript whenever there's more than one prompt: paged mode pages, continuous mode fast-skips. `[`/`]` and `j`/`k` jump prompts in every view.
- **Agent attribution** — the plugin stamps the resolving agent on task parts and agent switches (`metadata.agent`, rank-joined at sync time); the viewer renders agent-switch event rows and real subagent names without inferring anything (the viewer stays dumb by design). Task rows link to the subagent's sub-page.
- **Tool rendering** — read/write/edit/patch share **one FileCard** (kit `File` component): real file line numbers (plugin-stamped offsets), the host's own unified patches for edits (4 context lines), text bodies for reads/writes, and one highlighting engine (the kit's shiki worker pool). Grep/glob/list render preformatted output; todo lists render as checklists. Failed tools show their error text.
- **Scroll behaviour** — the title and footer live in the transcript flow; tool outputs contain their own wheel scrolling (horizontal-only scrollers don't chain); changing a setting or a live sync keeps the reader exactly where they were (measured-row snapshots + identity-preserving merge); no unpainted pop-in blocks while scrolling.
- **Reader settings** (gear or Ctrl+K, `osh_settings` cookie, 1 year, read pre-paint so there's no theme flash): theme (system/light/dark/mirrobot/midnight/sepia/nord), view, paged mode (per view), prompt rail, follow-live, text and reading sizes, diff layout (auto/split/unified), reasoning auto-open, tool info, auto-expand tools (a checklist of known + this session's tools), long-line scroll/wrap, content centering, background image — plus view-scoped settings rendered from each view's registration (classic: tool grouping + scope; grove: which side thinking sits on).
- **Branding** — the deployment's skin from `/branding`: logo chip, footer wordmark, favicon, accent, login and gone pages, and social/link previews (the worker injects og tags for crawler user-agents; the viewer does the same client-side as a fallback). Default is the neutral upstream look; see [`../share-worker/branding-example/`](../share-worker/branding-example/).

## Building

```bash
npm install
npm run build   # vite build + scripts/build-themes.mjs → dist/
```

`npm run dev` starts the vite dev server for UI iteration — note it has
**no API proxy**: pages render from local state, but `/data` and the
WebSocket call the origin and fail unless you wire a live worker in
`src/data-source.ts`. For a realistic local page, prefer
`python tools/view-export.py` (serves the built dist with real data).

Deploying is nothing special: `wrangler deploy` in `share-worker/` picks up `../share-viewer/dist` as assets. Rebuild after changing viewer code, then deploy.

## Layout

| File | Role |
|---|---|
| `src/entry.tsx` | pre-paint settings read (no theme flash), mount |
| `src/app.tsx` | page shell, the classic/reader chrome, branding, search + j/k |
| `src/data-source.ts` | live vs local sources, WS attach + poll fallback, auth flow, smart-sync merge |
| `src/fold.ts` | item merging, revert-pointer folding, the `Data[]` contract |
| `src/timeline-v2.tsx` | the virtualized continuous timeline (keyed rows, snapshot restore) |
| `src/section-window.tsx` | two-level virtualization for the composed views |
| `src/tool-overrides.tsx` | the FileCard + tool renderers registered over the kit |
| `src/hover-rail.tsx` | the prompt rail (paging / fast-skip) |
| `src/settings.ts`, `src/settings-panel.tsx` | settings cookie + the shared gear/Ctrl+K panel |
| `src/views/` | the views SDK: registry, ViewContext, chrome primitives, and the nine skins — see [`src/views/README.md`](src/views/README.md) |
| `src/copy-markdown.ts`, `src/subagent-map.ts`, `src/toggle-anchor.ts` | shared helpers (markdown export, agent attribution, disclosure anchoring) |
| `scripts/build-themes.mjs` | theme CSS build (bundler-safe file URLs) |
| `scripts/vendor-v2.mjs` / `vendor-solid.mjs` | deterministic vendoring + fork re-application (run via `npm run vendor`) |

(Key files — `reader.tsx` and the smaller view helpers live alongside these.)

## Vendored components

`vendor/` carries the opencode **v2** kit (`session-ui-v2`, `ui-v2`,
`client-v2`, `util-v2`) plus a **vendored solid-js** (snapshot-loop fix
for a re-entrant disposal crash — see
[`../DEVELOPMENT.md`](../DEVELOPMENT.md)), all under upstream licensing
(MIT), modified only where surgical forks require it. Regenerate with
`npm run vendor`; provenance in `vendor/V2-SOURCE.txt`. The theme
builder and data source are OpenShare's own.
