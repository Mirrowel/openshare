# Open(code)Share — portable server

The same share backend as the Cloudflare worker
([../share-worker](../share-worker)) as **one Bun process**: SQLite
storage, native WebSockets, the built viewer served statically. For VPS
deployments, self-hosting, or anything that isn't Cloudflare — same
protocol, same plugin, same auth model.

## Quick start

```sh
# build the viewer once (or point VIEWER_DIR at an existing build)
cd ../share-viewer && npm install && npm run build && cd ../share-server

CREATE_TOKEN=<your-root-token> bun server.ts
# listening on http://0.0.0.0:8787
```

Then point the plugin at it:

```jsonc
// openshare.config.json
{
  "servers": {
    "https://share.example.com": { "code": "osc_… (ask the hoster)" }
  }
}
```

or enroll from the TUI: `/openshare → Connect to a server`.

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | listen port |
| `CREATE_TOKEN` | *(unset)* | root admin token — required for the admin API and legacy root creates. Enrollment is the normal path for users. |
| `AUTH_MODE` | `private` | `public` = anyone knowing the host may enroll (rate-limited); `private` = access code required |
| `OPENSHARE_DB` | `./openshare.db` | SQLite file |
| `VIEWER_DIR` | `../share-viewer/dist` | static viewer build |
| `MAX_TTL_DAYS` | `90` | per-share TTL cap |
| `SOCKET_POLICY` | `auto` → `turn` | unlike Cloudflare there is no hibernation — sockets are real fds, so turn-scoped is the sane default here; `persistent` keeps them open |
| `TURN_GRACE_MS` / `IDLE_DROP_MS` / `FINALIZE_AFTER_MS` / `DEBOUNCE_MIN_MS` / `DEBOUNCE_MAX_MS` / `COMPLETED_DELAY_MAX_MS` | same as the worker | server policy (delivered in the WS init ack + `/health`) |
| `DEFAULT_MAX_LIVE_SHARES` / `DEFAULT_MAX_TTL_DAYS` / `DEFAULT_DAILY_CREATES` | `0` (unlimited) | per-token default limits for newly enrolled users |
| `BRAND_*` | *(unset)* | viewer skin overrides (see the worker README) |

## Identity model

Identical to the worker (see
[../share-worker/README.md](../share-worker/README.md#identity--enrollment)):
`osk_` user tokens (SHA-256-hashed in SQLite), `osc_` access codes with
activation budgets, per-share secrets, ownership + freeze semantics,
per-token limits, root `CREATE_TOKEN` as the forever-admin bootstrap.

Admin API: same `/api/admin/*` surface (users, tokens, codes, shares,
reassign, purge) — drive it with curl or the plugin's TUI admin console
(`/openshare → Admin console`).

## Docker

```dockerfile
# see Dockerfile; mount /data for the SQLite file and copy or mount the
# viewer build, then:
docker run -e CREATE_TOKEN=… -p 8787:8787 -v oshdata:/data openshare-server
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

- **Backups**: everything lives in the one SQLite file (WAL mode) — copy
  it, done. Shares TTL out by the 30s sweeper; nothing else deletes data.
- **Restart**: durable. Bindings/secrets/revs are in the DB; plugins
  re-attach and replay unacked frames from their spools. In-flight viewer
  sockets reconnect and refetch.
- **Reverse proxy**: terminate TLS, allow upgrade headers; turn-scoped
  sockets mean idle connections are dropped client-side anyway, so short
  proxy idle timeouts are fine.
