// OpenShare share flows — host-agnostic logic behind /share and
// the settings dialog's "this session" actions. Runs against the
// ShareHostApi facade (tui-host.ts) and the shared config module, so the
// same compiled code serves the v1 TUI and the v2 adapter.
//
// Flow contracts (mirrored by scripts/manual-tests.mjs):
//  /share     resolve root session -> config check (onboard to settings
//             when unconfigured) -> consent once -> set the enabled flag
//             (with per-session opts when present) -> wait for the server
//             plugin to publish the binding URL into session metadata
//             (~seconds; worker-down surfaces as a timeout toast) -> copy.
//  stop-sharing   resolve root -> confirm -> read binding -> clear flag ->
//             DELETE the share directly via the worker (belt and braces:
//             works even if the server plugin never saw the flag event) ->
//             the server-side flag-removal path cleans up on its own.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { loadConfig, moduleDir, configPaths, configHomePath, resolveServer, saveServerEntry, deleteServerEntry, METADATA_KEY, type ShareConfig, type ServerEntry } from "./config.js"
import { dbg, dbgLog } from "./sidebar.js"
import { engineTargetUrls, sessionStatsFor, type ClientApi, type SessionInfo, type SessionOpts } from "./core.js"
import { queueBindingWrite } from "./binding-queue.js"
import type { ShareHostApi } from "./tui-host.js"

export type SessionBinding = {
  id: string
  secret: string
  rev: number
  url: string
  enabled?: boolean
  opts?: SessionOpts
  /** per-server "leave as-is" marker: a snapshot, not a live mirror */
  optedOut?: boolean
  /** engine-recorded last create/attach refusal (quota, frozen, ...) */
  lastError?: string
  /** server policy clamped the requested TTL */
  ttlClamped?: { requested: number; effective: number }
}

export function pluginConfigPaths(baseDir: string = moduleDir()): string[] {
  return configPaths(baseDir)
}

export function currentConfig(baseDir: string = moduleDir()): ShareConfig {
  return loadConfig(baseDir)
}

/** Writes the config file. Target rule (owner-directed): the global
 * settings home by default, or an explicit existing file chosen in the
 * TUI — NEVER "first existing in the read chain" (that wrote TUI edits
 * into the tracked adjacent template, live-caught). $comment and foreign
 * keys preserved. */
export function saveConfig(cfg: ShareConfig, target?: string, baseDir: string = moduleDir()): { path: string } | undefined {
  const path = target ?? configHomePath()
  if (!path) return undefined
  try {
    const previous: Record<string, unknown> = existsSync(path)
      ? (() => {
          try {
            return JSON.parse(readFileSync(path, "utf8"))
          } catch {
            return {}
          }
        })()
      : {}
    // preserve $comment and any foreign keys, override with our values
    const next: Record<string, unknown> = { ...previous }
    for (const key of [
      "workerUrl",
      "createToken",
      "servers",
      "debounceMs",
      "completedDelayMs",
      "modelLabel",
      "ttlHours",
      "authLogin",
      "authPassword",
      "spoolDir",
      "urlFile",
      "shareMode",
      "announceStderr",
    ] as Array<keyof ShareConfig>) {
      next[key] = cfg[key]
    }
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n")
    return { path }
  } catch {
    return undefined
  }
}

export function isConfigured(cfg: ShareConfig): boolean {
  // token optional: with none, the engine (or the TUI connect flow)
  // enrolls on first contact — public servers take anyone, private ones
  // need servers.{url}.code
  return Boolean(resolveServer(cfg)?.url)
}

/** The resolved active server (url + entry), for the TUI server rows. */
export function activeServer(cfg: ShareConfig = currentConfig()): { url: string; token: string; entry: ServerEntry } | undefined {
  return resolveServer(cfg)
}

export function serverEntries(cfg: ShareConfig = currentConfig()): Array<{ url: string; entry: ServerEntry; active: boolean }> {
  const merged: Record<string, ServerEntry> = {}
  if (cfg.workerUrl) merged[cfg.workerUrl] = { token: cfg.createToken || "", active: true }
  if (cfg.servers) for (const [url, entry] of Object.entries(cfg.servers)) merged[url] = { ...merged[url], ...entry }
  const urls = Object.keys(merged)
  // EVERY explicit active is active (the engine fans out to all of them);
  // only when none is marked does the first entry act as the default
  const anyActive = urls.some((u) => merged[u].active)
  return urls.map((url) => ({ url, entry: merged[url], active: anyActive ? merged[url].active === true : url === urls[0] }))
}

