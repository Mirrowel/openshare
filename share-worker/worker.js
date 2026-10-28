// openshare-worker — Open(code)Share: self-hosted session sharing for
// opencode ("re:share"). Event-driven over hibernating WebSockets.
//
// Protocol:
//   HTTP (fallback + curl/testing):
//     POST   /api/share            {sessionID, ttlHours? (legacy ttlDays), authLogin?, authPassword?}
//                                  Bearer CREATE_TOKEN -> {id, secret}
//     POST   /api/share/:id/sync   {secret, data, status?} -> {ok, rev, status}
//     GET    /api/share/:id/data   -> {data, status, rev}   (401 authRequired if gated)
//     POST   /api/share/:id/auth   {login, password} -> cookie token (rate-limited)
//     DELETE /api/share/:id        {secret}
//     GET    /branding             -> BRAND_* vars as JSON (viewer skin)
//   WebSocket (primary):
//     viewer:  GET /api/share/:id/ws — hibernating; auth cookie checked;
//              pushes {op:"frame", status, rev, items} after every sync
//     plugin:  GET /api/ws?token=<CREATE_TOKEN> — one socket per process:
//              init create {sessionID, ttlHours? (legacy ttlDays), authLogin?, authPassword?}
//              init attach {id, secret, authLogin?, authPassword?}
//                 (attach with empty auth values REMOVES the read gate)
//              sync {items, status?} -> ack {rev}; delete
//
// Read auth (casual-eyes resistance): per-share PBKDF2-SHA256 hashes
// (10k iterations, per-share salt — free-tier CPU friendly; the hash
// never leaves the DO), session cookie tokens (7d, up to 5 devices),
// exponential lockout per IP (5 fails -> 1min doubling to 24h) and
// per-share total (20 fails -> 24h).
//
// Write auth (identity):
//   * user tokens "osk_…" — SHA-256-hashed in the AuthDO; every share
//     records its owner. Control ops accept the owner's valid token OR
//     the per-share secret while the owner is in good standing.
//   * enrollment: POST /api/enroll — public servers (AUTH_MODE=public)
//     issue tokens to anyone; private servers require an access code
//     ("osc_…") with an activation budget (1 for a personal invite,
//     -1 unlimited). Codes are minted by the admin.
//   * token lifecycle: POST /api/token/rotate, DELETE /api/token (self),
//     GET/PUT /api/me + /api/me/settings + /api/me/shares.
//   * per-token limits (enforced server-side at create): maxLiveShares,
//     maxTtlDays, dailyCreates (0 = unlimited).
//   * frozen user -> all their shares reject EVERY edit (even valid
//     secrets); viewing is unaffected until TTL. Admin unfreeze/reassign
//     is the rescue path. The root CREATE_TOKEN stays the forever-valid
//     admin bootstrap (admin = root only in this model).
//
// Viewer privacy: session items never leave with their `metadata` field
// (the plugin stores its share binding there — belt and suspenders).
//
// Resumability: every accepted sync bumps a monotonic rev; plugins ack
// and replay. TTL is per-share (capped at MAX_TTL_DAYS); the sweeper
// respects each share's own TTL.

const encoder = new TextEncoder()

// Neutral code defaults for every deployment. THIS deployment's skin lives
// in openshare.config.json (bundled at build); BRAND_* env vars override
// both — same ENV > file > defaults chain as the plugin config.
import defaultBrandingFile from "./openshare.config.json"
const DEFAULT_BRANDING = {
  name: "",
  logoUrl: "",
  wordmarkUrl: "",
  linkUrl: "",
  accent: "",
  faviconUrl: "",
  backgroundUrl: "",
  description: "",
  ogTitle: "",
  ogImage: "",
  ...defaultBrandingFile,
}

// resolve the deployment branding with the same env > file priority as
// the /branding endpoint (used by the crawler og-injection)
function brandingField(env, field) {
  const envKey = "BRAND_" + field.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase()
  return env[envKey] || DEFAULT_BRANDING[field] || ""
}

function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

function resolveBrandingObj(env) {
  const b = (field) => {
    const envKey = "BRAND_" + field.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase()
    return env[envKey] || DEFAULT_BRANDING[field] || ""
  }
  return {
    name: b("name"),
    logoUrl: b("logoUrl"),
    wordmarkUrl: b("wordmarkUrl"),
    linkUrl: b("linkUrl"),
    accent: b("accent"),
    faviconUrl: b("faviconUrl"),
    backgroundUrl: b("backgroundUrl"),
    description: b("description"),
    ogTitle: b("ogTitle"),
    ogImage: b("ogImage"),
  }
}

// GET /api/share/:id/snapshot — ONE self-contained HTML file: the viewer
// bundle inlined (JS+CSS), the share frozen as a JSON island, a boot shim
// feeding it to the embedded data path. Opens offline in any browser;
// point-in-time record that outlives the deployment. Read gate applies
// exactly as /data: a gated share demands a satisfied viewer session.
async function serveSnapshot(req, env, url, snap) {
  const r = await env.ASSETS.fetch(new Request(url.origin + "/index.html", { method: "GET" }))
  if (!r.ok) return new Response("viewer assets unavailable", { status: 502 })
  let html = await r.text()
  const assets = new Map()
  const grab = async (src) => {
    if (!assets.has(src)) {
      const a = await env.ASSETS.fetch(new Request(url.origin + src))
      assets.set(src, a.ok ? await a.text() : null)
    }
    return assets.get(src)
  }
  // modulepreload hints are dead weight when every module is inline
  html = html.replace(/[ \t]*<link[^>]*rel="modulepreload"[^>]*>\r?\n?/g, "")
  const scriptRe = /<script[^>]*src="(\/assets\/[^"]+\.js)"[^>]*>\s*<\/script>/g
  for (const m of [...html.matchAll(scriptRe)]) await grab(m[1])
  html = html.replace(scriptRe, (whole, src) => {
    const code = assets.get(src)
    return code == null ? whole : `<script type="module">\n${code}\n</script>`
  })
  const cssRe = /<link[^>]*href="(\/assets\/[^"]+\.css)"[^>]*>/g
  for (const m of [...html.matchAll(cssRe)]) await grab(m[1])
  html = html.replace(cssRe, (whole, src) => {
    const css = assets.get(src)
    return css == null ? whole : `<style>\n${css}\n</style>`
  })
  const island = `<script>window.__MIRROBOT_SNAPSHOT__=${snap.island};</script>` + `
<script>(function(){
  // a snapshot file runs from file:// — its PATH cannot be rewritten
  // (pushState across file paths throws SecurityError), so /s/<id>[/<n>][#h]
  // URLs translate to same-path hashes: subagent page n becomes #n<n>,
  // message anchors keep their hash. Without this shim every subagent
  // click would throw and the page would die mid-handler.
  if (!window.__MIRROBOT_SNAPSHOT__) return
  var orig = history.pushState.bind(history)
  history.pushState = function(st, title, url) {
    if (typeof url === "string" && url.charAt(0) === "/") {
      var m = /^\\/s\\/[^/]+(?:\\/(\\d+))?/.exec(url)
      var hi = url.indexOf("#")
      var hash = hi >= 0 ? url.slice(hi) : ""
      var sub = m && m[1] ? "#n" + m[1] : ""
      var next = sub || hash
      if (next) return orig(st, title, location.pathname + location.search + next)
      return
    }
    return orig(st, title, url)
  }
})()</script>`
  html = html.replace(/<head>/i, "<head>\n    " + island)
  const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  if (url.searchParams.has("download")) headers["content-disposition"] = `attachment; filename="openshare-${snap.id}.html"`
  return new Response(html, { status: 200, headers })
}

