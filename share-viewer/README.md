# Open(code)Share viewer

The share page your viewers open, built on the vendored opencode session UI and adapted for the OpenShare protocol. One build serves live pages on the share worker and local snapshots via the export tool, with the same rendering and settings.

## How it runs

- **Live** — the share worker serves this build as static assets (`share-worker/wrangler.toml` → `[assets] directory = "../share-viewer/dist"`). Pages live at `/s/<id>` and subagent sub-pages at `/s/<id>/<N>` (numbered by first task appearance; SPA routing; `/api/*`, `/health`, and `/branding` are passed to the worker first). One `GET /api/share/:id/data` loads the share, then a hibernating WebSocket streams plugin syncs (`{op:"frame", status, rev, items}`); if the socket can't connect, it falls back to 5-second polling and re-attaches when the socket returns — viewers never need to refresh.
- **Local** — `tools/view-export.py` serves this same build on localhost with the session injected inline (`window.__MIRROBOT_SNAPSHOT__`): an exported session renders exactly like a live share, no server, no network beyond localhost.

## Data contract

Everything renders one shape: the share `Data[]` items — the same items the plugin streams, the worker stores, and the export tool injects. Items merge client-side **by key** (idempotent — a replayed frame is a no-op); `del` tombstones remove undone work; the fold re-runs on every frame so the revert pointer (carried on the session item, `info.revert`) keeps undone turns folded exactly like opencode's own session view.

## Status badges

`live` → `completed` / `error` (set by the plugin on turn settle; the next busy flips live again), `interrupted` (the plugin vanished without goodbye — the worker finalizes after the grace window), `gone` (deleted or TTL-expired — the page says so, final).

## What the page does

- **Classic and Reader**: two presentations of the same scrollable, virtualized conversation. Reader uses a narrower editorial column and unboxed prompts; both share file rendering, live updates, navigation and disclosure state. The existing artistic skins remain available through the view selector.
- **Prompt navigation**: selecting a prompt jumps to its turn and briefly highlights it. The navigator tracks the current turn as you scroll. On mobile, a compact turn picker replaces the sidebar. Syntax highlighting, KaTeX, markdown and diff workers are bundled, with no CDN.
- **Focus on turn**: use a prompt entry's actions menu or right-click it to show only that prompt and its responses. Previous/next controls move between turns. Back to conversation, or Escape, restores the previous reading position.
- **Collapsible Turns**: the desktop sidebar folds into a centered tick rail with prompt and response previews. Phones keep the turn picker. File changes appear in their inline tool cards, not a session-wide review panel.
- **Multi-session shares**: the turn navigator lists only the current session's prompts. A subagent's navigator adds one parent-turn link above its own prompts; that link and Back to parent return to the spawning prompt. Task-row links open sub-pages (`/s/<id>/<N>`) and respect the new-tab preference. Subagent status and the parent action sit on the right of the session header.
- **Read auth gate** — auth-gated shares answer `401 {authRequired}`: the viewer swaps to a login form, exchanges credentials for a 7-day cookie, and resumes; repeated failures lock out (429 → "locked"). The gate never grants write access.
- **Reader settings** (gear panel, `osh_settings` cookie, 1 year): theme (system/light/dark/mirrobot/midnight/sepia/nord), follow-live, text and reading sizes, automatic/split/unified diffs, reasoning auto-open, per-tool auto-expansion, tool info visibility, content centering, and tool grouping for reads/searches or all calls. Search filters the prompt navigator without removing responses from the transcript.
- **Tool rendering** - read/write/edit/patch show their content (read: the file body; edit/write: the annotation above a collapsible diff with +added/−removed), grep/glob/list render preformatted output on a surface (no markdown paragraph inflation), and todo lists render as checklists. Edits default to collapsed so a long diff never eats the page.
- **Large inline diffs**: diffs over 500 lines render only the viewport and a surrounding buffer using Pierre's line virtualization. The full scroll height is preserved, and small diffs keep their existing renderer. The diff virtualizer uses the transcript scroll container rather than the tool's horizontal-scroll wrapper.
- **Scroll behaviour**: the title and footer scroll with the transcript. Long tool outputs scroll horizontally without trapping vertical wheel scrolling. Row measurements and scroll snapshots preserve the reading position through settings changes and focus/return.
- **Branding** — self-hosters can rebrand: the worker serves `/branding` (name + wordmark image) and the page renders it in the footer/title when present.

## Building

```bash
npm install
npm run build   # vite build + scripts/build-themes.mjs → dist/
```

`npm run dev` starts the Vite dev server. Open `/?demo=1` for a sample
conversation without a backend. Live shares need a backend at the same
origin; there is no API proxy. To preview an exported session, use
`python tools/view-export.py` with the built viewer.

Deploying is nothing special: `wrangler deploy` in `share-worker/` picks up `../share-viewer/dist` as assets. Rebuild after changing viewer code, then deploy.

## Layout

| File | Role |
|---|---|
| `src/entry.tsx` | pre-paint settings read (no theme flash), mount |
| `src/app.tsx` | shared Classic/Reader shell, focused turns, skin routing, branding |
| `src/reader.tsx` | Reader presentation over the shared timeline |
| `src/turn-nav.tsx` | desktop prompt rail, mobile picker, turn actions |
| `src/timeline-v2.tsx` | virtualized rows, prompt jumps, active turn tracking, live-follow |
| `src/data-source.ts` | live vs local sources, WS attach + poll fallback, auth flow |
| `src/fold.ts` | item merging, revert-pointer folding, the `Data[]` contract |
| `src/settings.ts`, `src/settings-panel.tsx` | settings cookie + gear panel |
| `src/views/` | existing artistic skins, shared section model, session info |
| `scripts/build-themes.mjs` | theme CSS build (bundler-safe file URLs) |

## Vendored components

`vendor/` carries upstream `@opencode-ai` packages (`ui`, `session-ui`,
core utils, SDK types) vendored for the client-only build — they are
upstream code under upstream licensing (MIT), modified only where the
adapter layers require it. The theme builder and data source are
OpenShare's own.
