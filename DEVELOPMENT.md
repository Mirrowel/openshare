# OpenShare — development notes

Working on the repo? This is the map. User-facing docs: [README](README.md).

## Repo layout

```
share-plugin/          the opencode plugin (@mirrowel/opencode-openshare)
  src/core.ts          the engine: session tracking, fan-out transports,
                       spool/replay, turn lifecycle, tombstones, backfill
  src/config.ts        config chain + servers group + enrollment persistence
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
  src/views/           the registered viewer views (see views/README.md)
tools/                 agent-side export/decrypt companions
```

`share-worker/worker.js` and `share-server/server.ts` implement the **same
protocol** — any protocol change must land in both (the parity suites
enforce it: the same auth/enroll suites run against both backends).

## Test suites

`npm test` (matrix driver, ~4.5 min) / `npm run test:quick` (~90s).

| Suite | Covers |
|---|---|
| regression | parity: legacy single file == standalone build == package (== package-dir via file:// URL) |
| manual (core/allmode/engine shards) | dormancy, flag/backfill, unshare, re-share, read-auth opts, all-mode gating, undo tombstones, completed debounce, turn sockets, finalize |
| tui-flow | share/manager flows, config write targets, enrollment, admin console, gone detection, size prefs |
| v2-mock | the v2 adapter against a scripted mock v2 host |
| auth (×backends) | identity: enroll, codes, rotate, freeze, limits, reassign — 48 checks, CF + Bun |
| enroll | plugin enrollment lifecycle vs a real worker (private + public) |
| fanout | dual workers, mid-session join backfill, opt-outs, collisions |
| cli / npm-e2e (on demand) | real `opencode run` with the CI bundle / package; the published npm package by registry spec (`node scripts/npm-e2e.mjs` — no npm alias by design: on-demand only) |

Note what CI actually gates: the GitHub workflow runs typecheck + build + pack dry-run (`npm run ci`) — **no test suites run there** (they need opencode + wrangler + port access). The matrix is a local-before-commit obligation.

Suite rules of the road (all learned from live failures):

- Every spawn gets **all three** XDG homes redirected — config alone is not isolation on opencode ≥1.18 (global plugin merge, machine-wide session DB, instance-lock port bumps).
- Ports: fast TCP probes gate every sweep; sweeps only run when a port is actually occupied; the matrix driver assigns disjoint port ranges per suite.
- `opencode run` retries 5xx with its own 2+4+8+16+32s backoff — mock failures use non-retryable 4xx when testing the error path.
- Wrangler supervisors survive tree-kills and respawn workerd — kill by command line, then sweep the port.
- Two wrangler instances share `.wrangler/state` unless `--persist-to` isolates them.
- Real-inference checks are on-demand scripts, never part of the default matrix.

## Release workflow

Lifted from the family (agent-variants/config-studio), adapted to the monorepo (the package lives in `share-plugin/`):

- Conventional commits drive semver (`feat` → minor, `fix`/`perf` → patch, `BREAKING CHANGE:`/`!` → major) — `.github/scripts/compute-version.sh`.
- Channels: `master` → `latest`; `dev`/`alpha`/`beta`/`rc`/`canary` branches → `0.x.y-<channel>.N` prereleases under the matching npm tag (`main` maps to `latest` too).
- `share-plugin/.release.json` pins the next intended version (`npm run release:intent -- patch|minor|major`); CI refuses drift.
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
- The 1.19.x plugin API imports the **v2 SDK** (`@opencode-ai/sdk/v2`) — client calls are flat-args and the path param is `sessionID` (see `src/v2-tui.ts`).
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
