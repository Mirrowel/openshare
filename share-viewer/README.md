# Open(code)Share viewer

The share page your viewers open — built on the vendored **opencode v2 component kit** (`@opencode/session-ui` v2 + `@opencode/ui`), speaking the OpenShare protocol. One build serves three jobs: **live** pages on the share worker, **snapshots** (one offline HTML file per share), and **local** rendering of exported sessions via the export tool. Same rendering, same views, same settings either way.

Every viewer setting (the `osh_settings` cookie) is tabulated in [../CONFIGURATION.md](../CONFIGURATION.md) §5; this file covers how the viewer runs and what the page does.

## How it runs

- **Live** — the share worker serves this build as static assets (`share-worker/wrangler.toml` → `[assets] directory = "../share-viewer/dist"`). Pages live at `/s/<id>`, subagent sub-pages at `/s/<id>/<N>` (numbered by first task appearance; SPA routing). One `GET /api/share/:id/data` loads the share, then a hibernating WebSocket streams plugin syncs; if the socket can't connect, it falls back to 5-second polling and re-attaches when the socket returns — viewers never need to refresh. Traffic stays minimal: an unchanged rev answers an empty frame (~200 bytes), a reconnect fetches only what it missed (delta frames), and a silently-dead socket heals on tab refocus. A prompt queued behind a running turn appears when the host persists it.
- **Snapshot** — `GET /api/share/:id/snapshot` (append `/snapshot` to the share's API path; `?download=1` for a file download) returns ONE self-contained HTML file: the viewer bundle inlined, the share frozen as a JSON island (`window.__MIRROBOT_SNAPSHOT__` — the same embedded path the `?demo` fixture and offline exports use), and a boot shim that translates in-page navigation onto `#` hashes (`file://` pages cannot rewrite their path; subagent pages navigate via `#n<N>`). The share's terminal status, deployment branding, and (for authenticated readers of gated shares) the private-facts block all ride the island. The read gate applies exactly as `/data` — gated shares demand a logged-in reader, no bypass. On `file://` browsers block worker/wasm loading, so syntax highlighting degrades to plain text; every other surface (views, virtualization, search, turn navigation) is identical. A snapshot is a point-in-time record that outlives the deployment.
- **Local** — `tools/view-export.py` serves this same build on localhost with an exported session injected inline: no server, no network beyond localhost.

## Data contract

Everything renders one shape: the share `Data[]` items — the same items the plugin streams, the worker stores, and the export tool injects. Items merge client-side **by key** (identity-preserving smart sync: a no-op frame returns the same containers, unchanged items keep their folded objects and rendered components, so expansion state and scroll position survive every update); `del` tombstones remove undone work; the fold re-runs on every frame so the revert pointer (carried on the session item, `info.revert`) keeps undone turns folded exactly like opencode's own session view.

**Private block.** Machine-local facts (the session's directory/worktree) never ride the public `session` item. They arrive in the envelope's top-level `private` block, which the backends only send to readers who passed the share's read gate; ungated shares never carry it, and paths render without relativization. A `pmeta` item is the plugin-side carrier — it never appears as a data item. The info panel shows the share id, not session ids.

## Status badges

`live` → `completed` / `error` (set by the plugin on turn settle; the next busy flips live again), `interrupted` (the plugin vanished without goodbye — the worker finalizes after the grace window), `gone` (deleted or TTL-expired — the page says so, final).

## Views and navigation

- **Twelve views, two cores** — the two core reading surfaces are classic and conversation (the ported conversation-view design: TurnNav sidebar, hover previews, focus overlay). Reader and nine full-page skins (terminal, casefile, blueprint, cinema, timeline, letterpress, atlas, teletype, grove) ride the same SDK — data, search, settings and virtualization come from the base ([`src/views/README.md`](src/views/README.md) is the contract; a complete skin is one file, ~30 lines).
- **Virtualization everywhere** — continuous mode windows rows as you scroll (`src/timeline-v2.tsx`), paged mode windows inside a giant turn, and the composed skins window two-level (sections + entries, `src/section-window.tsx`). Multi-thousand-message shares cost the same DOM as small ones.
- **Prompt nav** — one control, two states: the floating pill or the sidebar (drag its edge to resize; toggle from the popover or the sidebar header; from one turn upward one of the two is always present). Rows preview each response on hover; ctrl+click, the row's reticle, or right-click → "Focus on turn" opens focus mode (classic): one turn as an overlay with prev/next over the still-mounted transcript. `j`/`k` and `[`/`]` jump turns everywhere, smooth per the smooth-scrolling setting. Subagent pages pin a back-to-parent row that returns to the exact spawning turn.
- **Deep links** — ctrl+click a message to copy a link to its start (holding Ctrl outlines message bodies so the gesture is discoverable). The URL carries `#row=<projection key>`; opening it scrolls that exact row into view, expands it if collapsed, and flashes it. Row keys come from session data, so links survive reloads and deployments; a share never stores the anchor. Continuous modes only.

## Reading

- **Tool cards** — read/write/edit/patch share **one FileCard** (kit `File` component): the kit FileIcon in the title, the directory reading before the file name (session-relative, truncating from the start when long; the name never truncates), the host's own unified patches for edits (real line numbers), text bodies for reads/writes, and one highlighting engine (the kit's shiki worker pool). The card controls (diff mode U/A/S, the wrap toggle) sit beside the filename. Media payloads (image/svg/audio) render as media, not base64. Markdown images and `$math$` / `$$display$$` (katex) render in assistant text.
- **Tall outputs** — file cards stop at about 25 lines with chevrons marking content above and below ("Cap tall outputs" turns the cap off). Shell, grep/glob/list and every unregistered tool (ctx_*, MCP) share one output card with copy and wrap/scroll; all of them take a bottom-edge drag handle to resize that one output (double-click resets, nothing is saved).
- **Agent attribution** — the plugin stamps the resolving agent on task parts and agent switches (`metadata.agent`, rank-joined at sync time); the viewer renders agent-switch event rows and real subagent names without inferring anything. Task rows link to the subagent's sub-page and carry per-agent colors (explore blue, general dark red, ten distinct hues beyond).
- **Timestamps** — absolute, 24-hour, shown as recorded (UTC) until the header time is clicked, which converts the whole session to the reader timezone and remembers it. Today shows the clock (`07:57`), any other day adds the date (`07:57 27 Oct`).
- **Scroll behaviour** — the title and footer live in the transcript flow; tool outputs contain their own wheel scrolling (horizontal-only scrollers don't chain); changing a setting or a live sync keeps the reader exactly where they were (measured-row snapshots + identity-preserving merge); no unpainted pop-in blocks while scrolling.

## Search

The header search (or `/`) opens a command-bar palette over prompts, responses, thinking, and tool text with scope chips. Hits paint through the CSS Custom Highlight API — the DOM never mutates, so layout and virtualizer measurements never move — and the rows a hit lives in are already open when you scroll to them (pre-seeded disclosure), with collapsed hits expanding as they enter the viewport and closing again when the query clears. Esc clears and closes; clicking out preserves the query; a selected result jumps to the matched part. Marks are browser-find yellow.

## Settings, export, branding
- **Transcript menu** - one button in every header opens three actions: copy the session as markdown, export it as an `opencode import`-ready JSON ([`tools/README.md`](../tools/README.md) has the CLI converters and the reverse direction), or download an offline snapshot.
- **Offline snapshot** - the download button assembles ONE self-contained HTML file in the browser from the page's own assets: the chunks the share can reach (its languages' grammars, its file icons), the fonts and the session frozen at that moment (~8 MB for a normal session). Double-click it on any machine and the viewer opens with no server, no network and no install. Browsers block workers on `file://`, so file bodies render as numbered plain text (edit diffs keep their colors) and every tool row starts open; the markdown parser runs a main-thread copy of its worker module. Server-side `GET /s/:id/snapshot` produces the same file for scripts and CI (see the worker README for its subrequest cost).
- **Branding** - the deployment's skin from `/branding`: logo chip, footer wordmark, favicon, accent, login and gone pages, and social/link previews. Default is the neutral upstream look; see [`../share-worker/branding-example/`](../share-worker/branding-example/).

## Building

```bash
npm install
npm run build   # vite build + scripts/build-themes.mjs → dist/
```

`npm run dev` starts the vite dev server for UI iteration — add `?demo` to any `/s/<id>` path to render the built-in fixture share (no worker, no auth, no live data). The dev server has **no API proxy**; for a realistic local page against real data, prefer `python tools/view-export.py`. `npm run preview:tools` opens the **tool gallery** (`/?preview`): every tool in every state plus whole-message feature docs (prompts, agent switch, reasoning, markdown, math, images, compaction/retry/error, grouping) rendered through the production timeline path, with the settings that change their look beside it — dev-only, no share data.

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
| `src/search-state.ts` / `src/search-palette.tsx` | the search engine + command-bar palette |
| `src/views/conversation*.tsx` | the conversation core view (TurnNav, focus overlay, own header) |
| `src/parent-link.ts` | resolves the spawning parent turn for subagent back-links |
| `src/settings.ts`, `src/settings-panel.tsx` | settings cookie + the shared gear/Ctrl+K panel |
| `src/views/` | the views SDK: registry, ViewContext, chrome primitives, and the nine skins — see [`src/views/README.md`](src/views/README.md) |
| `src/copy-markdown.ts`, `src/subagent-map.ts`, `src/toggle-anchor.ts` | shared helpers (markdown export, agent attribution, disclosure anchoring) |
| `scripts/build-themes.mjs` | theme CSS build (bundler-safe file URLs) |
| `scripts/vendor-v2.mjs` / `vendor-solid.mjs` | deterministic vendoring + fork re-application (run via `npm run vendor`). `npm run vendor:check` validates the whole port against a candidate checkout into a temp dir and reports drift without touching the tree — run it before any kit bump. |

## Vendored components

`vendor/` carries the opencode **v2** kit (`session-ui-v2`, `ui-v2`, `client-v2`, `util-v2`) plus a **vendored solid-js** (snapshot-loop fix for a re-entrant disposal crash), all under upstream licensing (MIT), modified only where surgical forks require it. What the pin is, the update ritual, and the full patch catalogue: [`vendor/VENDOR.md`](vendor/VENDOR.md). Regenerate with `npm run vendor`; provenance in `vendor/V2-SOURCE.txt`. The theme builder and data source are OpenShare's own.
