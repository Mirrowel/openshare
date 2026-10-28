# OpenShare — development notes

Working on the repo? This is the map. User-facing docs: [README](README.md).

Working on the repo? This is the map. User-facing docs: [README](README.md). The complete configuration surface across all packages: [CONFIGURATION.md](CONFIGURATION.md).

## Repo layout

```
share-plugin/          the opencode plugin (@mirrowel/opencode-openshare)
  src/core.ts          the engine: session tracking, fan-out transports,
                       spool/replay, turn lifecycle, tombstones, backfill
  src/config.ts        config chain + servers group + enrollment persistence
  src/contract.ts      the OpenShare item contract (v: 2 envelope, message/
                       diff normalization, tombstone shape) — shared truth
                       for plugin, worker, Bun server, and viewer
  src/server.ts        v1 entry ({ id, server, setup })
  src/tui.tsx          v1 TUI entry  ({ id, tui, setup })
  src/v2-server.ts     v2 adapter: fine-grained events → engine, v2 client → v1 SDK
  src/v2-tui.ts        v2 TUI adapter
  src/share-flow.ts    share/unshare/verify flows + admin API client
  src/commands.ts      /share + /openshare command surfaces
  src/dialogs.tsx      MenuDialog/InfoDialog/PromptDialog + sizing core
  src/settings.ts      the grouped settings tree
  src/ui-prefs.ts      menu size prefs (host kv)
  src/sidebar.tsx      the session-sidebar chip
  ci/openshare.js      the committed single-file CI bundle (build artifact,
                       tracked by design — the zero-build install path)
share-worker/          Cloudflare Worker backend (worker.js, wrangler.toml)
share-server/          portable Bun backend (server.ts + Dockerfile)
share-viewer/          vendored upstream share page (vite + solid)
  src/views/           the viewer views SDK + nine skins (see views/README.md)
tools/                 agent-side export/local-view companion
```

`share-worker/worker.js` and `share-server/server.ts` implement the **same
protocol** — any protocol change must land in both (the parity suites
enforce it: the same auth/enroll suites run against both backends).

## Test suites

`npm test` (matrix driver, ~4.5 min) / `npm run test:quick` (~90s).