// index.html with og:/twitter: tags for link previews. /s/<id> pages get
// PER-SHARE tags (session title + stat line + the rendered card) for
// UNGATED shares; gated shares and the landing page stay generic — a
// preview must never leak what a gated share contains.
async function serveOgIndex(req, env, url) {
  const r = await env.ASSETS.fetch(new Request(url.origin + "/index.html", { method: "GET" }))
  if (!r.ok) return r
  const name = brandingField(env, "name") || "openshare"
  const desc = brandingField(env, "description") || "shared agent sessions, self-hosted"
  const accent = brandingField(env, "accent") || ""
  const image = brandingField(env, "ogImage") || brandingField(env, "logoUrl") || ""
  const title = brandingField(env, "ogTitle") || `${name} · Open(code)Share`
  const absImage = image && image.startsWith("/") ? url.origin + image : image

  let ogTitle = title
  let ogDesc = desc
  let ogImage = absImage
  let card = absImage ? "summary_large_image" : "summary"
  const sm = url.pathname.match(/^\/s\/([0-9a-f]{32})/)
  if (sm) {
    // per-share card: any failure keeps the deployment-generic tags
    try {
      const ogRes = await shareStub(env, sm[1]).fetch("https://do/og")
      if (ogRes.ok) {
        const meta = await ogRes.json()
        ogImage = `${url.origin}/api/share/${sm[1]}/og.png?v=${meta.rev ?? 0}`
        card = "summary_large_image"
        if (!meta.gated) {
          ogTitle = String(meta.title ?? "shared session").slice(0, 96)
          const s = meta.stats ?? {}
          const bits = []
          if (s.turns) bits.push(`${s.turns} turn${s.turns === 1 ? "" : "s"}`)
          if (s.tools) bits.push(`${s.tools} tool${s.tools === 1 ? "" : "s"}`)
          if (s.durationMs >= 60000) {
            const min = Math.round(s.durationMs / 60000)
            bits.push(min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`)
          }
          if (s.model) bits.push(s.model)
          ogDesc = bits.join(" · ") || desc
        } else {
          ogDesc = "Private share — log in to view"
        }
      }
    } catch {}
  }
  const tags = [
    `<meta property="og:title" content="${htmlEscape(ogTitle)}">`,
    `<meta property="og:description" content="${htmlEscape(ogDesc)}">`,
    `<meta property="og:site_name" content="${htmlEscape(name)}">`,
    `<meta name="twitter:card" content="${card}">`,
    `<meta name="twitter:title" content="${htmlEscape(ogTitle)}">`,
    `<meta name="twitter:description" content="${htmlEscape(ogDesc)}">`,
  ]
  if (accent) tags.push(`<meta name="theme-color" content="${htmlEscape(accent)}">`)
  if (ogImage) {
    tags.splice(3, 0, `<meta property="og:image" content="${htmlEscape(ogImage)}">`)
    tags.push(`<meta name="twitter:image" content="${htmlEscape(ogImage)}">`)
  }
  const html = (await r.text()).replace(/<head>/i, "<head>\n    " + tags.join("\n    "))
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
}

import { renderOgPng } from "./og/og-card.js"

// OG card render cache: PNG bytes per share at its rev (bounded LRU-ish;
// the ?v=<rev> URL makes crawler caches self-busting anyway)
const ogPngCache = new Map()
const ogPngHeaders = (rev) => ({ "content-type": "image/png", "cache-control": `public, max-age=300`, "x-og-rev": rev })

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    const path = url.pathname
    const json = (code, body, headers = {}) => new Response(JSON.stringify(body), {
      status: code,
      headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
    })

    try {
      // ---- link previews (branding v2) ----
      // /s/* and / reach the worker via run_worker_first; normal browsers
      // pass straight through to the static assets. Crawler user-agents
      // (Discord/Telegram/Slack/etc - they never run the SPA) get
      // index.html with og:/twitter: tags injected from the deployment
      // branding. og:title carries the DEPLOYMENT name, never the session
      // title - a link preview must not leak what a share contains.
      if (req.method === "GET" && (path === "/" || path === "/index.html" || path.startsWith("/s/"))) {
        const ua = (req.headers.get("user-agent") || "").toLowerCase()
        if (/(discordbot|discordapp|telegrambot|slackbot|slack-imgproxy|facebookexternalhit|facebookcatalog|whatsapp|twitterbot|x-bot|linkedinbot|pinterestbot|skypeuripreview|snapchat|bluefish|mattermost|gitter|flowdock)/.test(ua)) {
          return await serveOgIndex(req, env, url)
        }
        // temporary A/B build: ?legacy sticks in a cookie, ?legacy=0 clears
        // it, and the page is served verbatim from dist/legacy.html (built
        // from the `master` viewer). Nothing is injected; when legacy.html
        // is absent the request falls through to the current build.
        const param = url.searchParams.get("legacy")
        const cookie = req.headers.get("cookie") || ""
        let legacy = /(?:^|;\s*)osh_legacy=1/.test(cookie)
        let setCookie = null
        if (param === "0" || param === "false") {
          legacy = false
          setCookie = "osh_legacy=; Path=/; Max-Age=0; SameSite=Lax"
        } else if (param !== null) {
          legacy = true
          setCookie = "osh_legacy=1; Path=/; Max-Age=604800; SameSite=Lax"
        }
        if (legacy) {
          const legacyRes = await env.ASSETS.fetch(new Request(url.origin + "/legacy.html", { method: "GET" }))
          if (legacyRes.ok) {
            const headers = new Headers(legacyRes.headers)
            headers.set("cache-control", "no-store")
            if (setCookie) headers.set("set-cookie", setCookie)
            return new Response(legacyRes.body, { status: 200, headers })
          }
        }
        const res = await env.ASSETS.fetch(req)
        if (setCookie) {
          const headers = new Headers(res.headers)
          headers.set("set-cookie", setCookie)
          return new Response(res.body, { status: res.status, headers })
        }
        return res
      }

      if (path === "/health")
        return json(200, { ok: true, service: "openshare", policy: resolvePolicy(env), auth: { mode: authMode(env) }, frameAuth: true })

      // ---- identity -------------------------------------------------------
      // Enrollment + self-service. The heavy lifting lives in the AuthDO
      // (single writer for users/tokens/codes); the router only checks
      // the root bootstrap and forwards.
      if (path === "/api/enroll" && req.method === "POST") {
        const body = await req.json().catch(() => ({}))
        const r = await authCall(env, "/enroll", {
          code: typeof body.code === "string" ? body.code : "",
          label: typeof body.label === "string" ? body.label.slice(0, 64) : "",
          ip: req.headers.get("cf-connecting-ip") ?? "unknown",
        })
        return json(r.status, r.body)
      }

      if (path === "/api/me" && req.method === "GET") {
        const r = await authCall(env, "/me", { token: bearer(req) })
        return json(r.status, r.body)
      }
      if (path === "/api/me/settings" && (req.method === "GET" || req.method === "PUT")) {
        const body = req.method === "PUT" ? await req.json().catch(() => ({})) : {}
        const r = await authCall(env, "/settings", { token: bearer(req), patch: body, maxTtlHours: clampTtlHours(undefined, env) })
        return json(r.status, r.body)
      }
      if (path === "/api/me/shares" && req.method === "GET") {
        const r = await authCall(env, "/me-shares", { token: bearer(req) })
        return json(r.status, r.body)
      }
      if (path === "/api/token/rotate" && req.method === "POST") {
        const r = await authCall(env, "/rotate", { token: bearer(req) })
        return json(r.status, r.body)
      }
      if (path === "/api/token" && req.method === "DELETE") {
        const r = await authCall(env, "/token-delete", { token: bearer(req) })
        return json(r.status, r.body)
      }
      if (path === "/api/token" && req.method === "POST") {
        const body = await req.json().catch(() => ({}))
        const r = await authCall(env, "/token-self-mint", { token: bearer(req), ...body })
        return json(r.status, r.body)
      }
      if (path === "/api/token/sets" && req.method === "GET") {
        const r = await authCall(env, "/token-sets-get", { token: bearer(req) })
        return json(r.status, r.body)
      }
      if (path === "/api/token/sets" && req.method === "PUT") {
        const body = await req.json().catch(() => ({}))
        const r = await authCall(env, "/token-sets-put", { token: bearer(req), sets: body.sets })
        return json(r.status, r.body)
      }

      // ---- admin (root CREATE_TOKEN only in this model) --------------------
      if (path.startsWith("/api/admin/") && path !== "/api/admin/purge") {
        const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
        if (!env.CREATE_TOKEN || token !== env.CREATE_TOKEN) return json(403, { error: "forbidden" })
        const body = await req.json().catch(() => ({}))
        const call = async (route) => {
          const r = await authCall(env, route, body)
          return [r.status, r.body]
        }
        if (path === "/api/admin/users" && req.method === "POST") return json(...(await call("/user-create")))
        if (path === "/api/admin/users" && req.method === "GET") return json(...(await call("/users-get")))
        let m = path.match(/^\/api\/admin\/users\/([^/]+)\/(freeze|unfreeze)$/)
        if (m && req.method === "POST") {
          body.userId = m[1]
          return json(...(await call(`/user-freeze:${m[2] === "unfreeze" ? "0" : "1"}`)))
        }
        m = path.match(/^\/api\/admin\/users\/([^/]+)$/)
        if (m && req.method === "DELETE") return json(...(await call("/user-delete:" + m[1])))
        if (path === "/api/admin/tokens" && req.method === "POST") return json(...(await call("/token-mint")))
        if (path === "/api/admin/tokens" && req.method === "GET") return json(...(await call("/tokens-get")))
        m = path.match(/^\/api\/admin\/tokens\/([^/]+)$/)
        if (m && req.method === "DELETE") return json(...(await call("/token-revoke:" + m[1])))
        m = path.match(/^\/api\/admin\/tokens\/([^/]+)\/sets$/)
        if (m && req.method === "PUT") return json(...(await call("/token-sets-admin:" + m[1])))
        m = path.match(/^\/api\/admin\/tokens\/([^/]+)\/freeze-shares$/)
        if (m && req.method === "POST") return json(...(await call("/freeze-by-token:" + m[1])))
        if (path === "/api/admin/codes" && req.method === "POST") return json(...(await call("/code-create")))
        if (path === "/api/admin/codes" && req.method === "GET") return json(...(await call("/codes-get")))
        m = path.match(/^\/api\/admin\/codes\/([^/]+)$/)
        if (m && req.method === "DELETE") return json(...(await call("/code-disable:" + m[1])))
        m = path.match(/^\/api\/admin\/codes\/([^/]+)\/revoke-lineage$/)
        if (m && req.method === "POST") return json(...(await call("/code-lineage-revoke:" + m[1])))
        if (path === "/api/admin/shares" && req.method === "GET") {
          // global list straight from the KV index — the record rides in
          // key metadata (list() returns it inline; no per-key get = no
          // KV N+1). Legacy keys with a JSON value fall back to a get.
          const shares = []
          let cursor
          do {
            const page = await env.SHARE_INDEX.list({ cursor })
            for (const k of page.keys) {
              if (!k.name.startsWith("share:")) continue
              const id = k.name.slice(6)
              if (k.metadata) {
                shares.push({ id, ...k.metadata })
                continue
              }
              const raw = await env.SHARE_INDEX.get(k.name)
              if (!raw) continue
              // one corrupt value must not 500 the whole admin list
              try { shares.push({ id, ...JSON.parse(raw) }) } catch {}
            }
            cursor = page.list_complete ? undefined : page.cursor
          } while (cursor)
          return json(200, { ok: true, shares })
        }
        m = path.match(/^\/api\/admin\/shares\/([0-9a-f]+)\/reassign$/)
        if (m && req.method === "POST") return json(...(await call("/reassign:" + m[1])))
        return json(404, { error: "not found" })
      }

      // ---- admin purge: Bearer CREATE_TOKEN, wipes EVERY share ----
      // Maintenance endpoint (owner-only): chunked through the SweeperDO
      // alarm loop (bounded subrequests per invocation; the inline first
      // batch makes the response immediate). Viewers get a final "gone"
      // frame via each DO's /remove-all broadcast.
      if (path === "/api/admin/purge" && req.method === "POST") {
        const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
        if (!env.CREATE_TOKEN || token !== env.CREATE_TOKEN) return json(403, { error: "forbidden" })
        const r = await env.SWEEPER.get(env.SWEEPER.idFromName("singleton")).fetch("https://do/purge", { method: "POST" })
        const body = await r.json().catch(() => ({}))
        return json(200, { ok: true, removed: body.swept ?? 0, continuing: body.done === false })
      }

      if (path === "/branding") {
        return new Response(JSON.stringify(resolveBrandingObj(env)), {
          headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
        })
      }

      // ---- plugin control socket: forward the upgrade into a fresh DO ----
      // The token may arrive as an authorization header (preferred — undici
      // WS can't set headers, so the plugin also uses ?token=) or as the
      // FIRST frame after open ({op:"auth", token}) when /health advertised
      // frameAuth; the ControlDO handles both.
      if (path === "/api/ws") {
        const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token") ?? ""
        const fwd = new Request(url.origin + "/control-ws?token=" + encodeURIComponent(token), req)
        return env.SHARE_CONTROL.get(env.SHARE_CONTROL.newUniqueId()).fetch(fwd)
      }

      // ---- viewer socket: forward the upgrade into the ShareDO ----
      const wm = path.match(/^\/api\/share\/([0-9a-f]{32})\/ws$/)
      if (wm && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        // preserve the query (?since= handshake): the URL argument of
        // new Request REPLACES the original URL, so a bare https://do/ws
        // silently dropped since and forced a full first frame
        return shareStub(env, wm[1]).fetch(new Request(`https://do/ws${url.search}`, req))
      }

      const am = path.match(/^\/api\/share\/([0-9a-f]{32})\/auth$/)
      if (am && req.method === "POST") {
        const body = await req.json().catch(() => ({}))
        const r = await shareStub(env, am[1]).fetch("https://do/auth", {
          method: "POST",
          headers: { "x-ip": req.headers.get("cf-connecting-ip") ?? "unknown" },
          body: JSON.stringify({ login: body.login ?? "", password: body.password ?? "" }),
        })
        const out = await r.json()
        const headers = {}
        if (out.setCookie) headers["set-cookie"] = out.setCookie
        return json(r.status, out.body ?? out, headers)
      }

      // share-referencing ops need a REAL share id (32 hex — anything else
      // 404s here instead of waking a Durable Object per guess); the bare
      // POST create keeps its flexible hex suffix (routing convention —
      // the share id is minted server-side)
      const sm = path.match(/^\/api\/share\/([0-9a-f]+)(\/sync|\/data|\/snapshot|\/og\.png|)$/)
      if (!sm) return json(404, { error: "not found" })
      const id = sm[1]
      const op = sm[2]
      if (id.length !== 32 && !(req.method === "POST" && op === "")) return json(404, { error: "not found" })

      if (req.method === "POST" && op === "") {
        const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
        if (auth && env.CREATE_TOKEN && auth === env.CREATE_TOKEN) {
          // root bootstrap: ownerless create (legacy path keeps working)
          return await httpCreate(env, json, await req.json().catch(() => ({})), null, 0)
        }
        const rawBody = await req.json().catch(() => ({}))
        const chk = await authCall(env, "/create-check", { token: auth ?? "", ...(rawBody.set ? { set: rawBody.set } : {}) })
        if (!chk.body?.ok) return json(chk.body?.httpStatus ?? 401, { error: chk.body?.error ?? "bad create token" })
        return await httpCreate(env, json, rawBody, chk.body.userId ?? null, chk.body.ttlMaxHours ?? 0, chk.body.defaultTtlHours ?? 0, chk.body.tokenId, chk.body.tokenKind, chk.body.setA ?? null)
      }

      if (req.method === "POST" && op === "/sync") {
        // request-size cap: the engine's HTTP fallback chunks at a 4MB
        // byte budget, so 8MB covers every legit body (plus envelope) —
        // anything bigger is a hostile/buggy client. Refuse before parsing.
        const text = await req.text()
        if (text.length > 8_000_000) return json(413, { error: "payload too large" })
        const body = (() => { try { return JSON.parse(text) } catch { return {} } })()
        const ident = await resolveIdentity(env, req, body)
        const r = await shareStub(env, id).fetch("https://do/sync", {
          method: "POST",
          body: JSON.stringify({ secret: body.secret ?? "", ownerId: ident.ownerId, root: ident.root, tokenId: ident.tokenId, tokenKind: ident.tokenKind, data: body.data ?? [], status: body.status }),
        })
        return json(r.status, await r.json())
      }

      if (req.method === "GET" && op === "/data") {
        const token = bearer(req) || cookieToken(req, id)
        // forward the FULL query (since handshakes the poll delta; a
        // hardcoded token-only URL silently dropped it — the delta path
        // was dead on Cloudflare while Bun served it). Stream the body
        // through instead of materializing a 25MB string in the router.
        const doUrl = new URL("https://do/data")
        doUrl.searchParams.set("token", token)
        for (const [k, v] of url.searchParams) if (k !== "token") doUrl.searchParams.set(k, v)
        const r = await shareStub(env, id).fetch(doUrl)
        return new Response(r.body, {
          status: r.status,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        })
      }

      if (req.method === "GET" && op === "/snapshot") {
        // frozen self-contained HTML of the share as it stands RIGHT NOW;
        // the read gate applies exactly as /data (cookie or bearer viewer
        // token for gated shares — no bypass through the snapshot)
        const token = bearer(req) || cookieToken(req, id)
        const doUrl = new URL("https://do/snapshot")
        doUrl.searchParams.set("token", token)
        const r = await shareStub(env, id).fetch(doUrl)
        if (!r.ok) return json(r.status, await r.json().catch(() => ({})))
        return await serveSnapshot(req, env, url, { ...(await r.json()), id })
      }

      if (req.method === "GET" && op === "/og.png") {
        // per-share OG card, rendered once per rev (bounded isolate cache;
        // ?v=<rev> busts Discord's per-URL preview cache)
        const r = await shareStub(env, id).fetch("https://do/og")
        if (!r.ok) return new Response("gone", { status: 404 })
        const ogMeta = await r.json()
        const cached = ogPngCache.get(id)
        if (cached && cached.rev === ogMeta.rev) return new Response(cached.bytes, { status: 200, headers: ogPngHeaders(String(ogMeta.rev)) })
        try {
          const bytes = await renderOgPng({ title: ogMeta.gated ? undefined : ogMeta.title, status: ogMeta.status, stats: ogMeta.stats ?? {}, branding: resolveBrandingObj(env) })
          ogPngCache.set(id, { rev: ogMeta.rev, bytes })
          if (ogPngCache.size > 8) ogPngCache.delete(ogPngCache.keys().next().value)
          return new Response(bytes, { status: 200, headers: ogPngHeaders(String(ogMeta.rev)) })
        } catch (e) {
          return json(500, { error: `og render failed: ${e?.message ?? e}` })
        }
      }

      if (req.method === "DELETE" && op === "") {
        const body = await req.json().catch(() => ({}))
        const ident = await resolveIdentity(env, req, body)
        const r = await shareStub(env, id).fetch("https://do/remove", {
          method: "POST",
          body: JSON.stringify({ secret: body.secret ?? "", ownerId: ident.ownerId, root: ident.root, tokenId: ident.tokenId, tokenKind: ident.tokenKind }),
        })
        return json(r.status, await r.json())
      }

      // #13: edit ANY share setting after creation (login/pass, ttl,
      // meta labels) over REST - the attach-sync path covers live
      // sockets; this is the general surface. Identity-gated exactly
      // like sync; scoped tokens reach only their own shares.
      if (req.method === "PATCH" && op === "") {
        if (id.length !== 32) return json(404, { error: "not found" })
        const body = await req.json().catch(() => ({}))
        const ident = await resolveIdentity(env, req, body)
        const patch = {}
        if (body.authLogin !== undefined && body.authPassword !== undefined) {
          // both-or-none, same as the plugin contract: a half pair is
          // silently ungated server-side, refuse it at the door
          if ((body.authLogin === "") !== (body.authPassword === "")) return json(400, { error: "authLogin and authPassword must be set together" })
          patch.authLogin = String(body.authLogin)
          patch.authPassword = String(body.authPassword)
        }
        if (body.ttlHours !== undefined || body.ttlDays !== undefined) {
          const h = ttlHoursFrom(body)
          if (h === undefined) return json(400, { error: "ttlHours must be a positive number of hours" })
          patch.ttlHours = clampTtlHours(h, env, ident.ttlMaxHours ?? 0)
        }
        if (body.meta !== undefined) {
          if (!body.meta || typeof body.meta !== "object" || Array.isArray(body.meta)) return json(400, { error: "meta must be an object" })
          const clean = {}
          let c = 0
          for (const [k, v] of Object.entries(body.meta)) {
            if (c >= 20) break
            if (typeof k === "string" && typeof v === "string" && k.length <= 64 && v.length <= 500) { clean[k] = v; c++ }
          }
          patch.custom = clean
        }
        if (!Object.keys(patch).length) return json(400, { error: "nothing to update (authLogin/authPassword, ttlHours, meta)" })
        const r = await shareStub(env, id).fetch("https://do/set-opts", {
          method: "POST",
          body: JSON.stringify({ secret: body.secret ?? "", ownerId: ident.ownerId, root: ident.root, tokenId: ident.tokenId, tokenKind: ident.tokenKind, ...patch }),
        })
        const out = await r.json().catch(() => ({ ok: false, error: "bad response" }))
        return json(r.status, out.ok ? { ...out, id } : out)
      }

      return json(404, { error: "not found" })
    } catch (e) {
      console.log("[http] error", e?.message || e)
      return json(500, { error: "internal" })
    }
  },
}

function bearer(req) {
  return req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""
}

function cookieToken(req, shareId) {
  const raw = req.headers.get("cookie") ?? ""
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=")
    if (k === `osh_${shareId}`) return v.join("=")
  }
  return ""
}

function randomId() {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
}

/** TTL is HOURS-native (Wave 3). Every surface accepts the legacy
 * days-shaped input converted x24: old plugins, old tokens (limits
 * stored maxTtlDays), old env vars (MAX_TTL_DAYS / DEFAULT_MAX_TTL_DAYS).
 * New shapes: ttlHours fields, maxTtlHours limits, MAX_TTL_HOURS /
 * DEFAULT_MAX_TTL_HOURS vars. Floor is one hour (was one day).
 * tokenMax is HOURS when tokenMaxUnit!=="days". */
function clampTtlHours(hours, env, tokenMax = 0, tokenMaxUnit = "hours") {
  let max = Number(env.MAX_TTL_HOURS || 0) || Math.floor(Number(env.MAX_TTL_DAYS || 90) * 24)
  if (!Number.isFinite(max) || max < 1) max = 90 * 24
  if (tokenMax > 0) max = Math.min(max, tokenMaxUnit === "days" ? Math.floor(tokenMax * 24) : tokenMax)
  if (hours == null || !Number.isFinite(Number(hours))) return max
  return Math.max(1, Math.min(Math.floor(Number(hours)), max))
}

/** Accept a create/attach/PATCH body field pair: ttlHours wins, legacy
 * ttlDays converts. Returns hours | undefined. */
function ttlHoursFrom(body) {
  if (body && Number.isFinite(Number(body.ttlHours)) && Number(body.ttlHours) > 0) return Math.floor(Number(body.ttlHours))
  if (body && Number.isFinite(Number(body.ttlDays)) && Number(body.ttlDays) > 0) return Math.floor(Number(body.ttlDays) * 24)
  return undefined
}

// KV key METADATA is capped at 1024 bytes total: an over-budget `custom`
// object would make the index put throw forever (the share stays visible
// but the retry loop never ends). Trim to a safe byte budget: values
// first (60 chars), then drop overflow keys oldest-first.
function kvCustom(custom, budget = 700) {
  if (!custom || typeof custom !== "object") return {}
  const out = {}
  let used = 0
  for (const [k, v] of Object.entries(custom)) {
    if (typeof v !== "string") continue
    const val = v.length > 60 ? v.slice(0, 57) + "..." : v
    const cost = k.length + val.length + 8
    if (used + cost > budget) break
    out[k] = val
    used += cost
  }
  return out
}

function authMode(env) {
  return String(env.AUTH_MODE ?? "private").toLowerCase() === "public" ? "public" : "private"
}

/** Public servers may accept onboarding without an access code only when
 * this is explicitly enabled (default OFF - anonymous creating stays open
 * either way; this gate is about minting ACCOUNTS). */
function codelessOnboarding(env) {
  return /^(1|true|yes|on)$/i.test(String(env.CODELESS_ONBOARDING ?? "").trim())
}

async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", encoder.encode(s))
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("")
}

// All identity logic lives in the singleton AuthDO; HTTP routes and the
// ControlDO talk to it through this tiny RPC. Never throws — a failed
// call degrades to a 500 body the caller can surface.
async function authCall(env, route, body) {
  try {
    const r = await env.AUTH_DO.get(env.AUTH_DO.idFromName("singleton")).fetch("https://auth" + route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    })
    return { status: r.status, body: await r.json() }
  } catch (e) {
    return { status: 500, body: { ok: false, error: "auth do unavailable: " + (e?.message || e) } }
  }
}

async function httpCreate(env, json, body, ownerId, ttlMax, ownerDefault = 0, tokenId = null, tokenKind = null, setA = null) {
  if (!body.sessionID || typeof body.sessionID !== "string") return json(400, { error: "sessionID required" })
  // B4 Class A: the token's provisioned set overrides client values
  if (setA) {
    if (setA.authLogin !== undefined) { body.authLogin = setA.authLogin; body.authPassword = setA.authPassword ?? "" }
    if (setA.ttlHours !== undefined) body.ttlHours = setA.ttlHours
    else if (setA.ttlDays !== undefined) body.ttlDays = setA.ttlDays
  }
  const newId = randomId()
  const ttlHours = clampTtlHours(ttlHoursFrom(body) ?? (ownerDefault || undefined), env, ttlMax)
  const r = await shareStub(env, newId).fetch("https://do/init", {
    method: "POST",
    body: JSON.stringify({
      id: newId,
      sessionID: body.sessionID,
      ttlHours,
      authLogin: body.authLogin ?? "",
      authPassword: body.authPassword ?? "",
      ownerId,
      ...(tokenId ? { creatorTokenId: tokenId } : {}),
    }),
  })
  const out = await r.json()
  if (out.ok && ownerId) await authCall(env, "/register", { userId: ownerId, shareId: newId, sessionID: body.sessionID, ...(tokenId ? { tokenId } : {}) })
  if (out.ok) return json(r.status, { ...out, ttlHours })
  return json(r.status, out)
}

