# OpenShare — development notes

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
share-cli/             admin console over the worker API (stateful CLI + ink TUI)
tools/                 session interchange + offline snapshots (see tools/README.md)
```

`share-worker/worker.js` and `share-server/server.ts` implement the **same
protocol** — any protocol change must land in both (the parity suites
enforce it: the same auth/enroll suites run against both backends).

## Test suites

`npm test` (matrix driver, bounded-scheduler parallel, ~2.5 min) / `npm run test:quick` (~90s).

| Suite | Covers |
|---|---|
| regression | parity: legacy single file == standalone build == package (== package-dir via file:// URL) |
| manual (core/allmode/engine shards) | dormancy, flag/backfill, unshare, re-share, read-auth opts, all-mode gating, undo tombstones, completed debounce, turn sockets, finalize, queued-prompt ordering (S13) |
| tui-flow | share/manager flows, config write targets, enrollment, admin console, gone detection, size prefs |
| v2-mock | the v2 adapter against a scripted mock v2 host (incl. inbox queue semantics: held until `session.inbox.delivered`, cancelled never surfaces) |
| auth (×backends) | identity: enroll, codes, rotate, freeze, limits, reassign, request caps, the since/delta handshake — CF + Bun |
| enroll | plugin enrollment lifecycle vs a real worker (private + public) |
| fanout | dual workers, mid-session join backfill, opt-outs, collisions |
| big (×backends) | scale: ~3k items incl. MB-size parts through sharded storage — full `/data`, zero stuck revs |
| cli / npm-e2e (on demand) | real `opencode run` with the CI bundle / package; the published npm package by registry spec (`node scripts/npm-e2e.mjs` — no npm alias by design: on-demand only) |

What runs where: CI (`.github/workflows/ci.yml`) runs the **quick gate** on every push/PR — validate (typecheck + build + pack dry-run) then a `tests` job running `npm run test:quick` with the opencode CLI (pinned in the workflow) and wrangler (share-plugin devDependency) on the runner. The full matrix (fanout, enroll shards, big, engine shards) stays a local-before-push obligation: the quick gate covers the critical lanes, the full wave is the pre-release ritual.

Suite rules of the road (all learned from live failures):

- Every spawn gets **all three** XDG homes redirected — config alone is not isolation on opencode ≥1.18 (global plugin merge, machine-wide session DB, instance-lock port bumps).
- Ports: fast TCP probes gate every sweep; sweeps only run when a port is actually occupied; the matrix driver assigns disjoint port ranges per suite.
- `opencode run` retries 5xx with its own 2+4+8+16+32s backoff — mock failures use non-retryable 4xx when testing the error path.
- Wrangler supervisors survive tree-kills and respawn workerd — kill by command line, then sweep the port.
- Two wrangler instances share `.wrangler/state` unless `--persist-to` isolates them.
- Real-inference checks are on-demand scripts, never part of the default matrix.

## Viewer v2 kit + visual verification

`share-viewer` renders on the vendored **opencode v2 component kit** - a pinned, patched copy of upstream own packages, regenerated deterministically by `npm run vendor`. **[`share-viewer/vendor/VENDOR.md`](share-viewer/vendor/VENDOR.md) is the canonical doc**: what the pin is, the update ritual (check -> bump -> fix -> verify -> compare against the legacy build), why solid-js is vendored, the ordering/guard/import constraints, and the full patch catalogue. The script downloads the pinned commit itself (no local checkout needed; `OPENSHARE_BETA_SRC` overrides), deletes its download cache on success, fails when root package pins disagree with the vendored catalog, and throws at the exact drifted anchor on upstream moves. The `bun install` in `npm run vendor` stays mandatory (bun copies `file:` deps; `scripts/link-vendor.mjs` junctions them so a shared dependency can never exist twice). Provenance per regeneration: `vendor/V2-SOURCE.txt`.

The per-fork catalogue lives in `vendor/VENDOR.md` (kept in step with the script).

**Version-comparison build** (the `/legacy` + `/compare` prefixes): to A/B the
current viewer against any older build on the same deployment,
`cd share-viewer && node scripts/build-legacy.mjs --ref <tag|branch|sha>`
builds that ref in a temp worktree and drops `dist/legacy.html` plus its
hashed assets next to the current build; then deploy the worker
(`cd share-worker && npm run deploy`). The worker serves that build verbatim
under `/legacy/...` and `/compare/...` (e.g. `/compare/s/<id>`) while the
plain paths keep the current one — the URL alone decides, no cookies. Remove
it by rebuilding `dist` (no legacy.html) and redeploying. Without the file
both prefixes 404. Single slot by design (one comparison at a time); the Bun
server does not carry this route.

**Why solid-js is vendored**: Solid's `cleanNode` walks `node.owned`/`node.cleanups` with live loops; a re-entrant disposal nulls the arrays mid-walk and the next iteration throws `null[i]`, killing the whole reactive flush (a half-updated page with a stuck status, live-caught; opencode itself patches the same defect in its own dependency). `vendor-solid.mjs` patches `cleanNode`/`dispose` to snapshot-loop — 6 lines — and writes TWO variants: `vendor/solid/solid.js` (build) and `vendor/solid/dev.js` (dev server: unminified, dev warnings, readable stack traces); `vite.config.ts` picks by command and pins the exact-match alias `/^solid-js$/` so the bundle uses the patched copy and `node_modules` stays pristine.

**Gallery**: `npm run preview:tools` (vite dev) opens `/?preview` with every tool in every state beside the real settings panel; hover affordances can be force-revealed. Message-level features (prompts, agent switch, reasoning, markdown, math, images, compaction/retry/error, grouping) render as whole-message docs through `src/gallery-timeline.tsx` — the production projection + row renderer without the virtualizer. It holds no share data and is dev-only (`import.meta.env.DEV`). A load benchmark is built into the page (corner panel + `window.__oshBench`, with mutation-burst/card-sync counters from `window.__oshOutStats`) — "settle" is the moment every tall card is measured and chevroned without interaction, so load regressions in the card-sync layer show up there. In dev the pierre worker can evaluate its module graph twice (vite serves the entry and a plain copy under different URLs); the theme-alias fork in `vendor/VENDOR.md` makes both copies resolve, so the `Theme "pierre-dark" has not been resolved` flood cannot recur. Two viewer behaviors are wired outside the component tree, at the entry: the output-card drag-to-resize and clipped fade (`src/output-resize.tsx`, delegated listeners writing a per-card `--osh-out-h`) and ctrl+click link copying in the timeline.

**Viewer dev/probe workflow**: `npm run dev` + `?demo` on any `/s/<id>` path renders the built-in fixture share (`src/demo.ts`) — no worker, no auth, no live data needed. `vite.config.ts` excludes the vendored `@opencode/*` packages from esbuild's dep scanner (it cannot parse their `?worker&url` imports) while force-including `@pierre/diffs` and `lru_map` for CJS interop. For headless verification against the REAL production bundle, serve `dist/` from an in-process http server and inject the demo fixture as `window.__MIRROBOT_SNAPSHOT__` through an HTML wrapper (the local-mode contract) — no child processes, no vite, no stray windows.

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

## Offline snapshots

A snapshot is ONE HTML file: the built viewer (entry chunk, every chunk it can reach, CSS, fonts, provider sprite) plus the session frozen as a JSON island. `tools/snapshot-builder.mjs` is the single builder; the worker endpoint, the Bun server, the viewer's download button and both CLI tools call it with a different `readAsset`.

- Chunks ship as base64 in the JSON island; a boot script turns them into Blob URLs and installs the import map before the entry loads. `data:` module URLs do not work here: `import.meta.url` inside one is the entire module source, so every URL derived from it carries the full multi-megabyte text.
- Packing is minimal: grammars only for the languages the session uses, file icons only for the names its paths resolve to, KaTeX fonts only when the text contains math. The real worker bundles are excluded; `markdown.worker-main-*` stays because the offline shim imports it.
- `file://` pages cannot start Workers, so pierre and the markdown parser run main-thread copies of their worker modules behind vendored shims (`worker-shim.ts`, `markdown.worker-main.ts`). Both load lazily, so http pages never fetch them.
- The builder rewrites the island status to `snapshot`; the header shows that instead of the share's last live status.
- `GET /s/:id/snapshot` requires `SNAPSHOT_ENDPOINT=1`: the build reads one asset per subrequest, past the free plan's 50-per-invocation cap.

## Admin console (share-cli)

The `osh` console is one package with three modules over one API client: `src/api.ts` (typed fetch wrapper, cookie jar for gated-share logins), `src/cli.tsx` (headless command surface - scripts/agents), `src/tui.tsx` (ink interactive screens). `src/config.ts` holds the named server profiles in `~/.config/openshare/cli.json`. Role behavior mirrors the API: root goes through `/api/admin/*`, user tokens self-service; a scoped token only ever sees itself and its own shares. Shares lists hydrate private `/meta` in bounded parallel (6 at a time, first 100 rows) and join user labels - `--no-meta` skips it for raw listings.

Build gotchas: ink eagerly imports the optional `react-devtools-core` peer, so `build.mjs` aliases it to a stub (an `external:` entry would still crash ESM resolution at boot); bundled CJS deps (`signal-exit`) `require()` node builtins, so the banner prepends a `createRequire` shim. Bare `osh` in a pipe prints help instead of half-rendering (TTY check in `main.tsx`).

## Release workflow

Lifted from the family (agent-variants/config-studio), adapted to the monorepo (the package lives in `share-plugin/`). The whole kit is driven by one config file, `.github/scripts/release-kit.conf`, and one command surface: `bash .github/scripts/release-kit.sh <check|next|stage>` (`compute` is the CI entry).

- Versioning is CI-automatic. Pushes release; nothing runs locally for routine versions. After publishing, the workflow writes the released version back to the branch (`[skip ci] release: <version>` stamping VERSION + all manifests), so files, tags, and npm always agree; pull before your next push after a release.
- Conventional commits drive semver (`feat` → minor, `fix`/`perf` → patch, `BREAKING CHANGE:`/`!` → major, then clamped to `MAX_BUMP`, default `minor` - an automatic release never opens a new x.0.0 line) - `.github/scripts/compute-version.sh`.
- Channels: `STABLE_BRANCHES` (openshare: `master`) → `latest` with normal bumps; every other branch (`dev`/`alpha`/`beta`/`rc`) is a development channel stacking `<base>-<channel>.N` iterations per push under the matching npm tag. A dev branch freshly synced to a stable derives its base as `stable + MAX_BUMP` (or the VERSION pin); merging it back releases exactly that base, suffix dropped.
- VERSION semantics: the file at the repo root carries the branch's **base** version (`0.3.0`, never `0.3.0-dev.7` - the prerelease suffix is an iteration of the base, not a base line; repos whose VERSION is the sole carrier record the full version there). Comparisons are base-vs-base against the branch's current line: strictly above = exact pin for the next release, equal or lower = inert record. The stamp keeps it current after every release. `release-kit.sh next <1.2.3|major|minor|patch>` writes it (branch-aware bump).
- Manual levers: `release-kit.sh check` (what would the next push release - branch, channel, pin state, npm decision), `release-kit.sh next`, `release-kit.sh stage` (optional: create the release commit on your tip so the version ships inside your own push; the CI write-back then no-ops), and Release workflow dispatch inputs - `version_bump` (major honored as-is, not clamped), `target_version` (exact, one-shot), `release_notes` (replaces the generated commit list; header and footer stay), `dry_run` (computes and previews, publishes nothing).
- `RELEASE_GATE=on` (default off) pauses versioned (`latest`) releases in the `release` GitHub environment for a human approval - the run shows the computed version and the composed notes before npm moves. One-time setup: create the environment under Settings → Environments and add reviewers. Dev-channel builds and dry runs never pause.
- Publishing uses npm trusted publishing (GitHub OIDC) - no tokens stored. The job packs once and publishes the tarball itself, so the release asset is the exact archive npm serves. The publish exit code is the success signal: npm's read index lags the write by minutes, so nothing re-reads the registry to confirm (a re-run inside that window treats npm's "cannot publish over" rejection as success - the version is on npm).
- Release artifacts: every release attaches `viewer-dist-<version>.zip` (the built viewer, for snapshot tooling without a local build - dist is never committed; hashed assets churn every rebuild), `osh-<version>.mjs` (the prebuilt admin console, one self-contained file for Node 20+), `openshare-ci-<version>.js` (the single-file CI plugin), and the plugin `.tgz` (only when that release published one).
- Release notes: git-cliff (`.github/cliff.toml`) grouped by commit type, author attribution via the GitHub Compare API, merged-PR community section (`generate-release-notes.sh`). A Scope section names the parts that changed in the range and the npm publish decision.
- Path filters: `RELEASE_PATHS` (kit config) must equal the workflow's `paths:` trigger - `node tools/kit-check.mjs` enforces the sync. Any functional change in the four parts or `tools/` justifies a release; docs-only pushes trigger nothing (the dispatch relevance check shares the list).
- npm publish gating: only the plugin ships to npm, so a release caused by other parts tags the system version but skips the publish (`NPM_PATHS` + `NPM_GATE`; `force_npm` dispatch input overrides; the `npm-latest` tag marks the newest published commit; stamp-only manifest changes never count). npm version numbers gap when other parts released - every published version carries real plugin changes.
- Runtime version detection reads shipped files, never git at runtime: the worker `/health` serves `version.json` written at deploy (`0.3.0 · 2026-10-31 · abc1234`, `unknown` without a manifest), the viewer embeds the same shape at build (footer shows the short version, info panel the full form), and share-server reads its own manifest at boot. `tools/write-version.mjs` is the one writer.
- Prerelease cleanup: `cleanup-releases.yml` purges a branch's prerelease channel (releases + tags) on branch deletion or by dispatch (`keep_latest`, `dry_run`); protected branches come from the kit config; npm versions are immutable and untouched.
- `ci/openshare.js` is a **tracked build artifact** - rebuilds land in the same commit as their source changes.

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