export { saveServerEntry, deleteServerEntry }

// --- session metadata helpers -------------------------------------------------

/** All live per-server bindings from a v2 (or legacy v1) metadata record. */
export function bindingsOf(info: SessionInfo | undefined): Array<SessionBinding & { server: string; collided?: string }> {
  const raw = info?.metadata?.[METADATA_KEY]
  if (!raw || typeof raw !== "object") return []
  const record = raw as Record<string, unknown>
  const opts = (record.opts as SessionOpts | undefined) ?? undefined
  const enabled = record.enabled === true ? true : undefined
  const lastError = typeof record.lastError === "string" ? record.lastError : undefined
  const ttlClamped = record.ttlClamped && typeof record.ttlClamped === "object" ? (record.ttlClamped as { requested: number; effective: number }) : undefined
  const out: Array<SessionBinding & { server: string; collided?: string }> = []
  if (record.servers && typeof record.servers === "object") {
    for (const [server, entry] of Object.entries(record.servers as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue
      const e = entry as Record<string, unknown>
      if (typeof e.id !== "string" || typeof e.secret !== "string" || !e.id) continue
      const collided = typeof e.collided === "string" ? e.collided : undefined
      out.push({
        id: e.id,
        secret: e.secret,
        rev: typeof e.rev === "number" ? e.rev : 0,
        url: typeof e.url === "string" ? e.url : "",
        enabled,
        opts,
        server,
        collided,
        optedOut: e.optedOut === true ? true : undefined,
        lastError,
        ttlClamped,
      })
    }
    return out
  }
  // legacy flat binding
  if (typeof record.id === "string" && typeof record.secret === "string" && record.id) {
    const collided = typeof record.collided === "string" ? record.collided : undefined
    out.push({
      id: record.id,
      secret: record.secret,
      rev: typeof record.rev === "number" ? record.rev : 0,
      url: typeof record.url === "string" ? record.url : "",
      enabled,
      opts,
      server: "",
      collided,
      lastError,
      ttlClamped,
    })
  }
  return out
}

/** Read every live binding for a session (fan-out aware). */
export async function readBindings(client: ClientApi | undefined, sid: string): Promise<Array<SessionBinding & { server: string; collided?: string }>> {
  return bindingsOf(await getSession(client, sid))
}

/** Human TTL from hours: "6h", "2d", "90d" (the TUI prompt accepts
 * these same shapes back). */
export function fmtHours(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "?"
  if (hours % 24 === 0) return `${Math.floor(hours / 24)}d`
  return `${Math.floor(hours)}h`
}

/** Parse "6h" / "2d" / "48" into hours (bare number = hours). */
export function parseTtlHours(raw: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(h|d|hr|hours?|days?)?\s*$/i.exec(raw ?? "")
  if (!m) return undefined
  const v = Number(m[1])
  if (!Number.isFinite(v) || v <= 0) return undefined
  const unit = (m[2] ?? "h").toLowerCase()
  return Math.max(1, Math.floor(unit.startsWith("d") ? v * 24 : v))
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Mutate metadata.openshare.servers[url] through a patcher (TUI per-
 * server actions: opt-out entries, collision resolution). Reads-modifies-
 * writes the whole metadata to keep foreign keys intact. */
export async function patchSessionBinding(
  client: ClientApi | undefined,
  sid: string,
  mutator: (servers: Record<string, unknown>, binding: Record<string, unknown>) => void,
): Promise<boolean> {
  // the whole read-modify-write runs inside the shared per-session queue:
  // the engine patches the same metadata (binding refresh) and interleaved
  // RMWs silently lose one side's update (see binding-queue.ts)
  return queueBindingWrite(sid, async () => {
    const info = await getSession(client, sid)
    if (!info) return false
    const metadata: Record<string, unknown> = { ...(info.metadata ?? {}) }
    const raw = info.metadata?.[METADATA_KEY]
    const binding: Record<string, unknown> =
      raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : { v: 2, servers: {} }
    const servers: Record<string, unknown> =
      binding.servers && typeof binding.servers === "object" ? { ...(binding.servers as Record<string, unknown>) } : {}
    mutator(servers, binding)
    binding.servers = servers
    metadata[METADATA_KEY] = binding
    return patchMetadata(client, sid, metadata)
  })
}

/** The display/primary binding: the active server's entry when bound
 * there, else the first live entry (single-server configs are unchanged). */
export function bindingOf(info: SessionInfo | undefined): SessionBinding | undefined {
  const all = bindingsOf(info)
  if (!all.length) return undefined
  const active = activeServer()?.url
  return all.find((b) => b.server === active) ?? all[0]
}

async function getSession(client: ClientApi | undefined, sid: string): Promise<SessionInfo | undefined> {
  if (!client?.session?.get) return undefined
  try {
    const res = await client.session.get({ path: { id: sid } })
    const info = (res as { data?: SessionInfo })?.data ?? (res as SessionInfo)
    return info && typeof info === "object" ? info : undefined
  } catch {
    return undefined
  }
}

async function patchMetadata(client: ClientApi | undefined, sid: string, metadata: Record<string, unknown>): Promise<boolean> {
  if (!client?.session?.update) {
    dbgLog(`patchMetadata(${sid}): no client.session.update`)
    return false
  }
  try {
    const res = await client.session.update({ path: { id: sid }, body: { metadata } })
    if (res && typeof res === "object" && "error" in res && (res as { error?: unknown }).error) {
      const err = (res as { error?: { name?: string; data?: { message?: string; ref?: string } } }).error
      dbgLog(`patchMetadata(${sid}) ERROR: ${err?.name}: ${err?.data?.message ?? ""} ref=${err?.data?.ref ?? ""}`)
      return false
    }
    dbgLog(`patchMetadata(${sid}): ok res=${dbg(res)}`)
    return true
  } catch (e) {
    dbgLog(`patchMetadata(${sid}) THREW: ${(e as Error)?.stack ?? e}`)
    return false
  }
}

/** Walks parentID up to the root session (the share owns the whole tree). */
export async function resolveRoot(client: ClientApi | undefined, sid: string): Promise<string> {
  let current = sid
  for (let hops = 0; hops < 10; hops++) {
    const info = await getSession(client, current)
    const parent = info?.parentID
    if (typeof parent !== "string" || !parent || parent === current) return current
    current = parent
  }
  return current
}

export async function readBinding(client: ClientApi | undefined, sid: string): Promise<SessionBinding | undefined> {
  return bindingOf(await getSession(client, sid))
}

/** Sets metadata.openshare = { ...existing(v2 structure preserved),
 * enabled: true, opts? }. The per-server binding entries are the ENGINE's
 * to manage; the flag just opts the session in. CONSENT ONLY: every call
 * here means the user agreed to publish. */
export async function setShareFlag(
  client: ClientApi | undefined,
  sid: string,
  opts?: SessionOpts,
): Promise<boolean> {
  const info = await getSession(client, sid)
  if (!info) return false
  const metadata: Record<string, unknown> = { ...(info.metadata ?? {}) }
  const existing = info.metadata?.[METADATA_KEY]
  const value: Record<string, unknown> =
    existing && typeof existing === "object"
      ? { ...(existing as Record<string, unknown>) }
      : { v: 2, servers: {} }
  value.enabled = true
  if (opts && Object.keys(opts).length) value.opts = opts
  metadata[METADATA_KEY] = value
  return patchMetadata(client, sid, metadata)
}

/** Persists per-session opts WITHOUT touching the enabled state. On an
 * unshared session the opts sit dormant until a consented create consumes
 * them; on a live share the engine picks them up and re-syncs the server
 * (auth/TTL apply immediately). This must never publish anything - the
 * TTL/auth editors use it, and consent is the only path to enabled. */
export async function setShareOpts(
  client: ClientApi | undefined,
  sid: string,
  opts: SessionOpts,
): Promise<boolean> {
  const info = await getSession(client, sid)
  if (!info) return false
  const metadata: Record<string, unknown> = { ...(info.metadata ?? {}) }
  const existing = info.metadata?.[METADATA_KEY]
  const value: Record<string, unknown> =
    existing && typeof existing === "object"
      ? { ...(existing as Record<string, unknown>) }
      : { v: 2, servers: {} }
  if (Object.keys(opts).length) value.opts = opts
  else delete value.opts
  metadata[METADATA_KEY] = value
  return patchMetadata(client, sid, metadata)
}

export async function clearShareFlag(client: ClientApi | undefined, sid: string): Promise<boolean> {
  const info = await getSession(client, sid)
  if (!info) return false
  const metadata: Record<string, unknown> = { ...(info.metadata ?? {}) }
  delete metadata[METADATA_KEY]
  return patchMetadata(client, sid, metadata)
}

// --- worker direct access -------------------------------------------------------

export async function workerDeleteShare(workerUrl: string, id: string, secret: string): Promise<boolean> {
  try {
    const res = await fetch(`${workerUrl.replace(/\/$/, "")}/api/share/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret }),
      signal: AbortSignal.timeout(8000),
    })
    return res.ok
  } catch {
    return false
  }
}

/** PATCH a live share's settings over REST (#13): immediate effect with
 * no socket required (the engine's attach-sync remains the structural
 * path - this is the same edit pushed now, per server). Auth sends as
 * the both-or-none pair or not at all; ttlHours only when explicit. */
export async function patchShareOpts(
  workerUrl: string,
  id: string,
  opts: { authLogin?: string; authPassword?: string; ttlHours?: number },
  secret: string,
): Promise<{ ok: boolean; error?: string }> {
  const body: Record<string, unknown> = { secret }
  if (opts.authLogin !== undefined && opts.authPassword !== undefined) {
    body.authLogin = opts.authLogin
    body.authPassword = opts.authPassword
  }
  if (opts.ttlHours !== undefined) body.ttlHours = opts.ttlHours
  try {
    const res = await fetch(`${workerUrl.replace(/\/$/, "")}/api/share/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    })
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    return res.ok && json.ok ? { ok: true } : { ok: false, error: json.error ?? `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || String(e) }
  }
}

/** Health probe for the settings dialog's connection test. */
export async function probeWorker(workerUrl: string): Promise<{ ok: boolean; detail: string }> {
  if (!workerUrl) return { ok: false, detail: "workerUrl is empty" }
  try {
    const res = await fetch(`${workerUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` }
    const body = (await res.json().catch(() => ({}))) as { service?: string }
    return { ok: true, detail: body.service ? `service: ${body.service}` : "reachable" }
  } catch (error) {
    return { ok: false, detail: (error as Error).message }
  }
}

/** Share liveness probe — the "session says shared but the link is dead"
 * case (purged, TTL-expired, or deleted while the binding stayed in
 * session metadata). GET /data answers 404 {status:"gone"} BEFORE the
 * read-auth gate, so this is a credential-free existence check that
 * works identically on the CF worker and the Bun server. Network errors
 * return "unknown" — never auto-disable on unknown. */
export async function verifyShare(workerUrl: string, shareId: string): Promise<"live" | "gone" | "unknown"> {
  const base = normServerUrl(workerUrl)
  if (!base || !shareId) return "unknown"
  try {
    const res = await fetch(`${base}/api/share/${shareId}/data`, { signal: AbortSignal.timeout(4000) })
    if (res.status === 404) {
      const body = (await res.json().catch(() => ({}))) as { status?: string }
      return body.status === "gone" || Object.keys(body).length === 0 ? "gone" : "unknown"
    }
    // 200 = readable; 401 = read-gated but EXISTS. Both mean the page is there.
    return "live"
  } catch {
    return "unknown"
  }
}

/** Remove the binding entries for shares that no longer exist server-side
 * (the auto-disable half of gone detection). Entries are deleted outright —
 * not optedOut — so a later prompt in the session can create a fresh share. */
export async function clearGoneBindingEntries(host: ShareHostApi, root: string, servers: string[]): Promise<boolean> {
  if (!servers.length) return false
  return patchSessionBinding(host.client, root, (map) => {
    for (const server of servers) delete map[server]
  })
}

// --- server identity ops (TUI) -----------------------------------------------

export function normServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, "")
}

/** /health probe including the auth mode (public enrolls anyone). */
export async function probeAuthMode(workerUrl: string): Promise<{ ok: boolean; mode?: "public" | "private"; detail: string }> {
  const base = normServerUrl(workerUrl)
  if (!base) return { ok: false, detail: "no URL" }
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` }
    const body = (await res.json().catch(() => ({}))) as { auth?: { mode?: string } }
    const mode = body.auth?.mode === "public" ? "public" : body.auth?.mode === "private" ? "private" : undefined
    return { ok: true, mode, detail: mode ? `auth: ${mode}` : "reachable (pre-auth server?)" }
  } catch (error) {
    return { ok: false, detail: (error as Error).message }
  }
}

export async function enrollAtServer(workerUrl: string, code: string): Promise<{ ok: boolean; token?: string; userId?: string; label?: string; error?: string }> {
  const base = normServerUrl(workerUrl)
  try {
    const res = await fetch(`${base}/api/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code || undefined }),
      signal: AbortSignal.timeout(10000),
    })
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; token?: string; userId?: string; label?: string; error?: string }
    if (res.ok && body.ok && typeof body.token === "string") {
      return { ok: true, token: body.token, userId: body.userId, label: body.label }
    }
    return { ok: false, error: body.error ?? `HTTP ${res.status}` }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

export async function rotateAtServer(workerUrl: string, token: string): Promise<{ ok: boolean; token?: string; error?: string }> {
  const base = normServerUrl(workerUrl)
  try {
    const res = await fetch(`${base}/api/token/rotate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    })
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; token?: string; error?: string }
    if (res.ok && body.ok && typeof body.token === "string") return { ok: true, token: body.token }
    return { ok: false, error: body.error ?? `HTTP ${res.status}` }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

export async function disconnectAtServer(workerUrl: string, token: string): Promise<{ ok: boolean; error?: string }> {
  const base = normServerUrl(workerUrl)
  try {
    const res = await fetch(`${base}/api/token`, {
      method: "DELETE",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    })
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    return { ok: res.ok && body.ok !== false, error: body.error }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

// --- admin console (root CREATE_TOKEN) ----------------------------------------

export type AdminUser = { id: string; label: string; createdAt: number; frozen: boolean; shares: number; tokens: number; tokensActive: number }
export type AdminToken = { id: string; userId: string; label: string; limits: Record<string, number>; createdAt: number; lastUsedAt: number; expiresAt: number; revoked: boolean }
export type AdminCode = { id: string; label: string; activationsLeft: number; used: number; createdAt: number; expiresAt: number; disabled: boolean }
export type AdminShare = { id: string; createdAt: number; sessionID?: string; ownerId?: string | null }

/** Thin typed client for the worker's /api/admin surface. `token` must be
 * the server's root CREATE_TOKEN (user osk_ tokens get 403). */
export function adminClient(workerUrl: string, token: string) {
  const base = normServerUrl(workerUrl)
  const call = async <T>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data?: T; error?: string }> => {
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(12000),
      })
      const parsed = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string }
      if (!res.ok) return { ok: false, status: res.status, error: parsed?.error ?? `HTTP ${res.status}` }
      return { ok: parsed?.ok !== false, status: res.status, data: parsed, error: parsed?.error }
    } catch (error) {
      return { ok: false, status: 0, error: (error as Error).message }
    }
  }
  return {
    users: () => call<{ users: AdminUser[] }>("GET", "/api/admin/users"),
    createUser: (label: string) => call<{ userId: string; label: string }>("POST", "/api/admin/users", { label }),
    freeze: (userId: string) => call<{ frozen: boolean; shares: number }>("POST", `/api/admin/users/${userId}/freeze`),
    unfreeze: (userId: string) => call<{ frozen: boolean; shares: number }>("POST", `/api/admin/users/${userId}/unfreeze`),
    deleteUser: (userId: string, mode: "freeze" | "delete") => call<{ mode: string; shares: number }>("DELETE", `/api/admin/users/${userId}`, { mode }),
    tokens: () => call<{ tokens: AdminToken[] }>("GET", "/api/admin/tokens"),
    mintToken: (userId: string, label?: string, limits?: Record<string, number>) => call<{ token: string; id: string }>("POST", "/api/admin/tokens", { userId, label, limits }),
    revokeToken: (tokenId: string) => call("DELETE", `/api/admin/tokens/${tokenId}`),
    codes: () => call<{ codes: AdminCode[] }>("GET", "/api/admin/codes"),
    createCode: (label: string, activations: number) => call<{ code: string; id: string; activationsLeft: number }>("POST", "/api/admin/codes", { label, activations }),
    disableCode: (codeId: string) => call("DELETE", `/api/admin/codes/${codeId}`),
    shares: () => call<{ shares: AdminShare[] }>("GET", "/api/admin/shares"),
    deleteShare: (shareId: string) => call("DELETE", `/api/share/${shareId}`),
    reassign: (shareId: string, userId: string) => call("POST", `/api/admin/shares/${shareId}/reassign`, { userId }),
    purge: () => call<{ removed: number }>("POST", "/api/admin/purge"),
    health: () => call<{ ok: boolean; service: string; policy: Record<string, unknown>; auth: { mode: string } }>("GET", "/health"),
  }
}

