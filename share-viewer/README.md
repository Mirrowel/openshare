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

- **Twelve views, two cores** — the two core reading surfaces are classic and conversation (the ported conversation-view design: TurnNav sidebar, hover previews, focus overlay). Reader and nine full-page skins (terminal, casefile, blueprint, cinema, timeline, letterpress, atlas, teletype, grove) ride the same SDK — data, search, settings and virtualization come from the base ([`src/views/README.md`](src/views/README.md) is the contract; a complete skin is one file, ~30 lines).
- **Virtualization everywhere** — continuous mode windows rows as you scroll (`src/timeline-v2.tsx`), paged mode windows inside a giant turn, and the composed skins window two-level (sections + entries, `src/section-window.tsx`). Multi-thousand-message shares cost the same DOM as small ones.
- **Prompt nav** — one control, two states: the floating pill or the sidebar (drag its edge to resize; toggle from the popover or the sidebar header; from one turn upward one of the two is always present). Rows preview each response on hover; shift+click, the row's reticle, or right-click → "Focus on turn" opens focus mode (classic): one turn as an overlay with prev/next over the still-mounted transcript. `j`/`k` and `[`/`]` are aliases everywhere, smooth per the smooth-scrolling setting. Subagent pages pin a back-to-parent row that returns to the exact spawning turn.
- **Agent attribution** — the plugin stamps the resolving agent on task parts and agent switches (`metadata.agent`, rank-joined at sync time); the viewer renders agent-switch event rows and real subagent names without inferring anything (the viewer stays dumb by design). Task rows link to the subagent's sub-page.
- **Tool rendering** — read/write/edit/patch share **one FileCard** (kit `File` component): real file line numbers (plugin-stamped offsets), the host's own unified patches for edits (4 context lines), text bodies for reads/writes, and one highlighting engine (the kit's shiki worker pool). Grep/glob/list render preformatted output; todo lists render as checklists. Failed tools show their error text.
- **Scroll behaviour** — the title and footer live in the transcript flow; tool outputs contain their own wheel scrolling (horizontal-only scrollers don't chain); changing a setting or a live sync keeps the reader exactly where they were (measured-row snapshots + identity-preserving merge); no unpainted pop-in blocks while scrolling.
- **Reader settings** (gear or Ctrl+K, `osh_settings` cookie, 1 year, read pre-paint so there's no theme flash): theme (system/light/dark/darker/mirrobot/midnight/sepia/nord; darker is the dark tokens one step down), view, paged mode (per capable view; classic is continuous + focus), prompt nav (sidebar by default, drag-resized, or the pill - toggled inside the control; ghost mode rests the pill invisible until approached (it pings once per page load while on), hover-preview line counts from the nav gear in both states; selecting a turn scrolls to it in every view, far turns revealed by the section window), follow-live, reasoning auto-open, tool info, auto-expand tools (a checklist of known + this session's tools), content centering, background image — plus view-scoped settings rendered from each view's registration (grove: which side thinking sits on). The transcript section: tool grouping as an off/custom/all lever (custom collapses only the checked tools - an animated checklist, prefilled with reads & searches), paged mode, auto-expand, tool info, follow-live, reasoning. Task cards use the kit's own hover chevron (native reveal) plus a 1px accent underline expanding along the card's bottom edge - centered, a quarter of the card's width. File cards: the kit FileIcon in the title, the directory reading BEFORE the file name (session-relative, start-truncating when long; the name never truncates), and the card controls (diff mode U/A/S, the wrap toggle) beside the filename; the conversation view keeps its name-first titles. The collapsed tool row shows the full session-relative directory. Subagent pages share the main view's nav (the parent prompt pinned first, click returns to the spawning turn) and the classic subagent header reads: version/model/date on one line, then title, a "subagent" tag, and the back-to-parent pill. Header text is selectable for copying. A view opts into the shared tinted code surface via its registration (Skin.codeSurface; conversation uses it). The debug section holds a two-step Reset-all-settings (wipes the cookie, applies defaults live). The reading & layout group: interface scale (75-150%) and reading text (12-24px) as live sliders, file card width (20-80rem slider), and two-position levers for prompt style (bubble/flat) and smooth scrolling (instant/near/always - always animates long jumps too). The nav config (gear in the sidebar header or the pill pop-open) adds: hover-preview sizes, row content (prompt 1-5 lines, response 0-5 inline), the prompts-only filter toggle, and ghost mode. The header search palette (button left of copy, or /) is in every view's masthead, classic and conversation included: it searches prompts, responses, thinking and tool body text with toggleable scopes and jumps to the matched part (falling back to the turn when a part cannot mount, then retrying so the flash lands on the match). Subagent content stays out of the index (current view only). Agent labels resolve from the plugin's authoritative metadata.agent stamp at FOLD time - every view and every reload path reads the same resolved name. The sidebar-to-content gap is 14px and the pill-to-content gap 7px; nav turn numbers baseline-align with their label's first line; the prompt nav shows from one prompt. Marks are painted with the CSS Custom Highlight API - browser-find yellow, no DOM rewriting, so layout never shifts and virtualizer measurements stay stable (a <mark> fallback covers old browsers) - and persist after the palette closes. The engine waits for typing to settle (~900ms), then opens the rows a hit lives in BEFORE they reach the screen: matching disclosures are pre-seeded from the hit data, so a hit row renders already open on its first paint and scrolling never expands anything (verified: zero expansions across a full-transcript scroll). Rows whose kit disclosure key cannot be derived from the data are opened during the settle pass while they are still offscreen. A dense query (>24 hits, e.g. one character) skips pre-seeding and falls back to opening at most the nearest dozen rows per pass. A manual collapse sticks for that search and a new search re-expands. Result rows are 12px with the selection kept in view as you walk it with the keyboard. Disclosure ownership makes search-opened rows close reactively on clear, remounts included. Esc ends the search even after clicking away or jumping, clicking away closes without clearing, and the clear button ends it from inside. Opening a different session/subagent resets the search. The pill pop-open carries a reading rail: a hairline track with an accent block spanning the active turn row. Long-line overflow, diff layout (per-card U/A/S) and the per-tool file overflow are card-level toggles only - not panel settings.
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
| `src/hover-rail.tsx` | PromptNav — the pill/sidebar prompt navigation |
| `src/views/conversation*.tsx` | the conversation core view (TurnNav, focus overlay, own header) |
| `src/parent-link.ts` | resolves the spawning parent turn for subagent back-links |
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
