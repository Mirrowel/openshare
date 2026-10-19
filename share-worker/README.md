# Open(code)Share — re:share

Self-hosted session sharing for opencode. Upstream discontinued share
links (opncd.ai); this replaces the whole chain with infrastructure you
own. One data contract everywhere: the upstream share `Data[]` snapshot
model (session / message / part / session_diff / model / prefs items,
keyed-merge last-write-wins, keys derived server-side) — live and
archived sessions are the same bytes and render with the same viewer.

## Server policy (the worker owns the rules)

The plugin clamps itself into these on connect (WS init ack + `/health`
both carry the resolved policy). All are `[vars]` in `wrangler.toml`
with code defaults:

| Var | Default | Meaning |
|---|---|---|
| `SOCKET_POLICY` | `auto` | `auto` -> Cloudflare runtime detected -> `persistent` (WebSocket hibernation makes idle sockets free; dropping would just re-wake DOs); anything else (VPS/self-host) -> `turn`. |
| `TURN_GRACE_MS` | `120000` | Turn mode: after a turn settles the socket stays warm this long (typing time for the next prompt), then drops cleanly. Any activity cancels; the next event reconnects on demand and the spool replays the gap. |
| `IDLE_DROP_MS` | `600000` | Turn mode: no-signal fallback (hosts that never emit idle). |
| `FINALIZE_AFTER_MS` | `300000` | Plugin socket died WITHOUT a goodbye (kill -9, crash, power cut): after this long the share settles to `interrupted` (never `completed` - the run's truth is unknown). DO alarm on socket close; the daily sweeper backstops silent deaths where even the close never surfaced. Reconnects cancel it. |
| `DEBOUNCE_MIN_MS` / `DEBOUNCE_MAX_MS` | `1000` / `60000` | Allowed client sync interval (the clamp window). |
| `COMPLETED_DELAY_MAX_MS` | `60000` | Allowed client completed-delay. |

Share statuses: `live`, `completed`, `error` (terminal turn failure -
recovered retries are forgiven), `interrupted` (server-side only: plugin
vanished mid-live), `gone`.

- Title: **Open(code)Share** · tagline: *re:share — session sharing, back
  for opencode*
- Package/plugin: `openshare` (`openshare.js` + `openshare.config.json`,
  loaded like any opencode plugin)
- Worker: `openshare-worker` (Cloudflare, free-tier friendly)

The default look is the neutral upstream-derived page; deployments brand
themselves via `BRAND_*` worker vars (this deploy ships the mirrobot
example skin — swap the vars and the assets to make it yours).

## Architecture

**Live** — the plugin (`share-plugin/` — package
`@mirrowel/opencode-openshare` or its single-file `openshare.js` bundle)
streams events over one WebSocket per main session to the worker; viewers
watch via hibernating WebSockets. Free-tier friendly by construction:
sockets sleep while idle (zero cost), outgoing pushes are free, incoming
frames bill 20:1. A 10s-debounced batch costs a few request-equivalents
per session; a watched page costs exactly one request to open.

**Passive** — after a run, `export-session.py` (agent-side companion)
exports the session tree (main + every subagent session in the db),
normalizes to Data[], gzips and hybrid-encrypts it (MRB2:
RSA-OAEP-wrapped AES-256-CBC) into an Actions artifact plus an
encrypted meta blob for the run summary.

## Delivery reliability (no expensive pulls)

- Every accepted sync bumps a monotonic rev; the worker acks it on the
  socket. The plugin retains unacked frames in a disk spool (temporary
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

**Undo needs no protocol**: opencode publishes `info.revert` on the
session item; the viewer hides everything from that message while the
marker is set.

## Branding

The deployment skin is config-first: **`openshare.config.json`** next to
`wrangler.toml` (bundled at deploy) holds `name`, `logoUrl`,
`wordmarkUrl`, `linkUrl`, `accent`, `faviconUrl`, `backgroundUrl` — all
optional, all defaulting to the neutral upstream look. `BRAND_*` env
vars override the file when both exist (same ENV > file > defaults
chain as the plugin config). Edit the file, redeploy, done — no code.

Identity model on the page: **left header = the deployment** (logo,
links to its git when `linkUrl` is set), **right header = Open(code)
Share itself** (github mark → repo, fixed in source so the product
always promotes itself), **version badge = the tool that ran** (opencode
mark + version), **footer** = brand wordmark image or styled text
("Open(code)Share" by default).

## Viewer settings (cookie)

The gear in the header opens the settings panel — persisted in a
`osh_settings` cookie, applied pre-paint (no theme flash):

- **Theme**: system (default), forced light/dark, plus premades —
  `mirrobot` (the landing-page paper-terminal look, included by
  default), `midnight`, `sepia`, `nord`. Forced themes work via
  attribute-scoped token copies emitted by
  `tools/share-viewer/scripts/build-themes.mjs` at build time.
- **Text size**: compact / normal / roomy (root font scale).
- **Continuous mode**: render every prompt in one scroll instead of
  one-turn-at-a-time with the left selector — continuity reading.
- **Follow live scroll**: during a live share the view keeps the newest
  content visible, but only while you are already at the bottom — it
  never fights your reading position.
- **Reasoning expanded**: default open instead of collapsed (applies to
  rendered blocks immediately).
- **Background image**: on/off toggle, present only when the deployment
  sets `backgroundUrl` (rendered under a dark readability overlay).
- **Session search**: prompt filter (Ctrl+K).

Header extras: copy session as markdown, j/k prompt navigation.

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
  bootstrap). Manages everything: users, tokens, codes, shares, policy.
  No admin *tokens* — root is the only admin in this model.
- **Users** — anyone the hoster lets in. Full control of their OWN
  shares, tokens and settings; nothing else.

**Enrollment** (`POST /api/enroll`): a **public** server (`AUTH_MODE =
"public"`) issues a user token to anyone who knows the hostname
(per-IP rate limit); a **private** server (default) additionally
requires an **access code** (`osc_…`) minted by the admin with an
activation budget — 1 for a personal invite, `-1` unlimited for a team
code. Each activation burns one use and issues `osk_…`. Holding a valid
token lets you rotate (`POST /api/token/rotate`) without a code,
forever — tokens are long-lived by design (the OAuth-ish part without
the refresh churn).

**Ownership**: every share records its owner. Control ops accept the
owner's valid token **or** the per-share secret while the owner is in
good standing. **Freezing a user** severs BOTH paths on all their
shares at once (a valid secret no longer writes; viewing is unaffected
until TTL) — the kill switch for leaked identities. Unfreeze and
reassign-to-another-user are the admin rescue paths. Revoking a single
token only invalidates that token.

Per-token limits (enforced server-side at create): `maxLiveShares`,
`maxTtlDays`, `dailyCreates` (0 = unlimited; defaults via
`DEFAULT_*` vars). Default-limit knobs users may change themselves:
`PUT /api/me/settings` (`defaultTtlDays`, clamped by the server).

Self-service: `GET /api/me`, `GET /api/me/shares`,
`POST /api/token/rotate`, `DELETE /api/token` (self-revoke).

Admin API (Bearer `CREATE_TOKEN`):

- `POST /api/admin/users {label}` · `GET /api/admin/users`
- `POST /api/admin/users/:id/freeze` · `/unfreeze`
- `DELETE /api/admin/users/:id {mode?}` — default freezes; `{"mode":
  "delete"}` also removes every share and token
- `POST /api/admin/tokens {userId, label?, limits?}` · `GET
  /api/admin/tokens` · `DELETE /api/admin/tokens/:id`
- `POST /api/admin/codes {label, activations, ttlHours?}` · `GET
  /api/admin/codes` · `DELETE /api/admin/codes/:id` (disable)
- `GET /api/admin/shares` (global, with ownerId)
- `POST /api/admin/shares/:id/reassign {userId}`
- `POST /api/admin/purge` (unchanged)

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

- `GET /api/share/:id/ws` — viewer socket (hibernating; auth cookie)
- `GET /api/ws?token=<user token | CREATE_TOKEN>` — plugin socket:
  `init` (create/attach; user tokens create OWNED shares under their
  limits, the root token creates ownerless legacy shares; attach works
  with the share secret OR — for the socket's own token holder — by
  ownership), `sync` → ack, `delete`
- Tombstones: a sync item may carry `del: true` (`{type:"message",
  del:true, data:{id}}` / part variant) — the worker deletes the keyed
  item and broadcasts the tombstone so live viewers drop it. Message
  tombstones cascade-delete that message's parts (opencode's undo
  cleanup removes messages without per-part events).