/** Self-service client for the /api/me surface (the entry's user osk_
 * token - NOT the root token). Answers "what are my limits, how many
 * shares do I have, when does my token expire". */
export function meClient(workerUrl: string, token: string) {
  const base = normServerUrl(workerUrl)
  const call = async <T>(method: string, path: string): Promise<{ ok: boolean; status: number; data?: T; error?: string }> => {
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(12000),
      })
      const parsed = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string }
      if (!res.ok) return { ok: false, status: res.status, error: parsed?.error ?? `HTTP ${res.status}` }
      return { ok: parsed?.ok !== false, status: res.status, data: parsed, error: parsed?.error }
    } catch (error) {
      return { ok: false, status: 0, error: (error as Error).message }
    }
  }
  return {
    me: () => call<{ userId: string; label: string; token: { id: string; label: string; limits: Record<string, number>; expiresAt: number }; settings: Record<string, unknown> }>("GET", "/api/me"),
    myShares: () => call<{ shares: Array<{ id: string; sessionID: string; createdAt: number; status: string }> }>("GET", "/api/me/shares"),
  }
}

/** Resolve the admin credential for a server: the entry's adminToken, the
 * legacy createToken (when it points at this server), or prompt. */
export function adminTokenFor(url: string, cfg: ShareConfig = currentConfig()): string {
  const base = normServerUrl(url)
  const entry = serverEntries(cfg).find((s) => s.url === base)
  return entry?.entry.adminToken ?? (cfg.workerUrl && normServerUrl(cfg.workerUrl) === base ? cfg.createToken : "") ?? ""
}