| Suite | Covers |
|---|---|
| regression | parity: legacy single file == standalone build == package (== package-dir via file:// URL) |
| manual (core/allmode/engine shards) | dormancy, flag/backfill, unshare, re-share, read-auth opts, all-mode gating, undo tombstones, completed debounce, turn sockets, finalize, queued-prompt ordering (S13) |
| tui-flow | share/manager flows, config write targets, enrollment, admin console, gone detection, size prefs |
| v2-mock | the v2 adapter against a scripted mock v2 host (incl. inbox queue semantics: held until `session.inbox.delivered`, cancelled never surfaces) |
| auth (×backends) | identity: enroll, codes, rotate, freeze, limits, reassign, request caps, the since/delta handshake — 80 checks, CF + Bun |
| enroll | plugin enrollment lifecycle vs a real worker (private + public) |
| fanout | dual workers, mid-session join backfill, opt-outs, collisions |
| big (×backends) | scale: ~3k items incl. MB-size parts through sharded storage — full `/data`, zero stuck revs |
| cli / npm-e2e (on demand) | real `opencode run` with the CI bundle / package; the published npm package by registry spec (`node scripts/npm-e2e.mjs` — no npm alias by design: on-demand only) |

Note what CI actually gates: the GitHub workflow runs typecheck + build + pack dry-run (`npm run ci`) — **no test suites run there** (they need opencode + wrangler + port access). The matrix is a local-before-commit obligation.

Suite rules of the road (all learned from live failures):

- Every spawn gets **all three** XDG homes redirected — config alone is not isolation on opencode ≥1.18 (global plugin merge, machine-wide session DB, instance-lock port bumps).
- Ports: fast TCP probes gate every sweep; sweeps only run when a port is actually occupied; the matrix driver assigns disjoint port ranges per suite.
- `opencode run` retries 5xx with its own 2+4+8+16+32s backoff — mock failures use non-retryable 4xx when testing the error path.
- Wrangler supervisors survive tree-kills and respawn workerd — kill by command line, then sweep the port.
- Two wrangler instances share `.wrangler/state` unless `--persist-to` isolates them.
- Real-inference checks are on-demand scripts, never part of the default matrix.

## Viewer v2 kit + visual verification

`share-viewer` renders on the vendored **opencode v2 component kit** (`vendor/session-ui-v2`, `vendor/ui-v2`, `vendor/client-v2`, `vendor/util-v2`) plus a **vendored `solid-js`** (`vendor/solid`, aliased in vite — see below). Regenerate deterministically from the beta checkout with `npm run vendor` (= `vendor-v2.mjs` + `vendor-solid.mjs` + `bun install`; provenance in `vendor/V2-SOURCE.txt`). The `bun install` step is mandatory because bun copies `file:` dependencies, so the vendored tree in `node_modules/@opencode/*` goes stale otherwise and the build keeps using the old code (live-caught). The scripts re-apply every fork after copying and throw loudly when an upstream anchor drifts (anchors read sources with CRLF normalized to LF, otherwise the whole port fails on the first anchor); keep forks surgical (insert call sites, never rewrite a whole upstream function - a full rewrite silently dropped upstream's `thoughtOnly` guard and trailing notices across rev bumps). `scripts/link-vendor.mjs` links `node_modules/@opencode/*` to `vendor/*` rather than letting bun copy them, so a shared dependency can never exist twice (two `@pierre/diffs` instances killed every file-card body, two `effect` instances crashed subagent pages). Pinned rev: v2.0.0 lineage, `process-daemon-v0.3.2-12-ga882cf98a0` (see `vendor/V2-SOURCE.txt`). Dependency versions in the generated package.json are read from the beta's own package (`catalog:` resolved), so a kit bump brings its peers along.

Current session-ui forks (audit with `rg -n "fork|openshare" scripts/vendor-v2.mjs`): projection (per-assistant-message grouping, category `only` refinement, no top-level read/file groups with an explicit detail, todos renderable, agent-switch event rows), session-timeline-row (upstream spacing classes dropped in favor of `app.css` attribute-keyed spacing), tool-renderer (read/search rows keep their real renderer through `ToolDisplay`, todos not dropped, grouped rows expandable). Dropped on purpose in the 2026-10-24 hygiene round: the spacing-class *removal* (unlayered CSS wins the cascade anyway), the agent-registry module (the fold now stamps `state.input.agent` — plugin-stamped, viewer dumb), the reasoning prewarm (collapsed bodies unmount, so it prewarmed nothing), and the todos i18n patch (merged in `entry.tsx`).

**Why solid-js is vendored**: Solid's `cleanNode` walks `node.owned`/`node.cleanups` with live loops; a re-entrant disposal nulls the arrays mid-walk and the next iteration throws `null[i]`, killing the whole reactive flush (a half-updated page with a stuck status, live-caught; opencode itself patches the same defect in its own dependency). `vendor-solid.mjs` patches `cleanNode`/`dispose` to snapshot-loop — 6 lines — and writes TWO variants: `vendor/solid/solid.js` (build) and `vendor/solid/dev.js` (dev server: unminified, dev warnings, readable stack traces); `vite.config.ts` picks by command and pins the exact-match alias `/^solid-js$/` so the bundle uses the patched copy and `node_modules` stays pristine.

**Viewer dev/probe workflow**: `npm run dev` + `?demo` on any `/s/<id>` path renders the built-in fixture share (`src/demo.ts`) — no worker, no auth, no live data needed. `vite.config.ts` excludes the vendored `@opencode/*` packages from esbuild's dep scanner (it cannot parse their `?worker&url` imports) while force-including `@pierre/diffs` and `lru_map` for CJS interop. For headless verification against the REAL production bundle, serve `dist/` from an in-process http server and inject the demo fixture as `window.__MIRROBOT_SNAPSHOT__` through an HTML wrapper (the local-mode contract) — no child processes, no vite, no stray windows. `PRODUCT.md`/`DESIGN.md` at the repo root carry the product design context (register: product).

Two more hard rules learned live:

- **Import vendored code by package specifier only** (`@opencode/session-ui/...`) — a relative path into `vendor/` creates a second module id (bun `file:` symlinks), which means two `createContext` instances and "context must be used within a context provider" at runtime.
- The viewer has its own typecheck gate (`npm run typecheck` in `share-viewer`, via `bunx tsc`) — run it after every viewer change; it caught a missing import the browser only surfaced as an undefined-symbol crash.

**Live search** (`src/search-state.ts` + `src/search-palette.tsx`): the palette computes hits from DATA per section/scope and publishes matched part ids, file paths, message ids and section ids; the engine paints ranges through the CSS Custom Highlight API (DOM `<mark>` fallback, no padding so layout and virtualizer measurements never move) and opens the rows a hit lives in. **Pre-seeded disclosure** is the mechanism: `timeline-v2`'s and `vendored-part`'s disclosure accessors consult `searchOwnsDisclosure(key)` (any hit part id contained in the key, path-keyed cards by path, message/section ids for kit group keys) so a matching row is open on its FIRST paint - nothing expands on arrival. Native `<details>` reasoning (composed skins) reads the same helpers reactively and records manual toggles through `dismissSearchKey`; dismissal takes precedence over both pre-seed and engine ownership. Pre-seeding is gated to a settled query with `<= 24` hits (per-keystroke publishing would pre-open rows mid-typing; a one-character query would pre-open the whole cache). Expansion is gated three ways - a 900ms typing settle, a viewport+overscan window capped at the nearest 12 rows per pass, and once-per-settled-query evaluation so a manual collapse sticks. Rows the virtualizer mounts are expanded on an rAF fast path, which is what keeps scrolling free of pop-in. Ownership is tracked per disclosure key (`claimDisclosure`/`disclosureOwned` consulted by `timeline-v2` and `vendored-part`), so clearing the search closes search-opened rows reactively and a remount cannot resurrect them; grouped containers open their collapsibles without consuming member ids (consuming them suppressed every member expansion under grouping). The engine binds to the VISIBLE transcript scroller (focus overlay and responsive duplicates leave hidden ones mounted). Jumps resolve the part, fall back to the section/message, then retry so the flash lands on the match; a section far outside the window is revealed by `WindowedSections`' `reveal` request (estimate, mount, align). Prompt/response hits publish no part id, and tool name-only matches (e.g. "bash" rendered as "Shell") publish no part id - both would expand rows with nothing to highlight.

**Views SDK**: skins are reskins over one base — `src/views/README.md` is the contract (ViewContext, chrome primitives, registry, per-view settings schema). `classic` and `reader` live in the standard chrome (`app.tsx`); the nine composed skins live in `src/views/` and register via `registerSkin()`.

Visual verification rig (lives outside the repo; rebuild from this description when needed): a `share-viewer` build served by an in-process static server with a rich contract-v2 fixture share, then playwright-core over real Edge. Two instruments:

- **Fingerprint** (`snap`/`diff`): renders every view on the fixture (12 entries: classic, reader, conversation, nine skins) and hashes text + structure — any shared-code refactor must keep every view identical (deliberate unifications are listed in the commit, nothing else moves). Text hashes are blind to pure-layout breaks — pair with the gate's computed-style checks.
- **Gate**: behavioral assertions (settings schema per view, Ctrl+K, search parity, rail, agent labels, headers-are-flex-rows, zero page errors).

### Diff review view — removed (2026-10-24), optional future

A diff review panel (per-session changed-files view) existed briefly in classic + all skins and was removed by owner decision. Why: the only reconstructable data is the **per-edit tool-part patches** (`metadata.files[].patch`), so any aggregation is last-write-wins per file — not a true session-cumulative diff. Producing a real cumulative diff requires shipping **full file contents** in the share, which was rejected on privacy grounds. If ever revisited as an optional, opt-in-per-share feature: the v2 host API `session.diff()` (typed, FileDiffInfo[]) is the intended source — v1.18's `client.session.diff` is a hardcoded stub returning `[]` unconditionally (see `upstream-reports/`), and its `session.diff` event only fires on revert/compaction, so v1 hosts can never feed it. The `session_diff` item type remains in the contract and is still folded into the share data — only the dedicated panel was removed.

## Release workflow

Lifted from the family (agent-variants/config-studio), adapted to the monorepo (the package lives in `share-plugin/`):

- Conventional commits drive semver (`feat` → minor, `fix`/`perf` → patch, `BREAKING CHANGE:`/`!` → major) — `.github/scripts/compute-version.sh`.
- Channels: `master` → `latest`; `dev`/`alpha`/`beta`/`rc` branches → `0.x.y-<channel>.N` prereleases under the matching npm tag (`main` maps to `latest` too; `canary` is available via manual workflow dispatch, not a push trigger).
- `share-plugin/.release.json` pins the next intended version (`npm run release:intent -- <version|patch|minor|major>`); CI refuses drift. Set **above** the latest stable tag, `"next"` is an exact pin: that version releases regardless of what the commits would compute (holding a fix round at 0.2.1 under a feat-heavy range). The pin is self-consuming — once that version ships, latest == next and auto versioning resumes. At or below latest it acts as a floor only (`max(intent, prerelease line, auto bump)`).
- Publishing uses npm trusted publishing (GitHub OIDC) — no tokens stored. First publish was bootstrapped manually; everything after goes through the workflow.
- Release notes: git-cliff (`.github/cliff.toml`) grouped by commit type.
- `ci/openshare.js` is a **tracked build artifact** — rebuilds land in the same commit as their source changes.

Gotchas already paid for:

- `grep -q` exits on first match → SIGPIPE for the producer → **pipefail** flips the pipeline to failure on large inputs. Use `grep -E … > /dev/null`.
- The repo path contains a space — spawned commands with `shell:true` must use relative or properly quoted paths.
- `.gitattributes` forces LF for `*.sh`/`*.mjs`/`*.yml`/`*.toml` (the workflow scripts run on `ubuntu-latest`).

## Server policy internals

The worker resolves and delivers the connection policy (`/health` + the WS init ack); the plugin clamps itself into it. The canonical var table (`SOCKET_POLICY`, `TURN_GRACE_MS`, `IDLE_DROP_MS`, `FINALIZE_AFTER_MS`, the debounce/completed clamp window) lives in [`share-worker/README.md`](share-worker/README.md#server-policy).

Per-turn sequence in `turn` mode: prompt → connect/warm → stream → idle → content flushes immediately (status stays `live`) → `completedDelayMs` → completed/error flush → `TURN_GRACE_MS` grace (busy inside keeps the socket) → clean drop; the next event reconnects with spool replay.

## Host-integration notes (v1/v2)

- Plugin loading: server plugins from `opencode.json` layers, TUI plugins from `tui.json` layers — that split **is** the share-mode switch (presence detection scans tui.json layers; no selfwiring). In `opencode run` sandboxes, plugins load via `OPENCODE_CONFIG`; a redirected `XDG_CONFIG_HOME` alone silently loads NO plugins.
- The package exposes dual entries: `{ id, server, setup }` and `{ id, tui, setup }`; v2 hosts load `./server`'s `default.setup` with the v2 context and auto-discover `./tui` via the `oc-plugin` field in package.json.
- v1 public session PATCH accepts `title`/`metadata`/…; the share binding lives in `metadata.openshare` (binding v2: a `servers` map; legacy flat bindings migrate at read).
- The 1.19.x plugin API imports the **v2 SDK** (`@opencode-ai/sdk/v2`) — client calls are flat-args and the path param is `sessionID` (see `src/sidebar.tsx`, the only v2-SDK import; the TUI adapter itself uses structural types, `src/v2-types.ts`).
- v1 SDK client calls are hey-api shaped (`{path: {id}}` / `{path, body}`) and error envelopes don't throw — check `.error` or you fail silently (live-caught as literal `%7Bid%7D` URLs). The client can hit a foreign server when something else squats the target port — degrade loudly, the spool covers.
- v1 empirical event facts (1.18.x): `message.info.parentID` = the replied-to message; only session `info.parentID` marks subagent children. Task parts carry `state.metadata.sessionId` (the child session). Resumed sessions may emit the user message BEFORE any `session.*` event — unknown sids are treated as main (children announce first).
- v2 CLI: `opencode plugin add/remove/list/update` exist on v2 hosts; v1 hosts have only the positional `opencode plugin <module>` (writes opencode.json, not tui.json) — docs therefore teach config-file edits for v1 and the commands for v2.
- TUI dialogs/menus must be built with the **Bun solid transform** (`scripts/build-tui.mjs`) — plain tsc output loses the reactive compilation (`_$effect` blocks) and rows stop tracking state.
- The host dialog panel renders plugin content with its own padding — borderless family-style frames avoid the dead strip above a border.
- Upstream's ShareNext/opncd.ai remnants (`session.share`, the built-in `/share`) are the deprecated mechanism this project replaces; our `/share` shadows it by keymap priority.
- The v2 adapter (`src/v2-server.ts`) maps fine-grained `session.*` domain events onto the engine via a debounced re-sync through the client and converts v2 flat messages to the v1 message+parts Data[] contract; verified against a scripted mock v2 host (`test:v2`) — a live beta run remains the sign-off step.

## Engine behaviors worth knowing before touching core.ts

- **Idempotent keyed sync**: items are keyed (`type` + id fields); frames upsert; tombstones (`del: true` on the same key) delete and cascade parts. Revert (undo) forwards the revert pointer, the next prompt hard-deletes the range (`message.removed`/`part.removed`).
- **Single-flight connect**: `connecting` spans the whole init handshake; every frame is seq-tagged so a stale socket can never touch live state. A create ack's rev 0 is normal (the mismatch guard applies to attaches only).
- **All-mode gate**: only sessions whose first event the engine sees are auto-shared; pre-existing sessions need an explicit opt-in (with backfill). `writeBinding` preserves `optedOut` markers.
- **Epoch-guarded settle**: a pending completed flip aborts if any busy arrived since arming; a repeated idle never invalidates it (v1.18 fires status/idle pairs twice on some failure paths).
- **Self-heal**: error frames force a reconnect that replays the spool; dispose with an unready socket flushes over HTTP; the HTTP fallback merges *all* pending frames, not just the last.
