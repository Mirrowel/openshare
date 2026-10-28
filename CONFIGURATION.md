# OpenShare configuration reference

The complete configuration surface across every package — what can be set, where it lives, what order it loads in, and where to put what. This is the single cross-package inventory; package READMEs stay canonical for their own usage detail.

Four independent layers, each with its own storage:

| Layer | Storage | Changed via |
|---|---|---|
| Server (CF worker) | `wrangler.toml` vars + secrets + bundled branding file | edit + `wrangler deploy` |
| Server-side objects | Durable Object storage (users, tokens, codes, shares) | admin API / enrollment |
| Plugin (client) | env > plugin options > JSON config files | env, opencode.json, config files, `/openshare` TUI |
| Viewer | browser cookie `osh_settings` (1 year) | the settings gear / Ctrl+K in the share page |

A fifth, minor one: TUI menu sizing lives in the opencode host kv (`ui-prefs`), not in any file.

---

## 1. The Cloudflare Worker — deploy-time settings

Source of truth: `share-worker/wrangler.toml`. Values apply at deploy; the worker also reads one secret and one bundled file. Priority for overlapping knobs: `BRAND_*` env vars > `openshare.config.json` > code defaults (`resolvePolicy()` in `worker.js`). Any var left unset uses its code default.

To change anything: edit `share-worker/wrangler.toml`, then from `share-worker/` run `npx wrangler deploy`. Migrations are additive; verify with `GET /health` and a create+delete round-trip afterwards.

### `[vars]` — server policy and limits

| Var | Default | Meaning |
|---|---|---|
| `MAX_TTL_HOURS` | `2160` (90d) | Hard cap for per-share `ttlHours`; clients may request less. The legacy `MAX_TTL_DAYS` var is still accepted (converted x24) |
| `AUTH_MODE` | `private` | `private` = enrollment requires an `osc_` access code; `public` = anyone knowing the hostname (per-IP rate-limited) |
| `CODELESS_ONBOARDING` | `false` | Public servers only: allow enrolling an ACCOUNT without an access code (anonymous creating stays open either way — this gate is about minting users). Default OFF; the hoster opts in |
| `ANON_CREATE_HOURLY` | `100` | Global rolling-hourly cap on anonymous (ownerless) share creations, all visitors combined. Public mode only. Each create costs a Durable Object + one KV write |
| `DEFAULT_MAX_LIVE_SHARES` | `0` (= unlimited) | Per-token default limit for **newly enrolled** users: max non-swept shares owned at once |
| `DEFAULT_MAX_TTL_HOURS` | `0` (= unlimited) | Per-token extra cap on share `ttlHours` (legacy `DEFAULT_MAX_TTL_DAYS` accepted) |
| `DEFAULT_DAILY_CREATES` | `0` (= unlimited) | Per-token max share creations per UTC day |
| `SOCKET_POLICY` | `auto` | `persistent` \| `turn` \| `auto` (Cloudflare → persistent since hibernation makes idle sockets free; anything else → turn) |
| `TURN_GRACE_MS` | `120000` | Turn mode: socket stays warm after a turn settles |
| `IDLE_DROP_MS` | `600000` | Turn mode: no-signal fallback drop |
| `FINALIZE_AFTER_MS` | `300000` | Plugin gone without goodbye → share settles to `interrupted` |
| `DEBOUNCE_MIN_MS` / `DEBOUNCE_MAX_MS` | `1000` / `60000` | Server-authoritative clamp on the client's sync debounce (delivered in the WS init ack + `/health`; plugins clamp themselves) |
| `COMPLETED_DELAY_MAX_MS` | `60000` | Clamp on the client's completed-status delay |

The server owns socket rules and the cadence window; the client's own timing settings are clamped into this range, never beyond it.

### Secrets (`npx wrangler secret put …`)

| Secret | Meaning |
|---|---|
| `CREATE_TOKEN` | Root admin bootstrap. Everything: admin API, any share op, ownerless creates. Permanent until rotated by redeploy. Regular plugins should enroll via `/api/enroll` instead |

### Branding — `share-worker/openshare.config.json`