// --- the flows --------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Waits for the server plugin to publish the binding URL (poll; robust on
 * both hosts). Resolves the binding, or undefined on timeout. */
export async function waitForBinding(
  client: ClientApi | undefined,
  sid: string,
  timeoutMs = 25000,
): Promise<SessionBinding | undefined> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const binding = await readBinding(client, sid)
    if (binding?.url) return binding
    await sleep(600)
  }
  return undefined
}

export type FlowResult = { ok: boolean; message: string; url?: string; unconfigured?: boolean }

/** Consent gate: EVERY share creation asks explicitly (per owner
 * directive — no remembered consent, no silent creates). The dialog
 * carries the live context (server, TTL, gate state) so the decision is
 * informed, not ceremonial. */
export async function requestShareConsent(host: ShareHostApi, context?: { server?: string; ttlHours?: number; auth: boolean; counts?: { messages: number; toolCalls: number }; redaction?: { hits: number; samples: string[] } }): Promise<boolean> {
  const lines: string[] = ["Publish this session (and its subagent sessions) to your openshare worker?"]
  if (context) {
    const bits: string[] = []
    if (context.server) bits.push(`server: ${context.server}`)
    if (context.ttlHours !== undefined) bits.push(`TTL: ${fmtHours(context.ttlHours)}`)
    if (context.redaction && context.redaction.hits > 0) bits.push(`redaction: ${context.redaction.hits} hit(s)`)
    bits.push(`read auth: ${context.auth ? "on" : "off"}`)
    lines.push(bits.join(" - "))
  }
  lines.push("Anyone with the link can read the conversation (login-gated only when read auth is on).")
  return host.ui.showConfirm({
    title: "Share Session",
    message: lines.join("\n"),
    confirmLabel: "Share",
  })
}

