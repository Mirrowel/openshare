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

From the registry (published; opencode resolves npm specs):

```sh
opencode plugin add @mirrowel/opencode-openshare        # server (opencode.json)
opencode plugin add @mirrowel/opencode-openshare/tui    # TUI (tui.json) — flips to manual sharing
```

Or by hand in the config files:

```jsonc
// opencode.json
{ "plugin": ["@mirrowel/opencode-openshare"] }
// tui.json (global ~/.config/opencode/tui.json or project)
{ "plugin": ["@mirrowel/opencode-openshare/tui"] }
```

From a local checkout (developing / tracking main): use the directory spec
`"file:///…/openshare/share-plugin"` in both files (run `npm run build`
first — `dist/` is not committed). The CI bundle needs no build at all —
it is committed ready to use at [`ci/openshare.js`](ci/README.md).

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
`metadata.openshare = { v: 2, enabled: true, opts? }` with per-session
overrides (`ttlDays`, `authLogin`, `authPassword`, `modelLabel`). The
per-server binding map (`servers: {url: {id, secret, rev, url}}`) is
written next to it — legacy flat bindings migrate at read. The key is
stripped from everything synced and never reaches viewers.

On OpenCode v2: the package declaring its `tui` entrypoint is the presence
signal (the v2 host auto-loads it); the single file declares none and
stays all-mode.

## TUI

- `/share` — share the session (one-time consent; copies the URL). On a
  child session, shares the whole family. Already shared → the share
  manager: copy links (per server), per-server stop / leave-as-snapshot,
  share to another server, stop all. A credential conflict opens the
  collision dialog (copy debug info / share on a new share / don't share).
- `/openshare` — grouped settings (compact root with live summaries →
  focused submenus): This session (share/stop — delete or leave a
  snapshot —, TTL override, session read auth), **Servers** (connection
  AND membership: legacy pair, connect, enroll, rotate, get-a-user-token
  for root holders, disconnect, per-server **admin panel** — users,
  tokens, codes, shares, purge —, test, remove), Sharing (share mode +
  booleans via selection menus), Read auth, Interface (one combined
  Menu-size picker: live width cycling + height slider + capped-height
  preview), Advanced, Config files. Danger rows red, dirty rows green,
  `[i]` panes paged (`## sections`, 1-9 jump), messages wrap in real
  bodies (no clipped one-liners).
- Sidebar chip — share status next to the session title (`·N` when the
  session streams to several servers); click copies the link. A share
  whose page died server-side renders `⊘ gone` — clicking opens the share
  manager, which verifies every bound server, auto-clears dead entries
  and offers Share again (see Gone detection in the root README).
- Every menu row carries an `[i]` detail pane (what it does, current
  value + source, full URLs/ids); Interface rows set menu width/height
  (host preference store).

## Development

```bash
npm install
npm run build         # tsc -> dist/ + bun bundle -> openshare.js
npm run typecheck
npm run test          # full matrix via the parallel driver (~4.5 min)
npm run test:quick     # everyday gate (~90s): parity + manual core + TUI + v2 + auth
```

Suites (shared machinery in `scripts/suite-lib.mjs`; every run is
watchdogged, port-swept, and drives the real production path — local
`wrangler dev` worker + real `opencode serve` with a mock OpenAI-compatible
provider):

- `test:regression` — parity of legacy / single-file / package across the
  full lifecycle (create → prompt → completed → delete → 404).
- `test:manual` — dormancy, flag activation + backfill, restart attach,
  unshare, re-share, per-session auth opts, all-override, pre-existing
  gates, undo tombstones, completed debounce, turn-mode drops.
- `test:tui-flow` — share/unshare flows, config round-trip, connect
  flow (enroll + persist + rotate), admin console round-trip.
- `test:v2` — the v2 adapter against a scripted mock v2 host (event
  classification, message conversion, live re-sync, delete).
- `test:auth` — server identity contract: enrollment, code burn, rotate,
  freeze (secret dead too), limits, reassign, public mode (48 checks).
- `test:enroll` — the plugin's enrollment lifecycle end to end (code
  enroll, token persistence across processes, revoke → re-enroll,
  blocked path, public zero-config).
- `test:fanout` — multi-server: v2 bindings, content parity across
  servers, mid-session join with full-history backfill, per-session
  opt-outs.
- `test:cli` — real `opencode run` end-to-end (single file + package +
  silenced outputs), on-demand only (uses the default model).
- `test:server-auth` / `test:server-enroll` — the SAME auth/enroll
  suites against the portable Bun backend (`../share-server`): the
  two-backends-one-protocol parity guarantee.

Layout:

```
src/
  config.ts        config load/save (servers group, field-level merge), shareMode, tui.json scan
  core.ts          the engine: fan-out remotes (socket/spool/rev per server),
                   ws handshake, chunked syncs, backfill, collisions, opt-outs
  server.ts        v1 entry {id, server, setup}
  tui.tsx          v1 TUI entry + host facade
  commands.ts      /share (toggle + fan-out manager + collision dialog) /openshare
  share-flow.ts    host-agnostic flows: flag, bindings v1/v2, enrollment,
                   rotate/disconnect, admin client, unshare multi-delete
  settings.ts      grouped settings tree + servers section + admin console
  dialogs.tsx      MenuDialog/InfoDialog/PromptDialog + the sizing core (75% budget)
  ui-prefs.ts      menu size prefs (host kv store)
  sidebar.tsx      sidebar_title slot chip (v1, box-rooted)
  tui-host.ts      host facade interface
  v2-server.ts     v2 setup: event mapping + client adapter + v2->v1 conversion
  v2-tui.ts        v2 TUI adapter (dialogs, keymap, kv)
  v2-types.ts      structural v2 types (no SDK import)
```

The TUI surface (palette, dialogs, sidebar) is verified live; the flow
logic is covered headlessly. The v2 integration is verified against a
scripted host; run it live on a beta build via
`bun run dev` in your beta checkout with both package entries registered.
