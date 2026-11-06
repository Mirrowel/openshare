# OpenShare admin console (`osh`)

Stateful client for an OpenShare worker: one config file holds named servers
and their credentials, every command and every TUI action goes through the
worker API. The interactive TUI and the headless CLI expose the same
surface — the CLI for scripts/CI/agents, the TUI for exploring a deployment.

## Setup

```bash
cd share-cli && npm install && npm run build
node dist/osh.mjs ...        # any command below
node dist/osh.mjs            # no args: the TUI
```

Without a checkout: every release ships `osh-<version>.mjs` — the same
single file, prebuilt (see the
[release assets](https://github.com/Mirrowel/OpenShare/releases)).

```bash
curl -LO https://github.com/Mirrowel/OpenShare/releases/download/v0.3.0/osh-0.3.0.mjs
node osh-0.3.0.mjs           # the TUI (or any command below)
```

The built `dist/osh.mjs` is a single file (ink + react bundled); it runs on
any Node 20+. State lives in `~/.config/openshare/cli.json`
(`OPENSHARE_CLI_CONFIG` overrides).

## Connecting

```bash
# root token (full admin)
node dist/osh.mjs login https://<worker> --token <CREATE_TOKEN>

# enroll: creates your user + first token from an access code
node dist/osh.mjs login https://<worker> --code osc_xxx --label me

# anonymous (view-only) or an existing osk_ user token
node dist/osh.mjs login https://<worker>
```

Multiple servers coexist (`--name`); `osh use <name>` switches. Rotating
your credential (`osh tokens rotate`) stores the successor automatically.

## Commands

```
servers · use NAME · remove NAME · health · me
shares ls [--sort created|title|status|owner] [--no-meta]  hydrated: title,
       status, owner label, gated/subagent counts, relative age
shares info ID        title, sessions (agent/model/subagent), expiry,
                     liveness (plugin seen, last viewer), creator token
shares meta ID · data ID [--since REV] · rm ID --yes [--secret S]
shares patch ID --secret S [--ttl-hours N] [--login L --pass P] [--meta JSON]
shares freeze ID --yes | unfreeze ID        single-share write gate
shares auth ID --login L --pass P · snapshot ID [-o FILE]
users  ls (code lineage + counts) · new --label L · freeze ID · unfreeze ID
       · rm ID --yes [--mode delete]
tokens ls [--all] (user labels, createdBy, expiry) · new --user U [--kind
       scoped] [limits] [expiry] · self · rotate [overrides] · update [ID]
       · revoke ID · freeze-shares ID
       limits: --max-shares N --max-ttl-hours N --daily-creates N
       expiry: --expires-in-minutes/-hours/-days N (0 clears; floor 1m)
codes  ls (onboarded users) · new --activations N · disable ID
       · lineage ID --yes
settings get | put --json JSON    root/anon: server policy view instead
purge --yes
```

Sorting everywhere: `--sort <field>`, prefix `-` for descending
(`--sort -created`). Add `--json` to any command for machine output.
Roles follow the API: root does everything; a full token manages its own
user's tokens and shares; a scoped token sees and edits only itself and
the shares it created (and can never raise its own limits or expiry).

## TUI

`osh` with no arguments (needs a terminal; piping gets help instead of a
broken render). Tabs: `servers / shares / users / tokens / codes /
settings` (arrow keys). Lists: `↑/↓` select, `r` reload, `s` cycle the
sort (field + direction), `enter` detail. Destructive actions confirm
with `y/n`. First run starts in the server-add flow (url, then token /
access code / anonymous). Keys per screen are printed in the footer.

- **shares** lists hydrated rows (title, colored status, owner label,
  LOCK for gated, subagent count, expiry countdown); detail shows the
  session tree (`●` main, `↳ subagent`), liveness (plugin seen / last
  viewer), and single-share freeze (`f`)
- **tokens** shows user labels, `createdBy` provenance and expiry;
  `v` toggles revoked, `e` edits (label/limits/expiry), `m` mints,
  `R` rotates the current credential (saved + printed)
- **users** rows carry code lineage; `enter` opens the user's shares and
  tokens; **codes** rows show who onboarded with them
- **settings** shows user defaults, or the server policy view for
  root/anonymous credentials
