// openshare-server — the portable Open(code)Share backend.
//
// One Bun process, one SQLite file, native WebSockets: the SAME protocol
// as share-worker/worker.js (routes, frames, policy vars, auth model) so
// the same plugin and the same test suites run against either backend.
// worker.js stays the reference implementation; the ~pure helpers here
// mirror it deliberately (a shared module would force a re-verification
// of the production worker's bundling — parity via the identical suite
// is the stronger, lower-friction guarantee).
//
// Protocol parity (see share-worker/worker.js header for the contract):
//   HTTP: POST /api/share/<hex> (create), /api/share/:id/sync|/auth,
//         GET /api/share/:id/data, DELETE /api/share/:id, /health,
//         /branding, /api/enroll, /api/me*, /api/token*, /api/admin/*
//   WS:   /api/ws?token= (plugin control: init create/attach, sync, delete)
//         /api/share/:id/ws (viewer: frame pushes)
//
// Env: PORT (8787), CREATE_TOKEN (root admin + legacy creates — REQUIRED
// for admin), AUTH_MODE (private|public), MAX_TTL_DAYS, policy vars
// (SOCKET_POLICY/TURN_GRACE_MS/IDLE_DROP_MS/FINALIZE_AFTER_MS/
// DEBOUNCE_MIN_MS/DEBOUNCE_MAX_MS/COMPLETED_DELAY_MAX_MS), DEFAULT_*
// token limits, OPENSHARE_DB (sqlite path, default ./openshare.db),
// VIEWER_DIR (static viewer, default ../share-viewer/dist), BRAND_*.
//
// Run: bun server.ts   |   Docker: oven/bun (see Dockerfile)

import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

// --- env -------------------------------------------------------------------
const PORT = Number(process.env.PORT ?? 8787)
const CREATE_TOKEN = process.env.CREATE_TOKEN ?? ""
const MAX_TTL_DAYS = Number(process.env.MAX_TTL_DAYS ?? 90)
const DB_PATH = process.env.OPENSHARE_DB ?? join(here, "openshare.db")
const VIEWER_DIR = process.env.VIEWER_DIR ?? join(here, "..", "share-viewer", "dist")

function authMode(): "public" | "private" {
  return String(process.env.AUTH_MODE ?? "private").toLowerCase() === "public" ? "public" : "private"
}

function resolvePolicy() {
  let mode = String(process.env.SOCKET_POLICY ?? "auto").toLowerCase()
  if (mode !== "persistent" && mode !== "turn") mode = "auto"
  if (mode === "auto") {
    // a self-hosted single process has no hibernation: sockets cost real
    // fds, so the sane default here is turn-scoped (unlike Cloudflare)
    mode = "turn"
  }
  const num = (v: unknown, d: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : d
  }
  const min = num(process.env.DEBOUNCE_MIN_MS, 1000)
  return {
    mode: mode as "persistent" | "turn",
    turnGraceMs: num(process.env.TURN_GRACE_MS, 120000),
    idleDropMs: num(process.env.IDLE_DROP_MS, 600000),
    finalizeAfterMs: num(process.env.FINALIZE_AFTER_MS, 300000),
    debounceMinMs: min,
    debounceMaxMs: Math.max(num(process.env.DEBOUNCE_MAX_MS, 60000), min),
    completedDelayMaxMs: num(process.env.COMPLETED_DELAY_MAX_MS, 60000),
  }
}

function clampTtl(days: unknown, tokenMax = 0): number {
  let max = MAX_TTL_DAYS
  if (tokenMax > 0) max = Math.min(max, tokenMax)
  if (days == null || !Number.isFinite(Number(days))) return max
  return Math.max(1, Math.min(Math.floor(Number(days)), max))
}

// --- pure helpers (mirror worker.js) ---------------------------------------
const encoder = new TextEncoder()

function randomId(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
}

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", encoder.encode(s))
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("")
}

async function pbkdf2(value: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(value), "PBKDF2", false, ["deriveBits"])
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: 10000 }, key, 256)
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, "0")).join("")
}

const STATUSES = new Set(["live", "completed", "error", "interrupted"])

function itemKey(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return
  const t = (item as Record<string, unknown>).type
  const d = (item as Record<string, unknown>).data as Record<string, unknown> | undefined
  if (t === "session") return "session/" + (d?.id ?? "")
  if (t === "session_diff") return "session_diff/" + ((item as Record<string, unknown>).sessionID ?? d?.sessionID ?? "")
  if (t === "message") return "message/" + (d?.id ?? "")
  if (t === "part") return "part/" + (d?.messageID ?? "") + "/" + (d?.id ?? "")
  if (t === "model") return "model/" + ((item as Record<string, unknown>).sessionID ?? d?.sessionID ?? "")
  if (t === "prefs") return "prefs"
  return
}

function redactItems(items: unknown[]): unknown[] {
  return items.map((it) => {
    if ((it as { type?: string })?.type === "session" && (it as { data?: { metadata?: unknown } }).data?.metadata) {
      const { metadata, ...rest } = (it as { data: Record<string, unknown> }).data
      return { ...it, data: rest }
    }
    return it
  })
}

// --- storage ---------------------------------------------------------------
const db = new Database(DB_PATH)
db.exec("PRAGMA journal_mode = WAL")
db.exec(`CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY, secret TEXT NOT NULL, sessionID TEXT NOT NULL,
  ttlDays INTEGER NOT NULL, createdAt INTEGER NOT NULL, lastActive INTEGER NOT NULL,
  pluginSeen INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'live',
  ownerId TEXT, frozen INTEGER NOT NULL DEFAULT 0, auth TEXT, tokens TEXT NOT NULL DEFAULT '[]',
  attempts TEXT NOT NULL DEFAULT '{}', finalizeAt INTEGER)`)
