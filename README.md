<h1 align="center">Open(code)Share</h1>

<p align="center">
  <strong>re:share — session sharing, back for opencode.</strong><br>
  Self-hosted share links for your OpenCode sessions: one worker you own, one viewer, every session shareable — live or archived.
</p>

<p align="center">
  <a href="#what-you-get">What you get</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#the-plugin">The plugin</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#share-modes">Share modes</a> ·
  <a href="#tui-commands">TUI commands</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#read-auth--security">Security</a> ·
  <a href="#development">Development</a>
</p>

---

Upstream OpenCode discontinued share links (the old opncd.ai service). Open(code)Share replaces the whole chain with infrastructure you own: a Cloudflare Worker (free-tier friendly), a vendored viewer, and a plugin that ships in three shapes — a single file for CI, a package for your config, and a TUI for interactive sharing.

One data contract everywhere: the upstream share `Data[]` snapshot model (session / message / part / session_diff / model / prefs items, keyed-merge last-write-wins). Live and archived sessions are the same bytes and render with the same viewer.

## What you get

- **Live shares** — a running session streams to the worker over one WebSocket per main session; open pages update in place (hibernating sockets, zero idle cost).
- **Backfill** — share a session mid-way (or after the fact) and the full history lands in the page: messages, parts, models, diff, subagent sessions.
- **Subagent pages** — child sessions (`parentID`) route into the parent's share as numbered sub-pages; task rows link to them.
- **Read auth** (optional) — per-share login gates with lockout; write access is a separate lock entirely.
- **TTL + sweeper** — shares expire on their own; create-time TTL overrides per share.
- **Branding** — your deployment's logo, wordmark, accent, background — config only, no code.
- **Viewer settings** — themes, text size, continuous mode, live-follow, reasoning expanded, prompt search — persisted per visitor.

## Architecture

```
opencode (plugin)  --ws-->  Cloudflare Worker  <--ws--  viewers (browser)
        \                        |
         `-- session metadata    +-- share pages (vendored viewer, KV index,
             (binding: id,        |   Durable Objects per share, daily sweeper)
              secret, rev, url)  `-- /api/share/:id/data (HTTP fallback)
```

- **`share-plugin/`** — `@mirrowel/opencode-openshare`, the opencode plugin (server + optional TUI). Also builds `openshare.js`, a zero-dependency single file for CI bundles.
- **`share-worker/`** — Cloudflare Worker: `ShareDO` per share, `ControlDO` per plugin socket, `AuthDO` for users/tokens/codes, `SweeperDO` daily TTL sweep, KV index.
- **`share-server/`** — the portable backend: one Bun process, SQLite, native WebSockets — protocol-identical to the worker for VPS/self-hosting (`bun server.ts`, Docker-ready).
- **`share-viewer/`** — the vendored upstream share page (vite + solid + tailwind, client-only build) with branding and settings bolted on.
- **`tools/`** — agent-side companions (export/decrypt for the passive CI archive).