// ---------------------------------------------------------------------------
// Server policy — the worker owns the socket rules and the allowed sync
// cadence window; plugins clamp themselves into it (init ack + /health).
//_vars:
//   SOCKET_POLICY          auto | persistent | turn   (auto: Cloudflare
//                          runtime detected -> persistent — hibernation
//                          makes idle sockets free; anything else -> turn)
//   TURN_GRACE_MS          turn mode: socket stays warm this long after a
//                          turn settles (default 120000)
//   IDLE_DROP_MS           turn mode: no-signal fallback drop (default 600000)
//   FINALIZE_AFTER_MS      plugin gone without goodbye this long -> the
//                          share settles to "interrupted" (default 300000)
//   DEBOUNCE_MIN_MS / DEBOUNCE_MAX_MS    allowed client sync interval
//                          (default 1000 / 60000)
//   COMPLETED_DELAY_MAX_MS allowed client completed-delay (default 60000)
// ---------------------------------------------------------------------------
function resolvePolicy(env) {
  let mode = String(env.SOCKET_POLICY ?? "auto").toLowerCase()
  if (mode !== "persistent" && mode !== "turn") mode = "auto"
  if (mode === "auto") {
    const ua = globalThis.navigator?.userAgent ?? ""
    mode = ua.includes("Cloudflare-Workers") ? "persistent" : "turn"
  }
  const num = (v, d) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : d
  }
  const min = num(env.DEBOUNCE_MIN_MS, 1000)
  return {
    mode,
    turnGraceMs: num(env.TURN_GRACE_MS, 120000),
    idleDropMs: num(env.IDLE_DROP_MS, 600000),
    finalizeAfterMs: num(env.FINALIZE_AFTER_MS, 300000),
    debounceMinMs: min,
    debounceMaxMs: Math.max(num(env.DEBOUNCE_MAX_MS, 60000), min),
    completedDelayMaxMs: num(env.COMPLETED_DELAY_MAX_MS, 60000),
  }
}

// Bearer user tokens can drive sync/delete for their OWN shares (the
// "control all my shares with my token" promise). Resolve the request
// identity once: root flag or the token's userId.
async function resolveIdentity(env, req, body) {
  if (body.secret) return { ownerId: null, root: false } // secret path is checked in the DO
  const token = bearer(req)
  if (!token) return { ownerId: null, root: false }
  if (env.CREATE_TOKEN && token === env.CREATE_TOKEN) return { ownerId: null, root: true }
  const chk = await authCall(env, "/check", { token })
  if (chk.body?.kind === "user") return { ownerId: chk.body.userId, root: false, tokenId: chk.body.tokenId, tokenKind: chk.body.tokenKind === "scoped" ? "scoped" : "full", ttlMaxHours: chk.body.ttlMaxHours ?? 0 }
  return { ownerId: null, root: false }
}

function shareStub(env, id) {
  return env.SHARE_DO.get(env.SHARE_DO.idFromName(id))
}

// PBKDF2-SHA256 (10k iterations: ~5ms CPU, inside the free-tier per-request
// budget; the hash stays in the DO so offline cracking isn't the threat —
// the online lockout is).
async function pbkdf2(value, salt) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(value), "PBKDF2", false, ["deriveBits"])
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: 10000 },
    key,
    256,
  )
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, "0")).join("")
}

// ---------------------------------------------------------------------------
// ControlDO — one per plugin socket. Owns create/attach + forwards syncs.
// ---------------------------------------------------------------------------
export class ControlDO {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.attachId = undefined
    this.attachSecret = undefined
    this.attachOwner = null
    this.attachRoot = false
    this.attachTokenId = null
    this.attachTokenKind = null
    this.token = ""
    this.earlySyncs = [] // syncs that raced init (each webSocketMessage runs concurrently)
    this.earlyBytes = 0 // byte budget beside the count cap (OOM guard)
    this.initSeen = false // first exchange (init/attach) authenticates itself; revalidation is for long-lived sockets
  }

  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/control-ws" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      this.token = url.searchParams.get("token") ?? ""
      const pair = new WebSocketPair()
      this.state.acceptWebSocket(pair[1], ["control"])
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    return new Response("nf", { status: 404 })
  }

  // Hibernation: workerd evicts this DO between socket messages and
  // re-creates the class instance — in-memory attachId does NOT survive.
  // Restore it from storage before handling any frame, or every post-
  // eviction sync lands in "unknown op" (live-caught: shares stuck on
  // "live" with data loss mid-session).
  async restoreAttach() {
    if (this.attachId !== undefined) return
    try {
      const saved = await this.state.storage.get("attach")
      if (saved) {
        this.attachId = saved.id
        this.attachSecret = saved.secret
        this.attachOwner = saved.ownerId ?? null
        this.attachRoot = !!saved.root
        this.attachTokenId = saved.tokenId ?? null
        this.attachTokenKind = saved.tokenKind ?? null
      }
    } catch {}
  }

  /** AuthDO RPC from inside the socket lifecycle. */
  async authCall(route, body) {
    const r = await this.env.AUTH_DO.get(this.env.AUTH_DO.idFromName("singleton")).fetch("https://auth" + route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    })
    return r.json()
  }

  /** Resolve the socket's bearer token to {ownerId, root, tokenId, tokenKind}. */
  async socketIdentity() {
    const t = this.token ?? ""
    if (t && this.env.CREATE_TOKEN && t === this.env.CREATE_TOKEN) return { ownerId: null, root: true }
    if (!t) return { ownerId: null, root: false }
    const chk = await this.authCall("/check", { token: t })
    return chk.kind === "user"
      ? { ownerId: chk.userId, root: false, tokenId: chk.tokenId, tokenKind: chk.tokenKind === "scoped" ? "scoped" : "full", ttlMaxHours: chk.ttlMaxHours ?? 0 }
      : { ownerId: null, root: false }
  }

  /** Credential fields for ShareDO control calls (secret XOR owner XOR root).
   * tokenId/tokenKind: the write gate lets a SCOPED token touch only the
   * shares it created; FULL tokens (absent kind) reach all owner shares. */
  attachBody() {
    return { secret: this.attachSecret ?? "", ownerId: this.attachOwner ?? null, root: !!this.attachRoot, tokenId: this.attachTokenId, tokenKind: this.attachTokenKind }
  }

  async saveAttach(id, secret, ownerId = null, root = false, tokenId = null, tokenKind = null) {
    this.attachId = id
    this.attachSecret = secret
    this.attachOwner = ownerId
    this.attachRoot = root
    this.attachTokenId = tokenId
    this.attachTokenKind = tokenKind
    try {
      await this.state.storage.put("attach", { id, secret, ownerId, root, tokenId, tokenKind })
    } catch {}
  }

  async clearAttach() {
    this.attachId = undefined
    this.attachSecret = undefined
    this.attachOwner = null
    this.attachRoot = false
    this.attachTokenId = null
    this.attachTokenKind = null
    this.earlySyncs = []
    this.earlyBytes = 0
    try {
      await this.state.storage.delete("attach")
    } catch {}
  }

  /** Replay syncs that arrived while init was still talking to the
   * ShareDO (concurrent webSocketMessage invocations). */
  async flushEarlySyncs(send) {
    const queued = this.earlySyncs
    const queuedBytes = this.earlyBytes
    this.earlySyncs = []
    this.earlyBytes = 0
    for (const frame of queued) {
      if (this.attachId === undefined) {
        // init never landed: restore the buffer (bytes included) — the
        // next flush attempt replays them
        this.earlySyncs = queued
        this.earlyBytes = queuedBytes
        return
      }
      try {
        const r = await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(this.attachId)).fetch("https://do/sync", {
          method: "POST",
          body: JSON.stringify({ ...this.attachBody(), data: frame.items ?? [], status: frame.status }),
        })
        const body = await r.json()
        send({ op: body.ok ? "ack" : "nack", ...body, seq: frame.seq })
      } catch {}
    }
  }

  async webSocketMessage(ws, message) {
    const send = (obj) => {
      try { ws.send(JSON.stringify(obj)) } catch {}
    }
    try {
      await this.restoreAttach()
      const frame = JSON.parse(message)

      // frame auth: /health advertises frameAuth; a plugin that wants the
      // token off the query string (proxy logs) opens the socket empty and
      // sends {op:"auth", token} as the first frame. Query token still
      // works (backward compat with older plugins).
      if (frame.op === "auth") {
        this.token = typeof frame.token === "string" ? frame.token : ""
        return send({ op: "authed", ok: true })
      }

      // revocation latency: a revoked/rotated/frozen token would otherwise
      // keep its authority for the life of an open socket. Re-validate the
      // bearer every 5 minutes on ESTABLISHED sockets only — the first
      // exchange (init create/attach) authenticates and answers itself
      // (e.g. frozen attach replies init ok:false, not a bare error).
      // LIMIT: this is in-memory state — after a hibernation eviction the
      // recreated instance has no token to re-check (the stored attach
      // grant still authorizes writes; freeze still severs via meta.frozen
      // because the ShareDO gate checks it). Shallow by design: full
      // post-eviction revalidation would need the token persisted per
      // socket, which trades one secret-at-rest copy for another.
      if (this.initSeen && this.token && Date.now() - (this.tokenCheckedAt ?? 0) > 300000) {
        this.tokenCheckedAt = Date.now()
        const chk = await this.authCall("/check", { token: this.token })
        const isRoot = this.token === this.env.CREATE_TOKEN
        if (!isRoot && chk.kind !== "user") {
          send({ op: "error", error: "token no longer valid" })
          try { ws.close(4003, "token invalid") } catch {}
          return
        }
      }
      if (frame.op === "init") {
        this.initSeen = true
        if (frame.create) {
          // identity: root bootstrap (ownerless), user token (owned,
          // limits enforced server-side), or anonymous on public servers
          let ownerId = null
          let ttlMax = 0
          let ownerDefault = 0
          let creatorTokenId = null
          let creatorTokenKind = null
          if (!(this.token && this.env.CREATE_TOKEN && this.token === this.env.CREATE_TOKEN)) {
            const chk = await this.authCall("/create-check", { token: this.token ?? "", ...(frame.create.set ? { set: frame.create.set } : {}) })
            if (!chk.ok) return send({ op: "init", ok: false, error: chk.error })
            ownerId = chk.userId ?? null
            ttlMax = chk.ttlMaxHours ?? 0
            ownerDefault = chk.defaultTtlHours ?? 0
            creatorTokenId = chk.tokenId ?? null
            creatorTokenKind = chk.tokenKind ?? null
            // B4 Class A: the token's provisioned set overrides the
            // client's values (hoster policy - the client can still
            // change them later through the normal owner paths)
            if (chk.setA) {
              if (chk.setA.authLogin !== undefined) { frame.create.authLogin = chk.setA.authLogin; frame.create.authPassword = chk.setA.authPassword ?? "" }
              if (chk.setA.ttlHours !== undefined) frame.create.ttlHours = chk.setA.ttlHours
              else if (chk.setA.ttlDays !== undefined) frame.create.ttlDays = chk.setA.ttlDays
            }
          }
          const id = randomId()
          // explicit ttlHours wins (legacy ttlDays converts); otherwise
          // the owner's stored default, re-clamped against token+server
          const ttlHours = clampTtlHours(ttlHoursFrom(frame.create) ?? (ownerDefault || undefined), this.env, ttlMax)
          // free-form labels from the plugin config (B5): string-to-string,
          // capped, stored under meta.custom and shown in admin listings
          const custom = {}
          if (frame.create.meta && typeof frame.create.meta === "object") {
            let n = 0
            for (const [mk, mv] of Object.entries(frame.create.meta)) {
              if (n >= 20) break
              if (typeof mk === "string" && typeof mv === "string" && mk.length <= 64 && mv.length <= 500) {
                custom[mk] = mv
                n++
              }
            }
          }
          const r = await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(id)).fetch("https://do/init", {
            method: "POST",
            body: JSON.stringify({
              id,
              sessionID: frame.create.sessionID,
              ttlHours,
              authLogin: frame.create.authLogin ?? "",
              authPassword: frame.create.authPassword ?? "",
              ownerId,
              ...(creatorTokenId ? { creatorTokenId } : {}),
              ...(Object.keys(custom).length ? { custom } : {}),
            }),
          })
          const body = await r.json()
          if (!body.ok) return send({ op: "init", ok: false, error: body.error })
          if (ownerId) await this.authCall("/register", { userId: ownerId, shareId: id, sessionID: frame.create.sessionID, ...(creatorTokenId ? { tokenId: creatorTokenId } : {}) })
          await this.saveAttach(id, body.secret, ownerId, false, creatorTokenId, creatorTokenKind)
          await this.flushEarlySyncs(send)
          // auth mirrors what we just sent (the DO builds a gate only
          // from a full non-empty pair)
          return send({ op: "init", ok: true, id, secret: body.secret, rev: 0, status: "live", ttlHours, policy: resolvePolicy(this.env), auth: !!(frame.create.authLogin && frame.create.authPassword) })
        }
        if (frame.attach) {
          const ident = await this.socketIdentity()
          // explicit per-session TTL override changing mid-life: clamp it
          // exactly like create (server cap + the token's maxTtlDays).
          // ident already resolved the token's limits - no create-check
          // here (it burns a daily-create slot)
          let attachTtl
          const rawHours = ttlHoursFrom(frame.attach)
          if (rawHours !== undefined) {
            attachTtl = clampTtlHours(rawHours, this.env, ident.ttlMaxHours ?? 0)
          }
          const r = await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(frame.attach.id)).fetch("https://do/attach", {
            method: "POST",
            body: JSON.stringify({
              secret: frame.attach.secret ?? "",
              ownerId: ident.ownerId,
              root: ident.root,
              tokenId: ident.tokenId,
              tokenKind: ident.tokenKind,
              authLogin: frame.attach.authLogin,
              authPassword: frame.attach.authPassword,
              ...(attachTtl ? { ttlHours: attachTtl } : {}),
            }),
          })
        const body = await r.json()
        if (!body.ok) return send({ op: "init", ok: false, error: body.error })
        await this.saveAttach(frame.attach.id, frame.attach.secret, ident.ownerId, ident.root, ident.tokenId, ident.tokenKind)
        await this.flushEarlySyncs(send)
        return send({
            op: "init",
            ok: true,
            id: frame.attach.id,
            secret: this.attachSecret,
            rev: body.rev,
            status: body.status,
            // no `data` payload: the only ControlDO client is the plugin,
            // which backfills from the host and ignores attach data
            policy: resolvePolicy(this.env),
            // resolved gate state AFTER the attach applied any update -
            // the plugin warns when it asked for a gate and none exists
            auth: body.auth === true,
          })
        }
        return send({ op: "init", ok: false, error: "init needs create|attach" })
      }

      if (frame.op === "sync") {
        if (!this.attachId) {
          // a sync raced our init (webSocketMessage invocations run
          // concurrently; the init's ShareDO round-trip is in flight).
          // Buffer it — the init completion flushes in order. The cap is
          // high enough that a full backfill burst fits (frames are
          // chunk-sized client-side); if it ever overflows, error the
          // socket so the plugin reconnects and replays from its spool
          // instead of silently dropping the frame. Byte budget beside
          // the count: 1000 × 512KB frames would OOM a 128MB isolate
          // long before the count trips (audit N10).
          const frameBytes = String(message).length
          if (this.earlySyncs.length < 1000 && this.earlyBytes + frameBytes < 8_000_000) {
            this.earlySyncs.push(frame)
            this.earlyBytes += frameBytes
          } else {
            send({ op: "error", error: "early-sync buffer full" })
            try { ws.close(4004, "early-sync overflow") } catch {}
          }
          return
        }
        const r = await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(this.attachId)).fetch("https://do/sync", {
          method: "POST",
          body: JSON.stringify({ ...this.attachBody(), data: frame.items ?? [], status: frame.status }),
        })
        const body = await r.json()
        // echo the client frame seq: the plugin tracks pending per-chunk
        // and clears exactly what was acked (an ack without seq — old
        // server — keeps the legacy clear-all behavior client-side)
        return send({ op: body.ok ? "ack" : "nack", ...body, seq: frame.seq })
      }

      if (frame.op === "delete" && this.attachId) {
        await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(this.attachId)).fetch("https://do/remove", {
          method: "POST",
          body: JSON.stringify(this.attachBody()),
        })
        await this.clearAttach()
        return send({ op: "deleted" })
      }

      send({ op: "error", error: "unknown op" })
    } catch (e) {
      send({ op: "error", error: e?.message || String(e) })
    }
  }

  async webSocketClose() {
    // plugin vanished without a delete: arm the finalize clock on the
    // share (no-op when the socket already settled to completed/error —
    // graceful exits flush BEFORE closing). Reconnect within the window
    // cancels it; the sweeper backstops silent deaths.
    try {
      await this.restoreAttach()
      if (this.attachId !== undefined) {
        await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(this.attachId)).fetch("https://do/plugin-gone", { method: "POST" })
      }
    } catch {}
    // This DO is per-socket (newUniqueId per /api/ws) — after the socket
    // dies nothing can ever address it again, but its storage (including
    // the attach secret copy) is billed forever. Drop it all; new
    // connections get fresh DOs by design.
    try {
      await this.state.storage.deleteAll()
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// ShareDO — one per share: items, rev, status, auth, viewer sockets.
//
// Item storage is sharded: one storage key per item ("i:<itemKey>", e.g.
// "i:part/msg_x/prt_y"). The original single-blob layout ("items" key)
// hard-capped a share at 2 MB total (SQLite-backed DO value limit) and
// rewrote the whole map on every 200-item frame — big sessions could
// never persist and failed into reconnect loops. Shares written by the
// old layout migrate lazily on first touch. Each item is additionally
// fitted to ~1.5 MB (largest text fields clipped with a visible marker)
// so no single item can wedge the shard write. The full-share render for
// /data and the WS first frame is cached per rev in isolate memory —
// built once per revision while viewers keep loading it, dropped on any
// apply, no cost on the plugin sync path.
// ---------------------------------------------------------------------------
const MAX_ITEM_JSON = 1_500_000
const MAX_CACHE_JSON = 25_000_000

// Clip the largest string fields (deep) until the item fits the shard cap.
// The share is a view artifact, not a source of truth — a visible
// truncation marker beats a dead share. Falls back to a stub if the
// structure refuses to fit (in practice unreachable: halving ≥1024-char
// strings converges).
function fitItem(it) {
  let s = JSON.stringify(it)
  if (s.length <= MAX_ITEM_JSON) return it
  const clone = structuredClone(it)
  const clips = []
  const walk = (obj) => {
    if (!obj || typeof obj !== "object") return
    if (Array.isArray(obj)) { for (const v of obj) walk(v); return }
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && v.length > 1024) clips.push({ obj, key: k, len: v.length })
      else if (v && typeof v === "object") walk(v)
    }
  }
  walk(clone)
  clips.sort((a, b) => b.len - a.len)
  for (let round = 0; round < 4 && JSON.stringify(clone).length > MAX_ITEM_JSON; round++) {
    for (const c of clips) {
      c.obj[c.key] = c.obj[c.key].slice(0, Math.max(1024, Math.floor(c.obj[c.key].length / 2))) + "\n…[openshare: field truncated for share]"
      if (JSON.stringify(clone).length <= MAX_ITEM_JSON) break
    }
  }
  if (JSON.stringify(clone).length > MAX_ITEM_JSON) {
    return { type: it.type, sessionID: it.sessionID, data: { id: it.data?.id }, _oshDropped: "oversize" }
  }
  clone._oshTruncated = true
  return clone
}