db.exec(`CREATE TABLE IF NOT EXISTS items (shareId TEXT NOT NULL, key TEXT NOT NULL, item TEXT NOT NULL, PRIMARY KEY (shareId, key))`)
db.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, label TEXT NOT NULL, createdAt INTEGER NOT NULL, frozen INTEGER NOT NULL DEFAULT 0, settings TEXT NOT NULL DEFAULT '{}')`)
db.exec(`CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, userId TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', limits TEXT NOT NULL DEFAULT '{}', createdAt INTEGER NOT NULL, lastUsedAt INTEGER NOT NULL DEFAULT 0, revokedAt INTEGER NOT NULL DEFAULT 0, expiresAt INTEGER NOT NULL DEFAULT 0)`)
db.exec(`CREATE TABLE IF NOT EXISTS codes (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, label TEXT NOT NULL, activationsLeft INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0)`)
db.exec(`CREATE TABLE IF NOT EXISTS rate (ip TEXT PRIMARY KEY, n INTEGER NOT NULL, resetAt INTEGER NOT NULL)`)
db.exec(`CREATE TABLE IF NOT EXISTS dcreates (k TEXT PRIMARY KEY, n INTEGER NOT NULL)`)

type ShareRow = {
  id: string; secret: string; sessionID: string; ttlDays: number; createdAt: number; lastActive: number
  pluginSeen: number; rev: number; status: string; ownerId: string | null; frozen: number
  auth: string | null; tokens: string; attempts: string; finalizeAt: number | null
}

const q = {
  share: (id: string) => db.query<ShareRow, string>("SELECT * FROM shares WHERE id = ?").get(id),
}

// --- identity ----------------------------------------------------------------

type TokenRow = { id: string; hash: string; userId: string; label: string; limits: string; createdAt: number; lastUsedAt: number; revokedAt: number; expiresAt: number }

function defaultLimits() {
  const num = (v: unknown) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0 }
  return {
    maxLiveShares: num(process.env.DEFAULT_MAX_LIVE_SHARES),
    maxTtlDays: num(process.env.DEFAULT_MAX_TTL_DAYS),
    dailyCreates: num(process.env.DEFAULT_DAILY_CREATES),
  }
}

function normLimits(input: unknown) {
  const d = defaultLimits()
  if (!input || typeof input !== "object") return d
  const one = (v: unknown, def: number) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 ? n : def }
  const i = input as Record<string, unknown>
  return { maxLiveShares: one(i.maxLiveShares, d.maxLiveShares), maxTtlDays: one(i.maxTtlDays, d.maxTtlDays), dailyCreates: one(i.dailyCreates, d.dailyCreates) }
}

async function checkToken(token: string): Promise<{ kind: "none" | "root" } | { kind: "user"; token: TokenRow; userId: string }> {
  if (!token) return { kind: "none" }
  if (CREATE_TOKEN && token === CREATE_TOKEN) return { kind: "root" }
  const row = db.query<TokenRow, string>("SELECT * FROM tokens WHERE hash = ?").get(await sha256hex(token))
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt < Date.now())) return { kind: "none" }
  const user = db.query("SELECT * FROM users WHERE id = ?").get(row.userId) as { frozen: number } | undefined
  if (!user || user.frozen) return { kind: "none" }
  if (Date.now() - row.lastUsedAt > 60000) db.query("UPDATE tokens SET lastUsedAt = ? WHERE id = ?").run(Date.now(), row.id)
  return { kind: "user", token: row, userId: row.userId }
}

async function createCheck(token: string): Promise<{ ok: true; userId?: string; ttlMaxDays?: number } | { ok: false; error: string; httpStatus: number }> {
  const chk = await checkToken(token)
  if (chk.kind === "root") return { ok: true }
  if (chk.kind === "none") {
    if (authMode() === "public") return { ok: true } // anonymous ownerless
    return { ok: false, error: "token required", httpStatus: 401 }
  }
  const limits = JSON.parse(chk.token.limits) as { maxLiveShares: number; maxTtlDays: number; dailyCreates: number }
  if (limits.maxLiveShares > 0) {
    const n = db.query("SELECT COUNT(*) c FROM shares WHERE ownerId = ?").get(chk.userId) as { c: number }
    if (n.c >= limits.maxLiveShares) return { ok: false, error: "max shares reached", httpStatus: 403 }
  }
  if (limits.dailyCreates > 0) {
    const k = `${chk.token.id}:${new Date().toISOString().slice(0, 10)}`
    const row = db.query("SELECT n FROM dcreates WHERE k = ?").get(k) as { n: number } | undefined
    if ((row?.n ?? 0) >= limits.dailyCreates) return { ok: false, error: "daily create limit reached", httpStatus: 429 }
    db.query("INSERT INTO dcreates (k, n) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1").run(k)
  }
  return { ok: true, userId: chk.userId, ttlMaxDays: limits.maxTtlDays || 0 }
}

async function mint(userId: string, label: string, limits: unknown): Promise<{ value: string; id: string }> {
  const value = "osk_" + randomId() + randomId()
  const hash = await sha256hex(value)
  const id = "t_" + randomId().slice(0, 10)
  db.query("INSERT INTO tokens (id, hash, userId, label, limits, createdAt) VALUES (?, ?, ?, ?, ?, ?)").run(id, hash, userId, String(label ?? "").slice(0, 64), JSON.stringify(normLimits(limits)), Date.now())
  return { value, id }
}

// --- share ops -----------------------------------------------------------------

function makeAuth(login: string, password: string) {
  return pbkdf2(login, "").then(async () => {
    const salt = randomId() + randomId()
    const [loginHash, passHash] = await Promise.all([pbkdf2(login, salt), pbkdf2(password, salt)])
    return JSON.stringify({ salt, loginHash, passHash })
  })
}

function createShare(sessionID: string, ttlDays: number, ownerId: string | null, authLogin: string, authPassword: string): { id: string; secret: string } {
  const id = randomId()
  const secret = randomId() + randomId()
  const auth = authLogin && authPassword ? JSON.stringify({ salt: "", loginHash: "", passHash: "" }) : null
  db.query("INSERT INTO shares (id, secret, sessionID, ttlDays, createdAt, lastActive, pluginSeen, rev, status, ownerId, auth) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'live', ?, ?)")
    .run(id, secret, sessionID, ttlDays, Date.now(), Date.now(), Date.now(), ownerId, auth)
  if (authLogin && authPassword) {
    // hash asynchronously then persist (the synchronous insert keeps the
    // response fast; the gate materializes a moment later)
    void makeAuth(authLogin, authPassword).then((a) => db.query("UPDATE shares SET auth = ? WHERE id = ?").run(a, id))
  }
  return { id, secret }
}

