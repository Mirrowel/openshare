# Open(code)Share tools

Small standalone utilities around the share ecosystem. Nothing here is needed to run the plugin or the worker — these are local conveniences.

## osh-snapshot-local.mjs

The same offline snapshot, built from a local session export instead of a
live share: no network, no server, no share at all.

```bash
# one export file (or the whole family: main plus its subagents)
node tools/osh-snapshot-local.mjs example/export/main.json -o session.html

# main + subagent, explicit viewer build
node tools/osh-snapshot-local.mjs main.json child.json --viewer share-viewer/dist -o family.html
```

Requires a built viewer (`cd share-viewer && npm run build`) because it packs
that build into the file. The conversion is the interchange tool's, so the
page renders exactly like a share of the same session; the header reads
`snapshot` instead of the share status.
## osh-snapshot.mjs

Download a share as ONE self-contained offline HTML file, without a browser.
CI-friendly: it walks the deployment's static assets (free and unlimited on
Cloudflare) and assembles locally with the same builder the worker and the
viewer's download button use, so no worker CPU, no subrequest cap, and no
browser needed.

```bash
# public share -> ./<id>.html
node tools/osh-snapshot.mjs https://openshare.example.com/s/<id>

# choose the file, gated share via login (or --token <viewer token>)
node tools/osh-snapshot.mjs https://openshare.example.com/s/<id> -o run.html --login user:pass

# machine-readable result for a CI step
node tools/osh-snapshot.mjs "$SHARE_URL" --token "$VIEWER_TOKEN" --json
```

Exits `2` when the share is gated and no credentials were given; `--json`
prints `{ok,file,bytes,rev,status,items,sessionID}` on one line. A GitHub
Actions job only needs Node 20+ and network access to the deployment:

```yaml
- run: node tools/osh-snapshot.mjs "${{ env.SHARE_URL }}" -o share.html
- uses: actions/upload-artifact@v4
  with: { name: share-snapshot, path: share.html }
```
## view-export.py

View any exported opencode session locally, exactly like a live share page: it serves the real viewer (`../share-viewer/dist`) on localhost with the session(s) injected — same rendering, same views, subagent pages included when the exports cover the family. The conversion is plugin-parity: every item carries its `sessionID` (main and child sessions stay separate), and task calls are stamped with the child's resolved agent via the same rank-join the plugin uses, so subagent rows and labels render exactly as online. No crypto, no network beyond localhost; nothing is uploaded anywhere.

```bash
# newest session in your local opencode db, plus its subagent family
python tools/view-export.py

# a specific session (plus family)
python tools/view-export.py --session-id ses_xxx

# one or more `opencode export` JSON files (gzip accepted);
# several files merge into one view (main + children)
python tools/view-export.py session.json child.json
```

Options:

| Flag | Meaning | Default |
|---|---|---|
| `--port N` | localhost port | 7789 |
| `--no-open` | don't open the browser | opens |
| `--dist PATH` | viewer dist override | `../share-viewer/dist`, or `OPENSHARE_VIEWER_DIST` |
| `--model-label T` | model label; `$Provider/$Model` placeholders, literal passes through, empty hides it | placeholder form (or `SHARE_MODEL_LABEL`) |
| `--db PATH` | opencode db override | auto-discovery |
| `--opencode PATH` | `opencode` binary to run for `--session-id` exports | `opencode` on PATH |

Requires Python 3.10+ (stdlib only) and a built viewer (`cd ../share-viewer && npm install && npm run build` — or point `--dist` at an existing build). The export JSON is converted to the share `Data[]` contract — the one shape the plugin streams, the worker stores, and the viewer renders — which is why the local page is pixel-identical to a live share.

## osh-session.mjs

Session interchange: convert between a share, an `opencode export` file, and
the local viewer. Everything runs locally; nothing is uploaded.

**Status: experimental.** The roundtrip is proven by the self-check below,
but the converters have not been exercised across the full range of real
sessions — expect rough edges, and prefer the viewer's export button when
it suffices.

```bash
# share (or a saved envelope JSON) -> one `opencode import`-ready file per session
node tools/osh-session.mjs export https://your-host/s/<id> -o ./out

# opencode export(s) -> one share envelope (publish or view locally)
node tools/osh-session.mjs pack ./out/ses_*.json -o ./session.share.json

# import every session in a file straight into your local opencode
node tools/osh-session.mjs import ./out/ses_<id>.json
node tools/osh-session.mjs import ./session.share.json --dry   # print only
```

| Command | Input | Output |
|---|---|---|
| `export` | share URL, envelope JSON, or opencode export | `<sessionID>.json` per session (`--share` also writes `<sessionID>.share.json`) |
| `pack` | one or more opencode exports | one contract-v2 envelope (`{v:2, items}`) |
| `import` | any of the above | runs `opencode import` per session |

Notes:

- Gated shares need the password before the CLI can fetch `/data`; export from
  an authenticated browser session instead (the viewer's download button does
  exactly this) or save the envelope JSON and pass the file.
- `step-start`/`step-finish`/`snapshot`/`patch` parts have no contract-v2
  equivalent and are dropped when packing (the plugin does the same when it
  streams a session); text, reasoning and tool calls round-trip exactly,
  including tool names (`bash`/`task`) and inputs (`filePath`, `subagent_type`).
- Self-check: `node tools/interchange-test.mjs` (roundtrip + a real
  `opencode import` in a throwaway XDG home; `--no-import` skips the slow part).

The viewer's header has the same export as a one-click download (next to
"copy as markdown"), so a share can be re-imported locally without this tool.