Bundled at deploy; the deployment's skin. All fields optional, empty string = hide/fall back:

`name` (deployment label), `logoUrl` (header chip image; ship the file in `share-viewer/public/branding/` or any URL), `wordmarkUrl` (footer image; empty = `name · Open(code)Share` text), `linkUrl` (chip link), `accent` (hex; status dot, login card, rail marker, agent-switch name), `faviconUrl`, `backgroundUrl` (page background with readability overlay), `description` (login subtitle + `og:description`), `ogTitle` (full custom embed title), `ogImage` (link-preview image; falls back to logo).

`BRAND_*` env vars in `wrangler.toml` override the file field-for-field. A complete worked example lives in `share-worker/branding-example/`.

---

## 2. Server-side objects — runtime settings via API

Created/changed after deploy; stored in the AuthDO/ShareDO. These are data, not config files.

### Users
- `label` - display name in the admin console
- `settings.defaultTtlHours` - `GET`/`PUT /api/me/settings`; used when a share is created without an explicit `ttlHours` (still clamped by `MAX_TTL_HOURS`). The legacy `defaultTtlDays` field is accepted and converted x24
- `frozen` - severs token **and** secret control on all the user's shares at once (viewing unaffected); the kill switch for leaked identities. Unfreeze/reassign are the rescue paths
- `createdByCode` - which access code onboarded the user; `POST /api/admin/codes/:id/revoke-lineage` revokes EVERY token of EVERY user that code created (and disables the code)

### Tokens (`osk_:`)
Long-lived user tokens, SHA-256 hashed server-side, minted at enrollment or by the admin. Every token has a **class**:

- **full** (default) - the account credential. Creates, syncs any of the owner's shares, mints/revokes tokens (`POST /api/token` self-service), edits settings, rotates anything. Only full tokens keep the account alive.
- **scoped** - a service credential (CI, agents). Carries its own limits; creates within them; syncs/deletes/lists ONLY the shares it created (`creatorTokenId` is stamped on every share); self-rotates (the successor inherits the scope); cannot mint tokens, touch settings, or reach the owner's other shares. Minted by a full token: `POST /api/token {"kind":"scoped", "label", "limits"}`.

**Named config sets (B4)** - one token (key) carries up to 10 named sets; agents pick by name (`configSet` / `OPENSHARE_CONFIG_SET`), unspecified = the first set:
- Class A (`authLogin`, `authPassword`, `ttlHours`): applied by the SERVER at create - they never travel to any client response. A set with a credential pair gates every share that token creates, with zero config committed to the repo.
- Class B (`modelLabel`, `shareMode`): suggestions the plugin fetches ONCE per server per boot (`GET /api/token/sets`) and adopts only when the local config leaves them unspecified - then persists them to the settings home (no repeated fetches).
- Provisioning: `PUT /api/token/sets` (a full token edits its own; scoped read-only), `PUT /api/admin/tokens/:id/sets` (admin), or inline `sets` on any mint. A self/admin mint without explicit sets inherits the minter's.

Shared parameters:
- `label` (:64 chars)
- `limits` - `{ maxLiveShares, maxTtlHours, dailyCreates }`, each `0` = unlimited (legacy `maxTtlDays` accepted and converted); enforced atomically at share create (scoped tokens count only their own shares). New enrollments inherit the `DEFAULT_*` vars as their limits
- `expiresAt` - optional expiry
- lifecycle - rotation (`POST /api/token/rotate`, valid token in hand; the successor keeps the class and a scoped rotation TRANSFERS its shares to the successor), self-revoke (`DELETE /api/token`), admin revoke (`DELETE /api/admin/tokens/:id`). **Revocation freezes control**: when a user's last valid FULL token is revoked (or they all expire), every share that user created becomes read-only for anyone holding its secret too - only the admin can unfreeze or reassign. Scoped tokens never keep the account alive. Rotation never triggers this (the replacement is minted first). Bulk: `POST /api/admin/tokens/:id/freeze-shares` freezes just the shares one token created.