/** Write gate parity: owner token (ownerId resolved server-side), root, or
 * the per-share secret — while the owner is in good standing. */
function writeGate(share: ShareRow, body: { secret?: string; ownerId?: string | null; root?: boolean }): "" | "forbidden" | "frozen" {
  if (body.root === true) return ""
  if (body.secret && body.secret === share.secret) return share.frozen ? "frozen" : ""
  if (body.ownerId && share.ownerId && body.ownerId === share.ownerId) return share.frozen ? "frozen" : ""
  return "forbidden"
}

type Frame = { op?: string; items?: unknown[]; status?: string; [k: string]: unknown }

// Contract-level item cap (~1.5MB, mirrors the CF worker's fitItem): no
// single item may exceed it on ANY backend, so behavior is uniform.
const MAX_ITEM_JSON = 1_500_000
function fitItem<T>(it: T): T {
  const s = JSON.stringify(it)
  if (s.length <= MAX_ITEM_JSON) return it
  const clone = structuredClone(it) as Record<string, unknown>
  const clips: Array<{ obj: Record<string, unknown>; key: string }> = []
  const walk = (obj: unknown) => {
    if (!obj || typeof obj !== "object") return
    if (Array.isArray(obj)) { for (const v of obj) walk(v); return }
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === "string" && v.length > 1024) clips.push({ obj: obj as Record<string, unknown>, key: k })
      else if (v && typeof v === "object") walk(v)
    }
  }
  walk(clone)
  clips.sort((a, b) => String(b.obj[b.key]).length - String(a.obj[a.key]).length)
  for (let round = 0; round < 4 && JSON.stringify(clone).length > MAX_ITEM_JSON; round++) {
    for (const c of clips) {
      const v = String(c.obj[c.key])
      c.obj[c.key] = v.slice(0, Math.max(1024, Math.floor(v.length / 2))) + "\n…[openshare: field truncated for share]"
      if (JSON.stringify(clone).length <= MAX_ITEM_JSON) break
    }
  }
  if (JSON.stringify(clone).length > MAX_ITEM_JSON) {
    const raw = it as { type?: string; sessionID?: string; data?: { id?: string } }
    return { type: raw.type, sessionID: raw.sessionID, data: { id: raw.data?.id }, _oshDropped: "oversize" } as unknown as T
  }
  ;(clone as Record<string, unknown>)._oshTruncated = true
  return clone as T
}

function applySync(shareId: string, body: { secret?: string; ownerId?: string | null; root?: boolean; data?: unknown[]; status?: string }): { status: number; body: Record<string, unknown> } {
  const share = q.share(shareId)
  if (!share) return { status: 404, body: { ok: false, error: "share not found" } }
  const gate = writeGate(share, body)
  if (gate) return { status: 403, body: { ok: false, error: gate } }
  const rev = share.rev + 1
  const batch: unknown[] = []
  const tx = db.transaction(() => {
    for (const raw of body.data ?? []) {
      const it = (raw as { del?: boolean }).del ? raw : fitItem(raw)
      const key = itemKey(it)
      if (!key) continue
      if ((it as { del?: boolean }).del) {
        db.query("DELETE FROM items WHERE shareId = ? AND key = ?").run(shareId, key)
        batch.push(it)
        if ((it as { type?: string }).type === "message" && (it as { data?: { id?: string } }).data?.id) {
          const prefix = `part/${(it as { data: { id: string } }).data.id}/`
          const parts = db.query("SELECT key, item FROM items WHERE shareId = ? AND key LIKE ?").all(shareId, prefix + "%") as Array<{ key: string; item: string }>
          for (const p of parts) {
            db.query("DELETE FROM items WHERE shareId = ? AND key = ?").run(shareId, p.key)
            batch.push(JSON.parse(p.item))
          }
        }
      } else {
        db.query("INSERT INTO items (shareId, key, item) VALUES (?, ?, ?) ON CONFLICT(shareId, key) DO UPDATE SET item = excluded.item").run(shareId, key, JSON.stringify(it))
        batch.push(it)
      }
    }
    const status = body.status && STATUSES.has(body.status) ? body.status : share.status
    db.query("UPDATE shares SET rev = ?, lastActive = ?, pluginSeen = ?, status = ?, finalizeAt = NULL WHERE id = ?").run(rev, Date.now(), Date.now(), status, shareId)
  })
  tx()
  const updated = q.share(shareId)!
  broadcast(shareId, { op: "frame", status: updated.status, rev, items: redactItems(batch) })
  return { status: 200, body: { ok: true, rev, status: updated.status } }
}

function shareData(share: ShareRow) {
  const items = db.query("SELECT item FROM items WHERE shareId = ?").all(share.id) as Array<{ item: string }>
  return items.map((r) => JSON.parse(r.item))
}

async function validViewerToken(share: ShareRow, token: string): Promise<boolean> {
  if (!token || !share.auth) return false
  const auth = JSON.parse(share.auth) as { loginHash: string; passHash: string; salt: string }
  return await pbkdf2(token, auth.salt).then((h) => h === auth.passHash)
}

// viewer sockets: in-memory subscribers (reconnect + refetch on restart)
const viewers = new Map<string, Set<Bun.WebSocket>>()
function broadcast(shareId: string, frame: unknown) {
  const set = viewers.get(shareId)
  if (!set) return
  const s = JSON.stringify({ v: 2, ...(frame as Record<string, unknown>) })
  for (const ws of set) try { ws.send(s) } catch {}
}

function json(code: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } })
}

function bearer(req: Request): string {
  return req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""
}

// --- HTTP -----------------------------------------------------------------------

