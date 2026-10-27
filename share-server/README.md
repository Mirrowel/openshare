# Open(code)Share — portable server

Every environment variable this server reads is listed below; the cross-package config surface (worker, plugin, viewer) is inventoried in [../CONFIGURATION.md](../CONFIGURATION.md).

The same share backend as the Cloudflare worker
([../share-worker](../share-worker)) as **one Bun process**: SQLite
storage, native WebSockets, the built viewer served statically. For VPS
deployments, self-hosting, or anything that isn't Cloudflare — same
protocol, same plugin, same auth model.

## Quick start

From the repo root:

```sh
# build the viewer once (or point VIEWER_DIR at an existing build)
cd share-viewer && npm install && npm run build && cd ../share-server

# sh:
CREATE_TOKEN=root-secret bun server.ts
# PowerShell:
#   $env:CREATE_TOKEN = "root-secret"; bun server.ts
# listening on http://0.0.0.0:8787
```

You are the hoster of this server: the access codes users are asked for
are ones **you** mint (admin console or `POST /api/admin/codes` with the
root token). If you expose it beyond localhost, put TLS in front (any
reverse proxy; see [Ops notes](#ops-notes)) and point the plugin at the
https URL.

Then point the plugin at it:

```jsonc
// openshare.config.json  (you minted this code yourself — see above)
{
  "servers": {
    "https://share.example.com": { "code": "osc_…" }
  }
}
```

or enroll from the TUI: `/share → Connect to a server` (paste the URL,
then the code — you're both hoster and first user).

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | listen port |
| `CREATE_TOKEN` | *(unset)* | root admin token — required for the admin API and legacy root creates. Enrollment is the normal path for users. |
| `AUTH_MODE` | `private` | `public` = anyone knowing the host may enroll (rate-limited); `private` = access code required |
| `OPENSHARE_DB` | `./openshare.db` next to `server.ts` | SQLite file (resolved relative to `server.ts`, not your cwd) |
| `VIEWER_DIR` | `../share-viewer/dist` | static viewer build |
| `MAX_TTL_DAYS` | `90` | per-share TTL cap |
| `SOCKET_POLICY` | `auto` → `turn` | unlike Cloudflare there is no hibernation — sockets are real fds, so turn-scoped is the sane default here; `persistent` keeps them open |
| `TURN_GRACE_MS` / `IDLE_DROP_MS` / `FINALIZE_AFTER_MS` / `DEBOUNCE_MIN_MS` / `DEBOUNCE_MAX_MS` / `COMPLETED_DELAY_MAX_MS` | same as the worker | server policy (delivered in the WS init ack + `/health`) |
| `DEFAULT_MAX_LIVE_SHARES` / `DEFAULT_MAX_TTL_DAYS` / `DEFAULT_DAILY_CREATES` | `0` (unlimited) | per-token default limits for newly enrolled users |
| `BRAND_*` | *(unset)* | viewer skin overrides incl. `BRAND_DESCRIPTION` / `BRAND_OG_TITLE` / `BRAND_OG_IMAGE` (same fields as the worker's `openshare.config.json`, same og/link-preview crawler rewrite — see the worker README) |

## Identity model

Identical to the worker (see
[../share-worker/README.md](../share-worker/README.md#identity--enrollment)):
`osk_` user tokens (SHA-256-hashed in SQLite), `osc_` access codes with
activation budgets, per-share secrets, ownership + freeze semantics,
per-token limits, root `CREATE_TOKEN` as the forever-admin bootstrap.

Admin API: same `/api/admin/*` surface (users, tokens, codes, shares,
reassign, purge) — drive it with curl or the plugin's TUI admin console
(`/openshare → Servers → <server> → Admin panel`).

## Docker

```sh
# from the repo root — multi-stage image, viewer built in (see Dockerfile)
docker build -f share-server/Dockerfile -t openshare .

docker run -e CREATE_TOKEN=root-secret -p 8787:8787 -v oshdata:/data openshare
# health: curl -s http://127.0.0.1:8787/health
```

## Parity

The plugin suites run the SAME checks against both backends:

```sh
cd ../share-plugin
npm run test:server-auth     # the 48-check auth suite against bun
npm run test:server-enroll   # the engine enrollment lifecycle against bun
```

`share-worker/worker.js` remains the reference implementation; this
server mirrors its protocol deliberately (a shared module would force a
re-verification of the production worker's bundling — the identical
test suite is the stronger, lower-friction guarantee).

## Ops notes

- **Backups**: everything lives in the one SQLite file (WAL mode) — stop
  the server and copy `openshare.db` **plus** the `-wal`/`-shm` sidecar
  files, or run `sqlite3 openshare.db ".backup backup.db"` while it's
  up (copying only the `.db` mid-run can miss recent writes). Shares TTL
  out by the 30s sweeper; no other *background* process deletes data —
  explicit deletes (unshare, admin purge, user delete) do.
- **Restart**: durable. Bindings/secrets/revs are in the DB; plugins
  re-attach and replay unacked frames from their spools. In-flight viewer
  sockets reconnect and refetch.
- **Reverse proxy**: terminate TLS, allow upgrade headers; turn-scoped
  sockets mean idle connections are dropped client-side anyway, so short
  proxy idle timeouts are fine. Per-IP rate limits (enrollment, login
  lockout) trust `X-Forwarded-For`, which is only honest when a proxy you
  control sets it — if you expose the port directly, those limits are
  best-effort and the global caps (100 enrollments/hour, 20 login fails)
  are the real brake. Configure your proxy to overwrite (not append) the
  header.
