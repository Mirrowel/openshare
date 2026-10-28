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

/** TTL is HOURS-native (worker parity): legacy days-shaped inputs
 * convert x24; floor one hour; caps via MAX_TTL_HOURS or legacy
 * MAX_TTL_DAYS. tokenMax arrives in HOURS when unit!=="days". */
function clampTtlHours(hours: unknown, tokenMax = 0, unit: "hours" | "days" = "hours"): number {
  let max = Number(process.env.MAX_TTL_HOURS || 0) || Math.floor(Number(process.env.MAX_TTL_DAYS || 90) * 24)
  if (!Number.isFinite(max) || max < 1) max = 90 * 24
  if (tokenMax > 0) max = Math.min(max, unit === "days" ? Math.floor(tokenMax * 24) : tokenMax)
  const h = Math.floor(Number(hours))
  if (!Number.isFinite(h) || h <= 0) return max
  return Math.max(1, Math.min(h, max))
}

function ttlHoursFrom(body: Record<string, unknown>): number | undefined {
  const h = Number(body?.ttlHours)
  if (Number.isFinite(h) && h > 0) return Math.floor(h)
  const d = Number(body?.ttlDays)
  if (Number.isFinite(d) && d > 0) return Math.floor(d * 24)
  return undefined
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
  ttlDays INTEGER NOT NULL, ttlHours INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, lastActive INTEGER NOT NULL,
  pluginSeen INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'live',
  ownerId TEXT, frozen INTEGER NOT NULL DEFAULT 0, auth TEXT, tokens TEXT NOT NULL DEFAULT '[]',
  attempts TEXT NOT NULL DEFAULT '{}', finalizeAt INTEGER, custom TEXT NOT NULL DEFAULT '{}')`)
db.exec(`CREATE TABLE IF NOT EXISTS items (shareId TEXT NOT NULL, key TEXT NOT NULL, item TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, del INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (shareId, key))`)
// pre-existing databases: add the delta-tracking columns (rev stamps +
// delete markers for the /data `since` handshake)
try { db.exec("ALTER TABLE items ADD COLUMN rev INTEGER NOT NULL DEFAULT 0") } catch {}
try { db.exec("ALTER TABLE items ADD COLUMN del INTEGER NOT NULL DEFAULT 0") } catch {}
try { db.exec("ALTER TABLE shares ADD COLUMN custom TEXT NOT NULL DEFAULT '{}'") } catch {}
db.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, label TEXT NOT NULL, createdAt INTEGER NOT NULL, frozen INTEGER NOT NULL DEFAULT 0, settings TEXT NOT NULL DEFAULT '{}', createdByCode TEXT)`)
db.exec(`CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, userId TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', limits TEXT NOT NULL DEFAULT '{}', createdAt INTEGER NOT NULL, lastUsedAt INTEGER NOT NULL DEFAULT 0, revokedAt INTEGER NOT NULL DEFAULT 0, expiresAt INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'full', sets TEXT NOT NULL DEFAULT '{}')`)
db.exec(`CREATE TABLE IF NOT EXISTS codes (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, label TEXT NOT NULL, activationsLeft INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0)`)
db.exec(`CREATE TABLE IF NOT EXISTS rate (ip TEXT PRIMARY KEY, n INTEGER NOT NULL, resetAt INTEGER NOT NULL)`)
db.exec(`CREATE TABLE IF NOT EXISTS dcreates (k TEXT PRIMARY KEY, n INTEGER NOT NULL)`)
// pre-existing databases: the 2a columns (after ALL creates - an ALTER
// before its CREATE is swallowed by the catch on fresh DBs, leaving the
// column missing; live-caught by the tui-flow F15 codeless enroll)
try { db.exec("ALTER TABLE shares ADD COLUMN creatorTokenId TEXT") } catch {}
try { db.exec("ALTER TABLE tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'full'") } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN createdByCode TEXT") } catch {}
try { db.exec("ALTER TABLE shares ADD COLUMN ttlHours INTEGER NOT NULL DEFAULT 0") } catch {}
try { db.exec("ALTER TABLE shares ADD COLUMN private TEXT NOT NULL DEFAULT '{}'") } catch {}
// legacy rows: backfill hours from days once (idempotent: only where 0)
try { db.exec("UPDATE shares SET ttlHours = ttlDays * 24 WHERE ttlHours = 0") } catch {}
try { db.exec("ALTER TABLE tokens ADD COLUMN sets TEXT NOT NULL DEFAULT '{}'") } catch {}

type ShareRow = {
  id: string; secret: string; sessionID: string; ttlDays: number; ttlHours?: number; private?: string; createdAt: number; lastActive: number
  pluginSeen: number; rev: number; status: string; ownerId: string | null; frozen: number
  auth: string | null; tokens: string; attempts: string; finalizeAt: number | null; custom: string
}

const q = {
  share: (id: string) => db.query<ShareRow, string>("SELECT * FROM shares WHERE id = ?").get(id),
}

/** Effective TTL in HOURS: new rows carry ttlHours; legacy rows were
 * backfilled, but resolve defensively anyway. */
function ttlHoursOf(row: ShareRow): number {
  if (row.ttlHours && row.ttlHours > 0) return row.ttlHours
  return Math.floor((row.ttlDays || 90) * 24)
}

// --- identity ----------------------------------------------------------------

type TokenRow = { id: string; hash: string; userId: string; label: string; limits: string; createdAt: number; lastUsedAt: number; revokedAt: number; expiresAt: number; kind?: string }

function defaultLimits() {
  const num = (v: unknown) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0 }
  return {
    maxLiveShares: num(process.env.DEFAULT_MAX_LIVE_SHARES),
    maxTtlHours: num(process.env.DEFAULT_MAX_TTL_HOURS) || Math.floor(num(process.env.DEFAULT_MAX_TTL_DAYS) * 24),
    dailyCreates: num(process.env.DEFAULT_DAILY_CREATES),
  }
}

function normLimits(input: unknown) {
  const d = defaultLimits()
  if (!input || typeof input !== "object") return d
  const one = (v: unknown, def: number) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 ? n : def }
  const i = input as Record<string, unknown>
  return { maxLiveShares: one(i.maxLiveShares, d.maxLiveShares), maxTtlHours: one(i.maxTtlHours, one(i.maxTtlDays, 0) ? Math.floor(one(i.maxTtlDays, 0) * 24) : d.maxTtlHours), dailyCreates: one(i.dailyCreates, d.dailyCreates) }
}

/** Public servers may accept onboarding without a code only when
 * explicitly enabled (default OFF - worker parity). */
function codelessOnboarding(): boolean {
  return /^(1|true|yes|on)$/i.test(String(process.env.CODELESS_ONBOARDING ?? "").trim())
}

async function checkToken(token: string): Promise<{ kind: "none" | "root" } | { kind: "user"; token: TokenRow; userId: string }> {
  if (!token) return { kind: "none" }
  if (CREATE_TOKEN && token === CREATE_TOKEN) return { kind: "root" }
  const row = db.query<TokenRow, string>("SELECT * FROM tokens WHERE hash = ?").get(await sha256hex(token))
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt < Date.now())) return { kind: "none" }
  const user = db.query("SELECT * FROM users WHERE id = ?").get(row.userId) as { frozen: number } | undefined
  if (!user || user.frozen) return { kind: "none" }
  if (Date.now() - row.lastUsedAt > 60000) db.query("UPDATE tokens SET lastUsedAt = ? WHERE id = ?").run(Date.now(), row.id)
  // tokenKind (full|scoped) rides every identity: the write gate lets a
  // SCOPED token touch only the shares it created (worker parity)
  return { kind: "user", token: row, userId: row.userId, tokenId: row.id, tokenKind: row.kind === "scoped" ? "scoped" : "full", sets: JSON.parse(row.sets || "{}") as Record<string, TokenSet> }
}

