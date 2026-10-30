#!/usr/bin/env node
// osh-snapshot-local — build the offline snapshot from a local session
// export, with no share and no network.
//
//   node tools/osh-snapshot-local.mjs <export.json...> [-o out.html]
//        [--viewer share-viewer/dist]
//
// Takes what `opencode export` prints (one file per session, the whole
// family is fine) and produces the same self-contained HTML the viewer's
// download button writes: the built viewer, every chunk it can reach and
// the session frozen as a JSON island. Double-click the result on any
// machine; nothing is uploaded and no server is involved at any point.
//
// The conversion is the interchange tool's (tools/osh-session.mjs), so an
// export comes out rendered exactly like a share of the same session. The
// viewer must be built first (`cd share-viewer && npm run build`).

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { envelopeFromExports } from "./osh-session.mjs"
import { buildSnapshotHtml } from "../share-worker/og/snapshot.js"

const here = resolve(fileURLToPath(new URL("..", import.meta.url)))

const USAGE = `usage: osh-snapshot-local <export.json...> [-o out.html] [--viewer <dist dir>]

  <export.json...>  files written by \`opencode export\` (the whole session
                    family - main plus its subagents - renders as one page)
  -o, --out         output path (default: ./<session id>.html)
  --viewer          the built viewer directory (default: share-viewer/dist)
  --json            print a one-line JSON result instead of human text
`

function parseArgs(argv) {
  const out = { files: [], out: undefined, viewer: join(here, "share-viewer", "dist"), json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-h" || a === "--help") {
      process.stdout.write(USAGE)
      process.exit(0)
    } else if (a === "-o" || a === "--out") out.out = argv[++i]
    else if (a === "--viewer") out.viewer = resolve(argv[++i])
    else if (a === "--json") out.json = true
    else if (!a.startsWith("-")) out.files.push(a)
    else {
      process.stderr.write(`unknown argument: ${a}\n\n${USAGE}`)
      process.exit(2)
    }
  }
  if (!out.files.length) {
    process.stderr.write(USAGE)
    process.exit(2)
  }
  return out
}

const opts = parseArgs(process.argv.slice(2))

async function main() {
  const indexFile = join(opts.viewer, "index.html")
  if (!existsSync(indexFile)) {
    throw new Error(`no built viewer at ${opts.viewer} (run: cd share-viewer && npm run build)`)
  }
  const html = readFileSync(indexFile, "utf8")

  const exports = opts.files.map((file) => {
    const text = readFileSync(resolve(file), "utf8")
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`${file} is not JSON (export it with \`opencode export\`, not by copying the terminal)`)
    }
  })

  const items = envelopeFromExports(exports)
  if (!items.length) throw new Error("no sessions found in the export(s)")

  const root = items.find((it) => it.type === "session" && it.data && !it.data.parentID)
  if (!root) throw new Error("no root session (every session in the export has a parent)")
  const sessionID = String(root.data.id ?? "")

  const island = JSON.stringify({
    items,
    status: "snapshot",
    rev: 0,
    sessionID,
  }).replace(/</g, "\\u003c")

  const assets = join(opts.viewer, "assets")
  const readAsset = async (name) => {
    const file = join(assets, name)
    return existsSync(file) ? readFileSync(file, "utf8") : null
  }

  const out = await buildSnapshotHtml({ html, island, readAsset })
  const file = opts.out ?? `${sessionID}.html`
  writeFileSync(file, out)

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ ok: true, file, bytes: Buffer.byteLength(out), items: items.length, sessionID }) + "\n",
    )
    return
  }
  const mb = (Buffer.byteLength(out) / 1048576).toFixed(2)
  process.stdout.write(`snapshot: ${file} (${mb} MB, ${items.length} items, ${exports.length} export file(s))\n`)
}

main().catch((error) => {
  process.stderr.write(`osh-snapshot-local: ${error?.message ?? error}\n`)
  process.exit(1)
})
