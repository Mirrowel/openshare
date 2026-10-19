# Open(code)Share plugin (`@mirrowel/opencode-openshare`)

The opencode side of [Open(code)Share](../README.md) — session sharing for
OpenCode v1 and v2, self-hosted on your own worker.

## Artifacts

| Artifact | What it is | Share mode |
|---|---|---|
| `dist/server.js` | package server entry (opencode.json `plugin` array) | all, unless the TUI is registered |
| `dist/tui.js` | package TUI entry (tui.json `plugin` array) | its presence flips the server to manual |
| `openshare.js` | single-file, zero-dependency bundle of the same engine (built by `npm run build`) | always all — the CI bundle |

All three are behavior-identical where they overlap — `npm run
test:regression` proves the single file and the package match the frozen
original (`reference/openshare.legacy.js`) on the full share lifecycle.

## Install

Interactive (manual sharing, `/share` command, sidebar chip):

```jsonc
// opencode.json
{ "plugin": ["@mirrowel/opencode-openshare"] }
// tui.json (global ~/.config/opencode/tui.json or project)
{ "plugin": ["@mirrowel/opencode-openshare/tui"] }
```

CI (share everything, link to a file):

```jsonc
// OPENCODE_CONFIG one-file setup
{
  "plugin": ["/path/to/openshare.js"],
  ...env OPENSHARE_WORKER_URL, OPENSHARE_CREATE_TOKEN,
  ...OPENSHARE_URL_FILE collects each share URL (also printed to stderr)
}
```

Then configure (`openshare.config.json` next to the package — see the
[main README](../README.md#configuration) for all keys):

```jsonc
{ "workerUrl": "https://your-worker.workers.dev", "createToken": "…" }
```

Or the multi-server form (canonical; `workerUrl`/`createToken` above is
the single-server shorthand):

```jsonc
{
  "servers": {
    "https://your-worker.workers.dev": { "token": "osk_…", "active": true },
    "https://team-server.example.com": { "code": "osc_invite-from-hoster" }
  }
}
```

**With no token the plugin enrolls itself** on first contact: public
servers (hoster set `AUTH_MODE=public`) take anyone; private ones need
a `code` from the hoster (activation-budgeted invite). The enrolled
token persists to `~/.config/opencode/openshare.config.json` — enroll
once per server, then it just works. A revoked token re-enrolls the
same way (public/code available); if enrollment is impossible the
plugin says so on stderr and stops — no retry storms.

## Share modes

`shareMode` is explicit config (`"all"` / `"manual"`, env
`OPENSHARE_SHARE_MODE` > plugin options > config file) or — when unset —
**TUI presence**: the server scans the tui.json layers (global,
`OPENCODE_TUI_CONFIG`, project directory chain) for the openshare TUI
entry. Registered → manual (opt-in per session). Not registered → all.
No selfwiring: which parts you install IS the switch.

Manual mode stores the opt-in in session metadata:
`metadata.openshare = { enabled: true, opts? }` with per-session overrides
(`ttlDays`, `authLogin`, `authPassword`, `modelLabel`). The full binding
(`{id, secret, rev, url}`) is written next to it; the key is stripped from
everything synced and never reaches viewers.

On OpenCode v2: the package declaring its `tui` entrypoint is the presence
signal (the v2 host auto-loads it); the single file declares none and
stays all-mode.

## TUI

- `/share` — share the session (one-time consent; copies the URL). On a
  child session, shares the whole family. Already shared → the share
  manager: copy links (per server), per-server stop / leave-as-snapshot,
  share to another server, stop all. A credential conflict opens the
  collision dialog (copy debug info / share on a new share / don't share).
- `/openshare` — settings dialog: Servers (connect, enroll, rotate,
  disconnect, set active, remove), **Admin console** (manage any server
  with its root token: users, freeze/delete, mint tokens, invite codes,
  shares, reassign, purge), sharing defaults, read auth, advanced
  (spoolDir, urlFile), this-session actions.
- Sidebar chip — share status next to the session title (`·N` when the
  session streams to several servers); click copies the link.

## Development

```bash
npm install
npm run build         # tsc -> dist/ + bun bundle -> openshare.js
npm run typecheck
npm run test          # all suites (needs opencode + wrangler + network once)
```

Suites (shared machinery in `scripts/suite-lib.mjs`; every run is
watchdogged, port-swept, and drives the real production path — local
`wrangler dev` worker + real `opencode serve` with a mock OpenAI-compatible
provider):

- `test:regression` — parity of legacy / single-file / package across the
  full lifecycle (create → prompt → completed → delete → 404).
- `test:manual` — dormancy, flag activation + backfill, restart attach,
  unshare, re-share, per-session auth opts, all-override.
- `test:tui-flow` — the share/unshare flow code + config round-trip
  (headless against a scripted host).
- `test:v2` — the v2 adapter against a scripted mock v2 host (event
  classification, message conversion, live re-sync, delete).

Layout:

```
src/
  config.ts        config load/save, shareMode resolution, tui.json scan
  core.ts          the engine: sessions, ws, spool, backfill, redaction
  server.ts        v1 entry {id, server, setup}
  tui.tsx          v1 TUI entry + host facade
  commands.ts      /share /unshare /openshare (priority layer, shadows built-ins)
  share-flow.ts    host-agnostic flows (flag, binding wait, unshare delete)
  settings.ts      settings dialog (dialog-stack only, host-agnostic)
  sidebar.tsx      sidebar_title slot chip (v1)
  tui-host.ts      host facade interface
  v2-server.ts     v2 setup: event mapping + client adapter + v2->v1 conversion
  v2-tui.ts        v2 TUI adapter (dialogs, keymap, kv)
  v2-types.ts      structural v2 types (no SDK import)
  palette-category.ts  family palette registry (keep in sync across family plugins)
```

The TUI surface (palette, dialogs, sidebar) is verified live; the flow
logic is covered headlessly. The v2 integration is verified against a
scripted host; run it live on a beta build via
`bun run dev` in your beta checkout with both package entries registered.
