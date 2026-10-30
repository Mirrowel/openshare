<h1 align="center">Open(code)Share</h1>

<p align="center">
  <strong>re:share — session sharing, back for opencode.</strong><br>
  Self-hosted share links for your OpenCode sessions: one worker you own, one viewer, every session shareable — live or archived.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mirrowel/opencode-openshare"><img alt="npm" src="https://img.shields.io/npm/v/@mirrowel/opencode-openshare?color=cb3837&label=%40mirrowel%2Fopencode-openshare"></a>
  <a href="https://mirrowel.github.io/openshare/"><img alt="website" src="https://img.shields.io/badge/website-mirrowel.github.io%2Fopenshare-f5b648"></a>
  <a href="#license"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

<p align="center">
  <a href="https://ko-fi.com/C0C0UZS4P"><img alt="ko-fi" src="https://ko-fi.com/img/githubbutton_sm.svg"></a>
</p>

<p align="center">
  <a href="#tldr">TL;DR</a> ·
  <a href="#is-this-for-me">Is this for me</a> ·
  <a href="#what-you-get">What you get</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#where-everything-lives">Doc map</a> ·
  <a href="#how-your-data-is-handled">Data handling</a> ·
  <a href="#troubleshooting">Troubleshooting</a>
</p>

---

## TL;DR

Upstream OpenCode discontinued share links (the old opncd.ai service). Open(code)Share replaces the whole chain with infrastructure **you** own: a backend you run (a Cloudflare Worker or a single Bun process), a share page you build once, and a plugin — installed as an npm package, a local checkout, or a single CI file, with an optional TUI half for interactive sharing.

```bash
# 1. plugin — add the package to BOTH config files (see step 1 below)
#    opencode.json: { "plugin": ["@mirrowel/opencode-openshare"] }
#    tui.json:      { "plugin": ["@mirrowel/opencode-openshare"] }
# 2. backend (pick one)
git clone https://github.com/Mirrowel/openshare && cd openshare
cd share-viewer && npm install && npm run build && cd ..   # once
cd share-worker && npx wrangler deploy        # Cloudflare (or bun share-server/server.ts)
# 3. restart opencode, then: /share → Connect to a server → paste your URL
```

## Is this for me?

- **Yes** if you want share links for opencode sessions on infrastructure you control, with live streaming, subagent pages, multi-server fan-out, and no third-party service in the middle.
- **Yes** if you run agents in CI and want a durable, linkable transcript of every run (the single-file CI bundle emits URLs without any interaction).
- **Yes** if someone else runs a server you've been invited to — a friend's host or a community server works out of the box. There is no public directory of servers: ask the hoster for the URL, plus an access code if the server is private.

## What you get