async function httpHandler(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === "/health") return json(200, { ok: true, service: "openshare", policy: resolvePolicy(), auth: { mode: authMode() } })

  if (path === "/branding") {
    const b = (f: string) => (process.env["BRAND_" + f.replace(/[a-z]/g, (c) => c === f[0] ? c.toUpperCase() : c)] ?? "")
    return json(200, { name: process.env.BRAND_NAME ?? "", logoUrl: process.env.BRAND_LOGO_URL ?? "", wordmarkUrl: process.env.BRAND_WORDMARK_URL ?? "", linkUrl: process.env.BRAND_LINK_URL ?? "", accent: process.env.BRAND_ACCENT ?? "", faviconUrl: process.env.BRAND_FAVICON_URL ?? "", backgroundUrl: process.env.BRAND_BACKGROUND_URL ?? "", description: process.env.BRAND_DESCRIPTION ?? "", ogTitle: process.env.BRAND_OG_TITLE ?? "", ogImage: process.env.BRAND_OG_IMAGE ?? "" })
  }

  // identity
  if (path === "/api/enroll" && req.method === "POST") return enrollRoute(await bodyJson(req), req)
  if (path === "/api/me" && req.method === "GET") return meRoute(bearer(req))
  if (path === "/api/me/settings" && (req.method === "GET" || req.method === "PUT")) return settingsRoute(bearer(req), await bodyJson(req))
  if (path === "/api/me/shares" && req.method === "GET") return meSharesRoute(bearer(req))
  if (path === "/api/token/rotate" && req.method === "POST") return rotateRoute(bearer(req))
  if (path === "/api/token" && req.method === "DELETE") return tokenDeleteRoute(bearer(req))

  // admin (root only)
  if (path.startsWith("/api/admin/") && path !== "/api/admin/purge") {
    if (!CREATE_TOKEN || bearer(req) !== CREATE_TOKEN) return json(403, { error: "forbidden" })
    return adminRoute(req, path, await bodyJson(req))
  }
  if (path === "/api/admin/purge" && req.method === "POST") {
    if (!CREATE_TOKEN || bearer(req) !== CREATE_TOKEN) return json(403, { error: "forbidden" })
    const rows = db.query("SELECT id FROM shares").all() as Array<{ id: string }>
    for (const r of rows) removeShare(r.id)
    return json(200, { ok: true, removed: rows.length })
  }

  // viewer socket upgrade
  const wm = path.match(/^\/api\/share\/([0-9a-f]+)\/ws$/)
  if (wm && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const share = q.share(wm[1])
    if (!share) return new Response("gone", { status: 404 })
    if (share.auth) {
      const cookie = (req.headers.get("cookie") ?? "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === `osh_${share.id}`)
      const token = cookie ? cookie.slice(1).join("=") : ""
      if (!(await validViewerToken(share, token))) return new Response("auth required", { status: 401 })
    }
    return new Response(null, { status: 200 }) // upgraded in fetch() below
  }

  const am = path.match(/^\/api\/share\/([0-9a-f]+)\/auth$/)
  if (am && req.method === "POST") return shareAuthRoute(am[1], await bodyJson(req), req)

  const sm = path.match(/^\/api\/share\/([0-9a-f]+)(\/sync|\/data|)$/)
  if (!sm) return staticOr404(req, url)
  const id = sm[1]
  const op = sm[2]

  if (req.method === "POST" && op === "") {
    const auth = bearer(req)
    if (auth && CREATE_TOKEN && auth === CREATE_TOKEN) return httpCreate(await bodyJson(req), null, 0)
    const chk = await createCheck(auth)
    if (!chk.ok) return json(chk.httpStatus, { error: chk.error })
    return httpCreate(await bodyJson(req), chk.userId ?? null, chk.ttlMaxDays ?? 0)
  }
  if (req.method === "POST" && op === "/sync") {
    const body = await bodyJson(req)
    const ident = await resolveIdentity(req, body)
    const r = applySync(id, { ...body, ownerId: ident.ownerId, root: ident.root })
    return json(r.status, r.body)
  }
  if (req.method === "GET" && op === "/data") {
    const share = q.share(id)
    if (!share) return json(404, { data: [], status: "gone", rev: 0 })
    if (share.auth && !(await validViewerToken(share, bearer(req) || cookieToken(req, id)))) {
      return json(401, { authRequired: true })
    }
    return json(200, { v: 2, data: redactItems(shareData(share)), status: share.status, rev: share.rev })
  }
  if (req.method === "DELETE" && op === "") {
    const body = await bodyJson(req)
    const share = q.share(id)
    if (!share) return json(404, { ok: true })
    const gate = writeGate(share, body)
    if (gate) return json(403, { ok: false, error: gate })
    removeShare(id)
    return json(200, { ok: true })
  }
  return json(404, { error: "not found" })
}

async function resolveIdentity(req: Request, body: { secret?: string }): Promise<{ ownerId: string | null; root: boolean }> {
  if (body.secret) return { ownerId: null, root: false }
  const token = bearer(req)
  if (!token) return { ownerId: null, root: false }
  if (CREATE_TOKEN && token === CREATE_TOKEN) return { ownerId: null, root: true }
  const chk = await checkToken(token)
  return chk.kind === "user" ? { ownerId: chk.userId, root: false } : { ownerId: null, root: false }
}

async function httpCreate(body: Record<string, unknown>, ownerId: string | null, ttlMax: number): Promise<Response> {
  if (!body.sessionID || typeof body.sessionID !== "string") return json(400, { error: "sessionID required" })
  const ttlDays = clampTtl(body.ttlDays, ttlMax)
  const { id, secret } = createShare(body.sessionID, ttlDays, ownerId, String(body.authLogin ?? ""), String(body.authPassword ?? ""))
  return json(200, { ok: true, id, secret, ttlDays })
}

function removeShare(id: string) {
  broadcast(id, { op: "frame", status: "gone", rev: 1, items: [] })
  db.query("DELETE FROM shares WHERE id = ?").run(id)
  db.query("DELETE FROM items WHERE shareId = ?").run(id)
}

async function bodyJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json()
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function cookieToken(req: Request, shareId: string): string {
  const raw = req.headers.get("cookie") ?? ""
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=")
    if (k === `osh_${shareId}`) return v.join("=")
  }
  return ""
}