- HTTP fallback: `POST /api/share/<hex-suffix>` (Bearer user token or
  CREATE_TOKEN; anonymous ownerless allowed on public servers; the URL
  suffix is required by routing but ignored, the share id is generated
  server-side),
  `POST /api/share/:id/sync` (secret or Bearer owner token),
  `GET /api/share/:id/data`,
  `POST /api/share/:id/auth`, `DELETE /api/share/:id`
- `GET /branding` — the deployment's `BRAND_*` skin (name, logoUrl,
  wordmarkUrl, linkUrl, accent, faviconUrl; all optional — absent =
  neutral default)
- `POST /api/admin/purge` (Bearer CREATE_TOKEN) — owner maintenance:
  iterates the share index and removes EVERY share (DO storage + index;
  connected viewers get a final `gone` frame). Returns `{removed}`.
- ShareDO per share; ControlDO per plugin socket (attach state persisted
  to DO storage — survives hibernation eviction); AuthDO singleton
  (users/tokens/codes/registry; freeze denormalized onto each ShareDO so
  the write gate rejects locally); SweeperDO daily alarm
  deletes shares idle beyond their own ttlDays (create-time override,
  capped at MAX_TTL_DAYS).

Deploy: `npx wrangler deploy` (secret CREATE_TOKEN; KV SHARE_INDEX;
assets = ../share-viewer/dist).

