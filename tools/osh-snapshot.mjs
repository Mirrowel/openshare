#!/usr/bin/env node
// osh-snapshot — download a share as ONE self-contained offline HTML file,
// without a browser.
//
//   node tools/osh-snapshot.mjs <share-url> [-o file.html]
//        [--login user:pass | --token <viewer-token>]
//
// Works on GitHub Actions and any CI: the deployment's static assets are
// fetched through the normal CDN (static asset requests are free and
// unlimited on Cloudflare), so this needs no worker CPU and never touches
// the per-invocation subrequest cap the server-side endpoint has. The
// assembly is the same code the worker and the viewer's download button
// run (share-worker/og/snapshot.js).
//
// A gated share needs credentials: --login posts them to /api/share/<id>/auth
// and keeps the returned cookie, --token sends a viewer token as a bearer.
// If neither is given and the share is gated, the tool exits 2 and says so.

import { writeFileSync } from "node:fs"
import { basename } from "node:path"
import { buildSnapshotHtml } from "../share-worker/og/snapshot.js"

const USAGE = `usage: osh-snapshot <share-url> [-o out.html] [--login user:pass | --token <viewer-token>]

  <share-url>   https://host/s/<id> (a /s/<id>/<n> subagent URL is accepted;
                the snapshot always holds the whole share)
  -o, --out     output path (default: <id>.html in the current directory)
  --login       share login for gated shares, as user:pass
  --token       viewer token instead of login (sent as a bearer)
  --timeout     per-request timeout in seconds (default: 60)
  --json        print a one-line JSON result instead of human text
`

function parseArgs(argv) {
  const out = { url: undefined, out: undefined, login: undefined, token: undefined, timeout: 60, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-h" || a === "--help") {
      process.stdout.write(USAGE)
      process.exit(0)
    } else if (a === "-o" || a === "--out") out.out = argv[++i]
    else if (a === "--login") out.login = argv[++i]
    else if (a === "--token") out.token = argv[++i]
    else if (a === "--timeout") out.timeout = Number(argv[++i]) || 60
    else if (a === "--json") out.json = true
    else if (!a.startsWith("-") && !out.url) out.url = a
    else {
      process.stderr.write(`unknown argument: ${a}\n\n${USAGE}`)
      process.exit(2)
    }
  }
  if (!out.url) {
    process.stderr.write(USAGE)
    process.exit(2)
  }
  return out
}

/** origin + share id from any share URL shape (/s/<id>, /s/<id>/<n>, /s/<id>#...) */
function parseShareUrl(raw) {
  const u = new URL(raw)
  const m = u.pathname.match(/\/s\/([0-9a-f]{32})(?:\/\d+)?\/?/)
  if (!m) throw new Error(`not a share URL: ${raw}`)
  return { origin: u.origin, id: m[1], href: u.toString() }
}

const opts = parseArgs(process.argv.slice(2))

const withTimeout = (ms) => {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), ms)
  return { signal: c.signal, done: () => clearTimeout(t) }
}

async function get(url, headers = {}) {
  const t = withTimeout(opts.timeout * 1000)
  try {
    return await fetch(url, { headers, redirect: "follow", signal: t.signal })
  } finally {
    t.done()
  }
}

async function readText(url, headers) {
  const r = await get(url, headers)
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`)
  return await r.text()
}

async function main() {
  const share = parseShareUrl(opts.url)
  const authHeaders = opts.token ? { authorization: `Bearer ${opts.token}` } : {}
  let cookie = ""

  if (opts.login) {
    const [login, ...rest] = opts.login.split(":")
    const password = rest.join(":")
    const t = withTimeout(opts.timeout * 1000)
    try {
      const r = await fetch(`${share.origin}/api/share/${share.id}/auth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login, password }),
        signal: t.signal,
      })
      if (!r.ok) {
        const detail = await r.text().catch(() => "")
        throw new Error(`login failed: ${r.status} ${detail.slice(0, 200)}`)
      }
      const set = r.headers.getSetCookie?.() ?? []
      cookie = set.map((c) => c.split(";")[0]).join("; ")
      if (!cookie) {
        const body = await r.json().catch(() => ({}))
        if (body?.token) cookie = `osh_viewer_${share.id}=${body.token}`
      }
    } finally {
      t.done()
    }
  }

  const headers = { ...authHeaders, ...(cookie ? { cookie } : {}) }

  const dataRes = await get(`${share.origin}/api/share/${share.id}/data`, headers)
  if (dataRes.status === 401) {
    process.stderr.write("this share is gated: pass --login user:pass or --token <viewer-token>\n")
    process.exit(2)
  }
  if (!dataRes.ok) throw new Error(`data: ${dataRes.status} ${await dataRes.text().catch(() => "")}`)
  const payload = await dataRes.json()
  const items = payload.data ?? []
  if (!items.length) throw new Error("share has no items yet")

  let sessionID = ""
  for (const it of items) {
    if (it.type === "session" && it.data && !it.data.parentID) {
      sessionID = it.data.id ?? ""
      break
    }
  }
  if (!sessionID) throw new Error("share has no root session")

  const status = payload.status ?? "completed"
  const rev = payload.rev ?? 0
  const priv = payload.private
  const island = JSON.stringify({ items, status, rev, sessionID, ...(priv ? { private: priv } : {}) }).replace(/</g, "\\u003c")

  const htmlRes = await get(`${share.origin}/index.html`, headers)
  if (!htmlRes.ok) throw new Error(`index.html: ${htmlRes.status}`)
  const baseHtml = await htmlRes.text()

  const assetCache = new Map()
  const readAsset = async (name) => {
    if (!assetCache.has(name)) {
      const t = withTimeout(opts.timeout * 1000)
      try {
        const r = await fetch(`${share.origin}/assets/${name}`, { headers, signal: t.signal })
        assetCache.set(name, r.ok ? await r.text() : null)
      } catch {
        assetCache.set(name, null)
      } finally {
        t.done()
      }
    }
    return assetCache.get(name)
  }

  const out = await buildSnapshotHtml({ html: baseHtml, island, readAsset })
  const file = opts.out ?? `${share.id}.html`
  writeFileSync(file, out)

  const mb = (Buffer.byteLength(out) / 1048576).toFixed(2)
  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ ok: true, file, bytes: Buffer.byteLength(out), rev, status, items: items.length, sessionID }) + "\n",
    )
  } else {
    process.stdout.write(`snapshot: ${basename(file)} (${mb} MB, ${items.length} items, rev ${rev}, ${status})\n`)
  }
}

main().catch((error) => {
  process.stderr.write(`osh-snapshot: ${error?.message ?? error}\n`)
  process.exit(1)
})
