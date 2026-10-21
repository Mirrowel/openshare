# Open(code)Share viewer

The share page your viewers open — the vendored upstream opencode share page (built on `@opencode-ai/session-ui`), adapted for the OpenShare protocol. One build serves two jobs: **live** pages on the share worker, and **local** snapshots via the export tool. Same rendering, same views, same settings either way.

## How it runs

- **Live** — the share worker serves this build as static assets (`share-worker/wrangler.toml` → `[assets] directory = "../share-viewer/dist"`). Pages live at `/s/<id>` and subagent sub-pages at `/s/<id>/<N>` (numbered by first task appearance; SPA routing; `/api/*`, `/health`, and `/branding` are passed to the worker first). One `GET /api/share/:id/data` loads the share, then a hibernating WebSocket streams plugin syncs (`{op:"frame", status, rev, items}`); if the socket can't connect, it falls back to 5-second polling and re-attaches when the socket returns — viewers never need to refresh.
- **Local** — `tools/view-export.py` serves this same build on localhost with the session injected inline (`window.__MIRROBOT_SNAPSHOT__`): an exported session renders exactly like a live share, no server, no network beyond localhost.

## Data contract

Everything renders one shape: the share `Data[]` items — the same items the plugin streams, the worker stores, and the export tool injects. Items merge client-side **by key** (idempotent — a replayed frame is a no-op); `del` tombstones remove undone work; the fold re-runs on every frame so the revert pointer (carried on the session item, `info.revert`) keeps undone turns folded exactly like opencode's own session view.

## Status badges

`live` → `completed` / `error` (set by the plugin on turn settle; the next busy flips live again), `interrupted` (the plugin vanished without goodbye — the worker finalizes after the grace window), `gone` (deleted or TTL-expired — the page says so, final).

## What the page does

- **Conversation views** — classic and reader layouts plus the session-ui full-page views; syntax highlighting (shiki), KaTeX, markdown and diff workers all bundled — the dist is ~22 MB and self-contained, no CDN.
- **Multi-session shares** — subagent sessions appear in the share; each gets its own sub-page (`/s/<id>/<N>`) linked from task rows (new-tab behavior is a plugin setting), parent linked back; in-page navigation uses the URL sub-segment (popstate).
- **Read auth gate** — auth-gated shares answer `401 {authRequired}`: the viewer swaps to a login form, exchanges credentials for a 7-day cookie, and resumes; repeated failures lock out (429 → "locked"). The gate never grants write access.
- **Reader settings** (gear panel, `osh_settings` cookie, 1 year, read pre-paint so there's no theme flash): theme (system/light/dark/mirrobot/midnight/sepia/nord), view, continuous vs paged, follow-live, text and reading sizes, unified/split diffs, reasoning auto-open, tool info/output visibility, tool grouping, content centering.
- **Branding** — self-hosters can rebrand: the worker serves `/branding` (name + wordmark image) and the page renders it in the footer/title when present.

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
| `src/app.tsx` | page shell, item → renderer mapping, views, branding |
| `src/data-source.ts` | live vs local sources, WS attach + poll fallback, auth flow |
| `src/fold.ts` | item merging, revert-pointer folding, the `Data[]` contract |
| `src/reader.tsx` | reader layout |
| `src/settings.ts`, `src/settings-panel.tsx` | settings cookie + gear panel |
| `src/views/` | the registered conversation views (atlas, blueprint, casefile, cinema, grove, letterpress, teletype, terminal, timeline; `classic` is the built-in chrome layout, not a registered view) — see [`src/views/README.md`](src/views/README.md) for the view contract |
| `scripts/build-themes.mjs` | theme CSS build (bundler-safe file URLs) |

## Vendored components

`vendor/` carries upstream `@opencode-ai` packages (`ui`, `session-ui`,
core utils, SDK types) vendored for the client-only build — they are
upstream code under upstream licensing (MIT), modified only where the
adapter layers require it. The theme builder and data source are
OpenShare's own.