### Access codes (`osc_:`)
Invite-gated enrollment. Codes mint a user PLUS their first full token (one activation = one user); holders of any valid token mint more without a code. On public servers enrollment needs a code unless `CODELESS_ONBOARDING` is on - anonymous creating stays open regardless. Parameters: `label`, `activations` (budget; `-1` = unlimited), `ttlHours`, disable. Minted via `POST /api/admin/codes`.

### Shares
Created per shared session (`POST /api/share/<hex-suffix>` or the WS `init create`). Parameters at create:
- `sessionID` (required)
- `ttlHours` — resolution: request → the owner's `defaultTtlHours` → 2160; clamped (floor 1h) by the token's `maxTtlHours` and `MAX_TTL_HOURS`. Every legacy days-shaped input (config key, env var, token limit, request field, PATCH body) is accepted and converted x24
- `authLogin` / `authPassword` — optional read-auth gate on the viewer; changeable later via `POST /api/share/:id/auth`
- a per-share `secret` is returned (control alongside the owner token)
- `status` settles through `live` → `completed` | `error` | `interrupted`

Removing a share: delete (page gone) or disconnect (snapshot stays until TTL).

Key endpoints (full list in `share-worker/README.md`): enrollment `POST /api/enroll`; self-service `GET /api/me`, `GET /api/me/shares`, `GET|PUT /api/me/settings`, `POST /api/token` (self-mint; full tokens only), `GET|PUT /api/token/sets`, `POST /api/token/rotate`, `DELETE /api/token`, `PATCH /api/share/:id` (edit login/pass, ttlHours, meta after creation); admin (root or admin token) `POST /api/admin/users|tokens|codes`, freeze/unfreeze, `GET /api/admin/shares`, `POST /api/admin/shares/:id/reassign`, `POST /api/admin/codes/:id/revoke-lineage`, `POST /api/admin/tokens/:id/freeze-shares`, `POST /api/admin/purge` (wipes everything).

---

## 3. The plugin (client) — files, order, keys

### The read chain (per key, first found wins; `servers` merges per-field)

1. `OPENSHARE_*` environment variables
2. Plugin options — the `[path, options]` tuple in opencode's `plugin` array (opencode.json)
3. `openshare.config.json` **adjacent to the plugin file** — the CI single-file shape
4. `openshare.config.json` at the package root
5. `openshare.local.json` — walking up from the plugin dir (dev overrides; gitignored by convention)
6. `~/.config/opencode/openshare.config.json` — **the interactive settings home** (respectively `$OPENCODE_CONFIG_DIR` / `$XDG_CONFIG_HOME/opencode` / `%USERPROFILE%\.config\opencode`)
7. Code defaults

Empty string means "unset" for `workerUrl`, `createToken`, `urlFile`, `spoolDir` — a shipped template with blank values never shadows real config elsewhere. The `servers` group merges **field-level** across all files: a static `code` in plugin options plus a persisted `token` in the settings home combine instead of shadowing.

### All keys