// --- identity routes -------------------------------------------------------------

async function enrollRoute(body: Record<string, unknown>, req: Request): Promise<Response> {
  const now = Date.now()
  let codeRow: { id: string; hash: string; label: string; activationsLeft: number; used: number; expiresAt: number; disabled: number } | undefined
  if (body.code) {
    codeRow = db.query("SELECT * FROM codes WHERE hash = ?").get(await sha256hex(String(body.code))) as typeof codeRow
    if (!codeRow || codeRow.disabled || (codeRow.expiresAt && codeRow.expiresAt < now) || (codeRow.activationsLeft !== -1 && codeRow.activationsLeft <= 0)) {
      return json(403, { ok: false, error: "invalid code" })
    }
  } else if (authMode() !== "public") {
    return json(403, { ok: false, error: "code required" })
  }
  if (!codeRow) {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local"
    const row = db.query("SELECT * FROM rate WHERE ip = ?").get(ip) as { ip: string; n: number; resetAt: number } | undefined
    if (!row || row.resetAt < now) db.query("INSERT INTO rate (ip, n, resetAt) VALUES (?, 1, ?) ON CONFLICT(ip) DO UPDATE SET n = 1, resetAt = ?").run(ip, now + 3600000, now + 3600000)
    else if (row.n >= 10) return json(429, { ok: false, error: "too many enrollments, try later" })
    else db.query("UPDATE rate SET n = n + 1 WHERE ip = ?").run(ip)
  }
  if (codeRow) {
    db.query("UPDATE codes SET used = used + 1, activationsLeft = CASE WHEN activationsLeft = -1 THEN -1 ELSE activationsLeft - 1 END WHERE id = ?").run(codeRow.id)
  }
  const label = String(body.label ?? "").trim().slice(0, 64) || (codeRow ? `${codeRow.label || "invite"}-${codeRow.used + 1}` : "user-" + randomId().slice(0, 4))
  const userId = "u_" + randomId().slice(0, 10)
  db.query("INSERT INTO users (id, label, createdAt) VALUES (?, ?, ?)").run(userId, label, now)
  const token = await mint(userId, label, defaultLimits())
  console.log(`[auth] enrolled ${userId} ${label}${codeRow ? " via code" : " anonymous"}`)
  return json(200, { ok: true, token: token.value, userId, label })
}

async function meRoute(token: string): Promise<Response> {
  const chk = await checkToken(token)
  if (chk.kind !== "user") return json(401, { ok: false, error: "invalid token" })
  const user = db.query("SELECT * FROM users WHERE id = ?").get(chk.userId) as { label: string; settings: string }
  const t = chk.token
  return json(200, { ok: true, userId: chk.userId, label: user.label, settings: JSON.parse(user.settings), token: { id: t.id, label: t.label, limits: JSON.parse(t.limits), createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, expiresAt: t.expiresAt } })
}

async function settingsRoute(token: string, patch: Record<string, unknown>): Promise<Response> {
  const chk = await checkToken(token)
  if (chk.kind !== "user") return json(401, { ok: false, error: "invalid token" })
  const user = db.query("SELECT * FROM users WHERE id = ?").get(chk.userId) as { settings: string }
  const next = JSON.parse(user.settings) as Record<string, unknown>
  if (patch.defaultTtlDays !== undefined) {
    const n = Math.floor(Number(patch.defaultTtlDays))
    next.defaultTtlDays = Number.isFinite(n) && n > 0 ? Math.min(n, Math.max(1, MAX_TTL_DAYS)) : Math.max(1, MAX_TTL_DAYS)
  }
  db.query("UPDATE users SET settings = ? WHERE id = ?").run(JSON.stringify(next), chk.userId)
  return json(200, { ok: true, settings: next })
}

async function meSharesRoute(token: string): Promise<Response> {
  const chk = await checkToken(token)
  if (chk.kind !== "user") return json(401, { ok: false, error: "invalid token" })
  const rows = db.query("SELECT id, sessionID, createdAt, status FROM shares WHERE ownerId = ?").all(chk.userId) as Array<{ id: string; sessionID: string; createdAt: number; status: string }>
  return json(200, { ok: true, shares: rows })
}

async function rotateRoute(token: string): Promise<Response> {
  const chk = await checkToken(token)
  if (chk.kind !== "user") return json(401, { ok: false, error: "invalid token" })
  db.query("UPDATE tokens SET revokedAt = ? WHERE id = ?").run(Date.now(), chk.token.id)
  const fresh = await mint(chk.userId, chk.token.label, JSON.parse(chk.token.limits))
  return json(200, { ok: true, token: fresh.value, userId: chk.userId })
}

async function tokenDeleteRoute(token: string): Promise<Response> {
  const chk = await checkToken(token)
  if (chk.kind !== "user") return json(401, { ok: false, error: "invalid token" })
  db.query("UPDATE tokens SET revokedAt = ? WHERE id = ?").run(Date.now(), chk.token.id)
  return json(200, { ok: true })
}