/** runShareFlow with the consent gate applied: share copies the link,
 * unshared asks consent once, then creates. Every create path routes
 * through here (/share, settings, gone-again). */
export async function shareWithConsent(host: ShareHostApi, sessionID: string | undefined): Promise<FlowResult> {
  if (!sessionID) return { ok: false, message: "No active session to share." }
  const cfg = currentConfig()
  // engine-aware: plugin-options-layer config can target servers the file
  // chain cannot see (TUI blindness would push onboarding at a configured user)
  if (!isConfigured(cfg) && !engineTargetUrls().length) {
    return { ok: false, message: "No share server connected - run /openshare to connect one.", unconfigured: true }
  }
  const root = await resolveRoot(host.client, sessionID)
  const all = await readBindings(host.client, root)
  // fully opted-out (leave-as-is everywhere) is NOT live: consent again
  // instead of silently copying a snapshot link
  const live = all.find((b) => b.url && b.enabled !== false && !b.optedOut)
  if (live) {
    // already sharing: copy the link
    await host.clipboard.write(live.url)
    return { ok: true, message: `Share URL copied to clipboard: ${live.url}`, url: live.url }
  }
  const opts = all[0]?.opts
  const server = serverEntries(cfg).find((s) => s.active) ?? serverEntries(cfg)[0] ?? (engineTargetUrls()[0] ? { url: engineTargetUrls()[0] } : undefined)
  {
    const stats = sessionStatsFor(root)
    const gated = !!(opts?.authLogin ?? cfg.authLogin) && !!(opts?.authPassword ?? cfg.authPassword)
    if (
      !(await requestShareConsent(host, {
        server: server ? hostOf(server.url) : undefined,
        ttlHours: opts?.ttlHours ?? cfg.ttlHours,
        auth: gated,
        counts: { messages: stats.messages, toolCalls: stats.toolCalls },
          // redaction only runs on ungated shares (a gated share is
        // private from casual observers; the ledger reflects that)
        redaction: gated ? undefined : { hits: stats.redaction.count, samples: stats.redaction.samples.map((h) => `${h.sample} [${h.kind}]`) },
      }))
    )
      return { ok: false, message: "Share cancelled." }
  }
  return confirmShare(host, root)
}

