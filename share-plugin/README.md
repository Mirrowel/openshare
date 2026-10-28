# Open(code)Share plugin (`@mirrowel/opencode-openshare`)

The opencode side of [Open(code)Share](../README.md) — session sharing for
OpenCode v1 and v2, self-hosted on your own worker.

Every plugin config key, its file chain, and the cross-package config surface are inventoried in [../CONFIGURATION.md](../CONFIGURATION.md).

## Artifacts

| Artifact | What it is | Share mode |
|---|---|---|
| `dist/server.js` | package server entry (opencode.json `plugin` array) | all, unless the TUI is registered |
| `dist/tui.js` | package TUI entry (tui.json `plugin` array) | its presence flips the server to manual |
| `ci/openshare.js` | single-file, zero-dependency bundle of the same engine (committed; rebuilt by `npm run build`) | all-mode **by default** — it declares no TUI entry, but an explicit `shareMode` in config/env still wins |

All three are behavior-identical where they overlap — `npm run
test:regression` proves the single file and the package match the frozen
original (`reference/openshare.legacy.js`) on the full share lifecycle.

## Install

From the registry (published). **v1 hosts** — the bare package name in
BOTH config files (no `/tui` suffix; opencode resolves the entrypoints
itself):

```jsonc
// opencode.json
{ "plugin": ["@mirrowel/opencode-openshare"] }
// tui.json (global ~/.config/opencode/tui.json or project)
{ "plugin": ["@mirrowel/opencode-openshare"] }
```

**v2 hosts** — the CLI writes the config for you:

```sh
opencode plugin add @mirrowel/opencode-openshare
```

Restart opencode; `/share` and `/openshare` appear in the TUI.

Then configure. For an npm install the durable config file is the
**settings home** (`~/.config/opencode/openshare.config.json` — also
what `/openshare` writes); "next to the package" only applies to file
installs (the CI bundle):

```jsonc
{
  "servers": {
    "https://your-worker.workers.dev": { "token": "osk_…", "active": true },
    "https://team-server.example.com": { "code": "osc_invite-from-hoster" }
  }
}
```

`workerUrl`/`createToken` is the legacy single-server shorthand for the
same thing — the `servers` form above is canonical.

From a local checkout (developing / tracking main): use the directory
spec `"file:///…/openshare/share-plugin"` in both config files (run
`npm run build` first — `dist/` is not committed). The CI bundle needs
no build at all: [`ci/openshare.js`](ci/README.md), committed ready to
use.

**Identity is never assumed**: with no token configured the plugin does
NOT silently enroll (owner directive). A configured `code` IS expressed
intent — the engine enrolls with it headlessly (the CI shape). Without
one: public servers share **anonymously** (ownerless shares under the
server's global anonymous caps), private servers refuse with guidance.
Onboarding happens through the ask-once TUI flow — `/share` first run
or `/openshare` → Servers → Connect to a server offers "Onboard (get an
account)" vs "Stay anonymous" (with the differences explained), detects
whether a code is needed, and only then prompts for one; the outcome is
remembered per server (token = onboarded, `anonymous` flag = declined,
onboard later via the server menu's Enroll now). The enrolled token
persists to `~/.config/opencode/openshare.config.json` — enroll once per
server, then it just works. A revoked token re-enrolls the same way
(code configured / codeless server); if enrollment is impossible the
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

- `/share` — share the session (explicit consent on EVERY creation —
  nothing is published silently; then the URL is copied). On a child
  session, shares the whole family. Already shared → the session menu,
  identical to `/openshare → This session`: copy links (per server, or
  all), stop sharing — delete or leave a snapshot, per-server stop on
  multi-server shares —, share to another server, session TTL and read
  auth. A credential conflict opens the collision dialog (copy debug
  info / share on a new share / don't share).
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
- Sidebar chip (v1 hosts — the v2 TUI context has no slot registry yet) —
  share status next to the session title (`·N` when the session streams
  to several servers); click copies the link. A share whose page died
  server-side renders `⊘ gone` — clicking opens the share manager, which
  verifies every bound server, auto-clears dead entries and offers
  Share again (see Gone detection in the root README).
- Every menu row carries an `[i]` detail pane (what it does, current
  value + source, full URLs/ids); Interface rows set menu width/height
  (host preference store).

## Development

```bash
npm install
npm run build         # tsc -> dist/ + bun bundle -> ci/openshare.js (Bun on PATH)
npm run typecheck
npm run test          # full matrix via the parallel driver (~4.5 min)
npm run test:quick     # everyday gate (~90s): parity + manual core + TUI + v2 + auth
```

Suites (shared machinery in `scripts/suite-lib.mjs`; every run is
watchdogged, port-swept, and drives real `opencode serve` instances with
a mock OpenAI-compatible provider — except where noted). The canonical
suite table — what each covers, including the big/backends scale suites —
lives in [`../DEVELOPMENT.md`](../DEVELOPMENT.md#test-suites); the
commands:

- `test:regression` — parity of legacy / single-file / package across the
  full lifecycle.
- `test:manual` — the engine scenarios (dormancy, backfill, tombstones,
  timers, turn sockets, all-mode gating).
- `test:tui-flow` — share/manager flows, config write targets, enrollment,
  admin console, gone detection.
- `test:v2` — the v2 adapter against a scripted mock v2 host.
- `test:auth` / `test:server-auth` — the identity contract (52 checks)
  against the Cloudflare worker and the Bun backend.
- `test:enroll` / `test:server-enroll`, `test:fanout`, `test:big` /
  `test:server-big` — enrollment lifecycle, multi-server fan-out,
  big-session scale (both backends).
- `test:cli`, `node scripts/npm-e2e.mjs` — real `opencode run` / the
  published npm package — on demand only.

Layout:

```
src/
  config.ts        config load/save (servers group, field-level merge), shareMode, tui.json scan
  contract.ts      the OpenShare item contract (v: 2 envelope, message/diff
                   normalization, tombstone shape) — shared truth for plugin,
                   worker, Bun server, and viewer
  core.ts          the engine: fan-out remotes (socket/spool/rev per server),
                   ws handshake, chunked syncs, backfill, collisions, opt-outs
  server.ts        v1 entry {id, server, setup}
  tui.tsx          v1 TUI entry + host facade
  commands.ts      /share (consent gate → session menu — the SAME menu as /openshare → This session — plus collision + gone dialogs) /openshare
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