async function adminRoute(req: Request, path: string, body: Record<string, unknown>): Promise<Response> {
  let m = path.match(/^\/api\/admin\/users\/([^/]+)\/(freeze|unfreeze)$/)
  if (m && req.method === "POST") {
    const userId = m[1]
    const freeze = m[2] !== "unfreeze"
    const user = db.query("SELECT id FROM users WHERE id = ?").get(userId)
    if (!user) return json(404, { ok: false, error: "no such user" })
    db.query("UPDATE users SET frozen = ? WHERE id = ?").run(freeze ? 1 : 0, userId)
    const n = (db.query("SELECT COUNT(*) c FROM shares WHERE ownerId = ?").get(userId) as { c: number }).c
    db.query("UPDATE shares SET frozen = ? WHERE ownerId = ?").run(freeze ? 1 : 0, userId)
    return json(200, { ok: true, frozen: freeze, shares: n })
  }
  m = path.match(/^\/api\/admin\/users\/([^/]+)$/)
  if (m && req.method === "DELETE") {
    const userId = m[1]
    const user = db.query("SELECT id FROM users WHERE id = ?").get(userId)
    if (!user) return json(404, { ok: false, error: "no such user" })
    if (String(body.mode ?? "") === "delete") {
      const rows = db.query("SELECT id FROM shares WHERE ownerId = ?").all(userId) as Array<{ id: string }>
      for (const r of rows) removeShare(r.id)
      db.query("UPDATE tokens SET revokedAt = ? WHERE userId = ?").run(Date.now(), userId)
      db.query("DELETE FROM users WHERE id = ?").run(userId)
      return json(200, { ok: true, mode: "delete", shares: rows.length })
    }
    db.query("UPDATE users SET frozen = 1 WHERE id = ?").run(userId)
    const n = (db.query("SELECT COUNT(*) c FROM shares WHERE ownerId = ?").get(userId) as { c: number }).c
    db.query("UPDATE shares SET frozen = 1 WHERE ownerId = ?").run(userId)
    return json(200, { ok: true, frozen: true, shares: n })
  }
  if (path === "/api/admin/users" && req.method === "POST") {
    const label = String(body.label ?? "").trim().slice(0, 64) || "user-" + randomId().slice(0, 4)
    const id = "u_" + randomId().slice(0, 10)
    db.query("INSERT INTO users (id, label, createdAt) VALUES (?, ?, ?)").run(id, label, Date.now())
    return json(200, { ok: true, userId: id, label })
  }
  if (path === "/api/admin/users" && req.method === "GET") {
    const users = db.query("SELECT * FROM users").all() as Array<{ id: string; label: string; createdAt: number; frozen: number }>
    const tokens = db.query("SELECT * FROM tokens").all() as TokenRow[]
    const out = users.map((u) => {
      const toks = tokens.filter((t) => t.userId === u.id)
      const shares = (db.query("SELECT COUNT(*) c FROM shares WHERE ownerId = ?").get(u.id) as { c: number }).c
      return { id: u.id, label: u.label, createdAt: u.createdAt, frozen: !!u.frozen, shares, tokens: toks.length, tokensActive: toks.filter((t) => !t.revokedAt).length }
    })
    return json(200, { ok: true, users: out })
  }
  if (path === "/api/admin/tokens" && req.method === "POST") {
    const user = db.query("SELECT id FROM users WHERE id = ?").get(String(body.userId ?? ""))
    if (!user) return json(404, { ok: false, error: "no such user" })
    const t = await mint(String(body.userId), String(body.label ?? ""), body.limits)
    return json(200, { ok: true, token: t.value, id: t.id, userId: body.userId })
  }
  if (path === "/api/admin/tokens" && req.method === "GET") {
    const tokens = db.query("SELECT * FROM tokens").all() as TokenRow[]
    return json(200, { ok: true, tokens: tokens.map((t) => ({ id: t.id, userId: t.userId, label: t.label, limits: JSON.parse(t.limits), createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, expiresAt: t.expiresAt, revoked: !!t.revokedAt })) })
  }
  m = path.match(/^\/api\/admin\/tokens\/([^/]+)$/)
  if (m && req.method === "DELETE") {
    const res = db.query("UPDATE tokens SET revokedAt = ? WHERE id = ?").run(Date.now(), m[1])
    return res.changes ? json(200, { ok: true }) : json(404, { ok: false, error: "no such token" })
  }
  if (path === "/api/admin/codes" && req.method === "POST") {
    const activations = Math.floor(Number(body.activations))
    const left = Number.isFinite(activations) && activations >= 1 ? activations : -1
    const value = "osc_" + randomId()
    const id = "c_" + randomId().slice(0, 10)
    const expiresAt = Number(body.ttlHours) > 0 ? Date.now() + Number(body.ttlHours) * 3600000 : 0
    db.query("INSERT INTO codes (id, hash, label, activationsLeft, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?)").run(id, await sha256hex(value), String(body.label ?? "").trim().slice(0, 64) || "invite", left, Date.now(), expiresAt)
    return json(200, { ok: true, code: value, id, activationsLeft: left })
  }
  if (path === "/api/admin/codes" && req.method === "GET") {
    const codes = db.query("SELECT * FROM codes").all() as Array<{ id: string; label: string; activationsLeft: number; used: number; createdAt: number; expiresAt: number; disabled: number }>
    return json(200, { ok: true, codes: codes.map((c) => ({ id: c.id, label: c.label, activationsLeft: c.activationsLeft, used: c.used, createdAt: c.createdAt, expiresAt: c.expiresAt, disabled: !!c.disabled })) })
  }
  m = path.match(/^\/api\/admin\/codes\/([^/]+)$/)
  if (m && req.method === "DELETE") {
    const res = db.query("UPDATE codes SET disabled = 1 WHERE id = ?").run(m[1])
    return res.changes ? json(200, { ok: true }) : json(404, { ok: false, error: "no such code" })
  }
  if (path === "/api/admin/shares" && req.method === "GET") {
    const rows = db.query("SELECT id, sessionID, createdAt, ownerId FROM shares").all() as Array<{ id: string; sessionID: string; createdAt: number; ownerId: string | null }>
    return json(200, { ok: true, shares: rows })
  }
  m = path.match(/^\/api\/admin\/shares\/([0-9a-f]+)\/reassign$/)
  if (m && req.method === "POST") {
    const user = db.query("SELECT id FROM users WHERE id = ?").get(String(body.userId ?? ""))
    if (!user) return json(404, { ok: false, error: "no such user" })
    db.query("UPDATE shares SET ownerId = ?, frozen = 0 WHERE id = ?").run(body.userId, m[1])
    return json(200, { ok: true })
  }
  return json(404, { error: "not found" })
}