/** Post-consent share: set the flag, wait for the URL, copy it. */
export async function confirmShare(host: ShareHostApi, rootSessionID: string): Promise<FlowResult> {
  dbgLog(`confirmShare: setShareFlag(${rootSessionID})`)
  const set = await setShareFlag(host.client, rootSessionID)
  dbgLog(`confirmShare: setShareFlag -> ${set}`)
  if (!set) return { ok: false, message: "Could not write the share flag into session metadata." }
  // fresh consent: clear any leave-as-is markers so the engine re-arms
  // (re-attaching the same pages wherever the secrets still exist)
  await patchSessionBinding(host.client, rootSessionID, (servers) => {
    for (const e of Object.values(servers)) {
      if (e && typeof e === "object") delete (e as Record<string, unknown>).optedOut
    }
  })
  const binding = await waitForBinding(host.client, rootSessionID)
  dbgLog(`confirmShare: waitForBinding -> ${binding?.url ? binding.url : "timeout"}`)
  if (!binding?.url) {
    // a failed create must NOT leave the flag armed - the engine would
    // publish LATER with no further consent (live-caught). Disarm now;
    // re-running /share re-consents.
    await clearShareFlag(host.client, rootSessionID)
    const fresh = await readBinding(host.client, rootSessionID)
    const why = fresh?.lastError ? `\nReason: ${fresh.lastError}` : ""
    return {
      ok: false,
      message: `Share did not come up (timed out waiting for the URL); the share flag was disarmed.${why}\nCheck the [openshare] stderr lines for details.`,
    }
  }
  await host.clipboard.write(binding.url)
  return { ok: true, message: `Share URL copied to clipboard: ${binding.url}`, url: binding.url }
}