export class ShareDO {
  constructor(state, env) {
    this.state = state
    this.env = env
    this._cache = null // { rev, status, frameStr, dataStr } — per-isolate, per-rev
  }

  async listPrefix(prefix) {
    const out = []
    let cursor
    do {
      const page = await this.state.storage.list({ prefix, cursor })
      for (const [, v] of page) out.push(v)
      // pagination metadata is listComplete in the workers types; some
      // builds expose snake_case — accept both so big lists never
      // silently truncate at the 128-key page boundary
      const complete = page.listComplete ?? page.list_complete
      cursor = complete ? undefined : page.cursor
    } while (cursor)
    return out
  }

  // All items in storage, migrating a legacy single-blob share on first
  // touch. DO requests are serialized by input gates, so the read-shard-
  // write-delete migration can't interleave with a concurrent apply.
  async loadItems() {
    const legacy = await this.state.storage.get("items")
    if (legacy !== undefined) {
      const map = new Map()
      for (const [k, v] of Object.entries(legacy)) map.set("i:" + k, v)
      await putBatched(this.state.storage, map)
      await this.state.storage.delete("items")
      this._cache = null
    }
    // unwrap the {r, i} / {d, i} storage envelope: full renders see live
    // items only — delete markers are invisible here and re-emitted as
    // tombstones by the delta reader. Bare values are pre-envelope items
    // (legacy migration) and pass through.
    const out = []
    for (const v of await this.listPrefix("i:")) {
      if (v && typeof v === "object" && v.d === 1) continue
      if (v && typeof v === "object" && v.i !== undefined && v.r !== undefined) out.push(v.i)
      else out.push(v)
    }
    return out
  }

  /** Items changed since a rev (poll delta): every `i:` row with a newer
   * rev, tombstones included — a hard delete would be invisible to the
   * filter and undone content would resurrect until a full reload. */
  async itemsSince(since) {
    const out = []
    let cursor
    do {
      const page = await this.state.storage.list({ prefix: "i:", cursor })
      for (const v of page.values()) {
        if (v && typeof v === "object" && v.i !== undefined && v.r !== undefined) {
          if ((v.r ?? 0) > since) out.push(v.i)
        } else if (since < 1) {
          out.push(v) // legacy unwrapped row: only visible to rev-0 readers
        }
      }
      // pagination metadata: accept both spellings — a runtime exposing
      // only one silently truncates at the first page (the H5 sweeper
      // class; listPrefix guards the same way)
      const complete = page.listComplete ?? page.list_complete
      cursor = complete ? undefined : page.cursor
    } while (cursor)
    return out
  }

