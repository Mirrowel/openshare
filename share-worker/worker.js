// openshare-worker — Open(code)Share: self-hosted session sharing for
// opencode ("re:share"). Event-driven over hibernating WebSockets.
//
// Protocol:
//   HTTP (fallback + curl/testing):
//     POST   /api/share            {sessionID, ttlDays?, authLogin?, authPassword?}
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
//              init create {sessionID, ttlDays?, authLogin?, authPassword?}
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

// index.html with og:/twitter: tags for link-preview crawlers
async function serveOgIndex(req, env, url) {
  const r = await env.ASSETS.fetch(new Request(url.origin + "/index.html", { method: "GET" }))
  if (!r.ok) return r
  const name = brandingField(env, "name") || "openshare"
  const desc = brandingField(env, "description") || "shared agent sessions, self-hosted"
  const image = brandingField(env, "ogImage") || brandingField(env, "logoUrl") || ""
  const title = brandingField(env, "ogTitle") || `${name} · Open(code)Share`
  const absImage = image && image.startsWith("/") ? url.origin + image : image
  const tags = [
    `<meta property="og:title" content="${htmlEscape(title)}">`,
    `<meta property="og:description" content="${htmlEscape(desc)}">`,
    `<meta property="og:site_name" content="${htmlEscape(name)}">`,
    `<meta name="twitter:card" content="${absImage ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${htmlEscape(title)}">`,
    `<meta name="twitter:description" content="${htmlEscape(desc)}">`,
  ]
  if (absImage) {
    tags.splice(3, 0, `<meta property="og:image" content="${htmlEscape(absImage)}">`)
    tags.push(`<meta name="twitter:image" content="${htmlEscape(absImage)}">`)
  }
  const html = (await r.text()).replace(/<head>/i, "<head>\n    " + tags.join("\n    "))
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
}

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
        return env.ASSETS.fetch(req)
      }

      if (path === "/health")
        return json(200, { ok: true, service: "openshare", policy: resolvePolicy(env), auth: { mode: authMode(env) } })

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
        const r = await authCall(env, "/settings", { token: bearer(req), patch: body, maxTtl: clampTtl(undefined, env) })
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
        if (path === "/api/admin/codes" && req.method === "POST") return json(...(await call("/code-create")))
        if (path === "/api/admin/codes" && req.method === "GET") return json(...(await call("/codes-get")))
        m = path.match(/^\/api\/admin\/codes\/([^/]+)$/)
        if (m && req.method === "DELETE") return json(...(await call("/code-disable:" + m[1])))
        if (path === "/api/admin/shares" && req.method === "GET") {
          // global list straight from the KV index (ownerId rides along)
          const shares = []
          let cursor
          do {
            const page = await env.SHARE_INDEX.list({ cursor })
            for (const k of page.keys) {
              if (!k.name.startsWith("share:")) continue
              const raw = await env.SHARE_INDEX.get(k.name)
              if (raw) shares.push({ id: k.name.slice(6), ...JSON.parse(raw) })
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
      // Maintenance endpoint (owner-only): iterates the share index and
      // removes every ShareDO + index key. Existing viewers get a final
      // "gone" frame via each DO's /remove-all broadcast.
      if (path === "/api/admin/purge" && req.method === "POST") {
        const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
        if (!env.CREATE_TOKEN || token !== env.CREATE_TOKEN) return json(403, { error: "forbidden" })
        const removed = []
        let cursor
        do {
          const page = await env.SHARE_INDEX.list({ cursor })
          for (const k of page.keys) {
            const id = k.name.replace(/^share:/, "")
            if (!id) continue
            try {
              await env.SHARE_DO.get(env.SHARE_DO.idFromName(id)).fetch("https://do/remove-all", { method: "POST" })
              removed.push(id)
            } catch {}
          }
          cursor = page.list_complete ? undefined : page.cursor
        } while (cursor)
        return json(200, { ok: true, removed: removed.length })
      }

      if (path === "/branding") {
        const b = (field) => {
          const envKey = "BRAND_" + field.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase()
          return env[envKey] || DEFAULT_BRANDING[field] || ""
        }
        return new Response(JSON.stringify({
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
        }), {
          headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
        })
      }

      // ---- plugin control socket: forward the upgrade into a fresh DO ----
      if (path === "/api/ws") {
        const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token") ?? ""
        const fwd = new Request(url.origin + "/control-ws?token=" + encodeURIComponent(token), req)
        return env.SHARE_CONTROL.get(env.SHARE_CONTROL.newUniqueId()).fetch(fwd)
      }

      // ---- viewer socket: forward the upgrade into the ShareDO ----
      const wm = path.match(/^\/api\/share\/([0-9a-f]+)\/ws$/)
      if (wm && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return shareStub(env, wm[1]).fetch(new Request(`https://do/ws`, req))
      }

      const am = path.match(/^\/api\/share\/([0-9a-f]+)\/auth$/)
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

      const sm = path.match(/^\/api\/share\/([0-9a-f]+)(\/sync|\/data|)$/)
      if (!sm) return json(404, { error: "not found" })
      const id = sm[1]
      const op = sm[2]

      if (req.method === "POST" && op === "") {
        const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
        if (auth && env.CREATE_TOKEN && auth === env.CREATE_TOKEN) {
          // root bootstrap: ownerless create (legacy path keeps working)
          return await httpCreate(env, json, await req.json().catch(() => ({})), null, 0)
        }
        const chk = await authCall(env, "/create-check", { token: auth ?? "" })
        if (!chk.body?.ok) return json(chk.body?.httpStatus ?? 401, { error: chk.body?.error ?? "bad create token" })
        return await httpCreate(env, json, await req.json().catch(() => ({})), chk.body.userId ?? null, chk.body.ttlMaxDays ?? 0, chk.body.defaultTtlDays ?? 0)
      }

      if (req.method === "POST" && op === "/sync") {
        const body = await req.json().catch(() => ({}))
        const ident = await resolveIdentity(env, req, body)
        const r = await shareStub(env, id).fetch("https://do/sync", {
          method: "POST",
          body: JSON.stringify({ secret: body.secret ?? "", ownerId: ident.ownerId, root: ident.root, data: body.data ?? [], status: body.status }),
        })
        return json(r.status, await r.json())
      }

      if (req.method === "GET" && op === "/data") {
        const token = bearer(req) || cookieToken(req, id)
        const r = await shareStub(env, id).fetch(`https://do/data?token=${encodeURIComponent(token)}`)
        return new Response(await r.text(), {
          status: r.status,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        })
      }

      if (req.method === "DELETE" && op === "") {
        const body = await req.json().catch(() => ({}))
        const ident = await resolveIdentity(env, req, body)
        const r = await shareStub(env, id).fetch("https://do/remove", {
          method: "POST",
          body: JSON.stringify({ secret: body.secret ?? "", ownerId: ident.ownerId, root: ident.root }),
        })
        return json(r.status, await r.json())
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

function clampTtl(days, env, tokenMax = 0) {
  let max = Number(env.MAX_TTL_DAYS || 90)
  if (tokenMax > 0) max = Math.min(max, tokenMax)
  if (days == null || !Number.isFinite(Number(days))) return max
  return Math.max(1, Math.min(Math.floor(Number(days)), max))
}

function authMode(env) {
  return String(env.AUTH_MODE ?? "private").toLowerCase() === "public" ? "public" : "private"
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

async function httpCreate(env, json, body, ownerId, ttlMax, ownerDefault = 0) {
  if (!body.sessionID || typeof body.sessionID !== "string") return json(400, { error: "sessionID required" })
  const newId = randomId()
  const ttlDays = clampTtl(body.ttlDays ?? (ownerDefault || undefined), env, ttlMax)
  const r = await shareStub(env, newId).fetch("https://do/init", {
    method: "POST",
    body: JSON.stringify({
      id: newId,
      sessionID: body.sessionID,
      ttlDays,
      authLogin: body.authLogin ?? "",
      authPassword: body.authPassword ?? "",
      ownerId,
    }),
  })
  const out = await r.json()
  if (out.ok && ownerId) await authCall(env, "/register", { userId: ownerId, shareId: newId, sessionID: body.sessionID })
  if (out.ok) return json(r.status, { ...out, ttlDays })
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
  if (chk.body?.kind === "user") return { ownerId: chk.body.userId, root: false }
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
    this.token = ""
    this.earlySyncs = [] // syncs that raced init (each webSocketMessage runs concurrently)
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

  /** Resolve the socket's bearer token to {ownerId, root}. */
  async socketIdentity() {
    const t = this.token ?? ""
    if (t && this.env.CREATE_TOKEN && t === this.env.CREATE_TOKEN) return { ownerId: null, root: true }
    if (!t) return { ownerId: null, root: false }
    const chk = await this.authCall("/check", { token: t })
    return chk.kind === "user" ? { ownerId: chk.userId, root: false } : { ownerId: null, root: false }
  }

  /** Credential fields for ShareDO control calls (secret XOR owner XOR root). */
  attachBody() {
    return { secret: this.attachSecret ?? "", ownerId: this.attachOwner ?? null, root: !!this.attachRoot }
  }

  async saveAttach(id, secret, ownerId = null, root = false) {
    this.attachId = id
    this.attachSecret = secret
    this.attachOwner = ownerId
    this.attachRoot = root
    try {
      await this.state.storage.put("attach", { id, secret, ownerId, root })
    } catch {}
  }

  async clearAttach() {
    this.attachId = undefined
    this.attachSecret = undefined
    this.attachOwner = null
    this.attachRoot = false
    this.earlySyncs = []
    try {
      await this.state.storage.delete("attach")
    } catch {}
  }

  /** Replay syncs that arrived while init was still talking to the
   * ShareDO (concurrent webSocketMessage invocations). */
  async flushEarlySyncs(send) {
    const queued = this.earlySyncs
    this.earlySyncs = []
    for (const frame of queued) {
      if (this.attachId === undefined) {
        this.earlySyncs = queued
        return
      }
      try {
        const r = await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(this.attachId)).fetch("https://do/sync", {
          method: "POST",
          body: JSON.stringify({ ...this.attachBody(), data: frame.items ?? [], status: frame.status }),
        })
        const body = await r.json()
        send({ op: body.ok ? "ack" : "nack", ...body })
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

      if (frame.op === "init") {
        if (frame.create) {
          // identity: root bootstrap (ownerless), user token (owned,
          // limits enforced server-side), or anonymous on public servers
          let ownerId = null
          let ttlMax = 0
          let ownerDefault = 0
          if (!(this.token && this.env.CREATE_TOKEN && this.token === this.env.CREATE_TOKEN)) {
            const chk = await this.authCall("/create-check", { token: this.token ?? "" })
            if (!chk.ok) return send({ op: "init", ok: false, error: chk.error })
            ownerId = chk.userId ?? null
            ttlMax = chk.ttlMaxDays ?? 0
            ownerDefault = chk.defaultTtlDays ?? 0
          }
          const id = randomId()
          // explicit ttlDays wins; otherwise the owner's stored default
          // (PUT /api/me/settings), re-clamped against token+server caps
          const ttlDays = clampTtl(frame.create.ttlDays ?? (ownerDefault || undefined), this.env, ttlMax)
          const r = await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(id)).fetch("https://do/init", {
            method: "POST",
            body: JSON.stringify({
              id,
              sessionID: frame.create.sessionID,
              ttlDays,
              authLogin: frame.create.authLogin ?? "",
              authPassword: frame.create.authPassword ?? "",
              ownerId,
            }),
          })
          const body = await r.json()
          if (!body.ok) return send({ op: "init", ok: false, error: body.error })
          if (ownerId) await this.authCall("/register", { userId: ownerId, shareId: id, sessionID: frame.create.sessionID })
          await this.saveAttach(id, body.secret, ownerId)
          await this.flushEarlySyncs(send)
          return send({ op: "init", ok: true, id, secret: body.secret, rev: 0, status: "live", ttlDays, policy: resolvePolicy(this.env) })
        }
        if (frame.attach) {
          const ident = await this.socketIdentity()
          const r = await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(frame.attach.id)).fetch("https://do/attach", {
            method: "POST",
            body: JSON.stringify({
              secret: frame.attach.secret ?? "",
              ownerId: ident.ownerId,
              root: ident.root,
              authLogin: frame.attach.authLogin,
              authPassword: frame.attach.authPassword,
            }),
          })
        const body = await r.json()
        if (!body.ok) return send({ op: "init", ok: false, error: body.error })
        await this.saveAttach(frame.attach.id, frame.attach.secret, ident.ownerId, ident.root)
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
          })
        }
        return send({ op: "init", ok: false, error: "init needs create|attach" })
      }

      if (frame.op === "sync") {
        if (!this.attachId) {
          // a sync raced our init (webSocketMessage invocations run
          // concurrently; the init's ShareDO round-trip is in flight).
          // Buffer it — the init completion flushes in order.
          if (this.earlySyncs.length < 32) this.earlySyncs.push(frame)
          return
        }
        const r = await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(this.attachId)).fetch("https://do/sync", {
          method: "POST",
          body: JSON.stringify({ ...this.attachBody(), data: frame.items ?? [], status: frame.status }),
        })
        const body = await r.json()
        return send({ op: body.ok ? "ack" : "nack", ...body })
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
    return this.listPrefix("i:")
  }

  // Per-rev render cache for viewer loads. Both payload shapes build once
  // per revision; oversized shares (>25 MB) skip caching and re-render.
  async renderCache(meta) {
    const rev = meta.rev ?? 0
    if (this._cache && this._cache.rev === rev && this._cache.status === meta.status) return this._cache
    const items = redactItems(await this.loadItems())
    const frameStr = JSON.stringify({ v: 2, op: "frame", status: meta.status, rev, items })
    const dataStr = JSON.stringify({ v: 2, data: items, status: meta.status, rev })
    if (frameStr.length <= MAX_CACHE_JSON) {
      this._cache = { rev, status: meta.status, frameStr, dataStr }
      return this._cache
    }
    return { rev, status: meta.status, frameStr, dataStr }
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
        // doesn't need the full first frame again — an empty frame with
        // the rev/status keeps it in sync until the next broadcast
        const since = Number(url.searchParams.get("since") ?? "")
        const meta2 = meta
        if (Number.isFinite(since) && since === (meta2.rev ?? 0)) {
          pair[1].send(JSON.stringify({ op: "frame", rev: meta2.rev, status: meta2.status, items: [] }))
        } else {
          pair[1].send((await this.renderCache(meta)).frameStr)
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
        ttlDays: body.ttlDays ?? 90,
        createdAt: now,
        lastActive: now,
        pluginSeen: now,
        rev: 0,
        status: "live",
        ownerId: body.ownerId ?? null,
        frozen: false,
        auth,
        tokens: [],
        attempts: { ips: {}, total: 0, lockUntil: 0 },
      })
      try {
        await this.env.SHARE_INDEX.put(`share:${body.id}`, JSON.stringify({ createdAt: now, sessionID: body.sessionID, ownerId: body.ownerId ?? null }))
        await this.env.SWEEPER.get(this.env.SWEEPER.idFromName("singleton")).fetch("https://sweeper/arm", { method: "POST" })
      } catch (e) {
        console.log("[init] index error", e?.message || e)
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
          console.log("[attach] auth updated, tokens rotated")
        } else if (!wantAuth && meta.auth) {
          meta.auth = null
          console.log("[attach] auth removed (owner action)")
        }
        await this.state.storage.put("meta", meta)
      }

      const items = await this.loadItems()
      return json(200, {
        ok: true,
        rev: meta.rev ?? 0,
        status: meta.status,
        sessionID: meta.sessionID,
        data: redactItems(items),
      })
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
        attempts.total += 1
        if (ipState.fails >= 5) {
          ipState.lockUntil = now + Math.min(60000 * 2 ** (ipState.streak - 5), 86400000)
          ipState.fails = 0
        }
        if (attempts.total >= 20) attempts.lockUntil = now + 86400000
        meta.attempts = attempts
        await this.state.storage.put("meta", meta)
        const retryAfterMs = Math.max(ipState.lockUntil - now, attempts.lockUntil - now, 0)
        return json(401, { ok: false, error: "wrong credentials", retryAfterMs })
      }

      // success: reset this IP, mint a session token (max 5, LRU)
      delete attempts.ips[ip]
      attempts.total = Math.max(0, attempts.total - 1)
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
      return new Response((await this.renderCache(meta)).dataStr, { status: 200, headers: { "content-type": "application/json" } })
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
    // is unaffected — a frozen share is read-only until unfrozen or TTL.
    if (path === "/set-frozen" && req.method === "POST") {
      const body = await req.json()
      const meta = await this.state.storage.get("meta")
      if (!meta) return json(404, { ok: true })
      meta.frozen = !!body.frozen
      await this.state.storage.put("meta", meta)
      console.log("[set-frozen]", this.state.id.name, body.frozen ? "frozen" : "unfrozen")
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
        await this.env.SHARE_INDEX.put(`share:${this.state.id.name}`, JSON.stringify({ createdAt: meta.createdAt, sessionID: meta.sessionID, ownerId: meta.ownerId }))
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
    if (body?.ownerId && meta.ownerId && body.ownerId === meta.ownerId) return meta.frozen ? "frozen" : ""
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
    // One op per key: first-arrival position, last-arrival action, so the
    // broadcast order can never contradict the storage last-wins result
    // (e.g. a frame holding [tombstone K, upsert K] must leave K live on
    // the viewer too, not delete it after re-upserting).
    const ops = new Map() // shard key -> { shard, it, del }
    for (const raw of body.data ?? []) {
      const it = fitItem(raw)
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
    const dels = []
    const cascadePrefixes = []
    for (const op of ops.values()) {
      if (op.del) {
        dels.push(op.shard)
        if (op.it.type === "message" && op.it.data?.id) {
          // cascade: opencode's full-message cleanup removes the message
          // without per-part events; its parts must not linger as junk
          cascadePrefixes.push("i:part/" + op.it.data.id + "/")
        }
      } else puts.set(op.shard, op.it)
    }
    for (const prefix of cascadePrefixes) {
      let cursor
      do {
        const page = await this.state.storage.list({ prefix, cursor })
        for (const k of page.keys()) dels.push(k)
        cursor = page.list_complete ? undefined : page.cursor
      } while (cursor)
    }
    if (puts.size) await putBatched(this.state.storage, puts)
    if (dels.length) await deleteBatched(this.state.storage, dels)
    const rev = (meta.rev ?? 0) + 1
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
    for (const ws of this.state.getWebSockets("viewer")) {
      try { ws.send(JSON.stringify({ v: 2, ...frame })) } catch {}
    }
  }

  // finalize alarm: plugin gone without goodbye past the window
  async alarm() {
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
  }

  async fetch(req) {
    const url = new URL(req.url)
    const [route, param] = url.pathname.split(":")
    const body = await req.json().catch(() => ({}))
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
        case "/tokens-get": return json(...(await this.tokensGet()))
        case "/token-revoke": return json(...(await this.tokenRevoke(param)))
        case "/code-create": return json(...(await this.codeCreate(body)))
        case "/codes-get": return json(...(await this.codesGet()))
        case "/code-disable": return json(...(await this.codeDisable(param)))
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
    return { kind: "user", userId: t.userId, user: u, token: t }
  }

  async check(body) {
    const chk = await this.checkToken(typeof body.token === "string" ? body.token : "")
    if (chk.kind === "user") return { kind: "user", userId: chk.userId, label: chk.user.label }
    return { kind: chk.kind }
  }

  /** Pre-create authorization: resolves identity and enforces per-token
   * limits atomically (single-writer DO). Burns one daily-create slot on
   * success — a subsequent failed ShareDO init wastes at most one slot. */
  async createCheck(body) {
    const chk = await this.checkToken(typeof body.token === "string" ? body.token : "")
    if (chk.kind === "root") return { ok: true }
    if (chk.kind === "none") {
      if (authMode(this.env) === "public") return { ok: true } // anonymous ownerless
      return { ok: false, error: "token required", httpStatus: 401 }
    }
    const t = chk.token
    const now = Date.now()
    if (t.limits.maxLiveShares > 0) {
      const shares = (await this.state.storage.get(`uShares:${t.userId}`)) ?? []
      if (shares.length >= t.limits.maxLiveShares) return { ok: false, error: "max shares reached", httpStatus: 403 }
    }
    if (t.limits.dailyCreates > 0) {
      const key = `dc:${t.id}:${new Date(now).toISOString().slice(0, 10)}`
      const n = (await this.state.storage.get(key)) ?? 0
      if (n >= t.limits.dailyCreates) return { ok: false, error: "daily create limit reached", httpStatus: 429 }
      await this.state.storage.put(key, n + 1)
    }
    return { ok: true, userId: t.userId, ttlMaxDays: t.limits.maxTtlDays || 0, defaultTtlDays: Number(chk.user?.settings?.defaultTtlDays) || 0 }
  }

  // ---- enrollment + lifecycle ----------------------------------------------

  defaultLimits() {
    const num = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0 }
    return {
      maxLiveShares: num(this.env.DEFAULT_MAX_LIVE_SHARES),
      maxTtlDays: num(this.env.DEFAULT_MAX_TTL_DAYS),
      dailyCreates: num(this.env.DEFAULT_DAILY_CREATES),
    }
  }

  normLimits(input) {
    const d = this.defaultLimits()
    if (!input || typeof input !== "object") return d
    const one = (v, def) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 ? n : def }
    return {
      maxLiveShares: one(input.maxLiveShares, d.maxLiveShares),
      maxTtlDays: one(input.maxTtlDays, d.maxTtlDays),
      dailyCreates: one(input.dailyCreates, d.dailyCreates),
    }
  }

  async mint(userId, label, limits) {
    const value = "osk_" + randomId() + randomId()
    const hash = await sha256hex(value)
    const rec = { id: "t_" + randomId().slice(0, 10), hash, userId, label: String(label ?? "").slice(0, 64), limits, createdAt: Date.now(), lastUsedAt: 0, revokedAt: 0, expiresAt: 0 }
    await this.state.storage.put("t:" + hash, rec)
    return { value, rec }
  }

  async enroll(body) {
    const mode = authMode(this.env)
    const now = Date.now()
    let code = null
    if (body.code) {
      code = await this.state.storage.get("c:" + (await sha256hex(String(body.code))))
      const invalid = !code || code.disabled || (code.expiresAt && code.expiresAt < now) || (code.activationsLeft !== -1 && code.activationsLeft <= 0)
      if (invalid) return [403, { ok: false, error: "invalid code" }]
    } else if (mode !== "public") {
      return [403, { ok: false, error: "code required" }]
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
    const user = { id: "u_" + randomId().slice(0, 10), label, createdAt: now, frozen: false, settings: {} }
    await this.state.storage.put("u:" + user.id, user)
    const token = await this.mint(user.id, label, this.defaultLimits())
    console.log("[authdo] enrolled", user.id, label, code ? "via code" : "anonymous")
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

  async rotate(body) {
    const chk = await this.checkToken(typeof body.token === "string" ? body.token : "")
    if (chk.kind !== "user") return [401, { ok: false, error: "invalid token" }]
    const t = chk.token
    t.revokedAt = Date.now()
    await this.state.storage.put("t:" + t.hash, t)
    const fresh = await this.mint(t.userId, t.label, t.limits)
    return [200, { ok: true, token: fresh.value, userId: t.userId }]
  }

  async tokenDelete(body) {
    const chk = await this.checkToken(typeof body.token === "string" ? body.token : "")
    if (chk.kind !== "user") return [401, { ok: false, error: "invalid token" }]
    const t = chk.token
    t.revokedAt = Date.now()
    await this.state.storage.put("t:" + t.hash, t)
    return [200, { ok: true }]
  }

  // ---- self-service ---------------------------------------------------------

  tokenView(t) {
    return { id: t.id, label: t.label, limits: t.limits, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, expiresAt: t.expiresAt }
  }

  async me(body) {
    const chk = await this.checkToken(typeof body.token === "string" ? body.token : "")
    if (chk.kind !== "user") return [401, { ok: false, error: "invalid token" }]
    return [200, { ok: true, userId: chk.userId, label: chk.user.label, settings: chk.user.settings ?? {}, token: this.tokenView(chk.token) }]
  }

  async settings(body) {
    const chk = await this.checkToken(typeof body.token === "string" ? body.token : "")
    if (chk.kind !== "user") return [401, { ok: false, error: "invalid token" }]
    const u = chk.user
    const patch = body.patch ?? {}
    const next = { ...(u.settings ?? {}) }
    if (patch.defaultTtlDays !== undefined) {
      const n = Math.floor(Number(patch.defaultTtlDays))
      const max = Math.max(1, Math.floor(Number(body.maxTtl) || 90))
      next.defaultTtlDays = Number.isFinite(n) && n > 0 ? Math.min(n, max) : max
    }
    u.settings = next
    await this.state.storage.put("u:" + u.id, u)
    return [200, { ok: true, settings: next }]
  }

  async meShares(body) {
    const chk = await this.checkToken(typeof body.token === "string" ? body.token : "")
    if (chk.kind !== "user") return [401, { ok: false, error: "invalid token" }]
    const reg = (await this.state.storage.get(`uShares:${chk.userId}`)) ?? []
    const shares = await Promise.all(reg.map(async (s) => {
      const status = await this.shareField(s.id, "status")
      return { ...s, status }
    }))
    return [200, { ok: true, shares }]
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
      reg.push({ id: body.shareId, sessionID: body.sessionID ?? "", createdAt: Date.now() })
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
   * check, so both control paths sever together. */
  async userFreeze(freeze, body) {
    const u = await this.state.storage.get("u:" + body?.userId)
    if (!u) return [404, { ok: false, error: "no such user" }]
    u.frozen = !!freeze
    await this.state.storage.put("u:" + u.id, u)
    const reg = (await this.state.storage.get(`uShares:${u.id}`)) ?? []
    for (const s of reg) {
      try {
        await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(s.id)).fetch("https://do/set-frozen", {
          method: "POST", body: JSON.stringify({ frozen: !!freeze }),
        })
      } catch {}
    }
    console.log("[authdo] user", u.id, freeze ? "frozen" : "unfrozen", `(${reg.length} shares)`)
    return [200, { ok: true, frozen: !!freeze, shares: reg.length }]
  }

  async userDelete(userId, body) {
    const u = await this.state.storage.get("u:" + userId)
    if (!u) return [404, { ok: false, error: "no such user" }]
    if (String(body?.mode ?? "") === "delete") {
      const reg = (await this.state.storage.get(`uShares:${userId}`)) ?? []
      for (const s of reg) {
        try {
          await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(s.id)).fetch("https://do/remove-all", { method: "POST" })
        } catch {}
      }
      const tokens = await this.listPrefix("t:")
      for (const t of tokens.filter((t) => t.userId === userId)) {
        t.revokedAt = Date.now()
        await this.state.storage.put("t:" + t.hash, t)
      }
      await this.state.storage.delete(`uShares:${userId}`)
      await this.state.storage.delete("u:" + userId)
      console.log("[authdo] user deleted", userId, `(${reg.length} shares removed)`)
      return [200, { ok: true, mode: "delete", shares: reg.length }]
    }
    // default mode: freeze in place (reversible)
    return this.userFreeze(true, { userId })
  }

  async tokenMint(body) {
    const u = await this.state.storage.get("u:" + body?.userId)
    if (!u) return [404, { ok: false, error: "no such user" }]
    const t = await this.mint(u.id, body?.label, this.normLimits(body?.limits))
    return [200, { ok: true, token: t.value, id: t.rec.id, userId: u.id }]
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
    return [200, { ok: true }]
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
      if (!cur) await this.state.storage.setAlarm(Date.now() + 24 * 3600 * 1000)
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } })
    }
    if (url.pathname === "/sweep" && req.method === "POST") return this.sweep()
    return new Response("nf", { status: 404 })
  }

  async alarm() {
    await this.state.storage.setAlarm(Date.now() + 24 * 3600 * 1000)
    await this.sweep()
  }

  async sweep() {
    let listed = 0
    let swept = 0
    let cursor
    do {
      const page = await this.env.SHARE_INDEX.list({ cursor })
      cursor = page.list_cursor
      for (const k of page.keys) {
        if (!k.name.startsWith("share:")) continue
        listed++
        const id = k.name.slice("share:".length)
        try {
          const r = await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(id)).fetch("https://do/meta")
          if (r.status !== 200) {
            await this.env.SHARE_INDEX.delete(k.name)
            continue
          }
          const meta = await r.json()
          const ttlMs = (meta.ttlDays ?? 90) * 24 * 3600 * 1000
          if ((meta.lastActive ?? 0) + ttlMs < Date.now()) {
            await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(id)).fetch("https://do/remove-all", { method: "POST" })
            swept++
            continue
          }
          // backstop: "live" shares whose plugin has been silent past the
          // finalize window (silent socket deaths where even the close
          // never surfaced) settle to interrupted; /finalize no-ops when
          // the plugin is around or the share already settled
          if (meta.status === "live") {
            await this.env.SHARE_DO.get(this.env.SHARE_DO.idFromName(id)).fetch("https://do/finalize", { method: "POST" })
          }
        } catch (e) {
          console.log("[sweep] share error", id, e?.message || e)
        }
      }
    } while (cursor && listed < 5000)
    console.log(`[sweep] checked=${listed} swept=${swept}`)
    return new Response(JSON.stringify({ ok: true, listed, swept }), { headers: { "content-type": "application/json" } })
  }
}
