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
shares ls | info ID | data ID [--since REV] | rm ID --yes [--secret S]
       | patch ID --secret S [--ttl-hours N] [--login L --pass P] [--meta JSON]
       | auth ID --login L --pass P | snapshot ID [-o FILE]
users  ls | new --label L | freeze ID | unfreeze ID | rm ID --yes [--mode delete]
tokens ls | new --user U [--kind scoped] [--label L] [--max-shares N --daily-creates N]
       | self [--kind scoped] | rotate [--label L] | update [ID] [--label L] [limits]
       | revoke ID | freeze-shares ID
codes  ls | new --activations N [--label L] [--ttl-hours N] | disable ID | lineage ID --yes
settings get | put --json '{"defaultTtlHours":24}'
purge --yes
```

Add `--json` to any command for machine output. Roles follow the API: root
does everything; a full token manages its own user's tokens and shares; a
scoped token sees and edits only itself and the shares it created (and can
never raise its own limits).

## TUI

`osh` with no arguments. Tabs: `servers / shares / users / tokens / codes /
settings` (arrow keys). Every list supports `↑/↓` select, `r` reload,
`enter` detail; destructive actions confirm with `y/n`. First run starts in
the server-add flow (url, then token / access code / anonymous). Keys per
screen are printed in the footer line. Credentials rotate in place
(`R` on the tokens screen saves and prints the successor).
