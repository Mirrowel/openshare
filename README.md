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
  <a href="#identity--servers">Identity & servers</a> ·
  <a href="#tui-commands">TUI commands</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#read-auth--security">Security</a> ·
  <a href="#self-hosting">Self-hosting</a> ·
  <a href="#development">Development</a>
</p>

---

Upstream OpenCode discontinued share links (the old opncd.ai service). Open(code)Share replaces the whole chain with infrastructure you own: a backend you run (Cloudflare Worker or a single Bun process), a vendored viewer, and a plugin that ships in three shapes — a single file for CI, a package for your config, and a TUI for interactive sharing.

One data contract everywhere: the upstream share `Data[]` snapshot model (session / message / part / session_diff / model / prefs items, keyed-merge last-write-wins). Live and archived sessions are the same bytes and render with the same viewer.

## What you get

- **Live shares** — a running session streams to the server over one WebSocket per main session; open pages update in place.
- **Backfill** — share a session mid-way (or after the fact) and the full history lands in the page: messages, parts, models, diff, subagent sessions. Including servers added *later*: joining a session mid-run mirrors its whole past.
- **Multi-server fan-out** — one session can stream to several servers at once; switch the active set any time; per-session stop or leave-a-snapshot per server.
- **Identity & enrollment** — the plugin enrolls itself: public servers take anyone who knows the host, private ones need an access code (activation-budgeted invites). Long-lived tokens, rotation, revocation, freeze — OAuth-ish without the refresh churn.
- **Self-serve admin** — a full admin console *inside the TUI* (`/openshare → Admin console`): users, freeze/delete, mint tokens, invite codes, shares, reassign, purge.
- **Subagent pages** — child sessions (`parentID`) route into the parent's share as numbered sub-pages; task rows link to them.
- **Read auth** (optional) — per-share login gates with lockout; write access is a separate lock entirely.
- **TTL + sweeper** — shares expire on their own; create-time TTL overrides per share (per-token caps enforced server-side).
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

Pick a backend (either serves the same protocol):