async function shareAuthRoute(id: string, body: Record<string, unknown>, req: Request): Promise<Response> {
  const share = q.share(id)
  if (!share) return json(404, { ok: false, error: "share not found" })
  if (!share.auth) return json(200, { ok: true, note: "no auth required" })
  const auth = JSON.parse(share.auth) as { salt: string; loginHash: string; passHash: string }
  const attempts = JSON.parse(share.attempts) as { ips: Record<string, { fails: number; lockUntil: number; streak: number }>; total: number; lockUntil: number }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local"
  const now = Date.now()
  const ipState = attempts.ips[ip] ?? { fails: 0, lockUntil: 0, streak: 0 }
  attempts.ips[ip] = ipState
  const lockedFor = Math.max(ipState.lockUntil - now, attempts.lockUntil - now)
  if (lockedFor > 0) return json(429, { ok: false, error: "locked", retryAfterMs: lockedFor })
  const [loginHash, passHash] = await Promise.all([pbkdf2(String(body.login ?? ""), auth.salt), pbkdf2(String(body.password ?? ""), auth.salt)])
  if (loginHash !== auth.loginHash || passHash !== auth.passHash) {
    ipState.fails += 1
    ipState.streak += 1
    attempts.total += 1
    if (ipState.fails >= 5) {
      ipState.lockUntil = now + Math.min(60000 * 2 ** (ipState.streak - 5), 86400000)
      ipState.fails = 0
    }
    if (attempts.total >= 20) attempts.lockUntil = now + 86400000
    db.query("UPDATE shares SET attempts = ? WHERE id = ?").run(JSON.stringify(attempts), id)
    return json(401, { ok: false, error: "wrong credentials", retryAfterMs: Math.max(ipState.lockUntil - now, attempts.lockUntil - now, 0) })
  }
  delete attempts.ips[ip]
  attempts.total = Math.max(0, attempts.total - 1)
  const token = randomId() + randomId()
  const tokens = [{ token, expires: now + 7 * 86400000 }, ...JSON.parse(share.tokens)].slice(0, 5)
  db.query("UPDATE shares SET tokens = ?, attempts = ? WHERE id = ?").run(JSON.stringify(tokens), JSON.stringify(attempts), id)
  const cookie = `osh_${id}=${token}; Path=/; Max-Age=${7 * 86400}; HttpOnly; Secure; SameSite=Lax`
  return json(200, { setCookie: cookie, body: { ok: true } }, { "set-cookie": cookie })
}

// --- static viewer -------------------------------------------------------------

// link-preview crawlers (Discord/Telegram/Slack/... never run the SPA)
// get index.html with og:/twitter: tags injected from the BRAND_* env.
// og:title carries the DEPLOYMENT name, never the session title.
const CRAWLER_RE = /(discordbot|discordapp|telegrambot|slackbot|slack-imgproxy|facebookexternalhit|facebookcatalog|whatsapp|twitterbot|x-bot|linkedinbot|pinterestbot|skypeuripreview|snapchat|bluefish|mattermost|gitter|flowdock)/i

function htmlEscape(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

async function ogIndex(url: URL): Promise<Response> {
  const index = Bun.file(join(VIEWER_DIR, "index.html"))
  const name = process.env.BRAND_NAME ?? "openshare"
  const desc = process.env.BRAND_DESCRIPTION ?? "shared agent sessions, self-hosted"
  const image = process.env.BRAND_OG_IMAGE ?? process.env.BRAND_LOGO_URL ?? ""
  const title = process.env.BRAND_OG_TITLE ?? `${name} · Open(code)Share`
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
  const html = (await index.text()).replace(/<head>/i, "<head>\n    " + tags.join("\n    "))
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } })
}

async function staticOr404(req: Request, url: URL): Promise<Response> {
  if (!existsSync(VIEWER_DIR)) return json(404, { error: "not found" })
  const isSpa = url.pathname === "/" || url.pathname.startsWith("/s/")
  if (isSpa && CRAWLER_RE.test(req.headers.get("user-agent") ?? "")) {
    const index = Bun.file(join(VIEWER_DIR, "index.html"))
    if (await index.exists()) return await ogIndex(url)
  }
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1)
  const file = Bun.file(join(VIEWER_DIR, rel))
  if (await file.exists()) {
    return new Response(file, { headers: { "cache-control": rel.startsWith("assets/") ? "public, max-age=86400" : "no-cache" } })
  }
  if (isSpa) {
    const index = Bun.file(join(VIEWER_DIR, "index.html"))
    if (await index.exists()) return new Response(index, { headers: { "cache-control": "no-cache" } })
  }
  return json(404, { error: "not found" })
}

// --- websockets -----------------------------------------------------------------

type ControlData = {
  kind: "control"
  token: string
  attachId?: string
  attachSecret?: string
  attachOwner?: string | null
  attachRoot?: boolean
  earlySyncs: Frame[]
}
type ViewerData = { kind: "viewer"; shareId: string }
type WsData = ControlData | ViewerData