  // Per-rev render cache for viewer loads. Both payload shapes build once
  // per revision; oversized shares (>25 MB) skip caching and re-render.
  async renderCache(meta) {
    const rev = meta.rev ?? 0
    if (this._cache && this._cache.rev === rev && this._cache.status === meta.status) return this._cache
    const items = redactItems(await this.loadItems())
    // serialize the items ONCE and build both envelopes by concatenation —
    // two full serializations held two copies of the same body in isolate
    // memory (up to 2×25MB per ShareDO) and doubled the rebuild CPU
    const body = JSON.stringify(items)
    const frameStr = `{"v":2,"op":"frame","status":${JSON.stringify(meta.status)},"rev":${rev},"items":${body}}`
    const dataStr = `{"v":2,"data":${body},"status":${JSON.stringify(meta.status)},"rev":${rev}}`
    // authenticated variant: the private block (per-session machine facts)
    // rides the envelope tail; built by SPLICING before the final brace so
    // the shared body serialization is paid once
    const privJson = meta.private && Object.keys(meta.private).length ? JSON.stringify(meta.private).slice(1, -1) : ""
    const privData = privJson ? dataStr.slice(0, -1) + `,"private":{${privJson}}}` : dataStr
    // snapshot island: the boot payload a frozen HTML file feeds the viewer
    // with (`window.__MIRROBOT_SNAPSHOT__`). `<` is escaped so no string in
    // the share data can terminate the host <script> element early.
    const islandStr = JSON.stringify(items).replace(/</g, "\\u003c")
    if (frameStr.length <= MAX_CACHE_JSON) {
      this._cache = { rev, status: meta.status, frameStr, dataStr, privData, islandBody: islandStr, privJson }
      return this._cache
    }
    return { rev, status: meta.status, frameStr, dataStr, privData, islandBody: islandStr, privJson }
  }

  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname
    const json = (code, body) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } })

    if (path === "/ws" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const meta = await this.state.storage.get("meta")
      if (!meta) return new Response("gone", { status: 404 })
      if (meta.auth) {
        // browsers authenticate the WS with the session cookie
        const token = (req.headers.get("cookie") ?? "").split(";")
          .map((c) => c.trim().split("="))
          .filter(([k]) => k === `osh_${this.state.id.name}`)
          .map(([, ...v]) => v.join("="))[0] ?? ""
        if (!(await this.validToken(token))) return new Response("auth required", { status: 401 })
      }
      const pair = new WebSocketPair()
      this.state.acceptWebSocket(pair[1], ["viewer"])
      try {
        // `since` handshake: a viewer that just loaded /data at rev N
        // doesn't need the full first frame again. Cases (delta frames
        // only for clients that ANNOUNCED capability — an old cached
        // bundle treats any non-empty first frame as the full set and
        // would prune everything not in a delta):
        //   since === rev  -> empty frame (nothing changed; poll parity)
        //   since < rev, delta=1 -> DELTA frame (only items touched
        //                     since, tombstone markers re-emitted) — a
        //                     reconnect no longer re-transfers the whole
        //                     share and re-folds every item viewer-side
        //   else (no delta, or since > rev) -> FULL frame — since > rev
        //                     means the server rewound/recreated and the
        //                     viewer MUST prune what no longer exists
        const sinceRaw = url.searchParams.get("since")
        const since = sinceRaw === null ? NaN : Number(sinceRaw)
        const wantsDelta = url.searchParams.get("delta") === "1"
        const meta2 = meta
        const rev = meta2.rev ?? 0
        if (Number.isFinite(since) && since === rev) {
          pair[1].send(JSON.stringify({ op: "frame", rev, status: meta2.status, items: [] }))
        } else if (wantsDelta && Number.isFinite(since) && since >= 0 && since < rev) {
          const delta = redactItems(await this.itemsSince(since))
          pair[1].send(JSON.stringify({ op: "frame", rev, status: meta2.status, items: delta, kind: "delta" }))
        } else {
          // the upgrade 401s unauthenticated viewers on gated shares, so a
          // gate here means share auth is satisfied: first frame carries
          // the private block
          if (meta.auth) {
            pair[1].send((await this.renderCache(meta)).frameStr.slice(0, -1) + `,"private":${JSON.stringify(meta.private ?? {})}}`)
          } else {
            pair[1].send((await this.renderCache(meta)).frameStr)
          }
        }
      } catch {}
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    if (path === "/init" && req.method === "POST") {
      const body = await req.json()
      if (!body?.id || !body?.sessionID) return json(400, { ok: false, error: "id and sessionID required" })
      const secret = randomId() + randomId()
      const now = Date.now()
      const auth = body.authLogin && body.authPassword ? await this.makeAuth(body.authLogin, body.authPassword) : null
      await this.state.storage.put("meta", {
        secret,
        sessionID: body.sessionID,
        ttlHours: Number(body.ttlHours) > 0 ? Math.floor(Number(body.ttlHours)) : 90 * 24,
        createdAt: now,
        lastActive: now,
        pluginSeen: now,
        rev: 0,
        status: "live",
        ownerId: body.ownerId ?? null,
        frozen: false,
        auth,
        // which credential created this share (scoped-authority gate,
        // per-token listings, bulk freeze-by-token)
        creatorTokenId: body.creatorTokenId ?? null,
        // free-form labels from the plugin (B5), shown in admin listings
        custom: body.custom && typeof body.custom === "object" ? body.custom : {},
        tokens: [],
        attempts: { ips: {}, total: 0, lockUntil: 0 },
      })
      try {
        // record rides in KV key METADATA — list() returns it inline, so
        // the admin shares view needs no per-key get (KV N+1)
        await this.env.SHARE_INDEX.put(`share:${body.id}`, "", {
          metadata: { createdAt: now, sessionID: body.sessionID, ownerId: body.ownerId ?? null, custom: kvCustom(body.custom) },
        })
        await this.env.SWEEPER.get(this.env.SWEEPER.idFromName("singleton")).fetch("https://sweeper/arm", { method: "POST" })
      } catch (e) {
        // KV write failed: without the index key the share is invisible to
        // purge AND the TTL sweeper (permanent orphan). Arm our own alarm
        // to retry the put until it lands (alarm() checks indexRetry).
        console.log("[init] index error (will retry)", e?.message || e)
        await this.state.storage.put("indexRetry", { id: body.id, sessionID: body.sessionID, ownerId: body.ownerId ?? null, createdAt: now, custom: kvCustom(body.custom) })
        try {
          await this.state.storage.setAlarm(Date.now() + 5 * 60000)
        } catch {}
      }
      return json(200, { ok: true, id: body.id, secret })
    }

    if (path === "/attach" && req.method === "POST") {
      const body = await req.json()
      const meta = await this.state.storage.get("meta")
      if (!meta) return json(404, { ok: false, error: "share not found" })
      const gate = this.writeGate(meta, body)
      if (gate) return json(403, { ok: false, error: gate })

      // plugin is alive: cancel any pending finalize and note the contact.
      // ORDER MATTERS: persist pluginSeen BEFORE touching the alarm — some
      // workerd builds throw on setAlarm(null), and a crash before the
      // put left pluginSeen stale, so the still-armed alarm later marked
      // healthy shares "interrupted" (live-caught by the auth suite: any
      // attach-after-drop failed its init entirely).
      meta.pluginSeen = Date.now()
      // attach = the plugin is actively here; keep TTL from expiring a
      // share out from under a live (if quiet) session
      meta.lastActive = Date.now()
      // a pending index-write retry must survive the finalize cancel —
      // the retry alarm needs to stay armed or the share stays invisible
      // to purge + TTL sweeps forever
      const pendingIndexRetry = await this.state.storage.get("indexRetry")
      const pendingFinalize = await this.state.storage.get("finalizeAt")
      if (pendingFinalize) {
        await this.state.storage.delete("finalizeAt")
        await this.state.storage.put("meta", meta)
        try {
          await this.state.storage.setAlarm(null)
        } catch {
          // this build rejects null: leave the alarm armed — /finalize's
          // pluginSeen freshness check makes the stale fire a no-op
        }
        if (pendingIndexRetry) {
          try { await this.state.storage.setAlarm(Date.now() + 5 * 60000) } catch {}
        }
      } else {
        await this.state.storage.put("meta", meta)
      }

      // resume retroactively applies/updates/clears the read gate
      if (body.authLogin !== undefined && body.authPassword !== undefined) {
        const wantAuth = body.authLogin && body.authPassword
        const sameAuth = wantAuth && meta.auth
          && meta.auth.loginHash === await pbkdf2(body.authLogin, meta.auth.salt)
          && meta.auth.passHash === await pbkdf2(body.authPassword, meta.auth.salt)
        if (wantAuth && !sameAuth) {
          meta.auth = await this.makeAuth(body.authLogin, body.authPassword)
          meta.tokens = [] // credentials changed: viewers re-login
          meta.attempts = { ips: {}, total: 0, lockUntil: 0 } // fresh lockout slate
          console.log("[attach] auth updated, tokens rotated")
        } else if (!wantAuth && meta.auth) {
          meta.auth = null
          console.log("[attach] auth removed (owner action)")
        }
        await this.state.storage.put("meta", meta)
      }

      // explicit per-session TTL override (clamped by the ControlDO against
      // server + token caps): rebase the sweeper deadline. Shortening can
      // legitimately end an old page at once - that is the owner's ask.
      if (Number.isFinite(Number(body.ttlHours)) && Number(body.ttlHours) > 0) {
        meta.ttlHours = Math.floor(Number(body.ttlHours))
        await this.state.storage.put("meta", meta)
        console.log("[attach] ttl updated to", meta.ttlHours, "hours")
      }

      // no `data` payload: the plugin backfills from the host and never
      // reads attach data (full-set transfer per reconnect was pure
      // waste - Bun already strips it). `auth` reports the RESOLVED gate
      // state so the plugin can tell a half-pair no-op from a live gate
      // (B2: ack-level gate assurance).
      return json(200, {
        ok: true,
        rev: meta.rev ?? 0,
        status: meta.status,
        sessionID: meta.sessionID,
        auth: !!meta.auth,
      })
    }

    // REST opts editor (#13): PATCH /api/share/:id forwards here after
    // identity resolution. Mirrors the attach-sync mutations (auth
    // rotate/removal, TTL rebase) plus custom-label updates (the KV
    // index record carries them for admin listings).
    if (path === "/set-opts" && req.method === "POST") {
      const body = await req.json()
      const meta = await this.state.storage.get("meta")
      if (!meta) return json(404, { ok: false, error: "share not found" })
      const gate = this.writeGate(meta, body)
      if (gate) return json(403, { ok: false, error: gate })
      if (body.authLogin !== undefined && body.authPassword !== undefined) {
        const wantAuth = body.authLogin && body.authPassword
        const sameAuth = wantAuth && meta.auth
          && meta.auth.loginHash === await pbkdf2(body.authLogin, meta.auth.salt)
          && meta.auth.passHash === await pbkdf2(body.authPassword, meta.auth.salt)
        if (wantAuth && !sameAuth) {
          meta.auth = await this.makeAuth(body.authLogin, body.authPassword)
          meta.tokens = []
          meta.attempts = { ips: {}, total: 0, lockUntil: 0 }
          console.log("[set-opts] auth updated, tokens rotated")
        } else if (!wantAuth && meta.auth) {
          meta.auth = null
          console.log("[set-opts] auth removed (owner action)")
        }
      }
      if (Number.isFinite(Number(body.ttlHours)) && Number(body.ttlHours) > 0) {
        meta.ttlHours = Math.floor(Number(body.ttlHours))
        console.log("[set-opts] ttl updated to", meta.ttlHours, "hours")
      }
      if (body.custom !== undefined) meta.custom = body.custom ?? {}
      await this.state.storage.put("meta", meta)
      // keep the KV index record honest when labels changed
      if (body.custom !== undefined) {
        try {
          await this.env.SHARE_INDEX.put(`share:${this.state.id.name}`, "", {
            metadata: { createdAt: meta.createdAt, sessionID: meta.sessionID, ownerId: meta.ownerId, creatorTokenId: meta.creatorTokenId ?? null, custom: kvCustom(meta.custom) },
          })
        } catch {}
      }
      return json(200, { ok: true, ttlHours: meta.ttlHours ?? Math.floor((meta.ttlDays ?? 90) * 24), auth: !!meta.auth, custom: meta.custom ?? {} })
    }

    if (path === "/auth" && req.method === "POST") {
      const body = await req.json()
      const ip = req.headers.get("x-ip") ?? "unknown"
      const meta = await this.state.storage.get("meta")
      if (!meta) return json(404, { ok: false, error: "share not found" })
      if (!meta.auth) return json(200, { ok: true, note: "no auth required" })

      const now = Date.now()
      const attempts = meta.attempts ?? { ips: {}, total: 0, lockUntil: 0 }
      const ipState = attempts.ips[ip] ?? { fails: 0, lockUntil: 0, streak: 0 }
      attempts.ips[ip] = ipState

      const lockedFor = Math.max(ipState.lockUntil - now, attempts.lockUntil - now)
      if (lockedFor > 0) {
        return json(429, { ok: false, error: "locked", retryAfterMs: lockedFor })
      }

      const [loginHash, passHash] = await Promise.all([
        pbkdf2(body.login ?? "", meta.auth.salt),
        pbkdf2(body.password ?? "", meta.auth.salt),
      ])
      if (loginHash !== meta.auth.loginHash || passHash !== meta.auth.passHash) {
        ipState.fails += 1
        ipState.streak += 1
        ipState.at = now
        attempts.total += 1
        if (ipState.fails >= 5) {
          ipState.lockUntil = now + Math.min(60000 * 2 ** (ipState.streak - 5), 86400000)
          ipState.fails = 0
        }
        if (attempts.total >= 20) attempts.lockUntil = now + 86400000
        // bound the tracker: a distributed probe must not grow meta (the
        // 2 MB storage cap would eventually wedge the whole share) — keep
        // the 100 most recent source IPs
        const ips = Object.entries(attempts.ips)
        if (ips.length > 100) {
          ips.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
          attempts.ips = Object.fromEntries(ips.slice(0, 100))
        }
        meta.attempts = attempts
        await this.state.storage.put("meta", meta)
        const retryAfterMs = Math.max(ipState.lockUntil - now, attempts.lockUntil - now, 0)
        return json(401, { ok: false, error: "wrong credentials", retryAfterMs })
      }

      // success: reset this IP, mint a session token (max 5, LRU)
      delete attempts.ips[ip]
      attempts.total = Math.max(0, attempts.total - 1)
      // a global lock that has fully elapsed no longer counts: without
      // this, one failure per day kept the share read-locked forever
      if (attempts.lockUntil && attempts.lockUntil <= now) {
        attempts.lockUntil = 0
        attempts.total = 0
      }
      const token = randomId() + randomId()
      const tokens = [{ token, expires: now + 7 * 86400000 }, ...(meta.tokens ?? [])].slice(0, 5)
      meta.tokens = tokens
      meta.attempts = attempts
      await this.state.storage.put("meta", meta)
      const cookie = `osh_${this.state.id.name}=${token}; Path=/; Max-Age=${7 * 86400}; HttpOnly; Secure; SameSite=Lax`
      // the router translates this into a real Set-Cookie header
      return json(200, { setCookie: cookie, body: { ok: true } })
    }

    if ((path === "/sync" || path === "/sync-ws") && req.method === "POST") {
      const body = await req.json()
      const r = await this.apply(body)
      return json(r[0], r[1])
    }

    if (path === "/data") {
      const meta = await this.state.storage.get("meta")
      if (!meta) return json(404, { data: [], status: "gone", rev: 0 })
      if (meta.auth && !(await this.validToken(url.searchParams.get("token") ?? ""))) {
        return json(401, { authRequired: true })
      }
      // `since` handshake for the poll path (same shape as the WS):
      // unchanged rev answers an empty set; a CHANGED rev answers only
      // the items touched since — a polling viewer stops re-transferring
      // the whole share every 5s. NOTE: only when the caller actually
      // PASSED since (Number(null) is 0, which would collide with a
      // fresh share's rev 0)
      const sinceRaw = url.searchParams.get("since")
      if (sinceRaw !== null) {
        const since = Number(sinceRaw)
        if (Number.isFinite(since)) {
          if (since === (meta.rev ?? 0)) {
            return json(200, { v: 2, data: [], status: meta.status, rev: meta.rev ?? 0 })
          }
          return json(200, { v: 2, data: redactItems(await this.itemsSince(since)), status: meta.status, rev: meta.rev ?? 0 })
        }
      }
      // a gated share 401s unauthenticated readers above, so reaching here
      // on a gated share means share auth IS satisfied: serve the private
      // block (machine-local facts) to exactly these readers
      return new Response((await this.renderCache(meta))[meta.auth ? "privData" : "dataStr"], { status: 200, headers: { "content-type": "application/json" } })
    }

    if (path === "/snapshot") {
      const meta = await this.state.storage.get("meta")
      if (!meta) return json(404, { error: "gone" })
      if (meta.auth && !(await this.validToken(url.searchParams.get("token") ?? ""))) {
        return json(401, { authRequired: true })
      }
      const cache = await this.renderCache(meta)
      const items = await this.loadItems()
      // root session = the session item without a parent (children of
      // subagent calls carry parentID); fallback to the first session
      let sessionID = ""
      for (const it of items) {
        if (it.type === "session" && it.data && !it.data.parentID) { sessionID = it.data.id ?? ""; break }
      }
      if (!sessionID) {
        const s = items.find((i) => i.type === "session")
        sessionID = s?.data?.id ?? ""
      }
      // island assembled by concatenation; the body serialization is paid
      // once inside renderCache. Gated shares reaching here are already
      // authenticated, so the private block always rides the island.
      const island = `{"items":${cache.islandBody},"status":${JSON.stringify(meta.status)},"rev":${meta.rev ?? 0},"sessionID":${JSON.stringify(sessionID)}${cache.privJson ? `,"private":{${cache.privJson}}` : ""},"branding":${JSON.stringify(resolveBrandingObj(this.env))}}`
      return json(200, { ok: true, island, status: meta.status, rev: meta.rev ?? 0, sessionID })
    }

    if (path === "/og") {
      // per-share embed meta for crawlers: title/stat line only for
      // UNGATED shares (a link preview must not leak what a gated share
      // contains — those answer gated:true and the card stays generic)
      const meta = await this.state.storage.get("meta")
      if (!meta) return json(404, { ok: false })
      const rev = meta.rev ?? 0
      if (meta.auth) return json(200, { ok: true, gated: true, status: meta.status, rev })
      const items = redactItems(await this.loadItems())
      let rootId = ""
      for (const it of items) if (it.type === "session" && it.data && !it.data.parentID) { rootId = it.data.id ?? ""; break }
      let title = ""
      let turns = 0
      let tools = 0
      let first = 0
      let last = 0
      let model = ""
      for (const it of items) {
        if (it.type === "session" && it.data && it.data.id === rootId) title = it.data.title ?? title
        if (it.type === "model" && it.sessionID === rootId && !model) model = it.data?.name ?? ""
        if (it.type !== "message" || (rootId && it.sessionID !== rootId)) continue
        const d = it.data ?? {}
        const c = d.time?.created ?? 0
        if (c) {
          if (!first || c < first) first = c
          if (c > last) last = c
        }
        if (d.type === "user") turns++
        if (d.type === "assistant" && Array.isArray(d.content)) {
          for (const part of d.content) if (part?.type === "tool") tools++
        }
      }
      return json(200, { ok: true, gated: false, title: title || "shared session", status: meta.status, rev, stats: { turns, tools, durationMs: first && last ? last - first : 0, model } })
    }

    if (path === "/meta" && req.method === "GET") {
      const meta = await this.state.storage.get("meta")
      if (!meta) return json(404, { error: "not found" })
      const { secret, auth, tokens, pluginSeen, ...rest } = meta
      return json(200, { ...rest, auth: auth ? { set: true } : null, tokens: tokens?.length ?? 0, pluginSeen: pluginSeen ?? 0 })
    }

    if (path === "/plugin-gone" && req.method === "POST") {
      // ControlDO socket close: the plugin vanished without a goodbye.
      // Arm a DO alarm (survives eviction, unlike timers); the plugin
      // reconnecting cancels it via /attach. No-op for already-settled
      // shares — graceful exits flush completed/error BEFORE closing.
      const meta = await this.state.storage.get("meta")
      if (!meta) return json(404, { ok: true })
      if (meta.status !== "live") return json(200, { ok: true, note: "settled" })
      const after = resolvePolicy(this.env).finalizeAfterMs
      if (after <= 0) return json(200, { ok: true, note: "finalize disabled" })
      const at = Date.now() + after
      await this.state.storage.put("finalizeAt", at)
      const cur = await this.state.storage.getAlarm()
      if (cur === null || cur > at) await this.state.storage.setAlarm(at)
      return json(200, { ok: true, finalizeAt: at })
    }

    if (path === "/finalize" && req.method === "POST") {
      // settle-as-interrupted if the plugin is still gone and still live;
      // called by the alarm and by the sweeper's backstop pass
      const meta = await this.state.storage.get("meta")
      if (!meta) return json(404, { ok: true })
      await this.state.storage.delete("finalizeAt")
      if (meta.status !== "live") return json(200, { ok: true, note: "settled" })
      const after = resolvePolicy(this.env).finalizeAfterMs
      if ((meta.pluginSeen ?? meta.createdAt ?? 0) + after > Date.now()) {
        return json(200, { ok: true, note: "plugin alive recently" })
      }
      meta.status = "interrupted"
      meta.rev = (meta.rev ?? 0) + 1
      await this.state.storage.put("meta", meta)
      await this.broadcast({ op: "frame", status: "interrupted", rev: meta.rev, items: [] })
      console.log("[finalize] share interrupted:", this.state.id.name)
      return json(200, { ok: true, status: "interrupted" })
    }

    if (path === "/remove" && req.method === "POST") {
      const body = await req.json()
      const meta = await this.state.storage.get("meta")
      if (!meta) return json(404, { ok: true })
      const gate = this.writeGate(meta, body)
      if (gate) return json(403, { ok: false, error: gate })
      await this.unregister(meta)
      try { await this.env.SHARE_INDEX.delete(`share:${this.state.id.name}`) } catch {}
      await this.broadcast({ op: "frame", status: "gone", rev: (meta.rev ?? 0) + 1, items: [] })
      await this.state.storage.deleteAll()
      return json(200, { ok: true })
    }

    if (path === "/remove-all" && req.method === "POST") {
      // Internal-only (sweeper/admin): the public router never routes here.
      const meta = await this.state.storage.get("meta")
      if (meta) await this.unregister(meta)
      await this.broadcast({ op: "frame", status: "gone", rev: 1, items: [] })
      await this.state.storage.deleteAll()
      try { await this.env.SHARE_INDEX.delete(`share:${this.state.id.name}`) } catch {}
      return json(200, { ok: true })
    }

    // Internal (AuthDO fan-out): freeze/unfreeze a share's edits. Viewing
    // is unaffected - a frozen share is read-only until unfrozen or TTL.
    if (path === "/set-frozen" && req.method === "POST") {
      const body = await req.json()
      const meta = await this.state.storage.get("meta")
      if (!meta) return json(404, { ok: true })
      meta.frozen = !!body.frozen
      await this.state.storage.put("meta", meta)
      console.log("[set-frozen]", this.state.id.name, body.frozen ? "frozen" : "unfrozen")
      return json(200, { ok: true })
    }

    // Internal (AuthDO rotate): re-point a scoped token's share at its
    // successor so rotation never orphans the pages it created
    if (path === "/set-creator-token" && req.method === "POST") {
      const body = await req.json()
      const meta = await this.state.storage.get("meta")
      if (!meta) return json(404, { ok: true })
      meta.creatorTokenId = body.tokenId ?? null
      await this.state.storage.put("meta", meta)
      return json(200, { ok: true })
    }

    // Internal (AuthDO reassign): move ownership to another user; the
    // rescue path for lost identities also clears any freeze. Accepts
    // ownerId|userId (the AuthDO RPC sends {userId}).
    if (path === "/set-owner" && req.method === "POST") {
      const body = await req.json()
      const meta = await this.state.storage.get("meta")
      if (!meta) return json(404, { ok: false })
      meta.ownerId = body.ownerId ?? body.userId ?? null
      meta.frozen = false
      await this.state.storage.put("meta", meta)
      try {
        await this.env.SHARE_INDEX.put(`share:${this.state.id.name}`, "", { metadata: { createdAt: meta.createdAt, sessionID: meta.sessionID, ownerId: meta.ownerId, custom: kvCustom(meta.custom) } })
      } catch {}
      return json(200, { ok: true })
    }

    return json(404, { error: "not found" })
  }

  /** Write gate: per-share secret, owner token (ownerId resolved by the
   * caller from a validated user token — never client-asserted), or the
   * root bootstrap. A frozen owner rejects EVERY path, valid secret
   * included; viewing is never gated here. Returns "" or an error word. */
  writeGate(meta, body) {
    if (body?.root === true) return ""
    if (body?.secret && body.secret === meta.secret) return meta.frozen ? "frozen" : ""
    if (body?.ownerId && meta.ownerId && body.ownerId === meta.ownerId) {
      if (meta.frozen) return "frozen"
      // SCOPED tokens reach only the shares they created; FULL tokens
      // (absent kind = pre-2a caller) reach every owner share
      if (body.tokenKind === "scoped") return body.tokenId && body.tokenId === meta.creatorTokenId ? "" : "forbidden"
      return ""
    }
    return "forbidden"
  }

  /** Drop this share from its owner's registry (best-effort). */
  async unregister(meta) {
    if (!meta?.ownerId) return
    try {
      await this.env.AUTH_DO.get(this.env.AUTH_DO.idFromName("singleton")).fetch("https://auth/unregister", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shareId: this.state.id.name, userId: meta.ownerId }),
      })
    } catch {}
  }

  async makeAuth(login, password) {
    const salt = randomId() + randomId()
    const [loginHash, passHash] = await Promise.all([pbkdf2(login, salt), pbkdf2(password, salt)])
    return { salt, loginHash, passHash }
  }

  async validToken(token) {
    if (!token) return false
    const meta = await this.state.storage.get("meta")
    const now = Date.now()
    const tokens = (meta?.tokens ?? []).filter((t) => t.expires > now)
    const hit = tokens.find((t) => t.token === token)
    if (!hit) return false
    if (tokens.length !== (meta?.tokens ?? []).length) {
      meta.tokens = tokens
      await this.state.storage.put("meta", meta)
    }
    return true
  }

  async apply(body) {
    const meta = await this.state.storage.get("meta")
    if (!meta) return [404, { ok: false, error: "share not found" }]
    const gate = this.writeGate(meta, body)
    if (gate) return [gate === "frozen" ? 403 : 403, { ok: false, error: gate }]
    const rev = (meta.rev ?? 0) + 1
    // One op per key: first-arrival position, last-arrival action, so the
    // broadcast order can never contradict the storage last-wins result
    // (e.g. a frame holding [tombstone K, upsert K] must leave K live on
    // the viewer too, not delete it after re-upserting).
    // Storage shape: `i:<key>` = {r: rev, i: item} for live items and
    // {d:1, r: rev, i: tombstoneItem} for deletes — the rev stamps power
    // /data?since deltas (poll path), and delete MARKERS (not row
    // deletes) keep deletions visible to delta readers so an undone
    // message cannot resurrect for a polling viewer.
    const ops = new Map() // shard key -> { shard, it, del }
    // Wave 3 data-inventory split: pmeta items (machine-local facts:
    // directory/worktree) never become public item shards - they merge
    // into meta.private and reach only AUTHENTICATED viewers via the
    // envelope's private block. A pmeta tombstone drops that session's
    // entry. Storage stays capped (few hundred bytes per session).
    let privateDirty = false
    const priv = meta.private && typeof meta.private === "object" ? { ...meta.private } : {}
    const rest = []
    for (const raw of body.data ?? []) {
      const it = fitItem(raw)
      if (it?.type === "pmeta") {
        const sid = it.sessionID ?? it.data?.id ?? ""
        if (it.del) delete priv[sid]
        else if (sid && it.data && typeof it.data === "object") {
          const clean = {}
          for (const [k, v] of Object.entries(it.data)) {
            if (typeof v === "string" && v.length <= 512 && k.length <= 32) clean[k] = v
          }
          priv[sid] = clean
        }
        privateDirty = true
        continue
      }
      rest.push(it)
    }
    if (privateDirty) {
      meta.private = priv
      await this.state.storage.put("meta", meta)
    }
    for (const it of rest) {
      const key = itemKey(it)
      if (!key) continue
      const shard = "i:" + key
      const prev = ops.get(shard)
      if (prev) {
        prev.it = it
        prev.del = !!it.del
      } else {
        ops.set(shard, { shard, it, del: !!it.del })
      }
    }
    const puts = new Map()
    const hardDels = []
    const cascadePrefixes = []
    for (const op of ops.values()) {
      // both shapes carry the tombstone item: full renders skip d-rows,
      // delta readers re-emit the tombstone verbatim
      puts.set(op.shard, op.del ? { d: 1, r: rev, i: op.it } : { r: rev, i: op.it })
      if (op.del && op.it.type === "message" && op.it.data?.id) {
        // cascade ONLY on full-message deletes: opencode's cleanup removes
        // the message without per-part events, so its legacy v1 part
        // shards must not linger. Gating on del matters — an unconditional
        // cascade ran one storage.list per UPSERTED message too (200
        // sequential lists per backfill chunk, the dominant apply cost;
        // live-caught in the optimization audit)
        cascadePrefixes.push("i:part/" + op.it.data.id + "/")
      }
    }
    for (const prefix of cascadePrefixes) {
      let cursor
      do {
        const page = await this.state.storage.list({ prefix, cursor })
        for (const k of page.keys()) hardDels.push(k)
        cursor = page.list_complete ? undefined : page.cursor
      } while (cursor)
    }
    if (puts.size) await putBatched(this.state.storage, puts)
    if (hardDels.length) await deleteBatched(this.state.storage, hardDels)
    meta.rev = rev
    meta.lastActive = Date.now()
    meta.pluginSeen = Date.now()
    if (body.status && STATUSES.has(body.status)) meta.status = body.status
    this._cache = null // rev advanced: render cache is stale
    await this.state.storage.put("meta", meta)
    const batch = [...ops.values()].map((op) => op.it)
    await this.broadcast({ op: "frame", status: meta.status, rev, items: redactItems(batch) })
    return [200, { ok: true, rev, status: meta.status }]
  }

  async broadcast(frame) {
    // serialize ONCE per frame, send the same string to every socket —
    // per-socket stringify burned V× the CPU on every sync chunk (Bun
    // parity: its broadcast already stringifies once)
    const s = JSON.stringify({ v: 2, ...frame })
    for (const ws of this.state.getWebSockets("viewer")) {
      try { ws.send(s) } catch {}
    }
  }

  // finalize alarm: plugin gone without goodbye past the window
  async alarm() {
    // index-write retry (a failed KV index put at /init would otherwise
    // orphan the share from purge + TTL sweeps) — then finalize backstop;
    // both may be pending, so NO early return after the retry
    const retry = await this.state.storage.get("indexRetry")
    if (retry) {
      try {
        await this.env.SHARE_INDEX.put(`share:${retry.id}`, "", { metadata: { createdAt: retry.createdAt, sessionID: retry.sessionID, ownerId: retry.ownerId, custom: kvCustom(retry.custom) } })
        await this.env.SWEEPER.get(this.env.SWEEPER.idFromName("singleton")).fetch("https://sweeper/arm", { method: "POST" })
        await this.state.storage.delete("indexRetry")
      } catch {
        try { await this.state.storage.setAlarm(Date.now() + 30 * 60000) } catch {}
        return // retry still pending: finalize can wait for the next fire
      }
    }
    await this.fetch(new Request("https://do/finalize", { method: "POST" }))
  }

  async webSocketMessage() {}
  async webSocketClose() {}
}