- **Live shares** — a running session streams over one WebSocket per main session; open pages update in place.
- **Backfill** — share a session mid-way (or after the fact) and the full history lands in the page: messages, parts, models, diffs, subagent sessions. Servers added later mirror the whole past too.
- **Multi-server fan-out** — one session can stream to several servers at once; switch the active set any time; per-session stop or leave-a-snapshot per server.
- **Identity** — accounts, not just tokens: full tokens (the account credential), scoped tokens for CI that reach only their own shares, access codes that mint users with a one-call lineage kill-switch, ask-once onboarding.
- **Self-serve admin** — a full admin console *inside the TUI*: users, freeze/delete, mint tokens, invite codes, shares, reassign, purge.
- **Subagent pages** — child sessions route into the parent's share as numbered sub-pages; task rows link to them.
- **Read auth** (optional) — per-share login gates with lockout; write access is a separate lock entirely.
- **TTL + sweeper** — shares expire on their own; create-time TTL overrides per share.
- **Branding + link previews** — your deployment's logo, wordmark, accent, background, and rendered OG cards (five styles) from config alone: [worked example](share-worker/branding-example/).
- **A serious viewer** - twelve reading views on one SDK, every view virtualized to handle multi-thousand-message shares, live search, focus mode, deep links, one-click session export: [the viewer](share-viewer/README.md).
- **Offline snapshots** - download a share as ONE self-contained HTML file (viewer, chunks, fonts and the frozen transcript inside it) and open it on any machine with no server, no network, no install. From the page button, from a script (`tools/osh-snapshot.mjs`), or straight from an `opencode export` with no share at all (`tools/osh-snapshot-local.mjs`) - [details](#take-it-with-you-snapshots).

## Quick start

**Already have a server URL** (a community host, a friend's deployment)? Install the plugin (step 1) and skip to step 4.

**Prerequisites**

| Piece | Need it for | Minimum |
|---|---|---|
| [opencode](https://opencode.ai) | the plugin | v1.18+ ("v2" hosts — the next-gen plugin API — are supported by the same package) |
| [Node.js](https://nodejs.org) | building the viewer, running wrangler | 20.19+ (or 22.12+) — the viewer build uses Vite 7 |
| [Bun](https://bun.sh) | the portable backend, or building from source | 1.1+ |
| [wrangler](https://developers.cloudflare.com/workers/wrangler/) | deploying the Cloudflare backend | any recent version — every command uses `npx wrangler` |
| A Cloudflare account | the worker backend | free tier is enough |

### 1. Install the plugin

**Which host am I on?** v1 is the current stable opencode (1.18+); "v2" is the next-generation host with the new plugin API and CLI commands. Quick check: `opencode plugin list` works on v2 — v1 only has the positional `opencode plugin <module>`.

Add the package to your config files — the **bare package name in both** (opencode resolves the TUI entrypoint from the package itself; no `/tui` suffix):

```jsonc
// ~/.config/opencode/opencode.json  (the server engine; on Windows: %USERPROFILE%\.config\opencode\)
{ "plugin": ["@mirrowel/opencode-openshare"] }
// ~/.config/opencode/tui.json       (the TUI — flips sharing to manual mode)
{ "plugin": ["@mirrowel/opencode-openshare"] }
```

**Don't skip the tui.json entry** unless you want every *new* session to share automatically — the plugin's mode is decided by which halves are installed: both entries → manual (share per session via `/share`), only opencode.json → all-mode (auto-share every new session). An explicit `shareMode` in the plugin config overrides either way ([share modes](#share-modes)).

Restart opencode, then verify: `/share` and `/openshare` appear in the TUI. Project-level config files in a repo work the same way (then the plugin is active only there). opencode fetches npm plugins itself on restart — no manual `npm install` needed.

**On a v2 host** the CLI does the config for you:

```sh
opencode plugin add @mirrowel/opencode-openshare    # v2: writes both config entries + installs
opencode plugin list                                # verify
```

Other shapes, same codebase:

| Shape | When | Mode |
|---|---|---|
| `@mirrowel/opencode-openshare` (npm) | default interactive/daemon setup | manual with the TUI entry; all-mode without it |
| `file:///…/share-plugin` (local checkout) | developing or tracking main | same as npm — it's the same package. Note: a checkout carries the gitignored `openshare.local.json` dev slot (worker URL + dev token) — remove it before sharing the checkout, or sessions run inside it share to that worker |
| `share-plugin/ci/openshare.js` (committed single file, zero deps) | CI bundles, air-gapped runners | all-mode by default (no TUI entry; explicit `shareMode` still wins) |

Until a backend is configured the plugin stays dormant — it never blocks a session.

### 2. Run a backend (pick one)

**A. Cloudflare Worker** (free-tier friendly; idle sockets hibernate). First deploy needs a KV namespace of your own and a root token — the exact steps and the gotchas are in the [worker README](share-worker/README.md#deploy):

```sh
git clone https://github.com/Mirrowel/openshare && cd openshare
cd share-viewer && npm install && npm run build && cd ..   # the viewer ships as worker assets
cd share-worker
npx wrangler login
npx wrangler kv namespace create KV    # put YOUR id into wrangler.toml (see worker README)
npx wrangler secret put CREATE_TOKEN   # root admin token — treat like a password
npx wrangler deploy
curl -s https://<your-worker>.workers.dev/health
#  -> {"ok":true,"service":"openshare","policy":{...},"auth":{"mode":"private"}}
```

**B. Bun server** (any VPS / localhost — one process, one SQLite file):

```sh
cd share-server
CREATE_TOKEN=root-secret bun server.ts         # PowerShell: $env:CREATE_TOKEN="root-secret"; bun server.ts
curl -s http://127.0.0.1:8787/health
```

**C. Docker** (one image, server + viewer; state in one volume):

```sh
docker build -f share-server/Dockerfile -t openshare .
docker run -e CREATE_TOKEN=root-secret -p 8787:8787 -v oshdata:/data openshare
```

Both backends serve the built viewer, resolve the same policy vars, and pass the same identity suites — the plugin cannot tell them apart ([self-hosting](#self-hosting)).

### 3. Decide who gets in

- **Public** (`AUTH_MODE=public`): anyone knowing the hostname can create shares anonymously; enrolling an ACCOUNT needs an access code unless you also enable `CODELESS_ONBOARDING`. Fine for personal deployments behind a URL you keep to yourself.
- **Private** (default): mint an invite code with your root token and hand it out. Note the `code` field in the response — that's the invite:

```sh
export CREATE_TOKEN=root-secret        # the value you set at deploy (PowerShell: $env:CREATE_TOKEN)
curl -X POST https://your-host/api/admin/codes \
  -H "authorization: Bearer $CREATE_TOKEN" -H "content-type: application/json" \
  -d '{"label":"friends","activations":1}'
# -> {"ok":true,"code":"osc_…","id":"…","activationsLeft":1,...}
```

You are the hoster — the code the plugin asks for is one you mint yourself, right here.

### 4. Connect the plugin

In opencode: `/share` → **Connect to a server** → paste the server's base URL (the `https://your-host` part — not a `/s/…` share link) and the code, if private → enrolled, token saved. That's the one-time setup — no share exists yet. Run `/share` once more: the consent dialog, then the link is copied. Every later share is one keystroke, and the consent question appears every time. One exception by design: **all mode** (no TUI part installed, or `shareMode: "all"`) publishes every NEW session automatically — that is the CI posture, and it is why all-mode installs should only point at servers you want reading everything.

For CI, the single-file bundle plus a config next to it is the whole setup — [ci/README](share-plugin/ci/README.md) has the shapes (enrollment codes, `OPENSHARE_CONFIG_JSON`, JSON url-file lines, meta labels).

## Architecture

```
opencode (plugin)  --ws-->  Cloudflare Worker  <--ws--  viewers (browser)
          \                        |
           `-- session metadata    +-- share pages (vendored viewer, KV index,
               (binding: id,        |   Durable Objects per share, daily sweeper)
                secret, rev, url)  `-- /api/share/:id/data (HTTP fallback)
```

| Piece | What it is | Docs |
|---|---|---|
| `share-plugin/` | `@mirrowel/opencode-openshare` — the opencode plugin (server + optional TUI), plus the single-file CI bundle | [plugin README](share-plugin/README.md) |
| `share-worker/` | Cloudflare Worker: `ShareDO` per share, `ControlDO` per plugin socket, `AuthDO` for users/tokens/codes, `SweeperDO` daily TTL sweep, KV index | [worker README](share-worker/README.md) |
| `share-server/` | the portable backend: one Bun process, SQLite, native WebSockets — protocol-identical to the worker | [server README](share-server/README.md) |
| `share-viewer/` | the share page (vendored opencode v2 kit, vite + solid) with branding and settings | [viewer README](share-viewer/README.md) |
| `tools/` | CLI converters: export/pack/import sessions, view exported sessions locally | [tools README](tools/README.md) |

Delivery reliability is structural: every accepted sync bumps a monotonic rev, acked on the socket; unacked frames spool to disk and replay on reconnect; the share binding lives inside opencode session metadata, so recovery never depends on the spool. The binding key is stripped from everything synced, and the worker strips session metadata on all read paths — the write secret never reaches viewers.

## Where everything lives

- **Share modes** (all vs manual, how the mode resolves): [plugin README](share-plugin/README.md#share-modes). Short version: explicit `shareMode` wins; otherwise TUI presence decides — manual with the TUI installed, all-mode without.
- **Identity & enrollment** (users, scoped tokens, codes, freeze, lineage revocation): [worker README — Identity](share-worker/README.md#identity--enrollment).
- **TUI commands** (`/share`, `/openshare`, the admin console): [plugin README — TUI](share-plugin/README.md#tui).
- **The viewer** (views, navigation, search, settings, snapshots, export): [viewer README](share-viewer/README.md).
- **Configuration** — every knob across every package: [CONFIGURATION.md](CONFIGURATION.md). Plugin keys, worker vars, server-side objects, the viewer cookie, and a "where do I set X" router, all in one file. The plugin reads env > plugin options > adjacent config > package-root config > `openshare.local.json` > the settings home (`~/.config/opencode/openshare.config.json`), with `OPENSHARE_CONFIG_JSON` carrying a whole config as one env var; the TUI writes the settings home.
- **Read auth & security model**: [worker README — Read auth](share-worker/README.md#read-auth-optional-casual-eyes-resistance).
- **Internals, tests, vendoring, release workflow**: [DEVELOPMENT.md](DEVELOPMENT.md).
- **CLI tools** — export/pack/import sessions, local viewing of exported sessions: [tools README](tools/README.md).

## Share modes

- **all** — every **new** session shares automatically (the CI posture; what the single file always does). Sessions that predate the plugin's start are never auto-shared; opt one in explicitly (full history backfilled).
- **manual** — sessions stay dormant until you opt in; sharing backfills full history and attaches to the same page across restarts (binding in session metadata).
- The **enabled flag** (`metadata.openshare`) is the per-session opt-in in both modes; per-session overrides ride as `opts` (`ttlHours`, read auth, `modelLabel`).

Full resolution rules and the v2 presence signal: [plugin README — Share modes](share-plugin/README.md#share-modes).

## Identity & servers

Two roles per server: the **admin** (the root `CREATE_TOKEN`) and **users** — everyone the hoster lets in, each with full control of their own shares, tokens and settings. Access codes mint users with their first full token; scoped tokens are the CI credential — they create within limits and reach only the shares they created. Losing the last full token freezes everything; freezing a user severs both write paths on all their shares at once. Every detail: [worker README — Identity & enrollment](share-worker/README.md#identity--enrollment).

One session can fan out to several servers at once (the `servers` config group holds one membership per URL); a server added mid-session joins with a full-history backfill.

## TUI commands

- **`/share`** — connect flow when not connected; explicit consent dialog on every creation (nothing is published silently); once shared, the session menu: copy links, stop sharing (delete the page or leave a snapshot), per-server stop, TTL and read-auth overrides.
- **`/openshare`** — the grouped settings tree: This session, Servers (memberships + the admin console), Sharing, Read auth, Interface, Advanced, Config files.
- **Gone detection** — a binding can outlive its page (purge, TTL); `/share` probes every bound server, clears dead entries, and offers to share again.

All flows and the sidebar chip: [plugin README — TUI](share-plugin/README.md#tui).

## The viewer

Each share serves a self-contained page at `<worker>/s/<id>` (subagent sub-pages at `/s/<id>/<N>`). The page live-updates over WebSocket with smart sync (your scroll and expansion state survive every update), falls back to polling, and never requires a refresh. Twelve views render over one virtualized SDK — a multi-thousand-message share costs the same DOM as a small one. Search matches prompts and responses, focus mode isolates one turn, deep links point at any message, and every view exports the session as an import-ready JSON. Any share can also be frozen into one offline HTML file - see [Take it with you](#take-it-with-you-snapshots).

The tour, settings, and internals: [viewer README](share-viewer/README.md).

## Take it with you (snapshots)

A share can be frozen into **one HTML file** that carries the whole viewer:
the transcript, every chunk the page can reach, the fonts, the icons. Double
click it on any machine - offline, no server, no account, no install - and
the same reading experience opens, header reading `snapshot`. Expansion,
search, deep links, subagent pages and the theme all work; only the live
tail (new messages, download/export actions) is inert.

Three ways to make one:

```bash
# 1. the page itself: header menu -> Download snapshot

# 2. any share, from a script (works in CI, no browser);
#    gated shares take --login user:pass or --token <viewer-token>
node tools/osh-snapshot.mjs https://<host>/s/<id> -o session.html

# 3. no share at all - straight from an opencode export
node tools/osh-snapshot-local.mjs main.json child.json -o session.html
```

The third path needs only this repo's built viewer
(`cd share-viewer && npm run build`), so a session you exported months ago
becomes a portable page with nothing else involved. The server endpoint
(`GET /s/<id>/snapshot`) exists too and is off by default: assembling it
inside the worker costs one subrequest per asset, which the free plan does
not allow - the button and both scripts assemble from static assets instead.

## How your data is handled

- **What leaves your machine**: the session transcript you chose to share. Built-in secret detectors (GitHub/AWS/Slack/Google keys, `sk-` keys, Bearer tokens, private-key blocks, `.env` assignments, connection-string passwords) plus your own `redact.patterns` replace matches with `[redacted:<kind>]` markers — and the consent dialog previews counts and the first hits BEFORE anything is published.
- **Machine-local facts stay private**: the session's directory/worktree travel as a private item the server serves only to readers who passed the share's read gate; anonymous shares never expose them.
- **The share URL is a credential.** Anyone holding it can read the whole conversation unless you enable the read gate (off by default — turn it on for anything sensitive). Write access is separate: it needs the server-side token or per-share secret.
- **Oversize safety valve**: a single item over ~1.5 MB has its largest fields clipped with a visible marker rather than killing the share.
- **Retention**: shares live for their TTL (default 90 days, capped per server), then the sweeper deletes them. Unshare deletes; "leave as-is" keeps a frozen snapshot until its TTL.
- **Where it lives**: your backend — Cloudflare (DO storage + KV) or your own server (one SQLite file). No third party, no analytics, no telemetry from this repo's code.

## Read auth & security

Per-share PBKDF2 login gates with lockout and 7-day cookie sessions; write access is identity (a valid token or the per-share secret, both server-verified); revocation and freeze are instant and server-side. `CREATE_TOKEN` is a forever-valid admin credential — treat it like a password. The full model: [worker README](share-worker/README.md#read-auth-optional-casual-eyes-resistance).

## Troubleshooting

| Symptom | Meaning / fix |
|---|---|
| `[openshare] disabled: no share server configured` | No `servers`/`workerUrl` anywhere — expected right after install. Connect via `/share` or set config. |
| `[openshare] enrollment failed: …` | Wrong access code, code exhausted, or rate-limited. If you're the hoster: check `AUTH_MODE`, the code's activations, and that you used the server's base URL. |
| Viewer page `401 authRequired` | That share has the read gate on — log in with the credentials the sharer gave you (not a plugin error). |
| Share page 404s / blank | The backend's viewer build is missing. Bun: check the startup line (`viewer: not built`); Cloudflare: build `share-viewer/dist` before deploying; Docker builds it in. |
| `[openshare] … 404` on create | Deployed backend is older/newer than your plugin — redeploy from the same repo state and restart opencode. |
| Share page says `gone` | Deleted, purged, or TTL-expired. The TUI auto-clears the binding on next `/share`. |
| Share stuck on `interrupted` | The plugin vanished without goodbye (kill -9, crash) — the server finalizes after the grace window; reopen the session or run `/share` to re-attach. |
| Scripted client gets HTTP 403 with a Cloudflare 'error 1010' page | Zone-level bot protection — add a WAF exception for `/api/*` and `/s/*`, or send a browser-like User-Agent. |
| Worker deploy fails on the KV namespace | The shipped namespace id belongs to the author — create your own and put its id in `wrangler.toml`. |

More (url file, stderr policy, mode mismatches): [CONFIGURATION.md](CONFIGURATION.md) and the package READMEs.

## Self-hosting

Two interchangeable backends — pick by where you want to run it:

| | Cloudflare Worker (`share-worker/`) | Bun server (`share-server/`) |
|---|---|---|
| Storage | Durable Objects + KV | one SQLite file (WAL) |
| Idle sockets | hibernate (free) — auto policy resolves **persistent** | real fds — auto policy resolves **turn** |
| Deploy | `npx wrangler deploy` (+ viewer assets) | `bun server.ts` / Docker |
| Identity | identical (`AuthDO` vs SQLite tables) | identical |
| Backups | Cloudflare's DO persistence | stop and copy `openshare.db` **plus** `-wal`/`-shm`, or `sqlite3 openshare.db ".backup backup.db"` live |

Ops notes (restart durability, reverse proxies, TLS, backups): [share-server/README — Ops notes](share-server/README.md#ops-notes).

## Uninstalling

- **Plugin**: delete the package entries from `opencode.json` and `tui.json` (v2: `opencode plugin remove @mirrowel/opencode-openshare`), restart. Leftover local state: `~/.config/opencode/openshare.config.json` (tokens + settings), the spool dir under the XDG data home, and — for local-checkout installs — the gitignored `openshare.local.json` at the repo root. Share bindings stay inside each session's metadata in the opencode session DB until those sessions are deleted.
- **Shares**: unshare from the TUI (deletes the pages), or `POST /api/admin/purge`. TTL handles the rest if you just walk away.
- **Backend**: Cloudflare — `npx wrangler delete`. Bun — stop the process, delete the directory. Docker — remove the `oshdata` volume too.

## Glossary

- **Binding** — the share record in opencode session metadata (`metadata.openshare`): per-server share id, secret, rev, url. Survives restarts; never synced.
- **Spool** — on-disk buffer of unacked sync frames, one per session per server; replays on reconnect.
- **Enrollment** — the plugin obtaining a user token from a server (public, or via an access code). `osk_` = user token, `osc_` = access code.
- **Fan-out** — one session streaming to several servers at once.
- **Rev** — monotonic per-share revision, bumped by every accepted sync; the loss-detection and replay anchor.
- **Gone** — a share whose page no longer exists (deleted/purged/expired).
- **Backfill** — syncing a session's full prior history when it starts sharing (or when a server joins mid-session).

## License

MIT — [LICENSE](LICENSE).

## Development

```bash
cd share-plugin
npm install
npm run build          # dist/ + the single-file ci/openshare.js
npm run test           # full matrix
npm run test:quick     # everyday gate
```

The suites run the real production path — real `opencode serve` instances, a mock LLM provider, local `wrangler dev` workers, and the Bun backend parity runs. Architecture, suite layout, the release workflow, vendoring, and host-integration notes: [DEVELOPMENT.md](DEVELOPMENT.md).