## Plugin config (`openshare.config.json`)

The plugin lives in `share-plugin/` (see its README). Three artifacts:
`openshare.js` (single file, always share-all — the CI bundle),
`dist/server.js` (package server; share-all unless the TUI is
registered), `dist/tui.js` (package TUI; its presence flips the server
to manual mode with per-session opt-in via `/share`).

Priority `OPENSHARE_*` env > plugin options > file > code defaults.
Keys: workerUrl, createToken, shareMode ("all"/"manual"; default =
TUI presence), debounceMs (10000), modelLabel ("$Provider/$Model";
literal text as-is; "" hides), ttlDays (90), openTasksInNewTab (true),
authLogin/authPassword (""), spoolDir, urlFile (all-mode only).

Manual mode stores the opt-in in session metadata
(`metadata.openshare = { enabled: true, opts? }`; per-session opts:
ttlDays, authLogin, authPassword, modelLabel) next to the binding
`{id, secret, rev, url}`; flag removal deletes the share. The key is
stripped from all synced data (worker strips session metadata on read
paths as well).

## Local viewing (decrypt_share_link.py, agent-side)

Paste the MRB2 meta blob / MRB1 history / `--file` an artifact:
fetches via gh, decrypts, caches Data[] JSON, and serves the SAME
viewer on localhost (7788-7790) while the tool is open. Offline
minimal-template fallback for no-dist environments.

## Viewer (tools/share-viewer)

The upstream share page vendored (session-ui + ui + core utils + sdk
types; vite+solid+tailwind client-only build). Tailwind scan roots are
explicit (`source(none)` in the vendored ui entry + `@source` lines in
src/app.css) — without them, vendor-only utilities silently never
generate. Branding swaps at runtime: logo/wordmark images, header link,
page title, favicon, accent. Default = neutral upstream look.

## v1-plugin facts baked in (empirical, 1.18.31)

- Plugins load in `opencode run` via OPENCODE_CONFIG; a redirected
  XDG_CONFIG_HOME sandbox silently loads NO plugins.
- SDK client calls are hey-api shaped: `{path: {id}}` / `{path, body}`
  — and error envelopes don't throw (check `.error` or you fail
  silently; live-caught as literal `%7Bid%7D` URLs).
- The client can hit a foreign server when something else listens on
  Server.url's port — degrade loudly, spool covers.
- `message.info.parentID` = the replied-to message; only session
  `info.parentID` marks subagent children.
- Task parts carry `state.metadata.sessionId` (the child session).
- Resumed sessions may emit the user message BEFORE any session.* event
  — unknown sids are treated as main (children announce first).

## v2 port posture

DONE for the plugin: `share-plugin/src/v2-server.ts` maps the v2 event
model (fine-grained session.* domain events -> debounced re-sync through
the client) and converts v2 flat messages to the v1 message+parts Data[]
contract; `v2-tui.ts` runs the same flows on the v2 TUI (dialog bridge +
reactive keymap layer). Verified against a scripted mock v2 host; run
live on a beta build to sign off. The worker/viewer/crypto are
version-agnostic (Data[]).
