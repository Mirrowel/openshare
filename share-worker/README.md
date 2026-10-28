# Open(code)Share — re:share

Deploy-time settings (vars, secrets, branding) and the whole cross-package config surface are inventoried in [../CONFIGURATION.md](../CONFIGURATION.md); this file is the API and policy reference.

Self-hosted session sharing for opencode. Upstream discontinued share
links (opncd.ai); this replaces the whole chain with infrastructure you
own. One data contract everywhere: the OpenShare envelope `v: 2`
(session / message / session_diff / model / prefs items — messages carry
their content embedded (opencode v2 session shapes), keyed-merge
last-write-wins, keys derived server-side) — live and archived sessions
are the same bytes and render with the same viewer.

Storage scales with session size: each item lives under its own DO
storage key (`item/<key>`), tombstones cascade to their parts' shards,
and `/data` plus the WS first frame are rendered once per revision into
an isolate-memory cache. A viewer that just loaded `/data` may open the
WS with `?since=<rev>` — when the rev is unchanged the worker answers
with an empty frame instead of re-sending the full item set.

## Deploy

From the repo root (details and prerequisites: the [root README's Quick start](../README.md#quick-start)):

```sh
cd share-viewer && npm install && npm run build && cd ..   # the viewer ships as worker assets
cd share-worker
npx wrangler kv namespace create KV                        # YOUR namespace — replace the id in wrangler.toml
npx wrangler secret put CREATE_TOKEN                       # root admin token (treat like a password)
npx wrangler deploy
curl -s https://<your-worker>.workers.dev/health           # {"ok":true,"service":"openshare","policy":{...},"auth":{"mode":"private"}}
```

Vars (`AUTH_MODE`, `SOCKET_POLICY`, TTL caps, branding…) are `[vars]` in
`wrangler.toml` — edit and redeploy. The portable Bun alternative lives
in [`../share-server`](../share-server/README.md).

## Server policy

The worker owns the connection rules; the plugin clamps itself into these on connect (WS init ack + `/health` both carry the resolved policy). All are `[vars]` in `wrangler.toml` with code defaults:

| Var | Default | Meaning |
|---|---|---|
| `SOCKET_POLICY` | `auto` | `auto` -> Cloudflare runtime detected -> `persistent` (WebSocket hibernation makes idle sockets free; dropping would just re-wake DOs); anything else (VPS/self-host) -> `turn`. |
| `TURN_GRACE_MS` | `120000` | Turn mode: after a turn settles the socket stays warm this long (typing time for the next prompt), then drops cleanly. Any activity cancels; the next event reconnects on demand and the spool replays the gap. |
| `IDLE_DROP_MS` | `600000` | Turn mode: no-signal fallback (hosts that never emit idle). |
| `FINALIZE_AFTER_MS` | `300000` | Plugin socket died WITHOUT a goodbye (kill -9, crash, power cut): after this long the share settles to `interrupted` (never `completed` - the run's truth is unknown). DO alarm on socket close; the daily sweeper backstops silent deaths where even the close never surfaced. Reconnects cancel it. |
| `MAX_TTL_HOURS` | `2160` (90d) | Per-share TTL cap, **hours-native** (per-token `maxTtlHours` caps below this; the user's `defaultTtlHours` setting is clamped to it). Legacy `MAX_TTL_DAYS` / `maxTtlDays` / `defaultTtlDays` / `ttlDays` inputs are all accepted and converted x24; the floor is 1 hour. |
| `ANON_CREATE_HOURLY` | `100` | Public mode: global cap on anonymous (ownerless) share creations per rolling hour, ALL anonymous visitors combined. Each create costs a Durable Object + one KV write. |
| `DEBOUNCE_MIN_MS` / `DEBOUNCE_MAX_MS` | `1000` / `60000` | Allowed client sync interval (the clamp window). |
| `COMPLETED_DELAY_MAX_MS` | `60000` | Allowed client completed-delay. |

Share statuses: `live`, `completed`, `error` (terminal turn failure -
recovered retries are forgiven), `interrupted` (server-side only: plugin
vanished mid-live), `gone`.

## Architecture

**Live** — the plugin (`share-plugin/` — package
`@mirrowel/opencode-openshare` or its single-file `openshare.js` bundle)
streams events over one WebSocket per main session to the worker; viewers
watch via hibernating WebSockets. Free-tier friendly by construction:
sockets sleep while idle (zero cost), outgoing pushes are free, incoming
frames bill 20:1. A 10s-debounced batch costs a few request-equivalents
per session; a watched page costs exactly one request to open.

## Resource budget (what the worker actually spends)

The binding constraint on the Workers **free plan is Durable Object
SQLite row writes** — 100k/day, with puts *and* deletes each counting as
one row. The accounting is simple:

- every applied sync chunk writes `rows = items-changed + 1 meta row`
  (chunk-size overhead is ~0.5% at 200 items per chunk);
- a session's initial backfill is the big burst: a 5k-message session
  ≈ 5,000 rows in one go;
- steady-state streaming is amortized by the plugin's flush debounce —
  one row write per changed message per flush, not per event;
- reads are cheap (5M rows/day free) and viewer traffic is nearly free
  (hibernating sockets, free outgoing pushes, `?since` deltas answer
  ~200 bytes when nothing changed).

The floor is **one row per changed item** — irreducible without storing
multiple items per row (a batch-key layout would cut rows ~20x, but it
sits on the same storage/marker/delta machinery where the worst bugs in
this project's history lived, so it is deliberately not done). Personal
deployments sit far inside the budget (a busy day is typically 10-30k
rows); busy public community servers with many large backfills are what
approach it.

KV writes (1k/day free) are one per share create. On public servers the
global anonymous-create cap (`ANON_CREATE_HOURLY`, default 100 — all
anonymous visitors combined, per rolling hour) bounds that; note free
tier is not expected to host public servers in the first place.

**Passive** — after a run, [`tools/view-export.py`](../tools/README.md)
(agent-side companion) renders any exported session tree (main + every
subagent session) as the same viewer page locally — the durable CI
artifact path, no server involved.

## Delivery reliability (no expensive pulls)

- Every accepted sync bumps a monotonic rev; the worker acks it on the
  socket (seq-tagged — one ack per chunk-frame, so a partial
  acknowledgment can never retire unsent chunks). The plugin retains
  unacked frames in a disk spool (temporary
  buffer) and replays them on reconnect.
- The share binding `{id, secret, rev, url}` is persisted INSIDE
  opencode — session metadata (`metadata.openshare`, written via the
  session PATCH API) — so recovery never depends on the spool. The
  plugin strips the key from everything it syncs, and the worker strips
  session `metadata` on all read paths (belt and suspenders: the write
  secret must never reach viewers).
- Mismatch protocol (all logged loudly): attach refused / share gone /
  worker rev below our acked rev → fresh create (never merge into a bad
  base); nacked or dropped frames → spool replay; stale extras → left
  for the next prompt's keyed merge (and the revert marker) to correct.
- Degradation: if the session-metadata API is unreachable (e.g. a
  foreign server squats Server.url's port), the spool covers
  reconnects; a process crash loses only in-flight frames.

## States (last signal wins, always resumable)

`live` (busy) / `completed` (idle, no bad signals) / `error` (idle
after any part error or retry). The next busy flips live again — old
open pages wake in place via their hibernating socket. Viewer header
shows a colored dot (green/blue/red).

**Undo**: opencode publishes `info.revert` on the session item while a
revert marker is set (the viewer folds from it); the NEXT prompt then
hard-deletes the reverted range — the plugin emits **tombstones**
(`del: true` frames) so the share physically drops those items. See
[Worker API](#worker-api) for the tombstone wire form.

## Branding

The deployment skin is config-first: **`openshare.config.json`** next to
`wrangler.toml` (bundled at deploy) holds `name`, `logoUrl`,
`wordmarkUrl`, `linkUrl`, `accent`, `faviconUrl`, `backgroundUrl`,
`description`, `ogTitle`, `ogImage` — all optional, all defaulting to the
neutral upstream look. `BRAND_*` env vars override the file when both
exist (same ENV > file > defaults chain as the plugin config). Edit the
file, redeploy, done — no code. A complete worked example (config +
logo + steps) ships in **`branding-example/`**.

Identity model on the page: **left header = the deployment** (logo,
links to its git when `linkUrl` is set), **right header = Open(code)
Share itself** (github mark → repo, fixed in source so the product
always promotes itself), **version badge = the tool that ran** (opencode
mark + version), **footer** = brand wordmark image or styled text
("Open(code)Share" by default), **login + gone pages** = logo + name +
description, **accent** = status dot, login card, prompt-rail marker,
agent-switch name.

### Link previews (og: tags)

Crawler user-agents (Discordbot, TelegramBot, Slackbot, WhatsApp,
Twitterbot, ...) never run the SPA, so the worker serves them
`index.html` with `og:`/`twitter:` tags injected from the branding:
`og:title` = `ogTitle` (or `name · Open(code)Share` — the
**deployment** identity, never a session title; a link preview must
not leak what a share contains), `og:description` = `description`,
`og:image` = `ogImage` (absolute URL **or** a root-relative path,
resolved against the deployment origin; falls back to `logoUrl`). `/s/*` and `/` are
in `run_worker_first` for this; regular browsers pass straight through
to the static assets, and the viewer injects the same tags client-side
as a fallback.

## Viewer settings (cookie)

The gear in the header (or Ctrl+K, in every view) opens the settings
panel — persisted in a `osh_settings` cookie, applied pre-paint (no
theme flash). The canonical list of settings (theme, view, paged mode
per view, prompt rail, follow-live, text sizes, diff layout, reasoning
auto-open, auto-expand tools, long-line scroll/wrap, background image,
search) lives in one place: the
[viewer README](../share-viewer/README.md#what-the-page-does). Defaults:
system theme, continuous scroll, nothing auto-expanded.

Header extras: copy session as markdown, `j`/`k` prompt navigation.

## Read auth (optional, casual-eyes resistance)

`authLogin`/`authPassword` in the plugin config gate the share pages:
per-share PBKDF2-SHA256 hashes (10k iterations, per-share salt), a
branded login card, 7-day cookie session tokens (up to 5 devices), and
exponential lockout (5 fails per IP → 1min doubling to 24h; 20 total →
share-locked 24h). Credentials are sent on create AND attach: resuming
retroactively applies/updates them; empty-on-resume removes protection
(intentional owner action — write access is separately keyed).

**Write access is a different lock**: creating shares requires a valid
identity (user token or the root bootstrap), writing (sync/delete)
requires the owner's token or the per-share secret held only by the
plugin that created it. A URL plus valid login still cannot write a
byte. See "Identity & enrollment" below.

## Identity & enrollment

Two roles, one secret store (singleton AuthDO, tokens SHA-256-hashed at
rest):

- **Admin** = the root `CREATE_TOKEN` secret (env, forever-valid
  bootstrap). Manages everything operational: users, tokens, codes,
  shares. (Connection *policy* — socket mode, timers, TTL caps,
  AUTH_MODE — is deploy-time config in `wrangler.toml`, not an admin
  API surface.) No admin *tokens* — root is the only admin in this
  model.
- **Users** — anyone the hoster lets in. Full control of their OWN
  shares, tokens and settings; nothing else.

**Enrollment** (`POST /api/enroll`): a code mints a user PLUS their
first **full** token (one activation = one user). Private servers
(default) require an **access code** (`osc_…`) minted by the admin
with an activation budget — 1 for a personal invite, `-1` unlimited
for a team code. Public servers also require a code unless
`CODELESS_ONBOARDING` is enabled (default OFF — anonymous CREATING
stays open on public regardless; the gate is about minting ACCOUNTS).
Holders of any valid token mint more tokens without a code
(`POST /api/token`, full tokens only). Holding a valid token lets you
rotate (`POST /api/token/rotate`) without a code, forever — tokens
are long-lived by design (the OAuth-ish part without the refresh
churn).

**Ownership**: every share records its owner. Control ops accept the
owner's valid token **or** the per-share secret while the owner is in
good standing. **Freezing a user** severs BOTH paths on all their
shares at once (a valid secret no longer writes; viewing is unaffected
until TTL) — the kill switch for leaked identities. Unfreeze and
reassign-to-another-user are the admin rescue paths. Revoking a single
token only invalidates that token.

**Token classes** (both stay `osk_:` - the server knows the class):
- **full** (default) - the account credential: creates, syncs any of
  the owner's shares, mints/revokes tokens, edits settings. ONLY full
  tokens keep the account alive.
- **scoped** - a service credential (CI/agents), minted by a full
  token (`POST /api/token {kind:"scoped"}`): creates within its own
  limits, syncs/deletes/lists ONLY the shares it created (every share
  stamps `creatorTokenId`), self-rotates (successor inherits the
  scope), and nothing else. A scoped rotation TRANSFERS its shares to
  the successor - rotation never orphans the pages it made.

Per-token limits (enforced server-side at create): `maxLiveShares`,
`maxTtlDays`, `dailyCreates` (0 = unlimited; defaults via
`DEFAULT_*` vars; scoped tokens count only their own shares). Default-limit knobs users may change themselves:
`GET`/`PUT /api/me/settings` — `defaultTtlDays` (clamped by the
server; applied at create when the request omits `ttlHours`, the
explicit value always wins).

Self-service: `GET /api/me`, `GET /api/me/shares`,
`GET`/`PUT /api/me/settings` (full tokens only), `POST /api/token`
(self-mint full/scoped; full tokens only), `POST /api/token/rotate`,
`DELETE /api/token` (self-revoke). **Revocation freezes control**: when a
user's last valid FULL token is revoked (self or admin) — or they all
expire —
every share that user created turns read-only for EVERYONE holding its
secret too (both write paths reject with `frozen`); viewing continues to
TTL, and only the admin can unfreeze or reassign. Rotation never
triggers this (the replacement is minted first). An `init` attach may
also carry `ttlHours` (explicit per-session override only; legacy `ttlDays` converts): clamped like
create and applied to the live share — the plugin sends it when the
session's TTL override changes mid-life.

Admin API (Bearer `CREATE_TOKEN`):

- `POST /api/admin/users {label}` · `GET /api/admin/users`
- `POST /api/admin/users/:id/freeze` · `/unfreeze`
- `DELETE /api/admin/users/:id {mode?}` — default freezes; `{"mode":
  "delete"}` also removes every share and token
- `POST /api/admin/tokens {userId, label?, limits?, kind?}` · `GET
  /api/admin/tokens` · `DELETE /api/admin/tokens/:id`
  - `POST /api/admin/tokens/:id/freeze-shares` — bulk-freeze just the
    shares that token created (scoped blast radius without touching the
    owner's other shares; rotation never does this)
- `POST /api/admin/codes {label, activations, ttlHours?}` · `GET
  /api/admin/codes` · `DELETE /api/admin/codes/:id` (disable)
  - `POST /api/admin/codes/:id/revoke-lineage` — kill switch: revokes
    EVERY token of EVERY user that code onboarded (freezing each),
    disables the code. Users record `createdByCode`.
(dedup)  /api/admin/codes` · `DELETE /api/admin/codes/:id` (disable)
- `GET /api/admin/shares` (global, with ownerId; entries carry any
  `custom` labels the plugin stamped at create)
- `POST /api/admin/shares/:id/reassign {userId}`
- `DELETE /api/share/:id` — root may delete any share directly (the
  TUI admin console uses this)
- `POST /api/admin/purge` — removes EVERY share; details in
  [Worker API](#worker-api) below

`GET /health` reports `auth.mode` (`public`/`private`) next to the
socket policy so clients adapt without config.

Migration: shares created with the bare `CREATE_TOKEN` bearer are
ownerless (secret-only control, never frozen) — the legacy plugin
config keeps working unchanged.

## Subagent pages

Child sessions (`info.parentID`) route into the parent's share. URLs:
`/s/<id>` main, `/s/<id>/1`, `/2`, ... subagents ordered by first task
appearance. Task rows link to the sub-page (new tab by default — a
sender-side pref; in-page switching preserves scroll). Sub-pages render
the same view bound to the child session, with their own
title/version/model.

## Worker API

- `GET /api/share/:id/ws` — viewer socket (hibernating; auth cookie).
  Handshake params: `?since=<rev>` (the viewer already holds the share at
  `<rev>`), optionally `&delta=1` (announces delta-merge capability).
  First frame cases: `since === rev` → **empty** frame (nothing changed);
  `since < rev` with `delta=1` → **delta** frame (`kind:"delta"`, only the
  items touched since, tombstone markers re-emitted so clients delete);
  anything else (no `since`, or `since > rev` — server rewound/recreated)
  → **full** frame, the complete live item set, so the client prunes what
  no longer exists. Later frames are always deltas.
- `GET /api/ws?token=<user token | CREATE_TOKEN>` — plugin socket:
  `init` (create/attach; user tokens create OWNED shares under their
  limits, the root token creates ownerless legacy shares; attach works
  with the share secret OR — for the socket's own token holder — by
  ownership), `sync` → ack, `delete`. Acks are **seq-tagged**: the
  plugin chunks a logical frame and the ack identifies the chunk it
  applied, so only that chunk retires from the client's spool. The token
  may also arrive as a first `auth` frame instead of the query string
  (keeps it out of proxy logs; `/health` advertises `frameAuth`).
  The init create frame may carry `meta` (free-form string labels, max
  20 keys / 64-char names / 500-char values) - stored on the share and
  shown in the admin shares listing. The init **ack carries
  `auth: true|false`** - the share's resolved read-gate state after the
  exchange - so a client that asked for a gate can detect a half-pair
  no-op instead of assuming protection.
- Tombstones: a sync item may carry `del: true` (`{type:"message",
  del:true, data:{id}}` / part variant) — the worker deletes the keyed
  item and broadcasts the tombstone so live viewers drop it. Message
  tombstones cascade-delete that message's parts (opencode's undo
  cleanup removes messages without per-part events).
- HTTP fallback: `POST /api/share/<hex-suffix>` (Bearer user token or
  CREATE_TOKEN; anonymous ownerless allowed on public servers; the URL
  suffix is required by routing but ignored, the share id is generated
  server-side),
  `POST /api/share/:id/sync` (secret or Bearer owner token; bodies over
  8 MB are refused before parsing),
  `GET /api/share/:id/data` (accepts `?since=<rev>`: empty `data` array
  when the rev is unchanged, only the items touched since otherwise —
  same three-case semantics as the WS handshake minus the delta
  announcement, since the response is always a fresh set to merge),
  `GET /api/share/:id/snapshot` (ONE self-contained HTML file: the
  viewer bundle inlined + the share frozen as a JSON island + a boot
  shim; opens offline in any browser as a point-in-time record. The
  read gate applies exactly as `/data` — a gated share demands a
  satisfied viewer session (login cookie or bearer viewer token), no
  bypass. `?download=1` adds an attachment disposition. On `file://`
  browsers block worker/wasm loading, so code blocks render unhighlighted
  — every other surface is identical),
  `POST /api/share/:id/auth`, `DELETE /api/share/:id`
- `PATCH /api/share/:id` (#13) — edit ANY share setting after creation:
  body `{secret|Bearer owner, authLogin+authPassword (both-or-none),
  ttlHours (legacy ttlDays), meta}`; a credential change rotates viewer tokens; identity-
  gated exactly like sync (scoped tokens reach only their own shares)
- `GET|PUT /api/token/sets` and `PUT /api/admin/tokens/:id/sets` — named
  config sets on a token (B4): Class A (authLogin/authPassword/ttlHours)
  applies server-side at create and never appears in a client response;
  Class B (modelLabel/shareMode) is the fetchable suggestion view. Creates
  carry an optional `set` name; unset = the token's first set. Mints
  accept inline `sets` and inherit the minter's when omitted.
- `GET /api/share/:id/og.png` — per-share OG card (1200x630 PNG,
  rendered once per rev into a bounded isolate cache): deployment
  wordmark + accent edge, session title, status pill, stat line
  (turns · tools · duration · model). Gated shares render the GENERIC
  card ("Private share — log in to view") with no title and no stats —
  a link preview never leaks what a gated share contains. `?v=<rev>`
  in the served og:image URL busts Discord's per-URL preview cache.
  Link-preview crawlers (Discord/Telegram/Slack/etc) hitting `/s/<id>`
  get per-share `og:title`/`og:description` (stat line) + this card +
  `theme-color` (deployment accent); the landing page and gated shares
  keep the deployment-generic tags. Text rasterization: resvg-wasm with
  embedded Inter subsets (OFL). A design pass on the card look is
  scheduled (note #90).
- `GET /branding` — the deployment's resolved skin (name, logoUrl,
  wordmarkUrl, linkUrl, accent, faviconUrl, backgroundUrl, description,
  ogTitle, ogImage; all optional — absent = neutral default; see
  [Branding](#branding) and `branding-example/`)
- `POST /api/admin/purge` (Bearer CREATE_TOKEN) — owner maintenance:
  iterates the share index and removes EVERY share (DO storage + index;
  connected viewers get a final `gone` frame). Returns `{removed}`.
- ShareDO per share; ControlDO per plugin socket (attach state persisted
  to DO storage — survives hibernation eviction); AuthDO singleton
  (users/tokens/codes/registry; freeze denormalized onto each ShareDO so
  the write gate rejects locally); SweeperDO daily alarm
  deletes shares idle beyond their own ttlHours (create-time override,
  capped at MAX_TTL_HOURS).

## Plugin config

The plugin lives in `share-plugin/` (see its README). Three artifacts:
`ci/openshare.js` (single file, always share-all — the CI bundle),
`dist/server.js` (package server; share-all unless the TUI is
registered), `dist/tui.js` (package TUI; its presence flips the server
to manual mode with per-session opt-in via `/share`).

The full config contract (precedence chain, every key, env vars,
recipes) is documented once, in the [root README's Configuration
section](../README.md#configuration). Short version: `OPENSHARE_*` env
beats files; the `servers` group is the canonical multi-server form;
`workerUrl`/`createToken` is the legacy single-server shorthand.

Manual mode stores the opt-in in session metadata
(`metadata.openshare = { v: 2, enabled: true, opts? }`; per-session
opts: ttlHours, scope, authLogin, authPassword, modelLabel) next to the
per-server binding map `servers: {url: {id, secret, rev, url}}`
(legacy flat `{id, secret, rev, url}` bindings migrate at read); flag
removal deletes the share on every server. The key is stripped from all
synced data (worker strips session metadata on read paths as well).

## Local viewing (agent-side)

`python tools/view-export.py` serves the same viewer on localhost with
any exported session injected — see [`tools/README.md`](../tools/README.md).

## Viewer (share-viewer)

The share page — built on the vendored **opencode v2 component kit**
(session-ui + ui + core utils + sdk types; vite+solid+tailwind
client-only build). Tailwind scan roots are explicit (`source(none)` in
the vendored ui entry + `@source` lines in src/app.css) — without them,
vendor-only utilities silently never generate. Views are skins over one
base (the [views SDK](../share-viewer/src/views/README.md)); every view
virtualizes. Branding swaps at runtime: logo/wordmark images, header
link, page title, favicon, accent, login/gone pages, link previews.
Default = neutral upstream look.

Host-integration empirical notes (v1 event shapes, client quirks, the
v2 adapter posture) moved to [`../DEVELOPMENT.md`](../DEVELOPMENT.md#host-integration-notes-v1v2).