const STATUSES = new Set(["live", "completed", "error", "interrupted"])

// DO storage ops cap at 128 keys per call — batch the shards.
// NOTE: per-key sequential puts, NOT put(Map): the Map form resolves ok
// but persists NOTHING in workerd 4.151/wrangler 4.151 local dev
// (empirically isolated via /data?dbg=put — direct put landed, Map-form
// entries vanished). Correctness over micro-batching, everywhere.
async function putBatched(storage, map) {
  for (const [k, v] of map) await storage.put(k, v)
}

async function deleteBatched(storage, keys) {
  for (let i = 0; i < keys.length; i += 128) {
    await storage.delete(keys.slice(i, i + 128))
  }
}

// Server-side key derivation — the client never decides its own key.
function itemKey(item) {
  if (!item || typeof item !== "object") return
  const t = item.type
  const d = item.data
  if (t === "session") return "session/" + (d?.id ?? "")
  if (t === "session_diff") return "session_diff/" + (item.sessionID ?? d?.sessionID ?? "")
  if (t === "message") return "message/" + (d?.id ?? "")
  if (t === "part") return "part/" + (d?.messageID ?? "") + "/" + (d?.id ?? "")
  if (t === "model") return "model/" + (item.sessionID ?? d?.sessionID ?? "")
  if (t === "prefs") return "prefs"
  return
}

// Session items never leave with their metadata (the plugin stores its
// share binding — incl. the write secret — in session metadata).
function redactItems(items) {
  return items.map((it) => {
    if (it?.type === "session" && it.data?.metadata) {
      const { metadata, ...rest } = it.data
      return { ...it, data: rest }
    }
    return it
  })
}

// ---------------------------------------------------------------------------
// AuthDO — singleton: users, tokens, enrollment codes, share registry.
//
// Model (see header): opaque user tokens "osk_…" stored SHA-256-hashed;
// enrollment via nothing (public) or an activation-budgeted code "osc_…"
// (private); every share records its owner; a frozen user's shares reject
// ALL edits (denormalized onto each ShareDO by fan-out). Admin = the root
// env CREATE_TOKEN only. All state lives in DO storage:
//   u:<userId>            {id,label,createdAt,frozen,settings}
//   uShares:<userId>      [{id,sessionID,createdAt}]  (share registry)
//   shareOwner:<shareId>  userId                     (reverse index)
//   t:<sha256(token)>     {id,hash,userId,label,limits,…}
//   c:<sha256(code)>      {id,hash,label,activationsLeft,…}
//   rl:<ip> / dc:<tokenId>:<day>   rate limit + daily create counters
// ---------------------------------------------------------------------------
export class AuthDO {
  constructor(state, env) {
    this.state = state
    this.env = env
    // single-writer serialization for read-modify-write flows (code
    // budgets, daily counters, rate limits): DO requests interleave at
    // every await, so two concurrent enrolls on a 1-activation code
    // could both pass the check before either decremented
    this.mu = Promise.resolve()
  }

  async withMu(fn) {
    const run = this.mu.then(() => fn())
    this.mu = run.catch(() => {})
    return run
  }

