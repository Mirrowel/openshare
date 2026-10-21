# Open(code)Share tools

Small standalone utilities around the share ecosystem. Nothing here is needed to run the plugin or the worker — these are local conveniences.

## view-export.py

View any exported opencode session locally, exactly like a live share page: it serves the real viewer (`../share-viewer/dist`) on localhost with the session(s) injected — same rendering, same views, subagent pages included when the exports cover the family. No crypto, no network beyond localhost; nothing is uploaded anywhere.

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