1. **Cloudflare Worker** — `cd share-viewer && npm install && npm run build`, then `cd ../share-worker && npx wrangler deploy` (set the `CREATE_TOKEN` secret — that's your root admin token). Free-tier friendly; idle sockets hibernate.
2. **Bun server (VPS / self-host)** — `bun share-server/server.ts` with `CREATE_TOKEN=<root>` — SQLite + native WebSockets in one process, Docker-ready. Details: [share-server/README](share-server/README.md).

Then decide who gets in:

- **Public** (`AUTH_MODE=public`): anyone knowing the hostname can enroll — fine for personal deployments behind a URL you keep to yourself.
- **Private** (default): mint an invite code with your root token and hand it out:

```sh
curl -X POST https://your-host/api/admin/codes \
  -H "authorization: Bearer $CREATE_TOKEN" \
  -H "content-type: application/json" \
  -d '{"label":"friends","activations":1}'
```

Finally, connect the plugin — interactive or CI:

```jsonc
// ~/.config/opencode/tui.json  +  opencode.json (interactive: both entries)
{ "plugin": ["@mirrowel/opencode-openshare/tui"] }   // tui.json
{ "plugin": ["@mirrowel/opencode-openshare"] }       // opencode.json
```

Run `/share` → **Connect to a server** → paste the URL (and the code, if
private) → done: enrolled, token saved, link copied. Every following
share is one keystroke. For CI, bundle `openshare.js` and configure:

```jsonc
// openshare.config.json next to the bundle
{
  "servers": { "https://your-host": { "code": "osc_…" } }  // or "token": "osk_…"
}
```

The share URL is appended to `openshare.urls.txt` in the session's
directory and printed to stderr (both switchable).

## Share modes

- **all** — every **new** session shares automatically (CI posture; also what the single file always does). Sessions that predate the plugin's start are **never auto-shared**: attach the plugin to a long-lived server and your session history stays private. Opt one in explicitly with the `enabled` flag (full history backfilled), or share it interactively. A session already carrying a share binding keeps its page across restarts (resume continuity).
- **manual** — sessions stay dormant until you opt in; sharing backfills the full history and attaches to the same page across restarts (binding in session metadata).
- **Which one you get**: explicit `shareMode` config wins; otherwise **TUI presence decides** — the server scans the tui.json layers (global, `OPENCODE_TUI_CONFIG`, project chain) for the openshare TUI entry. No selfwiring: installing two parts is the switch. On v2, the package declaring its `tui` entrypoint is the presence signal; the single file has none, so it stays all-mode.
- The **enabled flag** lives in `metadata.openshare = { enabled: true, opts? }` (opts: `ttlDays`, `authLogin`, `authPassword`, `modelLabel` — per-session overrides). Flag removed → share deleted. All-mode bindings carry no flag; all-mode opt-ins use the same flag.

## Identity & servers

Two roles, per server:

- **Admin** — the root `CREATE_TOKEN` (env/secret, forever-valid bootstrap). Manages everything: users, tokens, codes, shares, policy. In the TUI: `/openshare → Admin console`.
- **Users** — everyone the hoster lets in. Full control of their *own* shares, tokens and settings; nothing else.

**Enrollment** (`POST /api/enroll`): a **public** server issues a user token to anyone who knows the hostname (per-IP rate limit); a **private** server additionally requires an **access code** (`osc_…`) minted by the admin with an activation budget — 1 for a personal invite, unlimited for a team code. Each activation issues a long-lived `osk_` token; holding a valid one lets you rotate without a code, forever.

**Ownership**: every share records its owner. Sync/delete accepts the owner's valid token **or** the per-share secret while the owner is in good standing. **Freezing a user** severs both paths on all their shares at once — the kill switch for leaked identities (viewing is unaffected; unfreeze/reassign are the admin rescue paths).

**Multiple servers**: the `servers` config group holds one membership per URL (token, optional code/label/adminToken, `active` flag). Every **active** entry receives new sessions — fan-out, one socket and one spool per server per session. Switch the active set in `/openshare` at any time; a server added mid-session joins with a **full-history backfill**, and per-session you can stop one server (delete) or leave it as a read-only snapshot. Tokens persist per server in the settings home — enroll once, then it just works. A revoked token re-enrolls the same way (public/code available); if enrollment is impossible the plugin says so on stderr and stops — no retry storms.

Full semantics: [share-worker/README — Identity & enrollment](share-worker/README.md#identity--enrollment).

## TUI commands

- **`/share`** — shadows the deprecated built-in. Not connected yet → the connect flow (URL + code). First share → one-time consent, then the URL is copied. Already shared → the **share manager**:
  - single server: copy link / stop sharing;
  - multiple servers: per-server copy, **manage per server** (stop here / leave as snapshot), share to another server, stop all;
  - a credential conflict opens the **collision dialog**: copy debug info (for the hoster / an issue), share on a new share, or don't share.
- **`/openshare`** — settings:
  - **Servers** — memberships with status; per-server: set active, enroll now, rotate token, disconnect (server-side revoke), test, remove; **Connect to a server** (URL + code → enrolled + active).
  - **Admin console** — manage any server with its root token: users (freeze/unfreeze/mint/delete), tokens (revoke), access codes (create/disable — value copied, shown once), shares (reassign/delete), purge all, server info.
  - Sharing defaults, read auth, advanced (spoolDir, urlFile), write-target picker, per-session actions (TTL override, session read auth).
  - **Interface** — menu width (medium/large/xlarge → 60/88/116 columns) and menu height (25–100% of the terminal, slider with presets). Stored in the host's own preference store — per machine, not the config file.
- **`[i]` info pane** — every meaningful menu row (settings, servers, share manager, admin console) carries a long-form detail pane: what the option does, current value + which file/env it comes from, defaults, effects and caveats, and the full data the row truncates (complete URLs, share ids, token kinds). Press `i` on a row, `esc` returns to the menu with the selection intact.
- **Gone detection** — a binding can outlive its page (purge, TTL, host-side delete). Opening the share manager probes every bound server (credential-free); dead entries are cleared from the session automatically with a **"Share is gone"** modal offering *Share again* / *Close*. The sidebar chip verifies lazily (per session+server, 1/min) and renders a dim `⊘` state — clicking it opens the manager instead of copying a dead link. Network errors never count as gone.
- **Sidebar chip** — `◉ re:share` next to the session title; click copies the link. `·N` when the session streams to several servers; `⊘` when the page is gone (click to fix).

## Configuration

Priority: `OPENSHARE_*` env > adjacent `openshare.config.json` > `openshare.local.json` (repo walk-up) > `~/.config/opencode/openshare.config.json` > defaults.

**Where the TUI writes:** `/openshare` saves to the **global settings home** (`~/.config/opencode/openshare.config.json`) by default; any *other* config file in the chain can be chosen as the write target if it already exists on disk (Write target row — the TUI never creates deploy-time override files). Each setting row shows `[source]` when a file or env var higher in the chain overrides it, and *Where values come from* lists every attribution.

| Key | Default | Meaning |
|---|---|---|
| `servers` | — | **Multi-server memberships** (URL → `{ token?, code?, label?, active?, adminToken? }`). Every `active` entry (or the first, if none is flagged) receives new sessions — fan-out. With no token the plugin **enrolls**: public servers take anyone, private ones use `code`. Enrolled tokens persist to the settings home (field-level merge: a static `code` in options and a persisted `token` combine instead of shadowing). `adminToken` is the server's root token for the TUI admin console (hoster convenience). |
| `workerUrl` / `createToken` | — | Legacy single-server shorthand — synthesizes into the `servers` group (`{ url: { token, active: true } }`). New setups should use `servers`. |
| `shareMode` | presence | `"all"` / `"manual"`; omit for presence-based. |
| `debounceMs` | `10000` | **Sync interval** — the max time between syncs while streaming, anchored at the previous flush (an event arriving after the interval flushes immediately). Turn-end batches flush instantly on idle, never on this timer. First batch flushes as soon as it exists. |
| `completedDelayMs` | `5000` | How long a session must stay idle before the share says **completed**. opencode's idle is authoritative turn end (busy is held through steps, tool runs and permission waits), so this only smooths an automation's gap before its next prompt; busy cancels (busy-epoch guarded); a graceful opencode exit flushes the pending flip (CI runs land their final status). `0` = immediate. |
| `modelLabel` | `"$Provider/$Model"` | Label template; `""` hides the model. |
| `ttlDays` | worker cap | Share lifetime (capped at `MAX_TTL_DAYS` and the token's `maxTtlDays`). |
| `openTasksInNewTab` | `true` | Viewer: task rows open sub-pages in a new tab. |
| `authLogin` / `authPassword` | `""` | Default read gate for share pages. |
| `spoolDir` | XDG data | Unacked-frame buffer (one spool per session per server). |
| `urlFile` | `openshare.urls.txt` in the session directory | Share-URL log (all-mode; appends every URL — one line per server on fan-out; manual mode never writes it). Default lands where the session lives — never a fixed global path. **`"none"` disables the file entirely.** |
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
- **Write access is identity**: creating shares needs a valid token — an enrolled `osk_` user token (with server-side limits: `maxLiveShares`, `maxTtlDays`, `dailyCreates`) or the root `CREATE_TOKEN`. Syncing/deleting needs the owner's token **or** the per-share secret held only by the creating plugin — and neither works once the owner is frozen. A URL plus a valid login still cannot write a byte.
- Revocation is instant and server-side: a revoked token stops working immediately; a frozen user's *secrets* stop working too. Lost both token and secret? The shares stay readable until TTL; re-enrolling (public server / fresh code) starts a new identity — the admin can reassign the old shares.
- The plugin strips the binding key from everything it syncs; the server strips session metadata on all read paths (belt and suspenders). Viewer credentials never appear in any write path.

## Self-hosting

Two interchangeable backends — pick by where you want to run it:

| | Cloudflare Worker (`share-worker/`) | Bun server (`share-server/`) |
|---|---|---|
| Storage | Durable Objects + KV | one SQLite file (WAL) |
| Idle sockets | hibernate (free) — auto policy resolves **persistent** | real fds — auto policy resolves **turn** |
| Deploy | `npx wrangler deploy` (+ viewer assets) | `bun server.ts` / Docker (`oven/bun`) |
| Identity | identical (`AuthDO` vs SQLite tables) | identical |
| Backups | Cloudflare's DO persistence | copy the `.db` file |

Both serve the built viewer (`share-viewer/dist`), resolve the same
policy vars, and pass the **same test suites** — the plugin cannot tell
them apart. Ops notes (restart durability, reverse proxies, backups) in
[share-server/README](share-server/README.md#ops-notes).

## Development

```bash
cd share-plugin
npm install
npm run build          # dist/ + the single-file openshare.js
npm run test           # full matrix (real `opencode serve` + mock LLM + local wrangler dev)
npm run test:regression   # parity: legacy == single file == package
npm run test:manual       # manual mode: dormancy, flag, backfill, unshare, re-share, auth opts
npm run test:tui-flow     # share/unshare flows, config round-trip, connect flow, admin console
npm run test:v2           # v2 adapter against a scripted mock v2 host
npm run test:auth         # server identity: enroll, codes, rotate, freeze, limits, reassign (48 checks)
npm run test:enroll       # plugin enrollment lifecycle vs a real worker (private + public)
npm run test:fanout       # multi-server: dual workers, backfill-on-join, opt-outs
npm run test:cli          # real `opencode run` end-to-end (CI bundle + package)
# backend parity — the SAME suites against the portable Bun server:
npm run test:server-auth
npm run test:server-enroll
```

All suites run the real production path: a local `wrangler dev` worker (or the Bun server), a mock OpenAI-compatible provider so a real `opencode serve` runs a real prompt pipeline, and share data compared (normalized) across variants. Worker protocol details, reliability semantics, and the passive CI archive live in [`share-worker/README.md`](share-worker/README.md); the portable backend in [`share-server/README.md`](share-server/README.md).

## License

MIT