async function controlMessage(ws: Bun.WebSocket<WsData>, raw: string | Buffer) {
  const data = ws.data as ControlData
  const send = (obj: unknown) => { try { ws.send(JSON.stringify(obj)) } catch {} }
  try {
    const frame = JSON.parse(String(raw)) as Frame
    if (frame.op === "init") {
      if (frame.create) {
        const chk = await createCheck(data.token)
        if (!chk.ok) return send({ op: "init", ok: false, error: chk.error })
        const ttlDays = clampTtl((frame.create as Record<string, unknown>).ttlDays, chk.ttlMaxDays ?? 0)
        const { id, secret } = createShare(String((frame.create as Record<string, unknown>).sessionID ?? ""), ttlDays, chk.userId ?? null, String((frame.create as Record<string, unknown>).authLogin ?? ""), String((frame.create as Record<string, unknown>).authPassword ?? ""))
        data.attachId = id
        data.attachSecret = secret
        data.attachOwner = chk.userId ?? null
        for (const early of data.earlySyncs) {
          // WS sync frames carry `items`; the HTTP apply path takes `data`
          const r = applySync(id, { secret, ownerId: data.attachOwner, root: false, data: early.items ?? [], status: early.status })
          send({ op: r.body.ok ? "ack" : "nack", ...r.body })
        }
        data.earlySyncs = []
        return send({ op: "init", ok: true, id, secret, rev: 0, status: "live", ttlDays, policy: resolvePolicy() })
      }
      if (frame.attach) {
        const share = q.share(String((frame.attach as Record<string, unknown>).id ?? ""))
        if (!share) return send({ op: "init", ok: false, error: "share not found" })
        // owner-token control: the socket's bearer may own the share even
        // without the secret; root administers everything
        const chk = await checkToken(data.token)
        const ownerId = chk.kind === "user" ? chk.userId : null
        const root = chk.kind === "root"
        const gate = writeGate(share, { secret: (frame.attach as Record<string, unknown>).secret, ownerId, root })
        if (gate) return send({ op: "init", ok: false, error: gate })
        data.attachId = share.id
        data.attachSecret = String((frame.attach as Record<string, unknown>).secret ?? "")
        data.attachOwner = ownerId
        data.attachRoot = root
        db.query("UPDATE shares SET pluginSeen = ?, finalizeAt = NULL WHERE id = ?").run(Date.now(), share.id)
        const updated = q.share(share.id)!
        for (const early of data.earlySyncs) {
          const r = applySync(share.id, { secret: data.attachSecret, ownerId, root, data: early.items ?? [], status: early.status })
          send({ op: r.body.ok ? "ack" : "nack", ...r.body })
        }
        data.earlySyncs = []
        return send({ op: "init", ok: true, id: share.id, secret: data.attachSecret, rev: updated.rev, status: updated.status, data: redactItems(shareData(updated)), policy: resolvePolicy() })
      }
      return send({ op: "init", ok: false, error: "init needs create|attach" })
    }
    if (frame.op === "sync") {
      if (!data.attachId) {
        if (data.earlySyncs.length < 32) data.earlySyncs.push(frame)
        return
      }
      // WS sync frames carry `items`; the HTTP apply path takes `data`
      const r = applySync(data.attachId, { secret: data.attachSecret, ownerId: data.attachOwner, root: data.attachRoot, data: frame.items ?? [], status: frame.status })
      return send({ op: r.body.ok ? "ack" : "nack", ...r.body })
    }
    if (frame.op === "delete" && data.attachId) {
      const share = q.share(data.attachId)
      if (share) {
        const gate = writeGate(share, { secret: data.attachSecret, ownerId: data.attachOwner, root: data.attachRoot })
        if (!gate) removeShare(data.attachId)
      }
      data.attachId = undefined
      data.attachSecret = undefined
      return send({ op: "deleted" })
    }
    send({ op: "error", error: "unknown op" })
  } catch (e) {
    send({ op: "error", error: (e as Error)?.message || String(e) })
  }
}

function controlClose(ws: Bun.WebSocket<WsData>) {
  const data = ws.data as ControlData
  if (!data.attachId) return
  const share = q.share(data.attachId)
  if (!share || share.status !== "live") return
  const after = resolvePolicy().finalizeAfterMs
  if (after <= 0) return
  db.query("UPDATE shares SET finalizeAt = ? WHERE id = ?").run(Date.now() + after, data.attachId)
}

// --- sweeper (TTL + finalize backstop) --------------------------------------------

setInterval(() => {
  try {
    const now = Date.now()
    // finalize: plugin gone without goodbye
    const overdue = db.query("SELECT id FROM shares WHERE status = 'live' AND finalizeAt IS NOT NULL AND finalizeAt < ?").all(now) as Array<{ id: string }>
    for (const r of overdue) {
      const share = q.share(r.id)!
      if ((share.pluginSeen ?? share.createdAt) + resolvePolicy().finalizeAfterMs > now) continue
      db.query("UPDATE shares SET status = 'interrupted', rev = rev + 1, finalizeAt = NULL WHERE id = ?").run(r.id)
      broadcast(r.id, { op: "frame", status: "interrupted", rev: share.rev + 1, items: [] })
      console.log("[finalize] share interrupted:", r.id)
    }
    // TTL sweep
    const rows = db.query("SELECT id, ttlDays, lastActive FROM shares").all() as Array<{ id: string; ttlDays: number; lastActive: number }>
    for (const r of rows) {
      if (r.lastActive + r.ttlDays * 86400000 < now) removeShare(r.id)
    }
  } catch (e) {
    console.log("[sweep] error", (e as Error)?.message)
  }
}, 30000)

// --- serve ---------------------------------------------------------------------------

const server = Bun.serve<WsData>({
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === "/api/ws") {
      const token = bearer(req) || url.searchParams.get("token") || ""
      if (srv.upgrade(req, { data: { kind: "control", token, earlySyncs: [] } satisfies ControlData })) return
      return new Response("upgrade failed", { status: 400 })
    }
    const wm = url.pathname.match(/^\/api\/share\/([0-9a-f]+)\/ws$/)
    if (wm && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return httpHandler(req).then((res) => {
        if (res.status !== 200) return res
        if (srv.upgrade(req, { data: { kind: "viewer", shareId: wm[1] } satisfies ViewerData })) return
        return new Response("upgrade failed", { status: 400 })
      })
    }
    return httpHandler(req)
  },
  websocket: {
    open(ws) {
      if (ws.data.kind === "viewer") {
        let set = viewers.get(ws.data.shareId)
        if (!set) viewers.set(ws.data.shareId, (set = new Set()))
        set.add(ws)
        const share = q.share(ws.data.shareId)
        if (share) {
          try { ws.send(JSON.stringify({ v: 2, op: "frame", status: share.status, rev: share.rev, items: redactItems(shareData(share)) })) } catch {}
        }
      }
    },
    message(ws, raw) {
      if (ws.data.kind === "control") return controlMessage(ws, raw)
      // viewer sockets are server-push only (parity with the worker)
    },
    close(ws) {
      if (ws.data.kind === "viewer") viewers.get(ws.data.shareId)?.delete(ws)
      else controlClose(ws)
    },
  },
})

console.log(`[openshare-server] listening on http://0.0.0.0:${server.port} (auth: ${authMode()}, db: ${DB_PATH}, viewer: ${existsSync(VIEWER_DIR) ? VIEWER_DIR : "not built"})`)
if (!CREATE_TOKEN) console.log("[openshare-server] WARNING: CREATE_TOKEN unset — admin API disabled; enrollment is the only way in (set it to use the admin console)")