export async function runUnshareFlow(host: ShareHostApi, sessionID: string | undefined): Promise<FlowResult> {
  if (!sessionID) return { ok: false, message: "No active session." }
  const root = await resolveRoot(host.client, sessionID)
  const info = await getSession(host.client, root)
  const all = bindingsOf(info)
  if (!all.length) return { ok: false, message: "This session is not shared." }
  // clear flag first (stops the forwarder), then delete every server's
  // page directly — the direct delete also covers server plugins that
  // never saw the event
  await clearShareFlag(host.client, root)
  let deleted = 0
  for (const b of all) {
    // the binding URL carries the origin the share lives on (with
    // multi-server that can differ from today's active entry)
    const bindingOrigin = b.url ? b.url.slice(0, b.url.indexOf("/s/")) : ""
    const deleteBase = bindingOrigin || b.server
    if (deleteBase && b.id && b.secret) {
      if (await workerDeleteShare(deleteBase, b.id, b.secret)) deleted++
    }
  }
  return {
    ok: true,
    message:
      deleted === all.length
        ? `Sharing stopped; ${deleted} share page${deleted === 1 ? "" : "s"} deleted.`
        : `Sharing stopped (${deleted}/${all.length} pages deleted; the rest will follow via the sweeper).`,
  }
}
