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
OPENSHARE_CREATE_TOKEN=…            # legacy: root token
OPENSHARE_URL_FILE=share-urls.txt   # each share URL appended + stderr line
```

```jsonc
// openshare.config.json — enrollment shape (no root token needed)
{
  "servers": {
    "https://your-host": { "code": "osc_…" }   // or "token": "osk_…"
  }
}
```

With no token held, the bundle **enrolls itself** on first contact
(public servers take anyone; private ones consume the one-time code) and
persists the token to `~/.config/opencode/openshare.config.json` —
enroll once, then every run just shares. A revoked token re-enrolls the
same way; if enrollment is impossible the error lands on stderr and
sharing stops (no retry storms). The bundle also supports **fan-out**:
multiple `active` servers in the `servers` group each get the session
(one urlFile line per server).

On OpenCode v2, plugin targets should be directories/packages — wrap this
file in a folder with a `package.json` exporting it (`{"exports": {".": "./openshare.js"}}`)
or install the package instead; the bundle itself works unchanged (its
`setup` is the v2 adapter, and with no package.json present it stays
share-all).

Rebuild after changing `../src/`: `npm run build` in the package root.