  /** Chunked fan-out continuation + daily hygiene. The fanoutQueue (a
   * LIST — several freezes/deletes may pend) processes 35 shares per run;
   * the hygiene pass deletes expired rate-limit keys (rl:), stale
   * daily-create counters (dc:), and long-revoked token rows so the
   * singleton's storage stays bounded. */
  async alarm() {
    const queue = await this.state.storage.get("fanoutQueue")
    if (Array.isArray(queue) && queue.length) {
      const job = queue[0]
      const batch = job.shareIds.slice(0, 35)
      job.shareIds = job.shareIds.slice(35)
      if (!job.shareIds.length) queue.shift()
      await this.state.storage.put("fanoutQueue", queue)
      for (const id of batch) {
        try {
          if (job.action === "set-frozen") {
            await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(id)).fetch("https://do/set-frozen", {
              method: "POST", body: JSON.stringify({ frozen: !!job.frozen }),
            })
          } else if (job.action === "set-creator-token") {
            await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(id)).fetch("https://do/set-creator-token", {
              method: "POST", body: JSON.stringify({ tokenId: job.tokenId }),
            })
          } else {
            await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(id)).fetch("https://do/remove-all", { method: "POST" })
          }
        } catch {}
      }
      if (queue.length) {
        return void (await this.state.storage.setAlarm(Date.now() + 60 * 1000))
      }
    }
    // hygiene: bound the singleton's storage growth
    try {
      const now = Date.now()
      let cursor
      do {
        const page = await this.state.storage.list({ prefix: "rl:", cursor })
        for (const [k, v] of page) {
          if (!v?.resetAt || v.resetAt + 2 * 3600000 < now) await this.state.storage.delete(k)
        }
        cursor = page.list_complete ? undefined : page.cursor
      } while (cursor)
      cursor = undefined
      do {
        const page = await this.state.storage.list({ prefix: "dc:", cursor })
        for (const [k] of page) {
          // dc:<tokenId>:<YYYY-MM-DD> — the date is the second-to-last segment
          const day = k.split(":")[2] ?? ""
          if (day && now - Date.parse(day + "T00:00:00Z") > 2 * 86400000) await this.state.storage.delete(k)
        }
        cursor = page.list_complete ? undefined : page.cursor
      } while (cursor)
      cursor = undefined
      do {
        const page = await this.state.storage.list({ prefix: "t:", cursor })
        for (const [k, t] of page) {
          if (t?.revokedAt && t.revokedAt + 30 * 86400000 < now) await this.state.storage.delete(k)
        }
        cursor = page.list_complete ? undefined : page.cursor
      } while (cursor)
      // revocation-by-expiry (eventual, daily): a user whose tokens ALL
      // expired loses control of their shares exactly like an explicit
      // revoke. One freeze per invocation - userFreeze's fan-out already
      // spends the subrequest budget, remaining users ride the next alarm.
      const expiredDead = []
      let uc
      do {
        const page = await this.state.storage.list({ prefix: "u:", cursor: uc })
        for (const [, u] of page) if (u && !u.frozen) expiredDead.push(u.id)
        uc = page.list_complete ? undefined : page.cursor
      } while (uc)
      if (expiredDead.length) {
        const tokens = await this.listPrefix("t:")
        const aliveUsers = new Set(tokens.filter((t) => t.kind !== "scoped" && !t.revokedAt && !(t.expiresAt && t.expiresAt < now)).map((t) => t.userId))
        for (const uid of expiredDead) {
          if (aliveUsers.has(uid)) continue
          const reg = (await this.state.storage.get(`uShares:${uid}`)) ?? []
          if (!reg.length) continue
          await this.userFreeze(true, { userId: uid })
          await this.state.storage.setAlarm(Date.now() + 60 * 1000)
          break
        }
      }
    } catch (e) {
      console.log("[authdo] hygiene error", e?.message || e)
    }
    await this.state.storage.setAlarm(Date.now() + 24 * 3600 * 1000)
  }

  async fetch(req) {
    const url = new URL(req.url)
    const [route, param] = url.pathname.split(":")
    const body = await req.json().catch(() => ({}))
    // hygiene/fan-out alarm cadence: arm lazily on any traffic (getAlarm
    // is a cheap no-op when one is already pending)
    try {
      if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + 60 * 1000)
    } catch {}
    const json = (code, b) => new Response(JSON.stringify(b), { status: code, headers: { "content-type": "application/json" } })
    try {
      switch (route) {
        case "/check": return json(200, await this.check(body))
        case "/create-check": return json(200, await this.createCheck(body))
        case "/enroll": return json(...(await this.enroll(body)))
        case "/rotate": return json(...(await this.rotate(body)))
        case "/token-delete": return json(...(await this.tokenDelete(body)))
        case "/me": return json(...(await this.me(body)))
        case "/settings": return json(...(await this.settings(body)))
        case "/me-shares": return json(...(await this.meShares(body)))
        case "/register": return json(200, await this.register(body))
        case "/unregister": return json(200, await this.unregister(body))
        case "/user-create": return json(...(await this.userCreate(body)))
        case "/users-get": return json(...(await this.usersGet()))
        case "/user-freeze": return json(...(await this.userFreeze(param === "1", body)))
        case "/user-delete": return json(...(await this.userDelete(param, body)))
        case "/token-mint": return json(...(await this.tokenMint(body)))
        case "/token-self-mint": return json(...(await this.tokenSelfMint(body)))
        case "/token-sets-get": return json(...(await this.tokenSetsGet(body)))
        case "/token-sets-put": return json(...(await this.tokenSetsPut(body)))
        case "/token-sets-admin": return json(...(await this.tokenSetsAdmin(param, body)))
        case "/tokens-get": return json(...(await this.tokensGet()))
        case "/token-revoke": return json(...(await this.tokenRevoke(param)))
        case "/code-create": return json(...(await this.codeCreate(body)))
        case "/codes-get": return json(...(await this.codesGet()))
        case "/code-disable": return json(...(await this.codeDisable(param)))
        case "/code-lineage-revoke": return json(...(await this.codeLineageRevoke(param)))
        case "/freeze-by-token": return json(...(await this.freezeByToken(param, body)))
        case "/reassign": return json(...(await this.reassign(param, body)))
        default: return json(404, { ok: false, error: "not found" })
      }
    } catch (e) {
      console.log("[authdo] error", route, e?.message || e)
      return json(500, { ok: false, error: "auth internal" })
    }
  }

  // ---- token resolution ---------------------------------------------------

  async checkToken(token) {
    if (!token) return { kind: "none" }
    if (this.env.CREATE_TOKEN && token === this.env.CREATE_TOKEN) return { kind: "root" }
    const t = await this.state.storage.get("t:" + (await sha256hex(token)))
    if (!t || t.revokedAt || (t.expiresAt && t.expiresAt < Date.now())) return { kind: "none" }
    const u = await this.state.storage.get("u:" + t.userId)
    if (!u || u.frozen) return { kind: "none" } // frozen user: tokens dead too
    if (Date.now() - (t.lastUsedAt ?? 0) > 60000) {
      t.lastUsedAt = Date.now()
      await this.state.storage.put("t:" + t.hash, t)
    }
    // tokenKind rides every identity: the write gate needs it to tell a
    // FULL token (any of the owner's shares) from a SCOPED one (only the
    // shares it created). Absent kind = full (pre-2a records).
    return { kind: "user", userId: t.userId, user: u, token: t, tokenId: t.id, tokenKind: t.kind === "scoped" ? "scoped" : "full" }
  }

  async check(body) {
    const chk = await this.checkToken(typeof body.token === "string" ? body.token : "")
    if (chk.kind === "user") return { kind: "user", userId: chk.userId, label: chk.user.label, tokenId: chk.tokenId, tokenKind: chk.tokenKind, ttlMaxHours: (chk.token.limits.maxTtlHours || 0) || Math.floor((chk.token.limits.maxTtlDays || 0) * 24) }
    return { kind: chk.kind }
  }

  /** Pre-create authorization: resolves identity and enforces per-token
   * limits atomically (single-writer DO). Burns one daily-create slot on
   * success — a subsequent failed ShareDO init wastes at most one slot. */
  async createCheck(body) {
    return this.withMu(() => this.createCheckInner(body))
  }

  async createCheckInner(body) {
    const chk = await this.checkToken(typeof body.token === "string" ? body.token : "")
    if (chk.kind === "root") return { ok: true }
    if (chk.kind === "none") {
      if (authMode(this.env) === "public") {
        // anonymous ownerless create: allowed, but under a GLOBAL cap —
        // per-IP limits are dodgeable and every create costs a DO + KV key
        if (!(await this.anonCreateLimit())) return { ok: false, error: "too many anonymous creates, try later", httpStatus: 429 }
        return { ok: true }
      }
      return { ok: false, error: "token required", httpStatus: 401 }
    }
    const t = chk.token
    const now = Date.now()
    if (t.limits.maxLiveShares > 0) {
      // SCOPED tokens count only their own shares; FULL counts the
      // user's whole registry
      if (t.kind === "scoped") {
        const reg = (await this.state.storage.get(`uShares:${t.userId}`)) ?? []
        if (reg.filter((s) => s.creatorTokenId === t.id).length >= t.limits.maxLiveShares) return { ok: false, error: "max shares reached", httpStatus: 403 }
      } else {
        const shares = (await this.state.storage.get(`uShares:${t.userId}`)) ?? []
        if (shares.length >= t.limits.maxLiveShares) return { ok: false, error: "max shares reached", httpStatus: 403 }
      }
    }
    if (t.limits.dailyCreates > 0) {
      const key = `dc:${t.id}:${new Date(now).toISOString().slice(0, 10)}`
      const n = (await this.state.storage.get(key)) ?? 0
      if (n >= t.limits.dailyCreates) return { ok: false, error: "daily create limit reached", httpStatus: 429 }
      await this.state.storage.put(key, n + 1)
    }
    // B4: resolve the requested (or default) config set's Class A fields -
    // applied server-side at create, never transported to the client
    const set = this.resolveSet(t.sets, body.set)
    return { ok: true, userId: t.userId, tokenId: t.id, tokenKind: t.kind === "scoped" ? "scoped" : "full", ttlMaxHours: (t.limits.maxTtlHours || 0) || Math.floor((t.limits.maxTtlDays || 0) * 24), defaultTtlHours: (Number(chk.user?.settings?.defaultTtlHours) || 0) || Math.floor((Number(chk.user?.settings?.defaultTtlDays) || 0) * 24), ...(Object.keys(set.classA).length ? { setA: set.classA } : {}) }
  }

  // ---- enrollment + lifecycle ----------------------------------------------

  defaultLimits() {
    const num = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0 }
    return {
      maxLiveShares: num(this.env.DEFAULT_MAX_LIVE_SHARES),
      maxTtlHours: num(this.env.DEFAULT_MAX_TTL_HOURS) || Math.floor(num(this.env.DEFAULT_MAX_TTL_DAYS) * 24),
      dailyCreates: num(this.env.DEFAULT_DAILY_CREATES),
    }
  }

  normLimits(input) {
    const d = this.defaultLimits()
    if (!input || typeof input !== "object") return d
    const one = (v, def) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 ? n : def }
    return {
      maxLiveShares: one(input.maxLiveShares, d.maxLiveShares),
      maxTtlHours: one(input.maxTtlHours, one(input.maxTtlDays, 0) ? Math.floor(one(input.maxTtlDays, 0) * 24) : d.maxTtlHours),
      dailyCreates: one(input.dailyCreates, d.dailyCreates),
    }
  }

  async mint(userId, label, limits, kind = "full") {
    const value = "osk_" + randomId() + randomId()
    const hash = await sha256hex(value)
    const rec = { id: "t_" + randomId().slice(0, 10), hash, userId, label: String(label ?? "").slice(0, 64), limits, kind: kind === "scoped" ? "scoped" : "full", sets: {}, createdAt: Date.now(), lastUsedAt: 0, revokedAt: 0, expiresAt: 0 }
    await this.state.storage.put("t:" + hash, rec)
    return { value, rec }
  }

  /** Named config sets on a token (B4 keying): one key (token) carries
   * several named configs; agents pick by name, unspecified = the first
   * (default) set. Class A fields (authLogin/authPassword/ttlHours) apply
   * server-side at create and NEVER travel to a client; Class B fields
   * (modelLabel/shareMode) are fetchable suggestions. Caps mirror the
   * create-frame validation. */
  normSets(input) {
    const out = {}
    if (!input || typeof input !== "object" || Array.isArray(input)) return out
    let n = 0
    for (const [name, raw] of Object.entries(input)) {
      if (n >= 10) break
      if (typeof name !== "string" || name.length > 32 || !/^[a-zA-Z0-9_-]+$/.test(name)) continue
      if (!raw || typeof raw !== "object") continue
      const set = {}
      for (const k of ["authLogin", "authPassword"]) {
        if (typeof raw[k] === "string" && raw[k].length <= 128) set[k] = raw[k]
      }
      const ttlH = Math.floor(Number(raw.ttlHours))
      if (Number.isFinite(ttlH) && ttlH > 0 && ttlH <= 87600) set.ttlHours = ttlH
      else {
        const ttl = Math.floor(Number(raw.ttlDays))
        if (Number.isFinite(ttl) && ttl > 0 && ttl <= 3650) set.ttlHours = ttl * 24
      }
      if (typeof raw.modelLabel === "string" && raw.modelLabel.length <= 64) set.modelLabel = raw.modelLabel
      if (raw.shareMode === "all" || raw.shareMode === "manual") set.shareMode = raw.shareMode
      if (Object.keys(set).length) { out[name] = set; n++ }
    }
    return out
  }

  /** Resolve the set a create should use and split it by class. Returns
   * { classA: {...}, classB: {...} } - classA never crosses to a client. */
  resolveSet(sets, wanted) {
    const names = Object.keys(sets ?? {})
    if (!names.length) return { classA: {}, classB: {} }
    const name = wanted && typeof wanted === "string" && sets[wanted] ? wanted : names[0]
    const set = sets[name] ?? {}
    const classA = {}
    if (set.authLogin !== undefined) classA.authLogin = set.authLogin
    if (set.authPassword !== undefined) classA.authPassword = set.authPassword
    if (set.ttlHours !== undefined) classA.ttlHours = set.ttlHours
    const classB = {}
    if (set.modelLabel !== undefined) classB.modelLabel = set.modelLabel
    if (set.shareMode !== undefined) classB.shareMode = set.shareMode
    return { classA, classB }
  }

  /** Client-safe view: Class B fields ONLY (never authLogin/authPassword). */
  setsPublicView(sets) {
    const out = {}
    for (const [name, set] of Object.entries(sets ?? {})) {
      const view = {}
      if (set.modelLabel !== undefined) view.modelLabel = set.modelLabel
      if (set.shareMode !== undefined) view.shareMode = set.shareMode
      if (Object.keys(view).length) out[name] = view
    }
    return out
  }

  async enroll(body) {
    return this.withMu(() => this.enrollInner(body))
  }

  async enrollInner(body) {
    const mode = authMode(this.env)
    const now = Date.now()
    let code = null
    if (body.code) {
      code = await this.state.storage.get("c:" + (await sha256hex(String(body.code))))
      const invalid = !code || code.disabled || (code.expiresAt && code.expiresAt < now) || (code.activationsLeft !== -1 && code.activationsLeft <= 0)
      if (invalid) return [403, { ok: false, error: "invalid code" }]
    } else if (mode !== "public" || !codelessOnboarding(this.env)) {
      // codeless onboarding is a deliberate opt-in even on public
      // servers (default OFF): anonymous creating stays open, but
      // ACCOUNTS (escaping the anonymous caps) need a code unless the
      // hoster says otherwise
      return [403, { ok: false, error: mode === "public" ? "code required (codeless onboarding disabled)" : "code required" }]
    }
    if (!code) {
      const rl = await this.rateLimit(String(body.ip ?? "unknown"))
      if (!rl) return [429, { ok: false, error: "too many enrollments, try later" }]
    }
    if (code) {
      code.used += 1
      if (code.activationsLeft !== -1) code.activationsLeft -= 1
      await this.state.storage.put("c:" + code.hash, code)
    }
    const label = String(body.label ?? "").trim().slice(0, 64)
      || (code ? `${code.label || "invite"}-${code.used}` : "user-" + randomId().slice(0, 4))
    const user = { id: "u_" + randomId().slice(0, 10), label, createdAt: now, frozen: false, settings: {}, ...(code ? { createdByCode: code.id } : {}) }
    await this.state.storage.put("u:" + user.id, user)
    const token = await this.mint(user.id, label, this.defaultLimits(), "full")
    console.log("[authdo] enrolled", user.id, label, code ? "via code" : "codeless")
    return [200, { ok: true, token: token.value, userId: user.id, label }]
  }

  async rateLimit(ip) {
    const key = "rl:" + ip
    const now = Date.now()
    const rl = await this.state.storage.get(key)
    if (!rl || rl.resetAt < now) {
      await this.state.storage.put(key, { n: 1, resetAt: now + 3600000 })
      return true
    }
    if (rl.n >= 10) return false
    rl.n += 1
    await this.state.storage.put(key, rl)
    return true
  }

  /** Global anonymous-create limiter (public mode): unlike per-IP enroll
   * limiting, this one cannot be dodged by rotating source addresses —
   * anonymous creates are ownerless and cost a ShareDO + KV key each.
   * Cap is per rolling hour, ALL anonymous users combined; configurable
   * via ANON_CREATE_HOURLY (default 100). */
  async anonCreateLimit() {
    const cap = Math.max(1, Number(this.env.ANON_CREATE_HOURLY ?? 100) || 100)
    const key = "rl:anon-creates"
    const now = Date.now()
    const rl = await this.state.storage.get(key)
    if (!rl || rl.resetAt < now) {
      await this.state.storage.put(key, { n: 1, resetAt: now + 3600000 })
      return true
    }
    if (rl.n >= cap) return false
    rl.n += 1
    await this.state.storage.put(key, rl)
    return true
  }

  async rotate(body) {
    const chk = await this.checkToken(typeof body.token === "string" ? body.token : "")
    if (chk.kind !== "user") return [401, { ok: false, error: "invalid token" }]
    const t = chk.token
    t.revokedAt = Date.now()
    await this.state.storage.put("t:" + t.hash, t)
    // successor keeps the class: rotating a scoped token yields a scoped
    // token (service credential), rotating a full token a full one
    const fresh = await this.mint(t.userId, t.label, t.limits, t.kind === "scoped" ? "scoped" : "full")
    // SCOPED authority is keyed by creatorTokenId: transfer the old
    // token's shares to the successor or rotation orphans its own pages
    if (t.kind === "scoped") await this.transferCreator(t.id, fresh.rec.id)
    return [200, { ok: true, token: fresh.value, userId: t.userId, tokenKind: fresh.rec.kind }]
  }

  /** Re-point a retiring scoped token's shares at its successor: registry
   * entries inline, ShareDO meta via the chunked fan-out. */
  async transferCreator(oldId, newId) {
    let uc
    const targets = []
    do {
      const page = await this.state.storage.list({ prefix: "uShares:", cursor: uc })
      for (const [k, reg] of page) {
        if (!Array.isArray(reg)) continue
        let dirty = false
        for (const s of reg) {
          if (s.creatorTokenId === oldId) {
            s.creatorTokenId = newId
            targets.push(s.id)
            dirty = true
          }
        }
        if (dirty) await this.state.storage.put(k, reg)
      }
      uc = page.list_complete ? undefined : page.cursor
    } while (uc)
    if (!targets.length) return
    const first = targets.slice(0, 35)
    const rest = targets.slice(35)
    for (const id of first) {
      try {
        await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(id)).fetch("https://do/set-creator-token", {
          method: "POST", body: JSON.stringify({ tokenId: newId }),
        })
      } catch {}
    }
    if (rest.length) {
      const q = (await this.state.storage.get("fanoutQueue")) ?? []
      q.push({ action: "set-creator-token", tokenId: newId, shareIds: rest })
      await this.state.storage.put("fanoutQueue", q)
      const cur = await this.state.storage.getAlarm()
      if (cur === null || cur > Date.now() + 60 * 1000) await this.state.storage.setAlarm(Date.now() + 60 * 1000)
    }
  }

  /** Self-service mint: only FULL tokens may mint (a scoped credential
   * must never bootstrap more credentials). Scoped mint target is the
   * point - CI/agent credentials without account authority. */
  async tokenSelfMint(body) {
    const chk = await this.checkToken(typeof body.token === "string" ? body.token : "")
    if (chk.kind !== "user") return [401, { ok: false, error: "invalid token" }]
    if (chk.tokenKind === "scoped") return [403, { ok: false, error: "scoped tokens cannot mint tokens" }]
    const kind = body.kind === "scoped" ? "scoped" : "full"
    // sets ride the new token: explicit, else inherit the minter's (a
    // repo's scoped key is provisioned from its full token)
    const sets = body.sets !== undefined ? this.normSets(body.sets) : (chk.token.sets ?? {})
    const t = await this.mint(chk.userId, body.label, this.normLimits(body.limits), kind)
    if (Object.keys(sets).length) { t.rec.sets = sets; await this.state.storage.put("t:" + t.rec.hash, t.rec) }
    return [200, { ok: true, token: t.value, id: t.rec.id, userId: chk.userId, kind: t.rec.kind }]
  }

  /** B4 set fetch: Class B fields only (scoped included - a service
   * credential reads its own config). Never authLogin/authPassword. */
  async tokenSetsGet(body) {
    const chk = await this.checkToken(typeof body.token === "string" ? body.token : "")
    if (chk.kind !== "user") return [401, { ok: false, error: "invalid token" }]
    return [200, { ok: true, sets: this.setsPublicView(chk.token.sets) }]
  }

  /** B4 set provisioning: a FULL token replaces its own sets (Class A
   * secrets ride here - this is the provisioning surface). */
  async tokenSetsPut(body) {
    const chk = await this.checkToken(typeof body.token === "string" ? body.token : "")
    if (chk.kind !== "user") return [401, { ok: false, error: "invalid token" }]
    if (chk.tokenKind === "scoped") return [403, { ok: false, error: "scoped tokens cannot edit sets" }]
    chk.token.sets = this.normSets(body.sets)
    await this.state.storage.put("t:" + chk.token.hash, chk.token)
    return [200, { ok: true, sets: this.setsPublicView(chk.token.sets) }]
  }

  /** Admin variant: root edits any token's sets by id. */
  async tokenSetsAdmin(tokenId, body) {
    const tokens = await this.listPrefix("t:")
    const t = tokens.find((x) => x.id === tokenId)
    if (!t) return [404, { ok: false, error: "no such token" }]
    t.sets = this.normSets(body?.sets)
    await this.state.storage.put("t:" + t.hash, t)
    return [200, { ok: true, id: t.id, sets: this.setsPublicView(t.sets) }]
  }

  /** Revocation kills control (owner directive): a user whose LAST valid
   * token is gone loses write access to ALL their shares - user token AND
   * share secret both - until an admin unfreezes/reassigns. Viewing is
   * never touched. Rotation never lands here (the replacement is minted
   * before the old token dies). */
  async freezeIfNoValidTokens(userId) {
    if (!userId) return false
    const tokens = await this.listPrefix("t:")
    const now = Date.now()
    // only FULL tokens keep the account alive - a user holding nothing
    // but scoped credentials is dead (scoped = service access, not
    // ownership)
    const alive = tokens.filter((x) => x.userId === userId && x.kind !== "scoped" && !x.revokedAt && !(x.expiresAt && x.expiresAt < now))
    if (alive.length) return false
    const reg = (await this.state.storage.get(`uShares:${userId}`)) ?? []
    if (!reg.length) return false
    console.log("[authdo] no valid tokens left - freezing shares of user", userId)
    await this.userFreeze(true, { userId })
    return true
  }

  async tokenDelete(body) {
    const chk = await this.checkToken(typeof body.token === "string" ? body.token : "")
    if (chk.kind !== "user") return [401, { ok: false, error: "invalid token" }]
    const t = chk.token
    t.revokedAt = Date.now()
    await this.state.storage.put("t:" + t.hash, t)
    const frozen = await this.freezeIfNoValidTokens(t.userId)
    return [200, { ok: true, frozen }]
  }

  // ---- self-service ---------------------------------------------------------

  tokenView(t) {
    return { id: t.id, label: t.label, limits: t.limits, kind: t.kind === "scoped" ? "scoped" : "full", createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, expiresAt: t.expiresAt }
  }

  async me(body) {
    const chk = await this.checkToken(typeof body.token === "string" ? body.token : "")
    if (chk.kind !== "user") return [401, { ok: false, error: "invalid token" }]
    return [200, { ok: true, userId: chk.userId, label: chk.user.label, settings: chk.user.settings ?? {}, token: this.tokenView(chk.token) }]
  }

  async settings(body) {
    const chk = await this.checkToken(typeof body.token === "string" ? body.token : "")
    if (chk.kind !== "user") return [401, { ok: false, error: "invalid token" }]
    if (chk.tokenKind === "scoped") return [403, { ok: false, error: "scoped tokens cannot edit settings" }]
    const u = chk.user
    const patch = body.patch ?? {}
    const next = { ...(u.settings ?? {}) }
    if (patch.defaultTtlDays !== undefined || patch.defaultTtlHours !== undefined) {
      const rawH = Number.isFinite(Number(patch.defaultTtlHours)) && Number(patch.defaultTtlHours) > 0
        ? Math.floor(Number(patch.defaultTtlHours))
        : Math.floor(Number(patch.defaultTtlDays) * 24)
      const max = Math.max(1, Math.floor(Number(body.maxTtlHours) || 90 * 24))
      next.defaultTtlHours = Number.isFinite(rawH) && rawH > 0 ? Math.min(rawH, max) : max
      delete next.defaultTtlDays
    }
    u.settings = next
    await this.state.storage.put("u:" + u.id, u)
    return [200, { ok: true, settings: next }]
  }

  async meShares(body) {
    const chk = await this.checkToken(typeof body.token === "string" ? body.token : "")
    if (chk.kind !== "user") return [401, { ok: false, error: "invalid token" }]
    let reg = (await this.state.storage.get(`uShares:${chk.userId}`)) ?? []
    // scoped tokens see ONLY the shares they created
    if (chk.tokenKind === "scoped") reg = reg.filter((s) => s.creatorTokenId === chk.tokenId)
    // subrequest cap: a /meta DO fetch per share breaks past ~50 on the
    // free tier — resolve statuses for the first 50 (newest listed last),
    // mark the tail unhydrated rather than 500ing the whole call
    const hydrated = reg.slice(-50)
    const tail = reg.slice(0, Math.max(0, reg.length - 50))
    const statuses = await Promise.all(hydrated.map((s) => this.shareField(s.id, "status")))
    const shares = [
      ...tail.map((s) => ({ ...s, status: "unknown" })),
      ...hydrated.map((s, i) => ({ ...s, status: statuses[i] })),
    ]
    return [200, { ok: true, shares, truncated: tail.length > 0 }]
  }

  async shareField(id, field) {
    try {
      const r = await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(id)).fetch("https://do/meta")
      if (r.status !== 200) return "gone"
      const m = await r.json()
      return m[field] ?? "unknown"
    } catch {
      return "unknown"
    }
  }

  // ---- registry ---------------------------------------------------------------

  async register(body) {
    if (!body?.userId || !body?.shareId) return { ok: false, error: "userId and shareId required" }
    const u = await this.state.storage.get("u:" + body.userId)
    if (!u) return { ok: false, error: "no such user" }
    const key = `uShares:${body.userId}`
    const reg = (await this.state.storage.get(key)) ?? []
    if (!reg.some((s) => s.id === body.shareId)) {
      // creatorTokenId: which credential made the share - scoped-authority
      // resolution, per-token listings, and the bulk freeze-by-token op
      reg.push({ id: body.shareId, sessionID: body.sessionID ?? "", createdAt: Date.now(), ...(body.tokenId ? { creatorTokenId: body.tokenId } : {}) })
      await this.state.storage.put(key, reg.slice(-10000))
    }
    await this.state.storage.put(`shareOwner:${body.shareId}`, body.userId)
    return { ok: true }
  }

  async unregister(body) {
    if (!body?.shareId) return { ok: false }
    const ownerId = body.userId ?? (await this.state.storage.get(`shareOwner:${body.shareId}`))
    await this.state.storage.delete(`shareOwner:${body.shareId}`)
    if (!ownerId) return { ok: true }
    const key = `uShares:${ownerId}`
    const reg = (await this.state.storage.get(key)) ?? []
    const next = reg.filter((s) => s.id !== body.shareId)
    if (next.length !== reg.length) await this.state.storage.put(key, next)
    return { ok: true }
  }

  // ---- admin -------------------------------------------------------------------

  async userCreate(body) {
    const label = String(body?.label ?? "").trim().slice(0, 64) || "user-" + randomId().slice(0, 4)
    const user = { id: "u_" + randomId().slice(0, 10), label, createdAt: Date.now(), frozen: false, settings: {} }
    await this.state.storage.put("u:" + user.id, user)
    return [200, { ok: true, userId: user.id, label }]
  }

  async usersGet() {
    const out = []
    const tokens = await this.listPrefix("t:")
    let cursor
    do {
      const page = await this.state.storage.list({ prefix: "u:", cursor })
      for (const [k, u] of page) {
        const toks = tokens.filter((t) => t.userId === u.id)
        out.push({
          id: u.id, label: u.label, createdAt: u.createdAt, frozen: !!u.frozen,
          shares: ((await this.state.storage.get(`uShares:${u.id}`)) ?? []).length,
          tokens: toks.length, tokensActive: toks.filter((t) => !t.revokedAt).length,
        })
      }
      cursor = page.list_complete ? undefined : page.cursor
    } while (cursor)
    return [200, { ok: true, users: out }]
  }

  /** Freeze/unfreeze fan-out: denormalizes the freeze onto every share the
   * user owns so the ShareDO write gate can reject locally (no AuthDO hop
   * in the hot path). Tokens die simultaneously via checkToken's user
   * check, so both control paths sever together. The user row flips
   * immediately; the per-share DO fan-out is chunked through the alarm
   * (bounded subrequests per invocation) so large accounts don't
   * half-freeze behind the free-tier cap. */
  async userFreeze(freeze, body) {
    const u = await this.state.storage.get("u:" + body?.userId)
    if (!u) return [404, { ok: false, error: "no such user" }]
    u.frozen = !!freeze
    await this.state.storage.put("u:" + u.id, u)
    const reg = (await this.state.storage.get(`uShares:${u.id}`)) ?? []
    const first = reg.slice(0, 35)
    const rest = reg.slice(35)
    for (const s of first) {
      try {
        await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(s.id)).fetch("https://do/set-frozen", {
          method: "POST", body: JSON.stringify({ frozen: !!freeze }),
        })
      } catch {}
    }
    if (rest.length) {
      const q = (await this.state.storage.get("fanoutQueue")) ?? []
      q.push({ action: "set-frozen", frozen: !!freeze, shareIds: rest })
      await this.state.storage.put("fanoutQueue", q)
      // sooner of (existing alarm, 60s) — a lazy-armed 24h hygiene alarm
      // must NOT delay a freeze/delete fan-out (the queued shares stay
      // writable until the freeze lands)
      const cur = await this.state.storage.getAlarm()
      if (cur === null || cur > Date.now() + 60 * 1000) await this.state.storage.setAlarm(Date.now() + 60 * 1000)
    }
    console.log("[authdo] user", u.id, freeze ? "frozen" : "unfrozen", `(${reg.length} shares${rest.length ? `, ${rest.length} queued` : ""})`)
    return [200, { ok: true, frozen: !!freeze, shares: reg.length, queued: rest.length }]
  }

  async userDelete(userId, body) {
    const u = await this.state.storage.get("u:" + userId)
    if (!u) return [404, { ok: false, error: "no such user" }]
    if (String(body?.mode ?? "") === "delete") {
      const reg = (await this.state.storage.get(`uShares:${userId}`)) ?? []
      const first = reg.slice(0, 35)
      const rest = reg.slice(35)
      for (const s of first) {
        try {
          await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(s.id)).fetch("https://do/remove-all", { method: "POST" })
        } catch {}
      }
      if (rest.length) {
        const q = (await this.state.storage.get("fanoutQueue")) ?? []
        q.push({ action: "remove-all", shareIds: rest })
        await this.state.storage.put("fanoutQueue", q)
        const cur = await this.state.storage.getAlarm()
        if (cur === null || cur > Date.now() + 60 * 1000) await this.state.storage.setAlarm(Date.now() + 60 * 1000)
      }
      const tokens = await this.listPrefix("t:")
      for (const t of tokens.filter((t) => t.userId === userId)) {
        t.revokedAt = Date.now()
        await this.state.storage.put("t:" + t.hash, t)
      }
      await this.state.storage.delete(`uShares:${userId}`)
      await this.state.storage.delete("u:" + userId)
      console.log("[authdo] user deleted", userId, `(${reg.length} shares removed${rest.length ? `, ${rest.length} queued` : ""})`)
      return [200, { ok: true, mode: "delete", shares: reg.length, queued: rest.length }]
    }
    // default mode: freeze in place (reversible)
    return this.userFreeze(true, { userId })
  }

  async tokenMint(body) {
    const u = await this.state.storage.get("u:" + body?.userId)
    if (!u) return [404, { ok: false, error: "no such user" }]
    const t = await this.mint(u.id, body?.label, this.normLimits(body?.limits), body?.kind === "scoped" ? "scoped" : "full")
    const sets = this.normSets(body?.sets)
    if (Object.keys(sets).length) { t.rec.sets = sets; await this.state.storage.put("t:" + t.rec.hash, t.rec) }
    return [200, { ok: true, token: t.value, id: t.rec.id, userId: u.id, kind: t.rec.kind }]
  }

  async tokensGet() {
    const tokens = (await this.listPrefix("t:")).map((t) => ({ ...this.tokenView(t), userId: t.userId, revoked: !!t.revokedAt }))
    return [200, { ok: true, tokens }]
  }

  async tokenRevoke(tokenId) {
    const tokens = await this.listPrefix("t:")
    const t = tokens.find((x) => x.id === tokenId)
    if (!t) return [404, { ok: false, error: "no such token" }]
    t.revokedAt = Date.now()
    await this.state.storage.put("t:" + t.hash, t)
    const frozen = await this.freezeIfNoValidTokens(t.userId)
    return [200, { ok: true, frozen }]
  }

  async codeCreate(body) {
    const activations = Math.floor(Number(body?.activations))
    const left = Number.isFinite(activations) && activations >= 1 ? activations : -1
    const value = "osc_" + randomId()
    const hash = await sha256hex(value)
    const rec = {
      id: "c_" + randomId().slice(0, 10), hash,
      label: String(body?.label ?? "").trim().slice(0, 64) || "invite",
      activationsLeft: left, used: 0, createdAt: Date.now(),
      expiresAt: Number(body?.ttlHours) > 0 ? Date.now() + Number(body.ttlHours) * 3600000 : 0,
      disabled: false,
    }
    await this.state.storage.put("c:" + hash, rec)
    return [200, { ok: true, code: value, id: rec.id, activationsLeft: left }]
  }

  async codesGet() {
    const codes = (await this.listPrefix("c:")).map((c) => ({
      id: c.id, label: c.label, activationsLeft: c.activationsLeft, used: c.used,
      createdAt: c.createdAt, expiresAt: c.expiresAt, disabled: !!c.disabled,
    }))
    return [200, { ok: true, codes }]
  }

  async codeDisable(codeId) {
    const codes = await this.listPrefix("c:")
    const c = codes.find((x) => x.id === codeId)
    if (!c) return [404, { ok: false, error: "no such code" }]
    c.disabled = true
    await this.state.storage.put("c:" + c.hash, c)
    return [200, { ok: true }]
  }

  /** Code-lineage kill-switch: revoke EVERY token of EVERY user that this
   * code onboarded, freezing each (no valid full token left -> D5 fan-out
   * per user). The code itself is disabled so it cannot onboard anyone
   * else. Viewing is untouched - shares stay readable to TTL. */
  async codeLineageRevoke(codeId) {
    const codes = await this.listPrefix("c:")
    const c = codes.find((x) => x.id === codeId)
    if (!c) return [404, { ok: false, error: "no such code" }]
    c.disabled = true
    await this.state.storage.put("c:" + c.hash, c)
    const tokens = await this.listPrefix("t:")
    let uc
    const affected = []
    do {
      const page = await this.state.storage.list({ prefix: "u:", cursor: uc })
      for (const [, u] of page) if (u?.createdByCode === codeId) affected.push(u.id)
      uc = page.list_complete ? undefined : page.cursor
    } while (uc)
    let revoked = 0
    let frozen = 0
    for (const uid of affected) {
      for (const t of tokens.filter((x) => x.userId === uid && !x.revokedAt)) {
        t.revokedAt = Date.now()
        await this.state.storage.put("t:" + t.hash, t)
        revoked++
      }
      if (await this.freezeIfNoValidTokens(uid)) frozen++
    }
    console.log("[authdo] code-lineage revoke", codeId, `(${affected.length} users, ${revoked} tokens)`)
    return [200, { ok: true, users: affected.length, revoked, frozen, codeDisabled: true }]
  }

  /** Bulk op: freeze every share a specific token created (scoped or
   * full) without touching the rest of the owner's shares. Rides the
   * chunked set-frozen fan-out. Rotation never lands here. */
  async freezeByToken(tokenId, body) {
    const frozen = body?.frozen === false ? false : true
    let uc
    const targets = []
    do {
      const page = await this.state.storage.list({ prefix: "uShares:", cursor: uc })
      for (const [, reg] of page) {
        if (!Array.isArray(reg)) continue
        for (const s of reg) if (s.creatorTokenId === tokenId) targets.push(s.id)
      }
      uc = page.list_complete ? undefined : page.cursor
    } while (uc)
    if (!targets.length) return [404, { ok: false, error: "no shares created by that token" }]
    const first = targets.slice(0, 35)
    const rest = targets.slice(35)
    for (const id of first) {
      try {
        await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(id)).fetch("https://do/set-frozen", {
          method: "POST", body: JSON.stringify({ frozen }),
        })
      } catch {}
    }
    if (rest.length) {
      const q = (await this.state.storage.get("fanoutQueue")) ?? []
      q.push({ action: "set-frozen", frozen, shareIds: rest })
      await this.state.storage.put("fanoutQueue", q)
      const cur = await this.state.storage.getAlarm()
      if (cur === null || cur > Date.now() + 60 * 1000) await this.state.storage.setAlarm(Date.now() + 60 * 1000)
    }
    console.log("[authdo] freeze-by-token", tokenId, `(${targets.length} shares${rest.length ? `, ${rest.length} queued` : ""})`)
    return [200, { ok: true, shares: targets.length, queued: rest.length }]
  }

  async reassign(shareId, body) {
    const target = await this.state.storage.get("u:" + body?.userId)
    if (!target) return [404, { ok: false, error: "no such user" }]
    const oldOwnerId = await this.state.storage.get(`shareOwner:${shareId}`)
    let entry = { id: shareId, sessionID: "", createdAt: Date.now() }
    if (oldOwnerId) {
      const key = `uShares:${oldOwnerId}`
      const reg = (await this.state.storage.get(key)) ?? []
      const idx = reg.findIndex((s) => s.id === shareId)
      if (idx >= 0) entry = reg[idx]
      const next = reg.filter((s) => s.id !== shareId)
      if (next.length !== reg.length) await this.state.storage.put(key, next)
    }
    const tkey = `uShares:${target.id}`
    const treg = (await this.state.storage.get(tkey)) ?? []
    if (!treg.some((s) => s.id === shareId)) treg.push(entry)
    await this.state.storage.put(tkey, treg)
    await this.state.storage.put(`shareOwner:${shareId}`, target.id)
    try {
      await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(shareId)).fetch("https://do/set-owner", {
        method: "POST", body: JSON.stringify({ userId: target.id }),
      })
    } catch {}
    console.log("[authdo] share", shareId, "reassigned", oldOwnerId ?? "(none)", "->", target.id)
    return [200, { ok: true }]
  }

  async listPrefix(prefix) {
    const out = []
    let cursor
    do {
      const page = await this.state.storage.list({ prefix, cursor })
      for (const [, v] of page) out.push(v)
      const complete = page.listComplete ?? page.list_complete
      cursor = complete ? undefined : page.cursor
    } while (cursor)
    return out
  }
}