async function createCheck(token: string, set: unknown = undefined): Promise<{ ok: true; userId?: string; ttlMaxHours?: number; defaultTtlHours?: number } | { ok: false; error: string; httpStatus: number }> {
  const chk = await checkToken(token)
  if (chk.kind === "root") return { ok: true }
  if (chk.kind === "none") {
    if (authMode() === "public") {
      // anonymous ownerless create: under a GLOBAL hourly cap — every
      // create costs storage + sweeper work, and per-anything limits are
      // dodgeable on this backend (XFF is client-controlled without a
      // trusted proxy)
      const now = Date.now()
      const g = db.query("SELECT * FROM rate WHERE ip = 'anon-creates'").get() as { n: number; resetAt: number } | undefined
      if (!g || g.resetAt < now) db.query("INSERT INTO rate (ip, n, resetAt) VALUES ('anon-creates', 1, ?) ON CONFLICT(ip) DO UPDATE SET n = 1, resetAt = ?").run(now + 3600000, now + 3600000)
      else if (g.n >= 100) return { ok: false, error: "too many anonymous creates, try later", httpStatus: 429 }
      else db.query("UPDATE rate SET n = n + 1 WHERE ip = 'anon-creates'").run()
      return { ok: true } // anonymous ownerless
    }
    return { ok: false, error: "token required", httpStatus: 401 }
  }
  const limits = JSON.parse(chk.token.limits) as { maxLiveShares: number; maxTtlDays: number; maxTtlHours?: number; dailyCreates: number }
  if (limits.maxLiveShares > 0) {
    // SCOPED tokens count only their own shares (worker parity).
    // params bind on .get() — db.query(sql, params) silently ignores
    // them in bun:sqlite and the count reads as undefined (cap never fired)
    const scoped = chk.token.kind === "scoped"
    const n = (scoped
      ? db.query("SELECT COUNT(*) c FROM shares WHERE ownerId = ? AND creatorTokenId = ?").get(chk.userId, chk.token.id)
      : db.query("SELECT COUNT(*) c FROM shares WHERE ownerId = ?").get(chk.userId)) as { c: number } | undefined
    if ((n?.c ?? 0) >= limits.maxLiveShares) return { ok: false, error: "max shares reached", httpStatus: 403 }
  }
  if (limits.dailyCreates > 0) {
    const k = `${chk.token.id}:${new Date().toISOString().slice(0, 10)}`
    const row = db.query("SELECT n FROM dcreates WHERE k = ?").get(k) as { n: number } | undefined
    if ((row?.n ?? 0) >= limits.dailyCreates) return { ok: false, error: "daily create limit reached", httpStatus: 429 }
    db.query("INSERT INTO dcreates (k, n) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1").run(k)
  }
  const u = db.query("SELECT settings FROM users WHERE id = ?").get(chk.userId) as { settings: string } | undefined
  const settingsDoc = JSON.parse(u?.settings ?? "{}") as { defaultTtlHours?: number; defaultTtlDays?: number }
  const defaultTtlHours = (Number(settingsDoc.defaultTtlHours) || 0) || Math.floor((Number(settingsDoc.defaultTtlDays) || 0) * 24)
  // B4: Class A of the requested (or default) set - applied at create,
  // never transported (worker parity)
  const setA = resolveSet(chk.sets, set).classA
  return { ok: true, userId: chk.userId, tokenId: chk.token.id, tokenKind: chk.token.kind === "scoped" ? "scoped" : "full", ttlMaxHours: (limits.maxTtlHours || 0) || Math.floor((limits.maxTtlDays || 0) * 24), defaultTtlHours, ...(Object.keys(setA).length ? { setA } : {}) }
}

async function mint(userId: string, label: string, limits: unknown, kind: "full" | "scoped" = "full"): Promise<{ value: string; id: string; kind: string }> {
  const value = "osk_" + randomId() + randomId()
  const hash = await sha256hex(value)
  const id = "t_" + randomId().slice(0, 10)
  db.query("INSERT INTO tokens (id, hash, userId, label, limits, createdAt, kind) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, hash, userId, String(label ?? "").slice(0, 64), JSON.stringify(normLimits(limits)), Date.now(), kind)
  return { value, id, kind }
}

// --- share ops -----------------------------------------------------------------

function makeAuth(login: string, password: string) {
  return pbkdf2(login, "").then(async () => {
    const salt = randomId() + randomId()
    const [loginHash, passHash] = await Promise.all([pbkdf2(login, salt), pbkdf2(password, salt)])
    return JSON.stringify({ salt, loginHash, passHash })
  })
}

function createShare(sessionID: string, ttlHours: number, ownerId: string | null, authLogin: string, authPassword: string, custom: Record<string, string> = {}, creatorTokenId: string | null = null): { id: string; secret: string } {
  const id = randomId()
  const secret = randomId() + randomId()
  const auth = authLogin && authPassword ? JSON.stringify({ salt: "", loginHash: "", passHash: "" }) : null
  db.query("INSERT INTO shares (id, secret, sessionID, ttlDays, ttlHours, createdAt, lastActive, pluginSeen, rev, status, ownerId, auth, attempts, tokens, custom, creatorTokenId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'live', ?, ?, ?, '[]', ?, ?)")
    .run(id, secret, sessionID, Math.ceil(ttlHours / 24), ttlHours, Date.now(), Date.now(), Date.now(), ownerId, auth, JSON.stringify({ ips: {}, total: 0, lockUntil: 0 }), JSON.stringify(custom), creatorTokenId)
  if (authLogin && authPassword) {
    // hash asynchronously then persist (the synchronous insert keeps the
    // response fast; the gate materializes a moment later)
    void makeAuth(authLogin, authPassword).then((a) => db.query("UPDATE shares SET auth = ? WHERE id = ?").run(a, id))
  }
  return { id, secret }
}


// free-form labels from the plugin create frame (B5): same caps as the
// worker (20 keys, 64-char names, 500-char values)
function normCustom(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== "object") return out
  let c = 0
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (c >= 20) break
    if (typeof k === "string" && typeof v === "string" && k.length <= 64 && v.length <= 500) {
      out[k] = v
      c++
    }
  }
  return out
}

/** Named config sets on a token (B4, worker parity): Class A fields
 * (authLogin/authPassword/ttlHours) apply at create and never travel to a
 * client; Class B (modelLabel/shareMode) are fetchable suggestions. */
type TokenSet = { authLogin?: string; authPassword?: string; ttlHours?: number; modelLabel?: string; shareMode?: string }

function normSets(input: unknown): Record<string, TokenSet> {
  const out: Record<string, TokenSet> = {}
  if (!input || typeof input !== "object" || Array.isArray(input)) return out
  let n = 0
  for (const [name, raw] of Object.entries(input as Record<string, unknown>)) {
    if (n >= 10) break
    if (typeof name !== "string" || name.length > 32 || !/^[a-zA-Z0-9_-]+$/.test(name)) continue
    if (!raw || typeof raw !== "object") continue
    const r = raw as Record<string, unknown>
    const set: TokenSet = {}
    for (const k of ["authLogin", "authPassword"] as const) {
      if (typeof r[k] === "string" && (r[k] as string).length <= 128) set[k] = r[k] as string
    }
    const ttlH = Math.floor(Number(r.ttlHours))
    if (Number.isFinite(ttlH) && ttlH > 0 && ttlH <= 87600) set.ttlHours = ttlH
    else {
      const ttl = Math.floor(Number(r.ttlDays))
      if (Number.isFinite(ttl) && ttl > 0 && ttl <= 3650) set.ttlHours = ttl * 24
    }
    if (typeof r.modelLabel === "string" && r.modelLabel.length <= 64) set.modelLabel = r.modelLabel
    if (r.shareMode === "all" || r.shareMode === "manual") set.shareMode = r.shareMode
    if (Object.keys(set).length) { out[name] = set; n++ }
  }
  return out
}

function resolveSet(sets: Record<string, TokenSet> | undefined, wanted: unknown): { classA: Partial<TokenSet>; classB: Partial<TokenSet> } {
  const names = Object.keys(sets ?? {})
  if (!names.length) return { classA: {}, classB: {} }
  const name = typeof wanted === "string" && sets?.[wanted] ? wanted : names[0]
  const set = sets?.[name] ?? {}
  const classA: Partial<TokenSet> = {}
  if (set.authLogin !== undefined) classA.authLogin = set.authLogin
  if (set.authPassword !== undefined) classA.authPassword = set.authPassword
  if (set.ttlHours !== undefined) classA.ttlHours = set.ttlHours
  const classB: Partial<TokenSet> = {}
  if (set.modelLabel !== undefined) classB.modelLabel = set.modelLabel
  if (set.shareMode !== undefined) classB.shareMode = set.shareMode
  return { classA, classB }
}

function setsPublicView(sets: Record<string, TokenSet> | undefined): Record<string, Partial<TokenSet>> {
  const out: Record<string, Partial<TokenSet>> = {}
  for (const [name, set] of Object.entries(sets ?? {})) {
    const view: Partial<TokenSet> = {}
    if (set.modelLabel !== undefined) view.modelLabel = set.modelLabel
    if (set.shareMode !== undefined) view.shareMode = set.shareMode
    if (Object.keys(view).length) out[name] = view
  }
  return out
}

/** Write gate parity: owner token (ownerId resolved server-side), root, or
 * the per-share secret — while the owner is in good standing. */
