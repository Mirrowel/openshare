# Open(code)Share — CI bundle (`openshare.js`)

The single-file, zero-dependency build of the plugin. **Always shares all
sessions** — this is the headless/CI artifact, behavior-identical to the
package server (`../dist/server.js`), proven by `npm run test:regression`.

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

Configure via env (CI) or the `openshare.config.json` next to the file:

```
OPENSHARE_WORKER_URL=https://your-worker.workers.dev
OPENSHARE_CREATE_TOKEN=…
OPENSHARE_URL_FILE=share-urls.txt   # each share URL appended + stderr line
```

On OpenCode v2, plugin targets should be directories/packages — wrap this
file in a folder with a `package.json` exporting it (`{"exports": {".": "./openshare.js"}}`)
or install the package instead; the bundle itself works unchanged (its
`setup` is the v2 adapter, and with no package.json present it stays
share-all).

Rebuild after changing `../src/`: `npm run build` in the package root.
