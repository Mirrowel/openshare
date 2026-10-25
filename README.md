<h1 align="center">Open(code)Share</h1>

<p align="center">
  <strong>re:share — session sharing, back for opencode.</strong><br>
  Self-hosted share links for your OpenCode sessions: one worker you own, one viewer, every session shareable — live or archived.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mirrowel/opencode-openshare"><img alt="npm" src="https://img.shields.io/npm/v/@mirrowel/opencode-openshare?color=cb3837&label=%40mirrowel%2Fopencode-openshare"></a>
  <a href="#license"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

<p align="center">
  <a href="#tldr">TL;DR</a> ·
  <a href="#is-this-for-me">Is this for me</a> ·
  <a href="#what-you-get">What you get</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#share-modes">Share modes</a> ·
  <a href="#identity--servers">Identity & servers</a> ·
  <a href="#tui-commands">TUI commands</a> ·
  <a href="#the-viewer">The viewer</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#how-your-data-is-handled">Data handling</a> ·
  <a href="#read-auth--security">Security</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="#self-hosting">Self-hosting</a> ·
  <a href="#uninstalling">Uninstalling</a> ·
  <a href="#glossary">Glossary</a> ·
  <a href="#development">Development</a>
</p>

---

## TL;DR

Upstream OpenCode discontinued share links (the old opncd.ai service). Open(code)Share replaces the whole chain with infrastructure **you** own: a backend you run (a Cloudflare Worker or a single Bun process), a share page you build once, and a plugin — installed as an npm package, a local checkout, or a single CI file, with an optional TUI half for interactive sharing.

```bash
# 1. plugin — add the package to BOTH config files (see step 1 below)
#    opencode.json: { "plugin": ["@mirrowel/opencode-openshare"] }
#    tui.json:      { "plugin": ["@mirrowel/opencode-openshare"] }
# 2. backend (pick one — needs a clone + a viewer build; full walkthrough below)
cd share-viewer && npm install && npm run build && cd ..   # once
cd share-worker && npx wrangler deploy        # Cloudflare (or bun share-server/server.ts)
# 3. restart opencode, then: /share → Connect to a server → paste your URL
```

## Is this for me?

- **Yes** if you want share links for opencode sessions on infrastructure you control, with live streaming, subagent pages, multi-server fan-out, and no third-party service in the middle.
- **Yes** if you run agents in CI and want a durable, linkable transcript of every run (the single-file CI bundle emits URLs without any interaction).
- **Yes** if someone else runs a server you've been invited to — a friend's host or a community server works out of the box. There is no public directory of servers (yet): ask the hoster for the URL, plus an access code if the server is private.

## What you get

- **Live shares** — a running session streams to the server over one WebSocket per main session; open pages update in place.
- **Backfill** — share a session mid-way (or after the fact) and the full history lands in the page: messages, parts, models, diff, subagent sessions. Including servers added *later*: joining a session mid-run mirrors its whole past.
- **Multi-server fan-out** — one session can stream to several servers at once; switch the active set any time; per-session stop or leave-a-snapshot per server.
- **Identity & enrollment** — the plugin enrolls itself: public servers take anyone who knows the host, private ones need an access code (activation-budgeted invites). Long-lived tokens, rotation, revocation, freeze — OAuth-ish without the refresh churn.
- **Self-serve admin** — a full admin console *inside the TUI* (`/openshare → Servers → <server> → Admin panel`): users, freeze/delete, mint tokens, invite codes, shares, reassign, purge.
- **Subagent pages** — child sessions (`parentID`) route into the parent's share as numbered sub-pages; task rows link to them.
- **Read auth** (optional) — per-share login gates with lockout; write access is a separate lock entirely.
- **TTL + sweeper** — shares expire on their own; create-time TTL overrides per share (per-token caps enforced server-side).
- **Branding** — your deployment's logo, wordmark, accent, background, description, link previews — config only, no code ([worked example](share-worker/branding-example/)).
- **Twelve reading views, two cores** — classic and conversation are the core reading surfaces (conversation: the ported TurnNav-sidebar design with hover previews and a focus overlay); reader and nine full-page skins (terminal, casefile, blueprint, cinema, timeline, letterpress, atlas, teletype, grove) ride the same SDK: the data, sync, search, settings and virtualization are the SDK's, the look is the skin's ([the view contract](share-viewer/src/views/README.md)).
- **Viewer settings** — per-visitor: theme, view, paged vs continuous scroll (per capable view; classic is continuous + focus mode), prompt nav (pill or drag-resizable sidebar), smooth scrolling, prompt style (bubble or flat band), auto-expanded tools, diff layout (per-card U/A/S toggle), output wrapping, grouping, follow-live, text sizes — plus prompt-and-response search, `j`/`k` and `[`/`]` turn navigation, focus mode (shift+click, the row reticle, or right-click), and copy-as-markdown in every view.