function writeGate(share: ShareRow, body: { secret?: string; ownerId?: string | null; root?: boolean; tokenId?: string | null; tokenKind?: string | null }): "" | "forbidden" | "frozen" {
  if (body.root === true) return ""
  if (body.secret && body.secret === share.secret) return share.frozen ? "frozen" : ""
  if (body.ownerId && share.ownerId && body.ownerId === share.ownerId) {
    if (share.frozen) return "frozen"
    // SCOPED tokens reach only the shares they created (worker parity)
    if (body.tokenKind === "scoped") return body.tokenId && body.tokenId === share.creatorTokenId ? "" : "forbidden"
    return ""
  }
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

function applySync(shareId: string, body: { secret?: string; ownerId?: string | null; root?: boolean; tokenId?: string | null; tokenKind?: string | null; data?: unknown[]; status?: string }): { status: number; body: Record<string, unknown> } {
  const share = q.share(shareId)
  if (!share) return { status: 404, body: { ok: false, error: "share not found" } }
  const gate = writeGate(share, body)
  if (gate) return { status: 403, body: { ok: false, error: gate } }
  const rev = share.rev + 1
  const batch: unknown[] = []
  const tx = db.transaction(() => {
    // Wave 3 data-inventory split: pmeta items (machine-local facts)
    // never become public item shards - they merge into shares.private
    // and reach only AUTHENTICATED viewers (worker parity)
    let priv: Record<string, Record<string, string>> | null = null
    const rest: unknown[] = []
    for (const raw of body.data ?? []) {
      const it = raw as { type?: string; del?: boolean; sessionID?: string; data?: unknown }
      if (it?.type === "pmeta") {
        priv = priv ?? (JSON.parse(share.private || "{}") as Record<string, Record<string, string>>)
        const sid = it.sessionID ?? (it.data as { id?: string } | undefined)?.id ?? ""
        if (it.del) delete priv[sid]
        else if (sid && it.data && typeof it.data === "object") {
          const clean: Record<string, string> = {}
          for (const [k, v] of Object.entries(it.data as Record<string, unknown>)) {
            if (typeof v === "string" && v.length <= 512 && k.length <= 32) clean[k] = v
          }
          priv[sid] = clean
        }
        continue
      }
      rest.push(raw)
    }
    if (priv) db.query("UPDATE shares SET private = ? WHERE id = ?").run(JSON.stringify(priv), shareId)
    for (const raw of rest) {
      const it = (raw as { del?: boolean }).del ? raw : fitItem(raw)
      const key = itemKey(it)
      if (!key) continue
      // upserts and deletes both keep a ROW: rev + del power the /data
      // `since` delta (a hard delete would be invisible to `rev > ?` and
      // undone content would resurrect for polling viewers); full reads
      // filter del rows, delta readers re-emit the tombstone verbatim
      const del = (it as { del?: boolean }).del ? 1 : 0
      db.query("INSERT INTO items (shareId, key, item, rev, del) VALUES (?, ?, ?, ?, ?) ON CONFLICT(shareId, key) DO UPDATE SET item = excluded.item, rev = excluded.rev, del = excluded.del").run(shareId, key, JSON.stringify(it), rev, del)
      batch.push(it)
      if (del && (it as { type?: string }).type === "message" && (it as { data?: { id?: string } }).data?.id) {
        // cascade: legacy v1 part shards die hard — the message marker
        // supersedes them for delta readers
        const prefix = `part/${(it as { data: { id: string } }).data.id}/`
        const parts = db.query("SELECT key, item FROM items WHERE shareId = ? AND key LIKE ? AND del = 0").all(shareId, prefix + "%") as Array<{ key: string; item: string }>
        for (const p of parts) {
          db.query("DELETE FROM items WHERE shareId = ? AND key = ?").run(shareId, p.key)
        }
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
  // full reads see live items only — del rows are markers for delta
  // readers (rev > since re-emits the tombstone), invisible here
  const items = db.query("SELECT item FROM items WHERE shareId = ? AND del = 0").all(share.id) as Array<{ item: string }>
  return items.map((r) => JSON.parse(r.item))
}

/** Viewer session-token validation: the cookie carries one of the share's
 * minted random tokens (stored raw in shares.tokens with an expiry) —
 * worker parity (ShareDO.validToken). NOT the password hash: comparing
 * pbkdf2(cookieToken) against passHash could never match a minted token,
 * which made every read-gated share on Bun permanently unviewable. */
async function validViewerToken(share: ShareRow, token: string): Promise<boolean> {
  if (!token || !share.auth) return false
  let tokens: Array<{ token: string; expires: number }> = []
  try { tokens = JSON.parse(share.tokens) } catch { tokens = [] }
  const now = Date.now()
  const live = tokens.filter((t) => t && typeof t.token === "string" && t.expires > now)
  if (live.length !== tokens.length) db.query("UPDATE shares SET tokens = ? WHERE id = ?").run(JSON.stringify(live), share.id)
  return live.some((t) => t.token === token)
}

// viewer sockets: in-memory subscribers (reconnect + refetch on restart)
const viewers = new Map<string, Set<Bun.WebSocket>>()
function broadcast(shareId: string, frame: unknown) {
  const set = viewers.get(shareId)
  if (!set) return
  const s = JSON.stringify({ v: 2, ...(frame as Record<string, unknown>) })
  for (const ws of set) try { ws.send(s) } catch {}
}

// per-rev /data render cache (worker parity): a polling viewer hits /data
// every 5s — rebuilding + re-serializing the full share per request is
// pure CPU burn when nothing changed. One slot per share holding BOTH
// envelopes (/data body + WS first frame), items serialized ONCE and
// both envelopes built by concatenation (worker renderCache parity —
// two full serializations held two copies of the body in memory).
// applySync bumps the rev so the slot self-invalidates; removeShare
// drops it. Oversized shares (> 25 MB) skip caching. Bounded by a
// global byte budget: an unbounded Map would hold ~1 GB+ resident with
// a hundred large polled shares (audit N9). Map insertion order doubles
// as the LRU (re-set on hit).
const DATA_CACHE_MAX_BYTES = 128 * 1024 * 1024
const dataCache = new Map<string, { rev: number; status: string; dataJson: string; frameJson: string; privData?: string; bytes: number }>()
let dataCacheBytes = 0
function dataCacheTrim() {
  for (const [k, v] of dataCache) {
    if (dataCacheBytes <= DATA_CACHE_MAX_BYTES) break
    dataCache.delete(k)
    dataCacheBytes -= v.bytes
  }
}
function dataCacheSet(share: ShareRow, dataJson: string, frameJson: string) {
  const hit = dataCache.get(share.id)
  if (hit) dataCacheBytes -= hit.bytes
  dataCache.delete(share.id)
  const priv = JSON.parse(share.private || "{}") as Record<string, unknown>
  const privData = Object.keys(priv).length ? dataJson.slice(0, -1) + ',"private":' + JSON.stringify(priv) + "}" : undefined
  dataCache.set(share.id, { rev: share.rev, status: share.status, dataJson, frameJson, privData, bytes: dataJson.length + frameJson.length + (privData?.length ?? 0) })
  dataCacheBytes += dataJson.length + frameJson.length
  dataCacheTrim()
}
/** Cached /data body for the share at its current rev. */
function renderData(share: ShareRow): string {
  const hit = dataCache.get(share.id)
  if (hit && hit.rev === share.rev && hit.status === share.status) {
    // LRU touch: reinsertion moves the key to the freshest position
    dataCache.delete(share.id)
    dataCache.set(share.id, hit)
    return hit.dataJson
  }
  const body = JSON.stringify(redactItems(shareData(share)))
  const dataJson = `{"v":2,"data":${body},"status":${JSON.stringify(share.status)},"rev":${share.rev}}`
  const frameJson = `{"v":2,"op":"frame","status":${JSON.stringify(share.status)},"rev":${share.rev},"items":${body}}`
  if (dataJson.length <= 25_000_000) dataCacheSet(share, dataJson, frameJson)
  else if (hit) {
    dataCache.delete(share.id)
    dataCacheBytes -= hit.bytes
  }
  return dataJson
}
/** Cached WS first-frame body (same slot, same rev). */
function renderFrame(share: ShareRow): string {
  const hit = dataCache.get(share.id)
  if (hit && hit.rev === share.rev && hit.status === share.status) {
    dataCache.delete(share.id)
    dataCache.set(share.id, hit)
    return hit.frameJson
  }
  // populate the shared slot via renderData, then read it back
  renderData(share)
  const fresh = dataCache.get(share.id)
  return fresh ? fresh.frameJson : `{"v":2,"op":"frame","status":${JSON.stringify(share.status)},"rev":${share.rev},"items":${JSON.stringify(redactItems(shareData(share)))}}`
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

  if (path === "/health") return json(200, { ok: true, service: "openshare", policy: resolvePolicy(), auth: { mode: authMode() }, frameAuth: true })

  if (path === "/branding") {
    return json(200, { name: process.env.BRAND_NAME ?? "", logoUrl: process.env.BRAND_LOGO_URL ?? "", wordmarkUrl: process.env.BRAND_WORDMARK_URL ?? "", linkUrl: process.env.BRAND_LINK_URL ?? "", accent: process.env.BRAND_ACCENT ?? "", faviconUrl: process.env.BRAND_FAVICON_URL ?? "", backgroundUrl: process.env.BRAND_BACKGROUND_URL ?? "", description: process.env.BRAND_DESCRIPTION ?? "", ogTitle: process.env.BRAND_OG_TITLE ?? "", ogImage: process.env.BRAND_OG_IMAGE ?? "" })
  }

  // identity
  if (path === "/api/enroll" && req.method === "POST") return enrollRoute(await bodyJson(req), req)
  if (path === "/api/me" && req.method === "GET") return meRoute(bearer(req))
  if (path === "/api/me/settings" && (req.method === "GET" || req.method === "PUT")) return settingsRoute(bearer(req), await bodyJson(req))
  if (path === "/api/me/shares" && req.method === "GET") return meSharesRoute(bearer(req))
  if (path === "/api/token/rotate" && req.method === "POST") return rotateRoute(bearer(req))
  if (path === "/api/token" && req.method === "POST") return tokenSelfMintRoute(await bodyJson(req), bearer(req))
  if (path === "/api/token/sets" && req.method === "GET") return tokenSetsGetRoute(bearer(req))
  if (path === "/api/token/sets" && req.method === "PUT") return tokenSetsPutRoute(await bodyJson(req), bearer(req))
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

  // viewer socket upgrade — {32}: share ids are exactly 32 hex chars
  const wm = path.match(/^\/api\/share\/([0-9a-f]{32})\/ws$/)
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

  const am = path.match(/^\/api\/share\/([0-9a-f]{32})\/auth$/)
  if (am && req.method === "POST") return shareAuthRoute(am[1], await bodyJson(req), req)

  // share-referencing ops need a REAL share id (32 hex); the bare POST
  // create keeps its flexible hex suffix (routing convention)
  const sm = path.match(/^\/api\/share\/([0-9a-f]+)(\/sync|\/data|\/snapshot|)$/)
  if (!sm) return staticOr404(req, url)
  const id = sm[1]
  const op = sm[2]
  if (id.length !== 32 && !(req.method === "POST" && op === "")) return staticOr404(req, url)

  if (req.method === "POST" && op === "") {
    const auth = bearer(req)
    if (auth && CREATE_TOKEN && auth === CREATE_TOKEN) return httpCreate(await bodyJson(req), null, 0)
    const rawBody = await bodyJson(req)
    const chk = await createCheck(auth, rawBody.set)
    if (!chk.ok) return json(chk.httpStatus, { error: chk.error })
    return httpCreate(rawBody, chk.userId ?? null, chk.ttlMaxHours ?? 0, chk.defaultTtlHours ?? 0, chk.tokenId ?? null, chk.setA ?? null)
  }
  if (req.method === "POST" && op === "/sync") {
    const body = await bodyJson(req, 8_000_000)
    if (body._tooLarge) return json(413, { error: "payload too large" })
    const ident = await resolveIdentity(req, body)
    const r = applySync(id, { ...body, ownerId: ident.ownerId, root: ident.root, tokenId: ident.tokenId, tokenKind: ident.tokenKind })
    return json(r.status, r.body)
  }
  if (req.method === "GET" && op === "/data") {
    const share = q.share(id)
    if (!share) return json(404, { data: [], status: "gone", rev: 0 })
    if (share.auth && !(await validViewerToken(share, bearer(req) || cookieToken(req, id)))) {
      return json(401, { authRequired: true })
    }
    // `since` handshake (worker parity): unchanged rev answers an empty
    // set; a changed rev answers only the items touched since — a
    // polling viewer stops re-transferring the whole share every 5s.
    // Only when the caller actually PASSED since (Number(null) is 0,
    // which would collide with a fresh share's rev 0)
    const sinceRaw = new URL(req.url).searchParams.get("since")
    if (sinceRaw !== null) {
      const since = Number(sinceRaw)
      if (Number.isFinite(since)) {
        if (since === share.rev) {
          return json(200, { v: 2, data: [], status: share.status, rev: share.rev })
        }
        const delta = db.query("SELECT item FROM items WHERE shareId = ? AND rev > ?").all(share.id, since) as Array<{ item: string }>
        return json(200, { v: 2, data: delta.map((r) => JSON.parse(r.item)), status: share.status, rev: share.rev })
      }
    }
    if (share.auth) {
      renderData(share)
      const hit = dataCache.get(share.id)
      if (hit && hit.privData) return new Response(hit.privData, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } })
    }
    return new Response(renderData(share), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } })
  }
  // frozen self-contained HTML of the share (worker parity): viewer bundle
  // inlined + share data as a JSON island. Read gate applies exactly as
  // /data — no bypass through the snapshot.
  if (req.method === "GET" && op === "/snapshot") {
    const share = q.share(id)
    if (!share) return json(404, { error: "gone" })
    if (share.auth && !(await validViewerToken(share, bearer(req) || cookieToken(req, id)))) {
      return json(401, { authRequired: true })
    }
    const items = redactItems(shareData(share))
    const body = JSON.stringify(items).replace(/</g, "\\u003c")
    let sessionID = ""
    for (const it of items as Array<{ type: string; data?: { id?: string; parentID?: string } }>) {
      if (it.type === "session" && it.data && !it.data.parentID) { sessionID = it.data.id ?? ""; break }
    }
    if (!sessionID) {
      const s = (items as Array<{ type: string; data?: { id?: string } }>).find((i) => i.type === "session")
      sessionID = s?.data?.id ?? ""
    }
    const priv = JSON.parse(share.private || "{}") as Record<string, unknown>
    const island = `{"items":${body},"status":${JSON.stringify(share.status)},"rev":${share.rev},"sessionID":${JSON.stringify(sessionID)}${Object.keys(priv).length ? `,"private":${JSON.stringify(priv)}` : ""},"branding":${JSON.stringify({
      name: process.env.BRAND_NAME ?? "", logoUrl: process.env.BRAND_LOGO_URL ?? "", wordmarkUrl: process.env.BRAND_WORDMARK_URL ?? "", linkUrl: process.env.BRAND_LINK_URL ?? "", accent: process.env.BRAND_ACCENT ?? "", faviconUrl: process.env.BRAND_FAVICON_URL ?? "", backgroundUrl: process.env.BRAND_BACKGROUND_URL ?? "", description: process.env.BRAND_DESCRIPTION ?? "", ogTitle: process.env.BRAND_OG_TITLE ?? "", ogImage: process.env.BRAND_OG_IMAGE ?? "",
    })}}`
    return serveSnapshot(url, id, island)
  }
  // #13: edit ANY share setting after creation (worker parity)
  if (req.method === "PATCH" && op === "") {
    if (id.length !== 32) return staticOr404(req, url)
    const body = await bodyJson(req)
    const share = q.share(id)
    if (!share) return json(404, { ok: false, error: "share not found" })
    const ident = await resolveIdentity(req, body)
    const gate = writeGate(share, { secret: body.secret, ownerId: ident.ownerId, root: ident.root, tokenId: ident.tokenId, tokenKind: ident.tokenKind })
    if (gate) return json(403, { ok: false, error: gate })
    const patch: Record<string, unknown> = {}
    if (body.authLogin !== undefined && body.authPassword !== undefined) {
      if ((body.authLogin === "") !== (body.authPassword === "")) return json(400, { error: "authLogin and authPassword must be set together" })
      patch.authLogin = String(body.authLogin)
      patch.authPassword = String(body.authPassword)
    }
    if (body.ttlHours !== undefined || body.ttlDays !== undefined) {
      const th = ttlHoursFrom(body as Record<string, unknown>)
      if (th === undefined) return json(400, { error: "ttlHours must be a positive number of hours" })
      patch.ttlHours = clampTtlHours(th, ident.ttlMaxHours ?? 0)
    }
    if (body.meta !== undefined) {
      if (!body.meta || typeof body.meta !== "object" || Array.isArray(body.meta)) return json(400, { error: "meta must be an object" })
      patch.custom = normCustom(body.meta)
    }
    if (!Object.keys(patch).length) return json(400, { error: "nothing to update (authLogin/authPassword, ttlHours, meta)" })
    if (patch.authLogin !== undefined) {
      const wantAuth = patch.authLogin && patch.authPassword
      let sameAuth = false
      if (wantAuth && share.auth) {
        const auth = JSON.parse(share.auth) as { salt: string; loginHash: string; passHash: string }
        sameAuth = auth.loginHash === await pbkdf2(String(patch.authLogin), auth.salt)
          && auth.passHash === await pbkdf2(String(patch.authPassword), auth.salt)
      }
      if (wantAuth && !sameAuth) {
        db.query("UPDATE shares SET auth = ?, tokens = '[]', attempts = ? WHERE id = ?")
          .run(await makeAuth(String(patch.authLogin), String(patch.authPassword)), JSON.stringify({ ips: {}, total: 0, lockUntil: 0 }), id)
        console.log("[patch] auth updated, tokens rotated")
      } else if (!wantAuth && share.auth) {
        db.query("UPDATE shares SET auth = NULL WHERE id = ?").run(id)
        console.log("[patch] auth removed (owner action)")
      }
    }
    if (patch.ttlHours !== undefined) {
      db.query("UPDATE shares SET ttlHours = ?, ttlDays = ? WHERE id = ?").run(patch.ttlHours, Math.ceil((patch.ttlHours as number) / 24), id)
      console.log("[patch] ttl updated to", patch.ttlHours, "hours")
    }
    if (patch.custom !== undefined) {
      db.query("UPDATE shares SET custom = ? WHERE id = ?").run(JSON.stringify(patch.custom), id)
    }
    const updated = q.share(id)!
    return json(200, { ok: true, id, ttlHours: ttlHoursOf(updated), auth: !!updated.auth, custom: JSON.parse(updated.custom || "{}") })
  }

  if (req.method === "DELETE" && op === "") {
    const body = await bodyJson(req)
    const share = q.share(id)
    if (!share) return json(404, { ok: true })
    // NEVER trust client-asserted root/ownerId here (H1: the raw body
    // reached writeGate and {"root":true} deleted any share by id).
    // Resolve identity from the bearer like every other write path.
    const ident = await resolveIdentity(req, body)
    const gate = writeGate(share, { secret: body.secret, ownerId: ident.ownerId, root: ident.root, tokenId: ident.tokenId, tokenKind: ident.tokenKind })
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
  return chk.kind === "user"
    ? { ownerId: chk.userId, root: false, tokenId: chk.tokenId, tokenKind: chk.tokenKind, ttlMaxHours: chk.kind === "user" ? ((JSON.parse(chk.token.limits).maxTtlHours || 0) || Math.floor((JSON.parse(chk.token.limits).maxTtlDays || 0) * 24)) : 0 }
    : { ownerId: null, root: false }
}

async function httpCreate(body: Record<string, unknown>, ownerId: string | null, ttlMax: number, ownerDefault = 0, tokenId: string | null = null, setA: Partial<TokenSet> | null = null): Promise<Response> {
  if (!body.sessionID || typeof body.sessionID !== "string") return json(400, { error: "sessionID required" })
  // B4 Class A: the token's provisioned set overrides client values
  if (setA) {
    if (setA.authLogin !== undefined) { body.authLogin = setA.authLogin; body.authPassword = setA.authPassword ?? "" }
    if (setA.ttlHours !== undefined) body.ttlHours = setA.ttlHours
  }
  // explicit ttlHours wins (legacy ttlDays converts); else the owner's
  // stored default, re-clamped
  const ttlHours = clampTtlHours(ttlHoursFrom(body) ?? (ownerDefault || undefined), ttlMax)
  const { id, secret } = createShare(body.sessionID, ttlHours, ownerId, String(body.authLogin ?? ""), String(body.authPassword ?? ""), normCustom(body.meta), tokenId)
  return json(200, { ok: true, id, secret, ttlHours })
}

function removeShare(id: string) {
  broadcast(id, { op: "frame", status: "gone", rev: 1, items: [] })
  db.query("DELETE FROM shares WHERE id = ?").run(id)
  db.query("DELETE FROM items WHERE shareId = ?").run(id)
  const cached = dataCache.get(id)
  if (cached) {
    dataCacheBytes -= cached.bytes
    dataCache.delete(id)
  }
  // close viewer sockets: the gone frame already told them; closing moves
  // them onto the poll path, where the 404 renders the gone page (parity
  // with the worker, where the DO dies and takes the sockets with it)
  const set = viewers.get(id)
  if (set) {
    for (const ws of set) try { ws.close(1000, "gone") } catch {}
    viewers.delete(id)
  }
}

async function bodyJson(req: Request, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
  try {
    const text = await req.text()
    // request-size cap before parse: a hostile client posting a huge
    // body must not burn CPU on the parse (the engine chunks at ~512 KB)
    if (text.length > maxBytes) return { _tooLarge: true }
    const b = JSON.parse(text)
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
  } else if (authMode() !== "public" || !codelessOnboarding()) {
    // codeless onboarding is an explicit opt-in even on public servers
    // (default OFF): anonymous creating stays open, ACCOUNTS need a code
    return json(403, { ok: false, error: authMode() === "public" ? "code required (codeless onboarding disabled)" : "code required" })
  }
  if (!codeRow) {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local"
    const row = db.query("SELECT * FROM rate WHERE ip = ?").get(ip) as { ip: string; n: number; resetAt: number } | undefined
    if (!row || row.resetAt < now) db.query("INSERT INTO rate (ip, n, resetAt) VALUES (?, 1, ?) ON CONFLICT(ip) DO UPDATE SET n = 1, resetAt = ?").run(ip, now + 3600000, now + 3600000)
    else if (row.n >= 10) return json(429, { ok: false, error: "too many enrollments, try later" })
    else db.query("UPDATE rate SET n = n + 1 WHERE ip = ?").run(ip)
    // GLOBAL backstop: x-forwarded-for is client-controlled when the
    // server is directly exposed (no trusted proxy), so per-IP limiting
    // alone is dodgeable — cap anonymous enrollments process-wide too
    const g = db.query("SELECT * FROM rate WHERE ip = '*'").get() as { n: number; resetAt: number } | undefined
    if (!g || g.resetAt < now) db.query("INSERT INTO rate (ip, n, resetAt) VALUES ('*', 1, ?) ON CONFLICT(ip) DO UPDATE SET n = 1, resetAt = ?").run(now + 3600000, now + 3600000)
    else if (g.n >= 100) return json(429, { ok: false, error: "too many enrollments, try later" })
    else db.query("UPDATE rate SET n = n + 1 WHERE ip = '*'").run()
  }
  if (codeRow) {
    // atomic budget consumption: the conditional UPDATE is the check AND
    // the decrement in one statement — two concurrent enrollments on a
    // 1-activation code cannot both pass (SELECT-then-UPDATE could)
    const consumed = db.query(
      "UPDATE codes SET used = used + 1, activationsLeft = CASE WHEN activationsLeft = -1 THEN -1 ELSE activationsLeft - 1 END WHERE id = ? AND disabled = 0 AND (expiresAt = 0 OR expiresAt >= ?) AND (activationsLeft = -1 OR activationsLeft > 0)",
    ).run(codeRow.id, now)
    if (!consumed.changes) return json(403, { ok: false, error: "invalid code" })
  }
  const label = String(body.label ?? "").trim().slice(0, 64) || (codeRow ? `${codeRow.label || "invite"}-${codeRow.used + 1}` : "user-" + randomId().slice(0, 4))
  const userId = "u_" + randomId().slice(0, 10)
  db.query("INSERT INTO users (id, label, createdAt, createdByCode) VALUES (?, ?, ?, ?)").run(userId, label, now, codeRow?.id ?? null)
  const token = await mint(userId, label, defaultLimits())
  console.log(`[auth] enrolled ${userId} ${label}${codeRow ? " via code" : " codeless"}`)
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
  if (chk.tokenKind === "scoped") return json(403, { ok: false, error: "scoped tokens cannot edit settings" })
  const user = db.query("SELECT * FROM users WHERE id = ?").get(chk.userId) as { settings: string }
  const next = JSON.parse(user.settings) as Record<string, unknown>
  if (patch.defaultTtlDays !== undefined || patch.defaultTtlHours !== undefined) {
    const rawH = Number.isFinite(Number(patch.defaultTtlHours)) && Number(patch.defaultTtlHours) > 0
      ? Math.floor(Number(patch.defaultTtlHours))
      : Math.floor(Number(patch.defaultTtlDays) * 24)
    next.defaultTtlHours = Number.isFinite(rawH) && rawH > 0 ? Math.min(rawH, Math.max(1, MAX_TTL_DAYS * 24)) : Math.max(1, MAX_TTL_DAYS * 24)
    delete next.defaultTtlDays
  }
  db.query("UPDATE users SET settings = ? WHERE id = ?").run(JSON.stringify(next), chk.userId)
  return json(200, { ok: true, settings: next })
}

async function meSharesRoute(token: string): Promise<Response> {
  const chk = await checkToken(token)
  if (chk.kind !== "user") return json(401, { ok: false, error: "invalid token" })
  // scoped tokens see ONLY the shares they created (worker parity)
  const rows = (chk.tokenKind === "scoped"
    ? db.query("SELECT id, sessionID, createdAt, status FROM shares WHERE ownerId = ? AND creatorTokenId = ?").all(chk.userId, chk.tokenId)
    : db.query("SELECT id, sessionID, createdAt, status FROM shares WHERE ownerId = ?").all(chk.userId)) as Array<{ id: string; sessionID: string; createdAt: number; status: string }>
  return json(200, { ok: true, shares: rows })
}

async function rotateRoute(token: string): Promise<Response> {
  const chk = await checkToken(token)
  if (chk.kind !== "user") return json(401, { ok: false, error: "invalid token" })
  db.query("UPDATE tokens SET revokedAt = ? WHERE id = ?").run(Date.now(), chk.token.id)
  // successor keeps the class (rotating scoped yields scoped); a scoped
  // rotation TRANSFERS its shares to the successor, or rotation would
  // orphan the very pages it created (creatorTokenId is the scope key)
  const fresh = await mint(chk.userId, chk.token.label, JSON.parse(chk.token.limits), chk.token.kind === "scoped" ? "scoped" : "full")
  if (chk.token.kind === "scoped") db.query("UPDATE shares SET creatorTokenId = ? WHERE creatorTokenId = ?").run(fresh.id, chk.token.id)
  return json(200, { ok: true, token: fresh.value, userId: chk.userId, tokenKind: fresh.kind })
}

/** Self-service mint (worker parity): only FULL tokens may mint; scoped
 * mint target is the point - CI/agent credentials without authority. */
async function tokenSelfMintRoute(body: Record<string, unknown>, token: string): Promise<Response> {
  const chk = await checkToken(token)
  if (chk.kind !== "user") return json(401, { ok: false, error: "invalid token" })
  if (chk.tokenKind === "scoped") return json(403, { ok: false, error: "scoped tokens cannot mint tokens" })
  const kind = body.kind === "scoped" ? "scoped" : "full"
  const t = await mint(chk.userId, String(body.label ?? ""), body.limits, kind)
  // sets ride the new token: explicit, else inherit the minter's
  const sets = body.sets !== undefined ? normSets(body.sets) : chk.sets ?? {}
  if (Object.keys(sets).length) db.query("UPDATE tokens SET sets = ? WHERE id = ?").run(JSON.stringify(sets), t.id)
  return json(200, { ok: true, token: t.value, id: t.id, userId: chk.userId, kind })
}

async function tokenSetsGetRoute(token: string): Promise<Response> {
  const chk = await checkToken(token)
  if (chk.kind !== "user") return json(401, { ok: false, error: "invalid token" })
  return json(200, { ok: true, sets: setsPublicView(chk.sets) })
}

async function tokenSetsPutRoute(body: Record<string, unknown>, token: string): Promise<Response> {
  const chk = await checkToken(token)
  if (chk.kind !== "user") return json(401, { ok: false, error: "invalid token" })
  if (chk.tokenKind === "scoped") return json(403, { ok: false, error: "scoped tokens cannot edit sets" })
  const sets = normSets(body.sets)
  db.query("UPDATE tokens SET sets = ? WHERE id = ?").run(JSON.stringify(sets), chk.tokenId)
  return json(200, { ok: true, sets: setsPublicView(sets) })
}

async function tokenDeleteRoute(token: string): Promise<Response> {
  const chk = await checkToken(token)
  if (chk.kind !== "user") return json(401, { ok: false, error: "invalid token" })
  db.query("UPDATE tokens SET revokedAt = ? WHERE id = ?").run(Date.now(), chk.token.id)
  const frozen = freezeIfNoValidTokens(chk.userId)
  return json(200, { ok: true, frozen })
}

/** Revocation kills control (owner directive, worker parity): a user whose
 * LAST valid token is gone loses write access to ALL their shares - user
 * token AND share secret - until an admin unfreezes/reassigns. Viewing is
 * never touched. Rotation never lands here (replacement minted first). */
function freezeIfNoValidTokens(userId: string): boolean {
  const now = Date.now()
  // only FULL tokens keep the account alive (worker parity)
  const alive = (db.query("SELECT id FROM tokens WHERE userId = ? AND kind != 'scoped' AND revokedAt = 0 AND (expiresAt = 0 OR expiresAt > ?)").all(userId, now) as unknown[]).length
  if (alive) return false
  const n = db.query("UPDATE shares SET frozen = 1 WHERE ownerId = ? AND frozen = 0").run(userId).changes
  if (n > 0) {
    db.query("UPDATE users SET frozen = 1 WHERE id = ?").run(userId)
    console.log("[auth] no valid tokens left - froze", n, "shares of user", userId)
    return true
  }
  return false
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
    const t = await mint(String(body.userId), String(body.label ?? ""), body.limits, body.kind === "scoped" ? "scoped" : "full")
    const sets = normSets(body.sets)
    if (Object.keys(sets).length) db.query("UPDATE tokens SET sets = ? WHERE id = ?").run(JSON.stringify(sets), t.id)
    return json(200, { ok: true, token: t.value, id: t.id, userId: body.userId, kind: t.kind })
  }
  if (path === "/api/admin/tokens" && req.method === "GET") {
    const tokens = db.query("SELECT * FROM tokens").all() as TokenRow[]
    return json(200, { ok: true, tokens: tokens.map((t) => ({ id: t.id, userId: t.userId, label: t.label, limits: JSON.parse(t.limits), createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, expiresAt: t.expiresAt, revoked: !!t.revokedAt, kind: t.kind === "scoped" ? "scoped" : "full" })) })
  }
  // code-lineage kill-switch: revoke every token of every user this
  // code onboarded (freezing each per the no-full-token rule)
  m = path.match(/^\/api\/admin\/codes\/([^/]+)\/revoke-lineage$/)
  if (m && req.method === "POST") {
    const codeId = m[1]
    const res = db.query("UPDATE codes SET disabled = 1 WHERE id = ?").run(codeId)
    if (!res.changes) return json(404, { ok: false, error: "no such code" })
    const users = db.query("SELECT id FROM users WHERE createdByCode = ?").all(codeId) as Array<{ id: string }>
    let revoked = 0
    let frozen = 0
    for (const u of users) {
      const r = db.query("UPDATE tokens SET revokedAt = ? WHERE userId = ? AND revokedAt = 0").run(Date.now(), u.id)
      revoked += r.changes ?? 0
      if (freezeIfNoValidTokens(u.id)) frozen++
    }
    return json(200, { ok: true, users: users.length, revoked, frozen, codeDisabled: true })
  }
  // bulk op: freeze every share a specific token created
  m = path.match(/^\/api\/admin\/tokens\/([^/]+)\/sets$/)
  if (m && req.method === "PUT") {
    const row = db.query("SELECT hash FROM tokens WHERE id = ?").get(m[1]) as { hash: string } | undefined
    if (!row) return json(404, { ok: false, error: "no such token" })
    const sets = normSets(body.sets)
    db.query("UPDATE tokens SET sets = ? WHERE id = ?").run(JSON.stringify(sets), m[1])
    return json(200, { ok: true, id: m[1], sets: setsPublicView(sets) })
  }
  m = path.match(/^\/api\/admin\/tokens\/([^/]+)\/freeze-shares$/)
  if (m && req.method === "POST") {
    const tokenId = m[1]
    const frozen = body.frozen === false ? 0 : 1
    const rows = db.query("SELECT id FROM shares WHERE creatorTokenId = ?").all(tokenId) as Array<{ id: string }>
    if (!rows.length) return json(404, { ok: false, error: "no shares created by that token" })
    for (const r of rows) {
      db.query("UPDATE shares SET frozen = ? WHERE id = ?").run(frozen, r.id)
      broadcast(r.id, { op: "frame", status: "frozen", rev: (q.share(r.id)?.rev ?? 0) + 1, items: [] })
    }
    return json(200, { ok: true, shares: rows.length })
  }
  m = path.match(/^\/api\/admin\/tokens\/([^/]+)$/)
  if (m && req.method === "DELETE") {
    const row = db.query("SELECT userId FROM tokens WHERE id = ?").get(m[1]) as { userId: string } | undefined
    const res = db.query("UPDATE tokens SET revokedAt = ? WHERE id = ?").run(Date.now(), m[1])
    if (!res.changes) return json(404, { ok: false, error: "no such token" })
    const frozen = row ? freezeIfNoValidTokens(row.userId) : false
    return json(200, { ok: true, frozen })
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
    const rows = (db.query("SELECT id, sessionID, createdAt, ownerId, custom FROM shares").all() as Array<{ id: string; sessionID: string; createdAt: number; ownerId: string | null; custom: string }>)
      .map((r) => ({ ...r, custom: JSON.parse(r.custom || "{}") }))
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
  // normalize: the column default is '{}' whose .ips is undefined (that
  // 500'd every login before)
  const attempts = (() => {
    try {
      const a = JSON.parse(share.attempts) as { ips?: Record<string, { fails: number; lockUntil: number; streak: number; at?: number }>; total?: number; lockUntil?: number }
      return { ips: a.ips ?? {}, total: a.total ?? 0, lockUntil: a.lockUntil ?? 0 }
    } catch { return { ips: {}, total: 0, lockUntil: 0 } }
  })()
  // NOTE: x-forwarded-for is only meaningful behind a trusted proxy that
  // overwrites it — the per-IP lock is best-effort; the per-share global
  // counters are the real brake on this backend.
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
    ipState.at = now
    attempts.total += 1
    if (ipState.fails >= 5) {
      ipState.lockUntil = now + Math.min(60000 * 2 ** (ipState.streak - 5), 86400000)
      ipState.fails = 0
    }
    if (attempts.total >= 20) attempts.lockUntil = now + 86400000
    // bound the tracker (distributed probes must not grow the row forever)
    const ips = Object.entries(attempts.ips)
    if (ips.length > 100) {
      ips.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
      attempts.ips = Object.fromEntries(ips.slice(0, 100))
    }
    db.query("UPDATE shares SET attempts = ? WHERE id = ?").run(JSON.stringify(attempts), id)
    return json(401, { ok: false, error: "wrong credentials", retryAfterMs: Math.max(ipState.lockUntil - now, attempts.lockUntil - now, 0) })
  }
  delete attempts.ips[ip]
  attempts.total = Math.max(0, attempts.total - 1)
  // an elapsed global lock no longer counts (one failure/day must not
  // keep the share read-locked forever)
  if (attempts.lockUntil && attempts.lockUntil <= now) {
    attempts.lockUntil = 0
    attempts.total = 0
  }
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

/** Frozen self-contained HTML snapshot (worker serveSnapshot parity):
 * viewer bundle inlined from disk, share data as a JSON island. */
async function serveSnapshot(url: URL, id: string, island: string): Promise<Response> {
  const index = Bun.file(join(VIEWER_DIR, "index.html"))
  if (!(await index.exists())) return json(502, { error: "viewer assets unavailable" })
  let html = await index.text()
  const grab = async (src: string) => {
    const f = Bun.file(join(VIEWER_DIR, src.replace(/^\//, "")))
    return (await f.exists()) ? await f.text() : null
  }
  html = html.replace(/[ \t]*<link[^>]*rel="modulepreload"[^>]*>\r?\n?/g, "")
  // collect asset texts first, then replace synchronously (async replace
  // callbacks are not supported)
  const scriptRe = /<script[^>]*src="(\/assets\/[^"]+\.js)"[^>]*>\s*<\/script>/g
  const scriptAssets = new Map<string, string | null>()
  for (const m of [...html.matchAll(scriptRe)]) scriptAssets.set(m[1], await grab(m[1]))
  html = html.replace(scriptRe, (whole: string, src: string) => {
    const code = scriptAssets.get(src)
    return code == null ? whole : `<script type="module">\n${code}\n</script>`
  })
  const cssRe = /<link[^>]*href="(\/assets\/[^"]+\.css)"[^>]*>/g
  const cssAssets = new Map<string, string | null>()
  for (const m of [...html.matchAll(cssRe)]) cssAssets.set(m[1], await grab(m[1]))
  html = html.replace(cssRe, (whole: string, src: string) => {
    const css = cssAssets.get(src)
    return css == null ? whole : `<style>\n${css}\n</style>`
  })
  const islandTag = `<script>window.__MIRROBOT_SNAPSHOT__=${island};</script>` + `
<script>(function(){
  // a snapshot file runs from file:// — its PATH cannot be rewritten
  // (pushState across file paths throws SecurityError), so /s/<id>[/<n>][#h]
  // URLs translate to same-path hashes: subagent page n becomes #n<n>,
  // message anchors keep their hash (worker serveSnapshot parity)
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
  html = html.replace(/<head>/i, "<head>\n    " + islandTag)
  const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  if (url.searchParams.has("download")) headers["content-disposition"] = `attachment; filename="openshare-${id}.html"`
  return new Response(html, { headers })
}

async function ogIndex(url: URL): Promise<Response> {  const index = Bun.file(join(VIEWER_DIR, "index.html"))
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
  attachTokenId?: string | null
  attachTokenKind?: string | null
  earlySyncs: Frame[]
}
type ViewerData = { kind: "viewer"; shareId: string; since?: string; delta?: string }
type WsData = ControlData | ViewerData

async function controlMessage(ws: Bun.WebSocket<WsData>, raw: string | Buffer) {
  const data = ws.data as ControlData
  const send = (obj: unknown) => { try { ws.send(JSON.stringify(obj)) } catch {} }
  try {
    // message-size cap before parse: a hostile socket posting a huge
    // frame must not burn CPU on the parse (engine WS chunks at ~512KB)
    if (String(raw).length > 8_000_000) return send({ op: "error", error: "payload too large" })
    const frame = JSON.parse(String(raw)) as Frame
    // frame auth: /health advertises frameAuth — the plugin can keep the
    // token out of the query string (proxy logs) by sending it as the
    // first frame. The ?token= upgrade param still works (old plugins).
    if (frame.op === "auth") {
      data.token = typeof frame.token === "string" ? frame.token : ""
      return send({ op: "authed", ok: true })
    }
    if (frame.op === "init") {
      if (frame.create) {
        const createBody = frame.create as Record<string, unknown>
        const chk = await createCheck(data.token, createBody.set)
        if (!chk.ok) return send({ op: "init", ok: false, error: chk.error })
        // B4 Class A: provisioned set overrides client values
        if (chk.setA) {
          if (chk.setA.authLogin !== undefined) { createBody.authLogin = chk.setA.authLogin; createBody.authPassword = chk.setA.authPassword ?? "" }
          if (chk.setA.ttlHours !== undefined) createBody.ttlHours = chk.setA.ttlHours
        }
        // explicit ttlHours wins (legacy ttlDays converts); else default
        const ttlHours = clampTtlHours(ttlHoursFrom(createBody) ?? (chk.defaultTtlHours || undefined), chk.ttlMaxHours ?? 0)
        const { id, secret } = createShare(String((frame.create as Record<string, unknown>).sessionID ?? ""), ttlHours, chk.userId ?? null, String((frame.create as Record<string, unknown>).authLogin ?? ""), String((frame.create as Record<string, unknown>).authPassword ?? ""), normCustom((frame.create as Record<string, unknown>).meta), chk.tokenId ?? null)
        data.attachId = id
        data.attachSecret = secret
        data.attachOwner = chk.userId ?? null
        data.attachTokenId = chk.tokenId ?? null
        data.attachTokenKind = chk.tokenKind ?? null
        for (const early of data.earlySyncs) {
          // WS sync frames carry `items`; the HTTP apply path takes `data`
          const r = applySync(id, { secret, ownerId: data.attachOwner, root: false, tokenId: data.attachTokenId, tokenKind: data.attachTokenKind, data: early.items ?? [], status: early.status })
          send({ op: r.body.ok ? "ack" : "nack", ...r.body, seq: (early as Frame).seq })
        }
        data.earlySyncs = []
        return send({ op: "init", ok: true, id, secret, rev: 0, status: "live", ttlHours, policy: resolvePolicy(), auth: !!(frame.create as Record<string, unknown>).authLogin && !!(frame.create as Record<string, unknown>).authPassword })
      }
      if (frame.attach) {
        const share = q.share(String((frame.attach as Record<string, unknown>).id ?? ""))
        if (!share) return send({ op: "init", ok: false, error: "share not found" })
        // owner-token control: the socket's bearer may own the share even
        // without the secret; root administers everything
        const chk = await checkToken(data.token)
        const ownerId = chk.kind === "user" ? chk.userId : null
        const root = chk.kind === "root"
        const tokenId = chk.kind === "user" ? chk.tokenId : null
        const tokenKind = chk.kind === "user" ? chk.tokenKind : null
        const gate = writeGate(share, { secret: (frame.attach as Record<string, unknown>).secret, ownerId, root, tokenId, tokenKind })
        if (gate) return send({ op: "init", ok: false, error: gate })
        data.attachId = share.id
        data.attachSecret = String((frame.attach as Record<string, unknown>).secret ?? "")
        data.attachOwner = ownerId
        data.attachRoot = root
        data.attachTokenId = tokenId
        data.attachTokenKind = tokenKind
        // attach = the plugin is actively here: cancel finalize, note the
        // contact, and keep TTL from expiring under a live-but-quiet session
        db.query("UPDATE shares SET pluginSeen = ?, lastActive = ?, finalizeAt = NULL WHERE id = ?").run(Date.now(), Date.now(), share.id)
        // resume retroactively applies/updates/clears the read gate (worker parity).
        // The plugin sends BOTH fields on EVERY attach — only rotate when the
        // credentials actually CHANGED (an unconditional re-hash logged every
        // viewer out on each turn-mode reconnect)
        const attach = frame.attach as Record<string, unknown>
        if (attach.authLogin !== undefined && attach.authPassword !== undefined) {
          const wantAuth = attach.authLogin && attach.authPassword
          let sameAuth = false
          if (wantAuth && share.auth) {
            const auth = JSON.parse(share.auth) as { salt: string; loginHash: string; passHash: string }
            sameAuth = auth.loginHash === await pbkdf2(String(attach.authLogin), auth.salt)
              && auth.passHash === await pbkdf2(String(attach.authPassword), auth.salt)
          }
          if (wantAuth && !sameAuth) {
            db.query("UPDATE shares SET auth = ?, tokens = ?, attempts = ? WHERE id = ?")
              .run(await makeAuth(String(attach.authLogin), String(attach.authPassword)), "[]", JSON.stringify({ ips: {}, total: 0, lockUntil: 0 }), share.id)
            console.log("[attach] auth updated, tokens rotated")
          } else if (!wantAuth && share.auth) {
            db.query("UPDATE shares SET auth = NULL WHERE id = ?").run(share.id)
            console.log("[attach] auth removed (owner action)")
          }
        }
        // explicit per-session TTL override changing mid-life: clamp like
        // create (server cap + the token's maxTtlDays), then rebase the
        // sweeper deadline (worker parity)
        const attachTtlH = ttlHoursFrom(attach)
        if (attachTtlH !== undefined) {
          // chk (from /check) already carries the token's maxTtlDays - a
          // create-check here would burn a daily-create slot
          const ttlH = clampTtlHours(attachTtlH, chk.kind === "user" ? ((JSON.parse(chk.token.limits).maxTtlHours || 0) || Math.floor((JSON.parse(chk.token.limits).maxTtlDays || 0) * 24)) : 0)
          db.query("UPDATE shares SET ttlHours = ?, ttlDays = ? WHERE id = ?").run(ttlH, Math.ceil(ttlH / 24), share.id)
          console.log("[attach] ttl updated to", ttlH, "hours")
        }
        const updated = q.share(share.id)!
        for (const early of data.earlySyncs) {
          const r = applySync(share.id, { secret: data.attachSecret, ownerId, root, tokenId: data.attachTokenId, tokenKind: data.attachTokenKind, data: early.items ?? [], status: early.status })
          send({ op: r.body.ok ? "ack" : "nack", ...r.body, seq: (early as Frame).seq })
        }
        data.earlySyncs = []
        // no `data` payload (worker parity): the plugin backfills from the
        // host and ignores attach data
        return send({ op: "init", ok: true, id: share.id, secret: data.attachSecret, rev: updated.rev, status: updated.status, policy: resolvePolicy(), auth: !!updated.auth })
      }
      return send({ op: "init", ok: false, error: "init needs create|attach" })
    }
    if (frame.op === "sync") {
      if (!data.attachId) {
        // buffer while init is in flight; a huge cap (frames are chunk-
        // sized client-side) with an error-and-close valve so a burst can
        // never be silently dropped
        if (data.earlySyncs.length < 1000) data.earlySyncs.push(frame)
        else {
          send({ op: "error", error: "early-sync buffer full" })
          try { ws.close(4004, "early-sync overflow") } catch {}
        }
        return
      }
      // WS sync frames carry `items`; the HTTP apply path takes `data`
      const r = applySync(data.attachId, { secret: data.attachSecret, ownerId: data.attachOwner, root: data.attachRoot, tokenId: data.attachTokenId, tokenKind: data.attachTokenKind, data: frame.items ?? [], status: frame.status })
      // echo the client frame seq: the plugin clears pending per-chunk
      return send({ op: r.body.ok ? "ack" : "nack", ...r.body, seq: frame.seq })
    }
    if (frame.op === "delete" && data.attachId) {
      const share = q.share(data.attachId)
      if (share) {
        const gate = writeGate(share, { secret: data.attachSecret, ownerId: data.attachOwner, root: data.attachRoot, tokenId: data.attachTokenId, tokenKind: data.attachTokenKind })
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
    const rows = db.query("SELECT id, ttlDays, ttlHours, lastActive FROM shares").all() as Array<{ id: string; ttlDays: number; ttlHours: number; lastActive: number }>
    for (const r of rows) {
      const hours = (r.ttlHours && r.ttlHours > 0) ? r.ttlHours : Math.floor((r.ttlDays || 90) * 24)
      if (r.lastActive + hours * 3600000 < now) removeShare(r.id)
    }
    // hygiene: daily-create counters and rate rows expire themselves out
    // (k = "<tokenId>:<YYYY-MM-DD>" / ip rows carry resetAt) - without
    // this both tables grow forever
    // revocation-by-expiry (worker parity, eventual): a user whose tokens
    // ALL expired loses control of their shares like an explicit revoke
    try {
      const dead = db.query(
        "SELECT DISTINCT u.id AS id FROM users u JOIN shares s ON s.ownerId = u.id WHERE u.frozen = 0 AND NOT EXISTS (SELECT 1 FROM tokens t WHERE t.userId = u.id AND t.revokedAt = 0 AND (t.expiresAt = 0 OR t.expiresAt > ?))",
      ).all(now) as Array<{ id: string }>
      for (const u of dead) freezeIfNoValidTokens(u.id)
    } catch (e) {
      console.log("[auth] expiry sweep error", e)
    }
    try {
      // k = "<tokenId>:<YYYY-MM-DD>" — the date is the trailing 10 chars
      const cutoff = new Date(now - 2 * 86400000).toISOString().slice(0, 10)
      db.query("DELETE FROM dcreates WHERE substr(k, length(k) - 9) < ?").run(cutoff)
      db.query("DELETE FROM rate WHERE resetAt < ?").run(now - 2 * 3600000)
    } catch {}
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
        if (srv.upgrade(req, { data: { kind: "viewer", shareId: wm[1], since: url.searchParams.get("since") ?? undefined, delta: url.searchParams.get("delta") ?? undefined } satisfies ViewerData })) return
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
          // `since` handshake (worker parity): since === rev answers an
          // empty frame; since < rev with delta=1 answers a DELTA (only
          // items touched since, tombstones included — rev/del rows);
          // anything else gets the full frame (incl. since > rev, where
          // the viewer must prune). Deltas only for clients that
          // announced capability (old bundles treat any non-empty first
          // frame as the full set).
          const since = Number(ws.data.since)
          if (Number.isFinite(since) && since === share.rev) {
            try { ws.send(JSON.stringify({ v: 2, op: "frame", status: share.status, rev: share.rev, items: [] })) } catch {}
          } else if (ws.data.delta === "1" && Number.isFinite(since) && since >= 0 && since < share.rev) {
            const delta = db.query("SELECT item FROM items WHERE shareId = ? AND rev > ?").all(share.id, since) as Array<{ item: string }>
            try { ws.send(JSON.stringify({ v: 2, op: "frame", status: share.status, rev: share.rev, items: delta.map((r) => JSON.parse(r.item)), kind: "delta" })) } catch {}
          } else {
            try {
              if (share.auth) {
                const priv = JSON.parse(share.private || "{}") as Record<string, unknown>
                ws.send(renderFrame(share).slice(0, -1) + ',"private":' + JSON.stringify(priv) + "}")
              } else ws.send(renderFrame(share))
            } catch {}
          }
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
