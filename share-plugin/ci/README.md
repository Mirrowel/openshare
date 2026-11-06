# Open(code)Share — CI bundle (`openshare.js`)

The single-file, zero-dependency build of the plugin. **All-mode by
default** — it declares no TUI entry, so presence detection always
resolves "all" on a CI runner (an explicit `shareMode` in config/env
still wins). Behavior-identical to the package server
(`../dist/server.js`), proven by `npm run test:regression`.

If your runner executes the bundle under plain Node (outside
opencode's runtime), use Node 22+ — the engine relies on the
`WebSocket`/`fetch` globals.

This folder is deliberately separate from the package root so that loading
the plugin by directory (`plugin: ["file:///…/share-plugin"]`) can only
ever resolve the package — never this file.

## Use

Reference the FILE (not this folder) from a one-file config:

```jsonc
// OPENCODE_CONFIG (or opencode.json)
{
  "plugin": ["C:/path/to/share-plugin/ci/openshare.js"]
}
```

Configure via env (CI) or the `openshare.config.json` next to the file —
either the legacy pair or the `servers` group (recommended; see the root
README's [Configuration](../../README.md#configuration)):

```
OPENSHARE_WORKER_URL=https://your-host
OPENSHARE_CREATE_TOKEN=:            # legacy: root token
OPENSHARE_URL_FILE=share-urls.txt   # each share URL appended + stderr line
```

CI conveniences:

- `OPENSHARE_CONFIG_JSON` - the whole config as one env var (same keys as
  the config file), when mounting a file is awkward. A specific
  `OPENSHARE_*` var still wins over it.
- `OPENSHARE_URL_FILE_FORMAT=json` - urlFile lines become
  `{"id":"…","url":"…","status":"…","gated":false}` objects, one per
  line, so workflow steps read fields instead of parsing URLs.
- `meta` in the config stamps free-form labels (env-interpolated, e.g.
  `"branch": "${GITHUB_REF_NAME}"`) onto every share - visible in the
  server's admin shares listing.

```jsonc
// openshare.config.json — enrollment shape (no root token needed)
{
  "servers": {
    "https://your-host": { "code": "osc_…" }   // or "token": "osk_…"
  }
}
```

With no token held the bundle never silently enrolls: a configured
`code` enrolls with it headlessly (the CI shape — each code use is one
enrollment); without one, public servers share anonymously (ownerless
shares under the server's global anonymous caps) and private servers
refuse with guidance. When enrollment does run, the token persists to
`~/.config/opencode/openshare.config.json` — enroll once, then every
run just shares. A revoked token re-enrolls the same way (code
configured / codeless server); if enrollment is impossible the error
lands on stderr and sharing stops (no retry storms).

**Ephemeral runners** (GitHub-hosted, containers): do NOT enroll through
a code - each fresh machine would burn one activation. Ask the hoster
for a pre-registered token and pass it via `OPENSHARE_CREATE_TOKEN`
(or the config's token field); registered tokens skip enrollment
entirely and never expire on their own. A **scoped** token
(`POST /api/token {"kind":"scoped"}`, minted by any full token) is the
right credential here: it creates within its limits, reaches only the
shares it created, and revoking it never freezes the owner's account.
Point `OPENCODE_CONFIG_DIR` (or mount) the settings home at a cached
path only if you want the token persisted; env alone is enough.

The bundle also supports **fan-out**: multiple `active` servers in the
`servers` group each get the session (one urlFile line per server).

On OpenCode v2, plugin targets should be directories/packages — wrap this
file in a folder with a `package.json` exporting it (`{"exports": {".": "./openshare.js"}}`)
or install the package instead; the bundle itself works unchanged (its
`setup` is the v2 adapter, and with no package.json present it stays
share-all).

Rebuild after changing `../src/`: `npm run build` in the package root.