One session can fan out to **several servers at once** (every `active`
entry in the `servers` config group); servers can join mid-session with a
full-history backfill, and per-session opt-outs leave a read-only
snapshot behind. Identity is per-server: the plugin **enrolls itself**
(public servers take anyone; private ones need an access code from the
hoster) and holds one long-lived token per server — see
[Identity & enrollment](share-worker/README.md#identity--enrollment).

Delivery reliability without expensive pulls: every accepted sync bumps a monotonic rev, acked on the socket; unacked frames spool to disk and replay on reconnect; the share binding lives inside opencode session metadata, so recovery never depends on the spool. The binding key (`metadata.openshare`) is stripped from everything synced, and the worker strips session metadata on all read paths — the write secret never reaches viewers.

States (last signal wins, always resumable): `live` (busy) / `completed` (idle) / `error` (idle after errors). The next busy flips live again; open pages wake in place.

## The plugin

Three artifacts, one codebase — behavior is identical, only the share mode differs:

| Artifact | Install | Share mode |
|---|---|---|
| **`openshare.js`** (single file, zero deps) | `OPENCODE_CONFIG` / `plugin: ["…/openshare.js"]` | Always **all** — every session shares; URL → urlFile + stderr line. The CI bundle. |
| **`@mirrowel/opencode-openshare`** (package, server) | opencode.json `plugin: ["@mirrowel/opencode-openshare"]` | **All** when no TUI is registered; flips to **manual** when it is. |
| **`@mirrowel/opencode-openshare/tui`** (package, TUI) | tui.json `plugin: ["@mirrowel/opencode-openshare/tui"]` | Presence of the TUI entry flips the server to **manual**: per-session opt-in via `/share`. |

Runs on OpenCode **v1 and v2** from the same package (dual `{ id, server, setup }` / `{ id, tui, setup }` entries; the v2 adapter maps the v2 event and client models onto the share pipeline).

## Quick start

1. **Worker** — `cd share-worker && npx wrangler deploy` (set the `CREATE_TOKEN` secret; KV `SHARE_INDEX`; assets = `../share-viewer/dist`, build it first with `npm run build`).
2. **Plugin** — for interactive use add both package entries (opencode.json + tui.json) and configure:
   ```jsonc
   // openshare.config.json (next to the package, or use OPENSHARE_* env)
   {
     "workerUrl": "https://your-worker.workers.dev",
     "createToken": "…"
   }
   ```
   For CI, bundle `openshare.js` + `openshare.config.json` and set env `OPENSHARE_WORKER_URL` / `OPENSHARE_CREATE_TOKEN`; the share URL is written to the urlFile and stderr.
3. **Share** — `/share` in the TUI (copies the link), or let CI share everything and collect the link from the urlFile.

## Share modes

- **all** — every **new** session shares automatically (CI posture; also what the single file always does). Sessions that predate the plugin's start are **never auto-shared**: attach the plugin to a long-lived server and your session history stays private. Opt one in explicitly with the `enabled` flag (full history backfilled), or share it interactively. A session already carrying a share binding keeps its page across restarts (resume continuity).
- **manual** — sessions stay dormant until you opt in; sharing backfills the full history and attaches to the same page across restarts (binding in session metadata).
- **Which one you get**: explicit `shareMode` config wins; otherwise **TUI presence decides** — the server scans the tui.json layers (global, `OPENCODE_TUI_CONFIG`, project chain) for the openshare TUI entry. No selfwiring: installing two parts is the switch. On v2, the package declaring its `tui` entrypoint is the presence signal; the single file has none, so it stays all-mode.
- The **enabled flag** lives in `metadata.openshare = { enabled: true, opts? }` (opts: `ttlDays`, `authLogin`, `authPassword`, `modelLabel` — per-session overrides). Flag removed → share deleted. All-mode bindings carry no flag; all-mode opt-ins use the same flag.

## TUI commands

- **`/share`** — shadows the deprecated built-in. First run: one-time consent, then the share is created and the URL copied. Already shared → copies the link. On a child session → shares the root family.
- **`/unshare`** — confirm, stop sharing, delete the page.
- **`/openshare`** — settings: worker connection (+ test), sharing defaults, read auth, advanced, and per-session actions (share/copy/stop, TTL override, session read auth).
- **Sidebar chip** — a `re:share` status dot next to the session title (live / dormant).

## Configuration

Priority: `OPENSHARE_*` env > adjacent `openshare.config.json` > `openshare.local.json` (repo walk-up) > `~/.config/opencode/openshare.config.json` > defaults.

**Where the TUI writes:** `/openshare` saves to the **global settings home** (`~/.config/opencode/openshare.config.json`) by default; any *other* config file in the chain can be chosen as the write target if it already exists on disk (Write target row — the TUI never creates deploy-time override files). Each setting row shows `[source]` when a file or env var higher in the chain overrides it, and *Where values come from* lists every attribution.

| Key | Default | Meaning |
|---|---|---|
| `workerUrl` | — | Your worker deployment (required). |
| `createToken` | — | Worker `CREATE_TOKEN` (required). |
| `shareMode` | presence | `"all"` / `"manual"`; omit for presence-based. |
| `debounceMs` | `10000` | **Sync interval** — the max time between syncs while streaming, anchored at the previous flush (an event arriving after the interval flushes immediately). Turn-end batches flush instantly on idle, never on this timer. First batch flushes as soon as it exists. |
| `completedDelayMs` | `5000` | How long a session must stay idle before the share says **completed**. opencode's idle is authoritative turn end (busy is held through steps, tool runs and permission waits), so this only smooths an automation's gap before its next prompt; busy cancels (busy-epoch guarded); a graceful opencode exit flushes the pending flip (CI runs land their final status). `0` = immediate. |
| `modelLabel` | `"$Provider/$Model"` | Label template; `""` hides the model. |
| `ttlDays` | worker cap | Share lifetime (capped at `MAX_TTL_DAYS`). |
| `openTasksInNewTab` | `true` | Viewer: task rows open sub-pages in a new tab. |
| `authLogin` / `authPassword` | `""` | Default read gate for share pages. |
| `spoolDir` | XDG data | Unacked-frame buffer. |
| `urlFile` | `openshare.urls.txt` in the session directory | Share-URL log (all-mode; appends every URL; manual mode never writes it). Default lands where the session lives — never a fixed global path. **`"none"` disables the file entirely.** |
| `announceStderr` | `true` | `false` silences the `[openshare] live:` / `url file:` stderr lines (the share itself is unaffected). |

The file is read on every activation — settings-dialog changes apply to the next share without a restart.

**Stderr policy:** in manual mode (TUI installed) stderr carries **errors only** — the informational `live:` / `url file:` / mode lines are suppressed because the TUI surfaces the URL (toast, clipboard, sidebar chip, settings). All-mode (CI / server-only) keeps the full stderr contract; `announceStderr: false` silences the informational lines there too. Error-class output (worker down, refused init, mismatch recreate, timeouts) always reaches stderr.

**Cadence profiles** (client preferences — always clamped into the worker's allowed window):

| Profile | `debounceMs` | Notes |
|---|---|---|
| CI | `5000` | near-real-time streaming for watched runs |
| Default | `10000` | current shipped values |
| Relaxed | `30000` | casual "here's a link" sessions |

**Socket policy is server-owned.** The worker defines how connections behave and the allowed cadence window (`SOCKET_POLICY` — auto: Cloudflare runtime → persistent since WebSocket hibernation makes idle sockets free; anything else (VPS etc.) → turn — turn-scoped sockets: settle + `TURN_GRACE_MS` (2 min) grace, then a clean drop, reconnect-on-next-event with spool replay; `IDLE_DROP_MS` (10 min) no-signal fallback; `FINALIZE_AFTER_MS` (5 min) — plugin gone without a goodbye → the share settles to **`interrupted`**; `DEBOUNCE_MIN_MS`/`DEBOUNCE_MAX_MS`/`COMPLETED_DELAY_MAX_MS` — the clamp window). The plugin fetches the policy from the init ack / `/health` and clamps itself into it. See the worker README for the full list.

## Read auth & security

- **Read gate** (optional): per-share PBKDF2-SHA256 hashes, branded login card, 7-day cookie sessions (5 devices), exponential lockout per IP. Set per deployment (config) or per session (opts).
- **Write access is a different lock**: creating shares needs the worker-level `CREATE_TOKEN`; writing (sync/delete) needs the per-share secret held only by the creating plugin. A URL plus a valid login still cannot write a byte.
- The plugin strips the binding key from everything it syncs; the worker strips session metadata on all read paths (belt and suspenders).

## Development

```bash
cd share-plugin
npm install
npm run build          # dist/ + the single-file openshare.js
npm run test           # full matrix (real `opencode serve` + mock LLM + local wrangler dev)
npm run test:regression   # parity: legacy == single file == package
npm run test:manual       # manual mode: dormancy, flag, backfill, unshare, re-share, auth opts
npm run test:tui-flow     # share/unshare flows + config round-trip
npm run test:v2           # v2 adapter against a scripted mock v2 host
```

All suites run the real production path: a local `wrangler dev` worker, a mock OpenAI-compatible provider so a real `opencode serve` runs a real prompt pipeline, and share data compared (normalized) across variants. Worker protocol details, reliability semantics, and the passive CI archive live in [`share-worker/README.md`](share-worker/README.md).

## License

MIT