// ---------------------------------------------------------------------------
// SweeperDO — daily alarm; deletes shares idle beyond their own TTL.
// ---------------------------------------------------------------------------
export class SweeperDO {
  constructor(state, env) {
    this.state = state
    this.env = env
  }

  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/arm" && req.method === "POST") {
      const cur = await this.state.storage.getAlarm()
      if (!cur) await this.state.storage.setAlarm(Date.now() + 60 * 1000)
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } })
    }
    if (url.pathname === "/purge" && req.method === "POST") {
      // admin purge, chunked through the alarm loop (bounded subrequests
      // per invocation): purgeAll makes the next pass remove everything
      const st = (await this.state.storage.get("sweepState")) ?? {}
      st.purgeAll = true
      st.pageKeys = []
      st.cursor = undefined
      st.done = false
      await this.state.storage.put("sweepState", st)
      await this.state.storage.setAlarm(Date.now() + 1000)
      // first batch inline so the admin sees immediate progress
      const r = await this.pass(true)
      return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } })
    }
    if (url.pathname === "/sweep" && req.method === "POST") {
      const st = (await this.state.storage.get("sweepState")) ?? {}
      st.done = false
      st.pageKeys = st.pageKeys ?? []
      await this.state.storage.put("sweepState", st)
      await this.state.storage.setAlarm(Date.now() + 1000)
      return new Response(JSON.stringify({ ok: true, started: true }), { headers: { "content-type": "application/json" } })
    }
    return new Response("nf", { status: 404 })
  }

  async alarm() {
    // daily tick STARTS a fresh pass; an in-progress pass continues in
    // 60s chunks. NOTE: completion re-arms +24h explicitly — the +24h set
    // here at start survives a same-invocation completion, but a pass
    // that finishes during a "busy" continuation would otherwise be
    // followed by an extra full pass 60s later.
    const st = (await this.state.storage.get("sweepState")) ?? { done: true }
    const busy = !st.done
    if (!busy) {
      st.done = false
      st.pageKeys = []
      st.cursor = undefined
      await this.state.storage.put("sweepState", st)
    }
    await this.state.storage.setAlarm(Date.now() + (busy ? 60 * 1000 : 24 * 3600 * 1000))
    await this.pass(false)
  }

  /** One bounded chunk of a sweep/purge pass: at most ~35 DO fetches per
   * invocation (free-tier subrequest cap is 50), cursor + remaining keys
   * persisted in DO storage so the next alarm continues exactly where
   * this run stopped. purgeAll removes every share instead of expiring.
   * `done` means the PASS finished (listing exhausted AND all keys
   * processed) — not merely that the KV listing reached its last page
   * (keys from that page still need their DO visits, chunked). */
  async pass(first) {
    const st = (await this.state.storage.get("sweepState")) ?? { done: true }
    const purgeAll = !!st.purgeAll
    let listed = 0
    let swept = 0
    let budget = 35
    try {
      while (budget > 0) {
        if (!st.pageKeys || !st.pageKeys.length) {
          if (st.listDone) break
          const page = await this.env.SHARE_INDEX.list({ cursor: st.cursor })
          // KV list pagination: `cursor` + `list_complete` (NOT
          // list_cursor — that typo froze the sweep at page 1 forever)
          st.cursor = page.list_complete ? undefined : page.cursor
          if (page.list_complete) st.listDone = true
          st.pageKeys = page.keys.map((k) => k.name).filter((n) => n.startsWith("share:"))
          if (!st.pageKeys.length) {
            if (st.listDone) break
            continue
          }
        }
        const key = st.pageKeys.shift()
        listed++
        budget--
        const id = key.slice("share:".length)
        try {
          if (purgeAll) {
            await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(id)).fetch("https://do/remove-all", { method: "POST" })
            await this.env.SHARE_INDEX.delete(key)
            swept++
            continue
          }
          const r = await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(id)).fetch("https://do/meta")
          budget--
          if (r.status !== 200) {
            await this.env.SHARE_INDEX.delete(key)
            continue
          }
          const meta = await r.json()
          const ttlMs = ((meta.ttlHours ?? 90 * 24) || Math.floor((meta.ttlDays ?? 90) * 24)) * 3600 * 1000
          if ((meta.lastActive ?? 0) + ttlMs < Date.now()) {
            await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(id)).fetch("https://do/remove-all", { method: "POST" })
            budget--
            swept++
            continue
          }
          // backstop: "live" shares whose plugin has been silent past the
          // finalize window (silent socket deaths where even the close
          // never surfaced) settle to interrupted. /meta already carried
          // pluginSeen — calling /finalize for a freshly-seen plugin is a
          // pure no-op DO request per live share per day, so gate on it
          const finalizeAfterMs = resolvePolicy(this.env).finalizeAfterMs
          if (meta.status === "live" && finalizeAfterMs > 0 && (meta.pluginSeen ?? 0) + finalizeAfterMs < Date.now()) {
            await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(id)).fetch("https://do/finalize", { method: "POST" })
            budget--
          }
        } catch (e) {
          console.log("[sweep] share error", id, e?.message || e)
        }
      }
    } finally {
      // pass done = listing exhausted AND no keys left to visit
      if (st.listDone && (!st.pageKeys || !st.pageKeys.length)) {
        st.done = true
        st.listDone = false
        if (purgeAll) st.purgeAll = false
      }
      await this.state.storage.put("sweepState", st)
      // re-arm 60s whenever work remains (pageKeys pending, or more pages
      // to list); on completion arm the daily tick
      if (!st.done) await this.state.storage.setAlarm(Date.now() + 60 * 1000)
      else await this.state.storage.setAlarm(Date.now() + 24 * 3600 * 1000)
    }
    console.log(`[sweep] chunk checked=${listed} swept=${swept} done=${st.done}${purgeAll ? " purge" : ""}`)
    return { ok: true, listed, swept, done: st.done }
  }
}