## Quick start

**Already have a server URL** (a community host, a friend's deployment, your own from before)? Install the plugin (step 1) and skip to step 4.

**Prerequisites**

| Piece | Need it for | Minimum |
|---|---|---|
| [opencode](https://opencode.ai) | the plugin | v1.18+ ("v2" hosts — the next-gen plugin API — are supported by the same package; see step 1 for how to tell which you have) |
| [Node.js](https://nodejs.org) | building the viewer, running wrangler | 20.19+ (or 22.12+) — the viewer build uses Vite 7 |
| [Bun](https://bun.sh) | the portable backend, or building from source | 1.1+ |
| [wrangler](https://developers.cloudflare.com/workers/wrangler/) | deploying the Cloudflare backend | any recent version — every command below uses `npx wrangler`, no global install needed |
| A Cloudflare account | the worker backend | free tier is enough |

Everything else (a mock LLM, local workers) only matters for development — see [Development](#development).

### 1. Install the plugin

**Which host am I on?** v1 is the current stable opencode (1.18+); "v2" is the next-generation host with the new plugin API and CLI commands. Quick check: `opencode plugin list` works on v2 — v1 only has the positional `opencode plugin <module>`.

Add the package to your config files — the **bare package name in both** (opencode resolves the TUI entrypoint from the package itself; no `/tui` suffix). Add the string to the existing `plugin` array if you already have one; create the files with exactly this content if you don't:

```jsonc
// ~/.config/opencode/opencode.json  (the server engine; on Windows: %USERPROFILE%\.config\opencode\)
{ "plugin": ["@mirrowel/opencode-openshare"] }
// ~/.config/opencode/tui.json       (the TUI — flips sharing to manual mode)
{ "plugin": ["@mirrowel/opencode-openshare"] }
```

**Don't skip the tui.json entry** unless you want every *new* session to share automatically — the plugin's mode is decided by which halves are installed: both entries → manual (share per session via `/share`), only opencode.json → all-mode (auto-share every new session). An explicit `"shareMode"` in the plugin config overrides either way (see [Share modes](#share-modes)).

Restart opencode, then verify: `/share` and `/openshare` appear in the TUI. Project-level `opencode.json`/`tui.json` in a repo work the same way (then the plugin is active only there). opencode fetches npm plugins itself on restart — no manual `npm install` needed.

**On a v2 host** the CLI does the config for you — the package carries both entrypoints:

```sh
opencode plugin add @mirrowel/opencode-openshare    # v2: writes the config + installs
opencode plugin list                                # verify
```

Other shapes, same codebase:

| Shape | When | Mode |
|---|---|---|
| `@mirrowel/opencode-openshare` (npm) | default interactive/daemon setup | manual with the TUI entry; all-mode without it |
| `file:///…/share-plugin` (local checkout) | developing or tracking main | same as npm — it's the same package. Note: a checkout carries the gitignored `openshare.local.json` dev slot (worker URL + dev token) — remove it before sharing the checkout, or sessions run inside it share to that worker |
| `share-plugin/ci/openshare.js` (committed single file, zero deps) | CI bundles, air-gapped runners | all-mode by default (it declares no TUI entry; explicit `shareMode` still wins) |

Until a backend is configured the plugin stays dormant — it never blocks a session.

### 2. Run a backend (pick one)

**A. Cloudflare Worker** (free-tier friendly; idle sockets hibernate):

```sh
git clone https://github.com/Mirrowel/openshare && cd openshare

# the viewer ships as worker assets — build it once
cd share-viewer && npm install && npm run build && cd ..

# first run: wrangler login, then create YOUR OWN kv namespace
# (the id shipped in wrangler.toml is the author's — a deploy to an
# account that doesn't own it fails)
cd share-worker
npx wrangler login
npx wrangler kv namespace create KV
#  -> put the printed id into wrangler.toml, in the [[kv_namespaces]]
#     block, KEEPING binding = "SHARE_INDEX" (the binding name is
#     load-bearing — the worker reads env.SHARE_INDEX)

# your root admin token (treat like a password — see Security)
npx wrangler secret put CREATE_TOKEN
npx wrangler deploy
curl -s https://<your-worker>.workers.dev/health
#  -> {"ok":true,"service":"openshare","policy":{...},"auth":{"mode":"private"}}
```

**B. Bun server** (any VPS / localhost — one process, one SQLite file):

```sh
git clone https://github.com/Mirrowel/openshare && cd openshare
cd share-viewer && npm install && npm run build && cd ..   # viewer, same as above
cd share-server
# PowerShell:  $env:CREATE_TOKEN="root-secret"; bun server.ts
CREATE_TOKEN=root-secret bun server.ts                    # (sh)
curl -s http://127.0.0.1:8787/health
#  -> {"ok":true,"service":"openshare",...}
```

**C. Docker** (one image, server + viewer; state in one volume):

```sh
git clone https://github.com/Mirrowel/openshare && cd openshare
docker build -f share-server/Dockerfile -t openshare .
docker run -e CREATE_TOKEN=root-secret -p 8787:8787 -v oshdata:/data openshare
curl -s http://127.0.0.1:8787/health
```

### 3. Decide who gets in

- **Public** (`AUTH_MODE=public`): anyone knowing the hostname can enroll — fine for personal deployments behind a URL you keep to yourself. On the worker this is a `wrangler.toml` var (set `AUTH_MODE = "public"`, then redeploy); on the Bun server and Docker it's an env var at launch (`-e AUTH_MODE=public` for Docker). Same name, different mechanisms.
- **Private** (default): mint an invite code with your root token and hand it out. Note the `code` field in the response — that's the invite:

```sh
# sh — set the env var once, then use it
export CREATE_TOKEN=root-secret        # the value you set at deploy
curl -X POST https://your-host/api/admin/codes \
  -H "authorization: Bearer $CREATE_TOKEN" \
  -H "content-type: application/json" \
  -d '{"label":"friends","activations":1}'
# -> {"ok":true,"code":"osc_…","id":"…","activationsLeft":1,...}
```

```powershell
# PowerShell — use the env var directly ($env:CREATE_TOKEN, not $CREATE_TOKEN)
$env:CREATE_TOKEN = "root-secret"
Invoke-RestMethod -Method Post https://your-host/api/admin/codes `
  -Headers @{ authorization = "Bearer $env:CREATE_TOKEN" } `
  -ContentType "application/json" `
  -Body '{"label":"friends","activations":1}'
# Bun on localhost: https://your-host -> http://127.0.0.1:8787
```

You are the hoster — the code the plugin asks for is one you mint yourself, right here.

### 4. Connect the plugin

In opencode: `/share` → **Connect to a server** → paste the server's base URL (the `https://your-host` part — not a `/s/…` share link) and the code, if private → **enrolled, token saved**. That's the one-time setup — no share exists yet. Run `/share` once more: the consent dialog, then the link is copied. Every later share is one keystroke, but the consent question itself always appears — no share is ever created silently.

For CI, bundle `ci/openshare.js` and drop a config next to it:

```jsonc
// openshare.config.json next to the bundle
{
  "servers": { "https://your-host": { "token": "osk_…" } }   // or "code": "osc_…" to enroll
}
```

The share URL is appended to `openshare.urls.txt` in the session's working directory and printed to stderr (both switchable). Local rendering of exported sessions (CI artifacts): [`tools/view-export.py`](tools/README.md).

## Architecture

```
opencode (plugin)  --ws-->  Cloudflare Worker  <--ws--  viewers (browser)
         \                        |
          `-- session metadata    +-- share pages (vendored viewer, KV index,
              (binding: id,        |   Durable Objects per share, daily sweeper)
               secret, rev, url)  `-- /api/share/:id/data (HTTP fallback)
```

- **`share-plugin/`** — `@mirrowel/opencode-openshare`, the opencode plugin (server + optional TUI). Also builds `ci/openshare.js`, a zero-dependency single file for CI bundles. Details: [`share-plugin/README.md`](share-plugin/README.md).
- **`share-worker/`** — Cloudflare Worker: `ShareDO` per share, `ControlDO` per plugin socket, `AuthDO` for users/tokens/codes, `SweeperDO` daily TTL sweep, KV index. Protocol reference: [`share-worker/README.md`](share-worker/README.md).
- **`share-server/`** — the portable backend: one Bun process, SQLite, native WebSockets — protocol-identical to the worker. Ops guide: [`share-server/README.md`](share-server/README.md).
- **`share-viewer/`** — the vendored upstream share page (vite + solid + tailwind, client-only build) with branding and settings bolted on. Viewer docs: [`share-viewer/README.md`](share-viewer/README.md).
- **`tools/`** — agent-side companion (renders exported sessions locally): [`tools/README.md`](tools/README.md).

One session can fan out to **several servers at once** (every `active` entry in the `servers` config group); servers can join mid-session with a full-history backfill, and per-session opt-outs leave a read-only snapshot behind.

Delivery reliability without expensive pulls: every accepted sync bumps a monotonic rev, acked on the socket; unacked frames spool to disk and replay on reconnect; the share binding lives inside opencode session metadata, so recovery never depends on the spool. The binding key (`metadata.openshare`) is stripped from everything synced, and the worker strips session metadata on all read paths — the write secret never reaches viewers.

States (last signal wins, always resumable): `live` (busy) / `completed` (idle) / `error` (idle after errors). The next busy flips live again; open pages wake in place.

## Share modes

- **all** — every **new** session shares automatically (CI posture; also what the single file always does). Sessions that predate the plugin's start are **never auto-shared**: attach the plugin to a long-lived server and your session history stays private. Opt one in explicitly with the `enabled` flag (full history backfilled), or share it interactively. A session already carrying a share binding keeps its page across restarts (resume continuity).
- **manual** — sessions stay dormant until you opt in; sharing backfills the full history and attaches to the same page across restarts (binding in session metadata).
- **Which one you get**: explicit `shareMode` config wins (`"all"` / `"manual"`; the TUI's `auto` = presence-based default); otherwise **TUI presence decides** — the plugin's server half (not your backend) scans the tui.json layers (global, `OPENCODE_TUI_CONFIG`, project chain) for the openshare TUI entry (bare name, `@version`, or subpath — all recognized). Which halves you install IS the switch — no config needed to flip it. On v2, the package declaring its `tui` entrypoint is the presence signal; the single file has none, so it stays all-mode. The mode resolves **once at plugin load** — changing `shareMode` in a config file takes effect on the next opencode start (or `serve` restart), not mid-session.
- The **enabled flag** lives in `metadata.openshare = { enabled: true, opts? }` (opts: `ttlDays`, `authLogin`, `authPassword`, `modelLabel` — per-session overrides). In manual mode, removing the flag deletes the share; in all mode the flag is only the opt-in for pre-existing sessions (an active share stops through `/share`, not flag removal). Bindings are `enabled: true` in **both** modes; all-mode opt-ins use the same flag.

## Identity & servers

Two roles, per server:

- **Admin** — the root `CREATE_TOKEN` (env/secret, forever-valid bootstrap). Manages everything: users, tokens, codes, shares, policy. In the TUI: `/openshare → Servers → <server> → Admin panel`.
- **Users** — everyone the hoster lets in. Full control of their *own* shares, tokens and settings; nothing else.

**Enrollment** (`POST /api/enroll`): a **public** server issues a user token to anyone who knows the hostname (per-IP rate limit); a **private** server additionally requires an **access code** (`osc_…`) minted by the admin with an activation budget — 1 for a personal invite, unlimited for a team code. Each activation issues a long-lived `osk_` token; holding a valid one lets you rotate without a code, forever.

**Ownership**: every share created by an enrolled user records its owner. Sync/delete accepts the owner's valid token **or** the per-share secret while the owner is in good standing. Root-bootstrap creates (and anonymous creates on public servers) are **ownerless** — secret-only control, never frozen. **Freezing a user** severs both paths on all their shares at once — the kill switch for leaked identities (viewing is unaffected; unfreeze/reassign are the admin rescue paths).

**Multiple servers**: the `servers` config group holds one membership per URL (token, optional code/label/adminToken, `active` flag). Every **active** entry receives new sessions — fan-out, one socket and one spool per server per session. Switch the active set in `/openshare` at any time; a server added mid-session joins with a **full-history backfill**, and per-session you can stop one server (delete) or leave it as a read-only snapshot. Tokens persist per server in the settings home — enroll once, then it just works. A revoked token re-enrolls the same way (public/code available); if enrollment is impossible the plugin says so on stderr and stops — no retry storms.

Full semantics: [share-worker/README — Identity & enrollment](share-worker/README.md#identity--enrollment).

## TUI commands

- **`/share`** — shadows the deprecated built-in. Not connected yet → the connect flow (URL + code). Not shared yet → an explicit consent dialog (every creation asks — nothing is published silently), then the URL is copied. Already shared → **the session menu, identical to `/openshare → This session`**:
  - copy the link (per server when several are bound, or all links at once) / **stop sharing** — with the choice to **delete the page** (links die, final "gone" frame) or **leave it as-is** (a frozen snapshot that stays readable until its TTL); multiple servers additionally offer per-server stop, and sharing to another configured server;
  - per-session **TTL** and **read auth** overrides;
  - a credential conflict opens the **collision dialog**: copy debug info (for the hoster / an issue), share on a new share, or don't share.
- **`/openshare`** — grouped settings (compact root, focused submenus): **This session**, **Servers** (memberships + the admin panel), **Sharing** (mode via selection menu, cadence, TTL), **Read auth**, **Interface** (menu size picker), **Advanced**, **Config files** (write target + per-key source map). Selection menus everywhere — no typed booleans; every row and group carries a live summary, an `[i]` detail pane, red danger rows, green edited rows.
- **Root holders are users too** — configuring with the legacy `createToken` files the root token as `adminToken`; the server menu then offers **Get a user token**: admin-mints your own user identity and keeps root for the admin panel.
- **Gone detection** — a binding can outlive its page (purge, TTL, host-side delete). Running `/share` probes every bound server; dead entries are cleared from the session automatically with a **"Share is gone"** modal offering *Share again* (asks consent) / *Close*. The sidebar chip verifies lazily and renders a dim `⊘` state — clicking it runs `/share` instead of copying a dead link. Network errors never count as gone.
- **Sidebar chip** (v1 hosts — the v2 TUI context has no slot registry yet) — `◉ re:share` next to the session title; click copies the link. `·N` when the session streams to several servers; `⊘` when the page is gone (click to fix).

## The viewer

Each share serves a self-contained page at `<worker>/s/<id>` (and `/s/<id>/<sub>` for a subagent's sub-page — task rows link there, new-tab behavior configurable). The page is static asset hosting that ships with the backend — you build it once at deploy (or use the Docker image, which builds it in).

- **Live updates** — the page attaches over WebSocket and merges frames client-side (identity-preserving smart sync: unchanged items keep their rendered components, so expansion state and scroll position survive every update; message tombstones remove undone work the same way opencode does). If the socket drops, it falls back to 5-second polling and re-attaches automatically — a refresh is never required. The WS opens with a `since` rev handshake, so a fresh page load transfers the item set exactly once.
- **Views** — the reading skin: classic, reader, or one of the nine composed views (terminal, casefile, blueprint, cinema, timeline, letterpress, atlas, teletype, grove). Every view is a skin over the same base ([the view contract](share-viewer/src/views/README.md)).
- **Big sessions** — the viewer is built on the opencode v2 component kit (vendored) and **every view virtualizes**: continuous mode windows rows as you scroll, paged mode windows inside a giant turn, and the composed skins two-level (sections + entries). A multi-thousand-message share costs the same DOM as a small one.
- **Prompt nav** — one control, two states: the floating pill or the sidebar (drag its edge to resize; toggle from the pill's popover or the sidebar header; with more than one turn, one of the two is always present — the pill is never fully hidden). Selection jumps to the turn (continuous) or pages (paged-capable skins), and in classic shift+click, the row's reticle, or right-click → "Focus on turn" opens focus mode: that turn as an overlay (prev/next, Esc exits) over the still-mounted transcript. `j`/`k` and `[`/`]` are aliases everywhere. Subagent pages pin a back-to-parent row that returns to the exact turn that spawned the child.
- **Status badges** — `live`, `completed`, `error`, `interrupted` (plugin vanished without goodbye — finalized server-side after the grace window), `gone` (deleted or TTL-expired; the final frame says so).
- **Multi-session shares** — a share that carries subagent sessions lists them; each opens its own sub-page with the parent linked back. Folded undone turns stay folded (the revert pointer is honored), diffs render unified or split (auto-split when width allows, per-card override).
- **Read auth gate** — auth-gated shares answer `401 {authRequired}`: the viewer renders a branded login form, exchanges it for a 7-day cookie, and locks out after repeated failures (429). The gate never grants write access.
- **Reader settings** (gear or Ctrl+K, persisted in a 1-year cookie): theme, view, **paged mode** (per capable view; classic is continuous + focus), prompt nav, follow-live, text and reading sizes, diff layout (auto/split/unified), reasoning auto-open, tool-call info, **auto-expanded tools** (a checklist of known + this session's tools), long-line behavior (scroll/wrap), prompt style (bubble/flat), smooth scrolling, tool grouping (classic: on/off + scope), content centering, background image (when the deployment ships one). Search matches prompts **and** responses; every view has copy-as-markdown in its header.

Viewer internals, branding, and the vendored components: [`share-viewer/README.md`](share-viewer/README.md).

## Configuration

Priority (highest wins, per key): `OPENSHARE_*` env > plugin options (the config's plugin array entry) > adjacent `openshare.config.json` (next to the plugin) > package-root config > `openshare.local.json` (repo walk-up) > `~/.config/opencode/openshare.config.json` (settings home) > defaults. For everyday interactive use, edit the settings home (or just use `/openshare` — that's where it writes); the earlier links in the chain exist for CI bundles and packaging. An empty string means *unset* for `workerUrl`, `createToken`, `urlFile`, and `spoolDir`; for the other string keys an explicit empty value is meaningful (`modelLabel: ""` hides the model; `authLogin`/`authPassword: ""` removes the read gate).

**Where the TUI writes:** `/openshare` saves to the **global settings home** (`~/.config/opencode/openshare.config.json`) by default; any *other* config file in the chain can be chosen as the write target if it already exists on disk (Write target row — the TUI never creates deploy-time override files). Each setting row shows `[source]` when a file or env var higher in the chain overrides it, and *Where values come from* lists every attribution.

| Key | Default | Meaning |
|---|---|---|
| `servers` | — | **Multi-server memberships** (URL → `{ token?, code?, label?, active?, adminToken? }`). Every `active` entry (or the first, if none is flagged) receives new sessions — fan-out. With no token the plugin **enrolls**: public servers take anyone, private ones use `code`. Enrolled tokens persist to the settings home (field-level merge). `adminToken` is the server's root token for the TUI admin console. |
| `workerUrl` / `createToken` | — | Legacy single-server shorthand — synthesizes into the `servers` group. New setups should use `servers`. |
| `shareMode` | presence | `"all"` / `"manual"`; omit for presence-based. Resolved once at load. |
| `debounceMs` | `10000` | **Sync interval** — the max time between syncs while streaming, anchored at the previous flush. Turn-end batches flush instantly on idle; the first batch flushes as soon as it exists. Clamped into the server's window. |
| `completedDelayMs` | `5000` | How long a session must stay idle before the share says **completed** (busy cancels; a graceful opencode exit flushes the pending flip). `0` = immediate. |
| `modelLabel` | `"$Provider/$Model"` | Label template; `""` hides the model. |
| `ttlDays` | `90` | Share lifetime (capped at the worker's `MAX_TTL_DAYS` and the token's `maxTtlDays`). |
| `openTasksInNewTab` | `true` | Viewer: task rows open sub-pages in a new tab. |
| `authLogin` / `authPassword` | `""` | Default read gate for share pages. |
| `spoolDir` | XDG data | Unacked-frame buffer (one spool per session per server). |
| `urlFile` | `openshare.urls.txt` in the session's working directory | Share-URL log (all-mode; appends; manual mode never writes it). **`"none"` disables the file entirely.** |
| `announceStderr` | `true` | `false` silences the `[openshare] live:` / `url file:` stderr lines. |

Values apply per share creation — the file is read on every activation. `shareMode` is the exception (resolved once at load, see [Share modes](#share-modes)).

**Recipes** — starting points for the three common postures (all keys optional; these are the diffs from defaults):

```jsonc
// CI: watched runs — near-real-time, everything to the url file
{ "shareMode": "all", "debounceMs": 5000, "announceStderr": true }

// Default: interactive with TUI — manual sharing, standard cadence
{ "shareMode": "manual", "debounceMs": 10000 }

// Relaxed: casual "here's a link" sessions — batchier sync, longer TTL
// (TTL is capped by the server's MAX_TTL_DAYS — 90 by default; raise it
// on your own deployment for this recipe to take full effect)
{ "shareMode": "manual", "debounceMs": 30000, "ttlDays": 180 }
```

**Environment variables** (all optional; every one overrides the config chain):

| Var | Meaning |
|---|---|
| `OPENSHARE_WORKER_URL` | target server URL (legacy single-server; superseded by the `servers` group) |
| `OPENSHARE_CREATE_TOKEN` | its create token (legacy) |
| `OPENSHARE_SHARE_MODE` | `all` / `manual` — beats every file |
| `OPENSHARE_DEBOUNCE_MS` / `OPENSHARE_COMPLETED_DELAY_MS` | cadence overrides (clamped into the server window) |
| `OPENSHARE_TTL_DAYS` | default share TTL |
| `OPENSHARE_MODEL_LABEL` | model label template |
| `OPENSHARE_URL_FILE` | url file path, or `none` |
| `OPENSHARE_SPOOL_DIR` | spool directory |
| `OPENSHARE_ANNOUNCE_STDERR` | `0`/`false` disables, anything else enables — gates the `live:` and `url file:` lines only (other engine diagnostics unaffected) |
| `OPENSHARE_AUTH_LOGIN` / `OPENSHARE_AUTH_PASSWORD` | default read gate |
| `OPENSHARE_DEBUG_FILE` | write a startup snapshot (mode, directory, share-mode resolution) to this path — a support/diagnostic aid, written once at load |
| `OPENSHARE_DEBUG_EVENTS` | any non-empty value enables verbose engine decision lines on stderr (note: stderr info lines are suppressed in manual/TUI mode; this is an all-mode/CI tool) |

**Stderr policy:** in manual mode (TUI installed) stderr carries **errors only** — the informational `live:` / `url file:` / mode lines are suppressed because the TUI surfaces the URL. All-mode (CI / server-only) keeps the full stderr contract; `announceStderr: false` silences the informational lines there too. Error-class output (worker down, refused init, mismatch recreate, timeouts) always reaches stderr.

**Socket policy is server-owned.** The worker defines how connections behave and the allowed cadence window; the plugin fetches the policy at connect and clamps itself into it. The full var list (`SOCKET_POLICY`, `TURN_GRACE_MS`, `IDLE_DROP_MS`, `FINALIZE_AFTER_MS`, the clamp window) lives in [share-worker/README.md](share-worker/README.md#server-policy).

## How your data is handled

- **What leaves your machine**: the session transcript you chose to share — session info, messages (text, reasoning, tool calls and outputs embedded per message, opencode v2 session shapes), model/prefs items. The plugin strips its own binding (including the share secret) from everything it syncs; the server strips session metadata on all read paths. The share format is the OpenShare envelope (`v: 2`): item types the viewer renders are `session`, `message` (content-embedded), `model`, `prefs`, and `session_diff`; unknown *message* content degrades to notices in the viewer, unknown top-level item types are ignored.
- **Oversize safety valve**: any single item whose serialized JSON exceeds ~1.5 MB (a giant tool output embedded in a message) has its largest string fields clipped with a visible `…[openshare: field truncated for share]` marker rather than killing the share; an item that still can't fit becomes an `oversize` stub. In practice this almost never fires.
- **The share URL is a credential.** Anyone holding it can read the whole conversation unless you enable the read gate (read auth is **off by default** — turn it on for anything sensitive). Write access is separate: it needs the server-side token or per-share secret.
- **Retention**: shares live for their TTL (default **90 days**, capped by the server), then the sweeper deletes them. Deleting a share (unshare, purge) removes the data; "leave as-is" keeps a frozen snapshot until its TTL.
- **Where it lives**: your backend — Cloudflare (DO storage + KV) or your own server (one SQLite file). No third party, no analytics, no telemetry from this repo's code.

## Read auth & security

- **Read gate** (optional): per-share PBKDF2-SHA256 hashes, branded login card, 7-day cookie sessions (5 devices), exponential lockout per IP. Set per deployment (config) or per session (opts).
- **Write access is identity**: on a private server, creating shares needs a valid token — an enrolled `osk_` user token (with server-side limits: `maxLiveShares`, `maxTtlDays`, `dailyCreates`) or the root `CREATE_TOKEN`. On a **public** server, anonymous ownerless creation is allowed — per-token limits don't apply to anonymous creates, so keep the server private if that matters. Syncing/deleting needs the owner's token **or** the per-share secret held only by the creating plugin — and neither works once the owner is frozen. A URL plus a valid login still cannot write a byte.
- Revocation is instant and server-side: a revoked token stops working immediately; a frozen user's *secrets* stop working too. Lost both token and secret? The shares stay readable until TTL; re-enrolling starts a new identity — the admin can reassign the old shares.
- **Root token hygiene**: `CREATE_TOKEN` is a forever-valid admin credential — treat it like a password. Keep it in env/secrets, not in committed files; prefer day-to-day use of enrolled user tokens (they're revocable and limit-capped); rotate by changing the secret if it ever leaks. Note: on a **public** server with default limits, anyone who learns the hostname can create shares — set per-token limits or keep the server private if that matters.

## Troubleshooting

| Symptom | Meaning / fix |
|---|---|
| `[openshare] disabled: no share server configured` | No `servers`/`workerUrl` anywhere — expected right after install. Connect via `/share` or set config. |
| `[openshare] enrollment failed: …` | The server refused enrollment — wrong access code (private server), code exhausted, or you're rate-limited. If you're the hoster: check `AUTH_MODE`, that the code still has activations, and that you used the server's base URL; otherwise ask the hoster / try again later. |
| Viewer page `401 authRequired` | That share has the read gate on — log in with the credentials the sharer gave you (not a plugin error). |
| Share page 404s / blank | The backend's viewer build is missing. Bun: check the startup line (`viewer: not built`); Cloudflare: the deploy must include `share-viewer/dist` (build it first — Quick start step 2); Docker builds it in. |
| `[openshare] … 404` on create | Server reachable but the endpoint changed — the deployed backend is older/newer than your plugin. Redeploy the backend from the same repo state as your plugin install and restart opencode. |
| `[openshare] … 429` | Rate limit — enrollment floods or daily create caps; wait or ask the admin to raise limits. |
| Share page says `gone` | The page was deleted, purged, or TTL-expired. The TUI auto-clears the binding on next `/share`; CI: start a new run or re-share. |
| Share stuck on `interrupted` | The plugin vanished without goodbye (kill -9, crash, network cut) — the server finalizes it after the grace window. Reopen the session or run `/share` to re-attach. |
| `share mode: manual` but you expected `all` | A tui.json layer registers the TUI — presence flips the mode. Set `shareMode` explicitly to override. |
| Old sessions not auto-shared in all mode | By design — all-mode only shares **new** sessions; opt old ones in explicitly (flag or `/share`). |
| url file not written | Manual mode never writes it; `urlFile: "none"` disables it. CI users have no TUI — check `OPENSHARE_URL_FILE` / the config file instead of `/openshare`. |
| Worker deploy fails on the KV namespace | The shipped namespace id belongs to the author — create your own and put its id in `wrangler.toml`. |

## Self-hosting

Two interchangeable backends — pick by where you want to run it (deploy steps in [Quick start](#quick-start)):

| | Cloudflare Worker (`share-worker/`) | Bun server (`share-server/`) |
|---|---|---|
| Storage | Durable Objects + KV | one SQLite file (WAL) |
| Idle sockets | hibernate (free) — auto policy resolves **persistent** | real fds — auto policy resolves **turn** |
| Deploy | `npx wrangler deploy` (+ viewer assets) | `bun server.ts` / Docker |
| Identity | identical (`AuthDO` vs SQLite tables) | identical |
| Backups | Cloudflare's DO persistence | stop the server and copy `openshare.db` **plus** the `-wal`/`-shm` files (or run `sqlite3 openshare.db ".backup backup.db"` while it's up — copying only the `.db` mid-run can miss recent writes) |

Both serve the built viewer (`share-viewer/dist`), resolve the same policy vars, and pass the **same identity/enrollment suites** (the plugin cannot tell them apart). Ops notes (restart durability, reverse proxies, TLS, backups) in [share-server/README](share-server/README.md#ops-notes); the worker's API and protocol reference in [share-worker/README](share-worker/README.md).

## Uninstalling

- **Plugin**: delete the `@mirrowel/opencode-openshare` entries from `opencode.json` and `tui.json` (on v2, `opencode plugin remove @mirrowel/opencode-openshare` does it), restart opencode. Leftover local state: `~/.config/opencode/openshare.config.json` (tokens + settings; on Windows `%USERPROFILE%\.config\opencode\`), the spool dir under the XDG data home (`%LOCALAPPDATA%\opencode\openshare` on Windows, `~/.local/share/opencode/openshare` on Linux), and — for local-checkout installs — the gitignored `openshare.local.json` at the repo root. Delete those to forget the credentials. Note: share bindings (incl. per-share secrets) stay inside each session's metadata in the opencode session DB until those sessions are deleted.
- **Shares**: unshare from the TUI (delete the pages), or purge everything with the admin console / `POST /api/admin/purge`. TTL handles the rest if you just walk away.
- **Backend**: Cloudflare — `npx wrangler delete`. Bun — stop the process, delete the directory (the SQLite file is the whole state). Docker — remove the `oshdata` volume too.

## Glossary

- **Binding** — the share record stored in opencode session metadata (`metadata.openshare`): per-server share id, secret, rev, url. Survives restarts; never synced.
- **Spool** — on-disk buffer of unacked sync frames, one per session per server; replays on reconnect.
- **Enrollment** — the plugin obtaining a user token from a server (public, or via an access code). `osk_` = user token, `osc_` = access code.
- **Fan-out** — one session streaming to several servers at once.
- **Turn-scoped sockets** — server policy where the plugin's WebSocket drops after a turn settles (+grace) instead of idling forever; reconnect-on-next-event with spool replay.
- **Rev** — monotonic per-share revision, bumped by every accepted sync; the loss-detection and replay anchor.
- **Gone** — a share whose page no longer exists (deleted/purged/expired); detected and recovered by the TUI.
- **Backfill** — syncing a session's full prior history when it starts sharing (or when a server joins mid-session).

## Development

```bash
cd share-plugin
npm install
npm run build          # dist/ + the single-file ci/openshare.js (needs Bun on PATH)
npm run test           # full matrix — ~4.5 min
npm run test:quick     # everyday gate — ~90s
```

The suites run the real production path — real `opencode serve` instances, a mock LLM provider, local `wrangler dev` workers, and the Bun backend parity runs. Architecture, suite layout, the release workflow, and host-integration notes live in [`DEVELOPMENT.md`](DEVELOPMENT.md).

## License

MIT