| Key | Default | Meaning |
|---|---|---|
| `workerUrl` | `""` | Legacy single-server shorthand (plugin disabled until set). Synthesizes a `servers` entry |
| `createToken` | `""` | Legacy credential for the above — the root CREATE_TOKEN, filed as both `token` and `adminToken` |
| `servers` | — | Multi-server memberships: `{ "<url>": { token, code, label, active, adminToken } }`. `token` = enrolled `osk_` token (or root); `code` = one-time enrollment code for private servers; `adminToken` = root token for the admin console (convenience); `active` picks where new sessions share (default: first entry). Fan-out: every session shares to all member servers |
| `debounceMs` | `10000` | Sync flush rate limit (server-clamped 1s–60s). CI ~5000, relaxed ~30000 |
| `completedDelayMs` | `5000` | Grace before the status flips to `completed` (server-capped). Dispose flushes a pending flip |
| `modelLabel` | `"$Provider/$Model"` | Template for the model label in share data |
| `ttlHours` | `2160` | Default TTL in hours for this plugin's shares (still server-clamped; legacy `ttlDays` accepted x24) |
| `redact.patterns` | built-ins | Extra regexes (strings) applied beside the built-in secret detectors on ungated shares |
| `authLogin` / `authPassword` | `""` | Default read-auth credentials applied when the share sets none. Both fields or neither — a half pair never builds a gate and is refused (logged once) |
| `spoolDir` | `$XDG_DATA_HOME/opencode/openshare` | Where the offline sync spool lives |
| `urlFile` | `""` → `openshare.urls.txt` in the session dir | Append-only log of share URLs per session. `"none"` disables the file entirely |
| `configSet` | `""` | Which named config set on the server token this client uses (B4; unset = the token's first/default set). Rides every create frame |
| `urlFileFormat` | `"url"` | Line format: `url` = one bare URL per line; `json` = one JSON object per line (`{"id","url","status","gated"}`) for CI consumers that parse fields instead of URLs |
| `meta` | - | Free-form string labels (max 20 keys, 64-char names, 500-char values) stamped onto every share at create; shown in the server's admin shares listing. Values may reference env vars as `${NAME}` - resolved when the share is created; unresolved refs stay literal so misconfiguration is visible |
| `announceStderr` | `true` | `false` silences the `[openshare] live:` and `url file:` stderr lines (errors still print; the TUI carries the URL) |
| `shareMode` | presence-detected | `all` = every session auto-shares (the CI shape); `manual` = explicit `/share` with per-share consent. Unset → presence detection: an openshare TUI entry in any `tui.json` layer (global, `OPENCODE_TUI_CONFIG`, project chain) = manual, none = all. Detection is read-only; the plugin never writes `tui.json`. Fixed at process start |

Matching env vars: `OPENSHARE_WORKER_URL`, `OPENSHARE_CREATE_TOKEN`, `OPENSHARE_DEBOUNCE_MS`, `OPENSHARE_COMPLETED_DELAY_MS`, `OPENSHARE_MODEL_LABEL`, `OPENSHARE_TTL_DAYS`, `OPENSHARE_AUTH_LOGIN`, `OPENSHARE_AUTH_PASSWORD`, `OPENSHARE_URL_FILE`, `OPENSHARE_URL_FILE_FORMAT`, `OPENSHARE_SPOOL_DIR`, `OPENSHARE_ANNOUNCE_STDERR`, `OPENSHARE_SHARE_MODE`.

**`OPENSHARE_CONFIG_JSON`** - a complete config object in one env var (same keys as a config file, including `servers` and `meta`), for pipelines that cannot mount files. It sits between the file/options layers and the per-key env vars: a specific `OPENSHARE_*` var still wins over it, and it wins over every file. Malformed JSON logs an error line and is ignored - it never clears lower layers.

### Where the plugin WRITES

The `/openshare` TUI writes only to the settings home (`~/.config/opencode/openshare.config.json`) by default, or to any *already existing* file in the read chain via its write-target picker — it never creates override files and never dirties shipped templates. Enrollment tokens persist as surgical `servers` entry patches into the same home.

Deliberately **not** in config files:
- per-session share state — the session metadata binding v2: `{v:2, enabled, opts?, servers:{url:{id, secret, rev, collided?|optedOut}}}`
- TUI menu sizing — opencode host kv (`ui-prefs`): width 60/88/116 columns, height percent
- the offline spool — append-only JSONL under `spoolDir`
- consent — asked per share creation, never stored

---

## 4. The Bun server — env-var configuration

The portable backend (`share-server/`) takes the same policy knobs as environment variables at launch; behavior is otherwise protocol-identical. `PORT` (8787), `CREATE_TOKEN` (required for admin/root), `AUTH_MODE`, `CODELESS_ONBOARDING`, `OPENSHARE_DB` (default `./openshare.db` **next to `server.ts`**, not your cwd), `VIEWER_DIR`, `MAX_TTL_HOURS` (legacy `MAX_TTL_DAYS`), `SOCKET_POLICY` (auto → `turn` here — no hibernation, sockets are real fds), the timer vars, the `DEFAULT_*` token limits, and `BRAND_*` (same fields as the worker's branding file). Full table in `share-server/README.md`.

---

## 5. The viewer — cookie settings

All reader settings live in one JSON cookie, `osh_settings` (1-year expiry), per browser — nothing server-side. Set through the settings gear / Ctrl+K on any share page; read pre-paint (no theme flash). Stored/loaded by `share-viewer/src/settings.ts`; old cookie shapes migrate in place.

| Key | Default | Meaning |
|---|---|---|
| `view` | `"classic"` | Which of the 12 views renders (classic, conversation, reader + skins) |
| `theme` | `"system"` | `system` \| `light` \| `dark` \| `darker` \| `mirrobot` \| `midnight` \| `sepia` \| `nord` |
| `continuous` | `false` | Legacy global paged/continuous (per-view below is current) |
| `pagedByView` | `{}` | Per-view paged choice, keyed by view id; absent = continuous |
| `promptNav` | `"sidebar"` | Turn navigation shape: floating `"pill"` or the `"sidebar"` column (with ≥1 prompt one of the two is always present) |
| `turnNavWidth` | — | Sidebar width in px (drag-resize, clamped 160–400) |
| `previewPromptLines` / `previewResponseLines` | `3` / `4` | Hover-preview line counts |
| `followLive` | `true` | New content keeps the viewport pinned to the live end |
| `textScale` | `100` | Interface scale, % of the type ladder (75–150) |
| `readTextPx` | `14` | Reading text base size, px (12–24) |
| `diffMode` | `"auto"` | `auto` (split when it fits) \| `split` \| `unified` (forced split still needs the space) |
| `backgroundOn` | `true` | Branded background (when the deployment ships one) |
| `reasoningOpen` | `false` | Reasoning/thinking expanded by default |
| `centerContent` | `false` | Center the content column |
| `toolInfo` | `true` | Show tool-call arguments (hidden unless the row is expanded) |
| `autoExpand` | `[]` | Tools whose bodies auto-expand on render (checkbox list; known tools + this session's) |
| `toolGrouping` | `"off"` | `off` \| `custom` \| `all` — grouping of consecutive tool calls |
| `groupTools` | `["read","glob","grep","list"]` | Which tools `custom` grouping collapses |
| `groveThinking` | `"left"` | Grove skin only: reasoning column |
| `outputOverflow` | `"wrap"` | Non-file tool outputs (shell/grep/glob/list): `wrap` or `scroll` (hidden-scrollbar pan) |
| `fileOverflow` | all `"wrap"` | Per-file-tool overflow: `{read, write, edit}` each `wrap`/`scroll` independently |
| `promptStyle` | `"bubble"` | User prompts: right-aligned `bubble` or `flat` text |
| `smoothScroll` | `"near"` | Prompt-jump animation: `instant` \| `near` (short jumps only) \| `always` |
| `pillGhost` | `false` | Pill rests invisible; proximity wakes it |
| `navSearchBar` | `false` | Filter field in the prompt views |
| `rowPromptLines` / `rowResponseLines` | `1` / `0` | Prompt-row content lines (1–5 / 0–5) |
| `cardWidth` | `40` | File-tool card width in rem (split diffs = 2×, viewport-capped); live as `--osh-card` |

---

## 6. Quick "where do I set X"

| I want to change… | Go to |
|---|---|
| Server TTL cap, auth mode, socket policy, token defaults | `share-worker/wrangler.toml` `[vars]` + redeploy |
| Root admin token | `wrangler secret put CREATE_TOKEN` |
| Deployment branding / OG embeds | `share-worker/openshare.config.json` + redeploy |
| A user's limits / a new token / an access code | admin API (`/api/admin/…`) — or the `/openshare` console on the hoster's machine |
| My default share TTL (as a user) | `PUT /api/me/settings` `defaultTtlDays` |
| Which server(s) my sessions share to, credentials | plugin config: `servers` group (TUI writes it to the settings home) |
| Sync timing, URL output, stderr noise, share mode | plugin config keys / `OPENSHARE_*` env (table in §3) |
| Reading experience (theme, views, widths, grouping) | the viewer settings gear — the `osh_settings` cookie |

Package READMEs: root `README.md` (usage + flows), `share-worker/README.md` (API + policy), `share-plugin/README.md` (plugin install + TUI), `share-server/README.md` (Bun backend), `share-viewer/README.md` (viewer), `DEVELOPMENT.md` (internals, tests, vendoring).
