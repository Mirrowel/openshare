// Open(code)Share — the forwarding engine.
//
// Design contract (unchanged from the original single file):
//  - Dumb forwarder: it forwards events, never diffs. Delivery reliability
//    = ack + retain-until-acked disk spool (temporary buffer, replayed on
//    reconnect) + the share binding persisted INSIDE opencode (session
//    metadata) so recovery never depends on the spool.
//  - One share per MAIN session; child sessions (session info.parentID)
//    route into the parent's share. (message info.parentID is the
//    replied-to message — NOT a subagent marker.)
//  - Status = last signal: busy -> live; idle -> completed, or error if
//    any part error / retry was seen. Always resumable.
//  - Model label: config template ($Provider/$Model placeholders,
//    literals as-is, "" hides) resolved from the user message's actual
//    model; rides every user message (robust, free).
//  - Optional read auth: authLogin/authPassword are sent on create AND
//    attach (resume retroactively applies/updates credentials; empty on
//    attach REMOVES protection — an intentional owner action).
//  - Mismatch protocol: attach refused / share gone / worker rev below
//    our acked rev -> fresh create (never merge into a bad base); nacked
//    or dropped frames -> spool replay; stale extras -> left for the
//    next prompt's keyed merge to correct. All logged loudly.
//  - Undo needs nothing here: opencode publishes info.revert on the
//    session item; the viewer hides the reverted range while it is set.
//
// Share modes:
//  - "all": every session shares from its first event (the CI shape —
//    behavior identical to the original single-file plugin).
//  - "manual": sessions stay dormant until metadata.openshare.enabled is
//    set on the MAIN session (the TUI /share flow). Activation runs a
//    full backfill (session tree, messages, parts, models, diff) through
//    the same keyed queue, so a share started mid-session is complete.
//    Clearing the flag (or deleting the key) deletes the share — the
//    same path as session.deleted.
//
// Session metadata shape (metadata.openshare):
//  - all-mode binding: { id, secret, rev, url }
//  - manual-mode:      { id, secret, rev, url, enabled: true, opts? }
//    opts: { ttlDays?, authLogin?, authPassword?, modelLabel? } optional
//    per-session overrides (capture at activation; modelLabel applies
//    immediately, the rest at create/attach).
//  - The plugin strips this key from everything it syncs — the write
//    secret must never reach viewers.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { METADATA_KEY, loadConfig, resolveShareMode, spoolDirFor, URL_FILE_NONE, resolveServer, saveServerToken, type ShareConfig, type ShareMode, type ServerEntry } from "./config.js"

// --- minimal structural types (hand-written: the standalone bundle must
// not depend on the plugin SDK at runtime; shapes verified against
// opencode 1.18.x) --------------------------------------------------------

export type SessionModel = { providerID?: string; modelID?: string }
export type SessionInfo = {
  id: string
  parentID?: string
  title?: string
  time?: Record<string, unknown>
  metadata?: Record<string, unknown>
  [key: string]: unknown
}
export type MessageInfo = {
  id: string
  sessionID: string
  role?: string
  model?: SessionModel
  [key: string]: unknown
}
export type PartInfo = {
  id: string
  messageID: string
  sessionID: string
  state?: { status?: string; [key: string]: unknown }
  [key: string]: unknown
}

export type ShareEvent =
  | { type: "session.created" | "session.updated"; sessionID: string; info: SessionInfo }
  | { type: "session.status"; sessionID: string; status: { type: string } }
  | { type: "message.updated"; sessionID: string; info: MessageInfo }
  | { type: "message.part.updated"; sessionID: string; part: PartInfo }
  | { type: "session.diff"; sessionID: string; diff: unknown }
  | { type: "session.deleted"; sessionID: string }

export type SessionOpts = {
  ttlDays?: number
  authLogin?: string
  authPassword?: string
  modelLabel?: string
}

type Binding = { id: string; secret: string; rev: number; url: string }

/** One server's transport state within a session's fan-out: its share,
 * socket handshake, spooled frames and socket policy are independent of
 * every other server's. Content comes from the shared session queue. */
type RemoteState = {
  url: string
  shareId: string | null
  secret: string | null
  ackedRev: number
  ws: WebSocket | null
  wsReady: boolean
  connecting: boolean
  socketSeq: number
  initTimer: ReturnType<typeof setTimeout> | null
  initWasAttach: boolean
  backoff: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  intentionalClose: boolean
  connectQueued: boolean
  /** identity dead-end for THIS server (frozen owner, unenrollable
   * private server): stop reconnecting it; other servers unaffected. */
  authBlocked: boolean
  pending: Array<{ items: unknown[]; status: string }> // frames awaiting ack (spool)
  announced: boolean
  settleTimer: ReturnType<typeof setTimeout> | null
  idleDropTimer: ReturnType<typeof setTimeout> | null
  /** attach refused on credential grounds: do NOT auto-recreate; the TUI
   * offers copy-debug / share-new / don't-share (headless: share-new). */
  collided: string | null
}

type SessionState = {
  sid: string
  client: ClientApi | undefined
  queue: Map<string, unknown> // key -> item (not yet sent)
  timer: ReturnType<typeof setTimeout> | null
  metaTimer: ReturnType<typeof setTimeout> | null
  completedTimer: ReturnType<typeof setTimeout> | null
  lastFlushAt: number
  statusEpoch: number
  remotes: Map<string, RemoteState> // url -> transport state (fan-out)
  status: string
  badSignal: boolean
  lastSentStatus: string | null
  closed: boolean
  prefsSent: boolean
  binding: Record<string, unknown> | null // mirrors what was written into session metadata (v2 map)
  bindingQueried: boolean
  /** per-session server opt-outs (TUI "stop sharing here" / "leave as-is"):
   * the engine never (re)creates remotes for these urls on this session */
  optOuts: Set<string>
  // manual-mode bookkeeping
  opts: SessionOpts | undefined
  activated: boolean
  wroteBinding: boolean
  /** any remote completed a handshake — used to detect LATER creates
   * (fan-out adds, post-mismatch recreates) which need a history backfill */
  everConnected: boolean
}

type Message = { info?: Record<string, unknown>; parts?: Record<string, unknown>[] }

/** Server-authoritative socket policy (WS init ack + /health). */
type ServerPolicy = {
  mode: "persistent" | "turn"
  turnGraceMs: number
  idleDropMs: number
  finalizeAfterMs: number
  debounceMinMs: number
  debounceMaxMs: number
  completedDelayMaxMs: number
}

const DEFAULT_POLICY: ServerPolicy = {
  mode: "persistent",
  turnGraceMs: 120000,
  idleDropMs: 600000,
  finalizeAfterMs: 300000,
  debounceMinMs: 0,
  debounceMaxMs: Infinity,
  completedDelayMaxMs: Infinity,
}

export type ClientApi = {
  session: {
    get(input: { path: { id: string }; query?: Record<string, unknown> }): Promise<unknown>
    update(input: { path: { id: string }; body: Record<string, unknown> }): Promise<unknown>
    list?(input: { query?: Record<string, unknown> } | Record<string, unknown>): Promise<unknown>
    messages?(input: { path: { id: string }; query?: Record<string, unknown> }): Promise<unknown>
    diff?(input: { path: { id: string }; query?: Record<string, unknown> }): Promise<unknown>
    status?(input?: { query?: Record<string, unknown> }): Promise<unknown>
  }
}

export type EngineDeps = {
  client?: ClientApi
  directory?: string
  worktree?: string
  pluginDir: string
  options?: Record<string, unknown>
}

export type Engine = {
  hooks: {
    event: (evt: { event?: { type?: string; properties?: Record<string, unknown> } }) => Promise<void>
    dispose: () => Promise<void>
  }
  mode: ShareMode
  config: () => ShareConfig
}

// Stderr policy (owner directive): in manual mode (TUI present) stderr is
// for ACTUAL ERRORS only — informational lines (live:/url file:/mode
// banner, lifecycle traces) are suppressed; the TUI surfaces the URL.
// All-mode (CI/server-only) keeps its stderr contract (announce lines,
// silenceable via announceStderr). Error-class lines always reach stderr.
let stderrInfoAllowed = true

const log = (...a: unknown[]) => {
  if (!stderrInfoAllowed) return
  try {
    console.error(`[${METADATA_KEY}]`, ...a)
  } catch {}
}

/** Error-class log: reaches stderr in BOTH modes (worker down, refused
 * init, mismatch recreate, timeouts — things an owner must see even with
 * the TUI installed). */
const logError = (...a: unknown[]) => {
  try {
    console.error(`[${METADATA_KEY}]`, ...a)
  } catch {}
}

function formatLabel(template: string | undefined, model: SessionModel | undefined): string {
  if (template === "") return ""
  if (!model) return template ?? ""
  return (template ?? "")
    .replace(/\$Provider/g, model.providerID ?? "")
    .replace(/\$provider/g, model.providerID ?? "")
    .replace(/\$Model/g, model.modelID ?? "")
    .replace(/\$model/g, model.modelID ?? "")
}

type ItemEntry = { key: string; item: Record<string, unknown> }

function itemFor(type: string, data: unknown, sessionID: string): ItemEntry | undefined {
  if (type === "model") return { key: `model/${sessionID}`, item: { type, sessionID, data } }
  if (type === "prefs") return { key: "prefs", item: { type, data } }
  if (type === "session") return { key: `session/${(data as SessionInfo)?.id ?? ""}`, item: { type, data } }
  if (type === "message") return { key: `message/${(data as MessageInfo)?.id ?? ""}`, item: { type, data } }
  if (type === "part")
    return { key: `part/${(data as PartInfo)?.messageID ?? ""}/${(data as PartInfo)?.id ?? ""}`, item: { type, data } }
  if (type === "session_diff") return { key: `session_diff/${sessionID}`, item: { type, sessionID, data } }
  return undefined
}

// session items must never carry our binding (the secret would reach
// viewers) — strip our metadata key from anything we enqueue
function redact<T extends { metadata?: Record<string, unknown> }>(info: T): T {
  if (!info?.metadata || typeof info.metadata !== "object") return info
  if (!(METADATA_KEY in info.metadata)) return info
  const metadata = { ...info.metadata }
  delete metadata[METADATA_KEY]
  return { ...info, metadata }
}

function shareFlag(info: SessionInfo | undefined): { enabled: boolean; opts: SessionOpts | undefined } {
  const raw = info?.metadata?.[METADATA_KEY]
  if (!raw || typeof raw !== "object") return { enabled: false, opts: undefined }
  const record = raw as Record<string, unknown>
  if (record.enabled !== true) return { enabled: false, opts: undefined }
  const optsRaw = record.opts
  const opts: SessionOpts = {}
  if (optsRaw && typeof optsRaw === "object") {
    const o = optsRaw as Record<string, unknown>
    if (typeof o.ttlDays === "number" && o.ttlDays > 0) opts.ttlDays = o.ttlDays
    if (typeof o.authLogin === "string") opts.authLogin = o.authLogin
    if (typeof o.authPassword === "string") opts.authPassword = o.authPassword
    if (typeof o.modelLabel === "string") opts.modelLabel = o.modelLabel
  }
  return { enabled: true, opts: Object.keys(opts).length ? opts : undefined }
}

export function createEngine(deps: EngineDeps): Engine {
  let cfg = loadConfig(deps.pluginDir, deps.options)
  const mode: ShareMode = resolveShareMode(cfg, deps)
  // stderr = errors only when the TUI part exists (the TUI surfaces URLs)
  if (mode === "manual") stderrInfoAllowed = false
  if (process.env.OPENSHARE_DEBUG_FILE) {
    // diagnostic ground truth for the suites (never set in production)
    try {
      writeFileSync(
        process.env.OPENSHARE_DEBUG_FILE,
        JSON.stringify(
          {
            mode,
            directory: deps.directory,
            worktree: deps.worktree,
            pluginDir: deps.pluginDir,
            shareModeCfg: cfg.shareMode ?? null,
          },
          null,
          2,
        ),
      )
    } catch {}
  }
  const server = resolveServer(cfg)
  if (!server || !server.url) {
    log("disabled: no share server configured (workerUrl or a servers entry)")
    return {
      mode,
      config: () => cfg,
      hooks: {
        event: async () => {},
        dispose: async () => {},
      },
    }
  }
  log(`share mode: ${mode} (directory: ${deps.directory ?? "?"} worktree: ${deps.worktree ?? "?"})`)

  // ---- share servers (the fan-out set) -----------------------------------
  // Every entry flagged active:true shares new sessions; when none is
  // flagged, the first (legacy single-server semantics) does. Targets are
  // re-resolved by refreshConfig between activations, so switching the
  // active set in the TUI takes effect on the next event.
  type ServerTarget = { url: string; entry: ServerEntry }
  const resolveTargets = (): ServerTarget[] => {
    const merged: Record<string, ServerEntry> = {}
    if (cfg.workerUrl) merged[cfg.workerUrl] = { token: cfg.createToken || "", active: true }
    if (cfg.servers) for (const [u, e] of Object.entries(cfg.servers)) merged[u] = { ...merged[u], ...e }
    const urls = Object.keys(merged)
    const actives = urls.filter((u) => merged[u].active)
    const chosen = actives.length ? actives : urls.slice(0, 1)
    return chosen.map((url) => ({ url, entry: merged[url] }))
  }
  let targets = resolveTargets()

  // ---- per-server credentials (identity) ----------------------------------
  // Each server enrolls INDEPENDENTLY: a legacy root CREATE_TOKEN works
  // forever (server-side bootstrap); an osk_ user token is the normal
  // shape. With no token the plugin ENROLLS: public servers take anyone,
  // private ones need servers.{url}.code. Tokens persist to the settings
  // home so enrollment happens once per server.
  const credState = new Map<string, { credential: string; error: string; lastEnrollAt: number }>()
  const credOf = (url: string) => {
    let s = credState.get(url)
    if (!s) {
      s = { credential: "", error: "", lastEnrollAt: 0 }
      credState.set(url, s)
    }
    return s
  }
  const seedCredentials = () => {
    for (const t of targets) {
      const c = credOf(t.url)
      if (t.entry.token) {
        if (c.credential !== t.entry.token) {
          c.credential = t.entry.token
          c.error = ""
        }
      } else if (!c.credential && !c.error) {
        c.credential = "" // enrolled token may arrive via config refresh
      }
    }
  }
  seedCredentials()
  const ENROLL_RETRY_MS = 60000

  const ensureCredential = async (url: string): Promise<string> => {
    const c = credOf(url)
    const target = targets.find((t) => t.url === url)
    if (c.credential) return c.credential
    if (Date.now() - c.lastEnrollAt < ENROLL_RETRY_MS) return ""
    c.lastEnrollAt = Date.now()
    try {
      const h = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) })
      const hb = h.ok ? ((await h.json().catch(() => null)) as { auth?: { mode?: string } } | null) : null
      const authMode2 = hb?.auth?.mode
      const code = target?.entry.code ?? ""
      if (authMode2 === "public" || code) {
        const r = await fetch(`${url}/api/enroll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code }),
          signal: AbortSignal.timeout(10000),
        })
        const b = r.ok ? ((await r.json().catch(() => null)) as { ok?: boolean; token?: string; userId?: string; label?: string; error?: string } | null) : null
        if (b?.ok && typeof b.token === "string") {
          c.credential = b.token
          c.error = ""
          const savedTo = saveServerToken(url, c.credential)
          log(`enrolled at ${url} (user ${b.userId} "${b.label}")${savedTo ? " - token saved" : ""}`)
          return c.credential
        }
        c.error = `enroll refused: ${b?.error ?? `HTTP ${r.status}`}`
      } else if (authMode2 === "private") {
        c.error = "private server: add servers.{url}.code (or token) to enroll"
      } else {
        c.error = `server health unreachable (HTTP ${h.status})`
      }
    } catch (e) {
      c.error = `enrollment failed: ${(e as Error)?.message || e}`
    }
    logError(`no credential for ${url}: ${c.error}`)
    return ""
  }

  const remoteFor = (st: SessionState, url: string): RemoteState => {
    let r = st.remotes.get(url)
    if (!r) {
      r = {
        url,
        shareId: null,
        secret: null,
        ackedRev: 0,
        ws: null,
        wsReady: false,
        connecting: false,
        socketSeq: 0,
        initTimer: null,
        initWasAttach: false,
        backoff: 1000,
        reconnectTimer: null,
        intentionalClose: false,
        connectQueued: false,
        authBlocked: false,
        pending: [],
        announced: false,
        settleTimer: null,
        idleDropTimer: null,
        collided: null,
      }
      st.remotes.set(url, r)
    }
    return r
  }

  // ---- server policy (worker-owned, per server) ---------------------------
  // The worker defines the socket policy and the allowed sync-cadence
  // window; the plugin clamps its own preferences into the INTERSECTION
  // of every connected server's window (cfg is shared across remotes).
  // Received in the WS init ack (authoritative) and from /health (covers
  // the pure HTTP fallback). Defaults apply until a server answers.
  const policyMap = new Map<string, ServerPolicy>()
  const policyAsked = new Set<string>()
  const policyOf = (url: string): ServerPolicy => policyMap.get(url) ?? DEFAULT_POLICY

  const clampToPolicy = () => {
    const policies = [...policyMap.values()]
    if (!policies.length) return
    const min = Math.max(0, ...policies.map((p) => p.debounceMinMs))
    const max = Math.min(...policies.map((p) => p.debounceMaxMs))
    cfg.debounceMs = Math.min(Math.max(cfg.debounceMs, min), Math.max(min, max))
    const cd = Math.min(...policies.map((p) => p.completedDelayMaxMs))
    cfg.completedDelayMs = Math.min(Math.max(cfg.completedDelayMs, 0), cd)
  }

  const applyPolicy = (raw: unknown, url: string) => {
    if (!raw || typeof raw !== "object") return
    const p = raw as Record<string, unknown>
    const num = (v: unknown, d: number): number => {
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? n : d
    }
    const prev = policyOf(url)
    policyMap.set(url, {
      mode: p.mode === "turn" ? "turn" : "persistent",
      turnGraceMs: num(p.turnGraceMs, prev.turnGraceMs),
      idleDropMs: num(p.idleDropMs, prev.idleDropMs),
      finalizeAfterMs: num(p.finalizeAfterMs, prev.finalizeAfterMs),
      debounceMinMs: num(p.debounceMinMs, 0),
      debounceMaxMs: Math.max(num(p.debounceMaxMs, Infinity), num(p.debounceMinMs, 0)),
      completedDelayMaxMs: num(p.completedDelayMaxMs, Infinity),
    })
    clampToPolicy()
    if (debugEvents) log(`policy ${url}: ${JSON.stringify(policyOf(url))}`)
  }

  const askPolicy = (url: string) => {
    if (policyAsked.has(url)) return
    policyAsked.add(url)
    void fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (b && typeof b === "object" && (b as { policy?: unknown }).policy) {
          applyPolicy((b as { policy: unknown }).policy, url)
        }
      })
      .catch(() => {
        // unreachable worker: defaults stay; the init ack will correct us
        policyAsked.delete(url)
      })
  }
  const wsUrl = (url: string) => url.replace(/^http/, "ws")

  // ---- spool root ---------------------------------------------------------
  let spoolRoot = spoolDirFor(cfg)
  try {
    mkdirSync(spoolRoot, { recursive: true })
  } catch {}

  // ---- per-main-session state -------------------------------------------
  const sessions = new Map<string, SessionState>() // mainSid -> st
  const childToParent = new Map<string, string>() // childSid -> mainSid
  // all-mode opt-in ledger: sessions that predate plugin start and are
  // neither flagged nor already bound stay unshared (log once each)
  const bootTime = Date.now()
  const preExistingRetired = new Set<string>()
  const verifying = new Set<string>()
  let chain: Promise<unknown> = Promise.resolve()
  let lastUrlFile: string | null = null
  let urlFileAnnounced = false

  const newSt = (sid: string): SessionState => ({
    sid,
    client: deps.client,
    queue: new Map(),
    timer: null,
    metaTimer: null,
    completedTimer: null,
    lastFlushAt: 0,
    statusEpoch: 0,
    remotes: new Map(),
    status: "live",
    badSignal: false,
    lastSentStatus: null,
    closed: false,
    prefsSent: false,
    binding: null,
    bindingQueried: false,
    optOuts: new Set(),
    opts: undefined,
    activated: false,
    wroteBinding: false,
    everConnected: false,
  })

  const refreshConfig = () => {
    // settings may change between activations (the TUI writes the config
    // file); each activation re-reads. env always wins, so CI is stable.
    const next = loadConfig(deps.pluginDir, deps.options)
    const resolved = resolveServer(next)
    if (resolved?.url) {
      cfg = next
      spoolRoot = spoolDirFor(cfg)
      const before = new Set(targets.map((t) => t.url))
      targets = resolveTargets()
      seedCredentials()
      clampToPolicy()
      if (debugEvents) {
        const after = targets.map((t) => t.url)
        const added = after.filter((u) => !before.has(u))
        if (added.length) log(`fan-out set grew: ${added.join(", ")}`)
      }
    }
  }

  /** Activate a main session: create state, connect, backfill when gated
   * (manual mode always; all-mode flag activations need the history too —
   * an opted-in old session deserves a complete page, not just the events
   * after the flag). */
  const activate = (sid: string, opts: SessionOpts | undefined, info: SessionInfo | undefined, opts2?: { gated?: boolean }) => {
    refreshConfig()
    let st = sessions.get(sid)
    if (!st) {
      st = newSt(sid)
      sessions.set(sid, st)
    } else if (st.activated) {
      if (opts) st.opts = opts
      return st
    }
    st.activated = true
    st.opts = opts
    const gated = mode === "manual" || opts2?.gated === true
    if (gated) {
      // seed the share status from the session's CURRENT state before
      // anything flushes: activating an idle session must not ship a
      // phantom "live" badge. backfill follows, then the connection —
      // through the same single-flight queue as everyone else.
      chain = chain
        .then(() => seedManualStatus(st))
        .then(() => backfill(st, info))
        .then(() => queueConnectAll(st))
        .catch((e) => logError("activation error", (e as Error)?.message || e))
    } else {
      queueConnectAll(st)
    }
    return st
  }

  const seedManualStatus = async (st: SessionState) => {
    if (!st.client || typeof st.client.session.status !== "function") return
    try {
      const map = unwrap(
        await st.client.session.status({
          ...(deps.directory ? { query: { directory: deps.directory } } : {}),
        }),
      )
      const type = map && typeof map === "object" ? (map as Record<string, { type?: string }>)[st.sid]?.type : undefined
      if (type === "busy" || type === "retry") {
        st.status = "live"
        if (type === "retry") st.badSignal = true
      } else {
        // idle (or absent from the map = not running): completed unless
        // the backfilled history shows errors (resolved after backfill)
        st.status = "completed"
      }
    } catch {
      // status unknown: keep "live" (a prompt may be running)
    }
  }

  /** Existing state for an event sid, or null (manual mode never creates
   * state on sight — activation is flag-driven). */
  const stFor = (sid: string): SessionState | null => {
    const main = childToParent.get(sid) ?? sid
    return sessions.get(main) ?? null
  }

  // ---- durable binding: session metadata (inside opencode's db) ---------
  // NOTE: the plugin SDK client can hit a foreign server when something
  // else listens on Server.url's port — error envelopes don't throw, so
  // every call is checked and degradation (spool covers reconnects) is
  // logged loudly instead of failing silently.
  const unwrap = (res: unknown): any => {
    if (res && typeof res === "object" && "error" in res && (res as { error?: unknown }).error) {
      throw new Error(`client error: ${JSON.stringify((res as { error: unknown }).error).slice(0, 120)}`)
    }
    return (res as { data?: unknown })?.data ?? res
  }

  async function sessionInfo(client: ClientApi | undefined, sid: string): Promise<SessionInfo | undefined> {
    if (!client) return undefined
    try {
      const info = unwrap(
        await client.session.get({
          path: { id: sid },
          ...(deps.directory ? { query: { directory: deps.directory } } : {}),
        }),
      )
      return info as SessionInfo
    } catch {
      return undefined
    }
  }

  async function writeMetadata(st: SessionState, value: Record<string, unknown> | null) {
    if (!st.client) return
    try {
      const info = unwrap(
        await st.client.session.get({
          path: { id: st.sid },
          ...(deps.directory ? { query: { directory: deps.directory } } : {}),
        }),
      )
      const metadata = { ...(info?.metadata ?? {}) }
      if (value === null) delete metadata[METADATA_KEY]
      else metadata[METADATA_KEY] = value
      unwrap(
        await st.client.session.update({
          path: { id: st.sid },
          body: { metadata },
          ...(deps.directory ? { query: { directory: deps.directory } } : {}),
        }),
      )
    } catch (e) {
      log("metadata write failed (spool still covers reconnects):", (e as Error)?.message || e)
    }
  }

  /** Parse the metadata binding: v2 map ({v:2, servers:{url:{id,secret,
   * rev,url,enabled?}}}) or legacy flat ({id,secret,rev,url}) which maps
   * onto the first target. Returns per-server live entries. */
  const parseBinding = (record: Record<string, unknown>): Map<string, { id: string; secret: string; rev: number; optedOut?: boolean }> => {
    const out = new Map<string, { id: string; secret: string; rev: number; optedOut?: boolean }>()
    if (record.servers && typeof record.servers === "object") {
      for (const [url, raw] of Object.entries(record.servers as Record<string, unknown>)) {
        if (!raw || typeof raw !== "object") continue
        const e = raw as Record<string, unknown>
        if (typeof e.id === "string" && typeof e.secret === "string" && e.id && e.secret) {
          out.set(url, { id: e.id, secret: e.secret, rev: typeof e.rev === "number" ? e.rev : 0 })
        } else if (e.optedOut === true) {
          out.set(url, { id: "", secret: "", rev: 0, optedOut: true })
        }
      }
      return out
    }
    if (typeof record.id === "string" && typeof record.secret === "string" && record.id) {
      const url = targets[0]?.url ?? ""
      if (url) out.set(url, { id: record.id, secret: record.secret, rev: typeof record.rev === "number" ? record.rev : 0 })
    }
    return out
  }

  async function readBinding(st: SessionState) {
    if (!st.client || st.bindingQueried) return
    st.bindingQueried = true
    try {
      const info = await sessionInfo(st.client, st.sid)
      const b = info?.metadata?.[METADATA_KEY]
      if (b && typeof b === "object") {
        const record = b as Record<string, unknown>
        if (mode === "manual" && record.enabled !== true) {
          // flagless binding (unshared, or legacy): stay dormant
          return
        }
        const found = parseBinding(record)
        if (found.size) {
          for (const [url, e] of found) {
            if (e.optedOut) continue
            const r = remoteFor(st, url)
            if (!r.shareId) {
              r.shareId = e.id
              r.secret = e.secret
              r.ackedRev = e.rev
            }
          }
          if (mode === "manual") st.opts = shareFlag(info).opts ?? st.opts
          log(`binding recovered from session metadata: ${[...found.keys()].join(", ")}`)
        }
      }
    } catch (e) {
      log("metadata read failed (degrading to spool):", (e as Error)?.message || e)
    }
  }

  async function writeBinding(st: SessionState) {
    if (!st.client) return
    const servers: Record<string, unknown> = {}
    let any = false
    for (const [url, r] of st.remotes) {
      if (!r.shareId || !r.secret) continue
      any = true
      const entry: Record<string, unknown> = { id: r.shareId, secret: r.secret, rev: r.ackedRev, url: `${url}/s/${r.shareId}` }
      if (r.collided) entry.collided = r.collided
      servers[url] = entry
    }
    if (!any) return
    // preserve per-session opt-outs in the written map — a retired remote
    // is absent from `servers`, and dropping the marker would let the next
    // refreshOptOuts resurrect (and re-create) the opted-out server
    for (const url of st.optOuts) if (!servers[url]) servers[url] = { optedOut: true }
    // A binding in session metadata means opted-in — enabled: true in BOTH
    // modes (live-caught: all-mode bindings without `enabled` made the TUI
    // gate fall through to the consent dialog on an already-shared session;
    // live is now uniformly "url && enabled !== false").
    const value: Record<string, unknown> = { v: 2, servers, enabled: true }
    if (mode === "manual" && st.opts) value.opts = st.opts
    st.binding = value
    st.wroteBinding = true
    await writeMetadata(st, value)
  }

  const scheduleBindingWrite = (st: SessionState) => {
    if (st.metaTimer) return
    st.metaTimer = setTimeout(() => {
      st.metaTimer = null
      chain = chain.then(() => writeBinding(st)).catch(() => {})
    }, 30000)
  }

  // ---- spool (temporary buffer for unacked frames) ----------------------
  // One spool per session per server: `<sid>.<h8(url)>.meta/queue`. The
  // legacy suffix-less files (single-server era) migrate onto the first
  // target at load.
  const h8 = (url: string): string => {
    let h = 5381
    for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) >>> 0
    return h.toString(16).padStart(8, "0")
  }
  const metaPath = (st: SessionState, url: string) => join(spoolRoot, `${st.sid}.${h8(url)}.meta.json`)
  const queuePath = (st: SessionState, url: string) => join(spoolRoot, `${st.sid}.${h8(url)}.queue.jsonl`)
  const legacyMetaPath = (st: SessionState) => join(spoolRoot, `${st.sid}.meta.json`)
  const legacyQueuePath = (st: SessionState) => join(spoolRoot, `${st.sid}.queue.jsonl`)

  const spoolSave = (st: SessionState, r: RemoteState) => {
    try {
      writeFileSync(metaPath(st, r.url), JSON.stringify({ shareId: r.shareId, secret: r.secret, ackedRev: r.ackedRev, sid: st.sid, url: r.url }))
      writeFileSync(queuePath(st, r.url), r.pending.map((f) => JSON.stringify(f)).join("\n") + (r.pending.length ? "\n" : ""))
    } catch (e) {
      logError("spool save failed", (e as Error)?.message || e)
    }
  }
  const spoolLoad = (st: SessionState, r: RemoteState) => {
    try {
      const meta = JSON.parse(readFileSync(metaPath(st, r.url), "utf8"))
      // metadata binding (db) is authoritative when both exist and disagree
      if (!r.shareId && meta.shareId) {
        r.shareId = meta.shareId
        r.secret = meta.secret
        r.ackedRev = meta.ackedRev ?? 0
      }
      if (existsSync(queuePath(st, r.url))) {
        r.pending = readFileSync(queuePath(st, r.url), "utf8")
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l))
      }
    } catch {
      r.pending = []
    }
    // single-server-era spool (no url suffix): belongs to the first target
    if (!r.shareId && targets[0]?.url === r.url) {
      try {
        const meta = JSON.parse(readFileSync(legacyMetaPath(st), "utf8"))
        if (meta.shareId && !r.shareId) {
          r.shareId = meta.shareId
          r.secret = meta.secret
          r.ackedRev = meta.ackedRev ?? 0
          if (existsSync(legacyQueuePath(st))) {
            r.pending = readFileSync(legacyQueuePath(st), "utf8")
              .split("\n")
              .filter((l) => l.trim())
              .map((l) => JSON.parse(l))
          }
          log(`migrated legacy spool for ${st.sid.slice(0, 18)} onto ${r.url}`)
        }
      } catch {}
    }
  }
  const spoolClear = (st: SessionState, r: RemoteState) => {
    try {
      rmSync(metaPath(st, r.url), { force: true })
      rmSync(queuePath(st, r.url), { force: true })
    } catch {}
  }

  // ---- websocket transport (per remote) ----------------------------------
  const wsSend = (r: RemoteState, obj: unknown) => {
    if (debugEvents) log(`ws ${r.url.slice(0, 24)} #${r.socketSeq} send ${(obj as { op?: string })?.op} (ready=${r.wsReady})`)
    try {
      r.ws?.send(JSON.stringify(obj))
    } catch {
      return false
    }
    return true
  }

  /** Sync frames are chunked (~1MB WS cap on CF; a 5000-message backfill
   * must ride several frames — worker apply is keyed-idempotent, chunks
   * just bump rev). Status rides each chunk; last write wins. */
  const SYNC_CHUNK = 200
  const sendSync = (r: RemoteState, f: { items: unknown[]; status: string }) => {
    if (!f.items.length) return wsSend(r, { op: "sync", items: [], status: f.status })
    for (let i = 0; i < f.items.length; i += SYNC_CHUNK) {
      wsSend(r, { op: "sync", items: f.items.slice(i, i + SYNC_CHUNK), status: f.status })
    }
    return true
  }

  const announceUrl = (st: SessionState, r: RemoteState) => {
    if (r.announced) return
    r.announced = true
    const url = `${r.url}/s/${r.shareId}`
    if (cfg.announceStderr) log(`live: ${url}`)
    if (mode === "all" && cfg.urlFile !== URL_FILE_NONE) {
      // default: the file lives where the session lives (its directory,
      // falling back to the process cwd) — never a fixed global path.
      // Explicit urlFile config/env wins ("none" disables the file).
      // Append: CI reads the file after each run; keeping every share
      // URL lets one file serve a whole workflow (the legacy original
      // overwrote with the latest only).
      const file = cfg.urlFile || join(deps.directory ?? process.cwd(), "openshare.urls.txt")
      try {
        appendFileSync(file, url + "\n")
        if (cfg.announceStderr && (file !== lastUrlFile || !urlFileAnnounced)) {
          urlFileAnnounced = true
          lastUrlFile = file
          log(`url file: ${file}`)
        }
      } catch {}
    }
  }

  const authFrame = (st: SessionState) => {
    // always send both (empty strings included): attach with empty values
    // REMOVES protection — an intentional owner action. Session opts
    // override the global config when set.
    const login = st.opts?.authLogin ?? cfg.authLogin ?? ""
    const password = st.opts?.authPassword ?? cfg.authPassword ?? ""
    return { authLogin: login, authPassword: password }
  }

  const ttlFor = (st: SessionState) => st.opts?.ttlDays ?? cfg.ttlDays

  /** Best-effort cleanup of a share we are about to abandon (refused
   * attach, mismatch recreate). Prevents husk litter; failures are fine —
   * the TTL sweeper collects strays eventually. */
  const deleteAbandoned = (r: RemoteState) => {
    const id = r.shareId
    const secret = r.secret
    if (!id || !secret) return
    void fetch(`${r.url}/api/share/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => {})
  }

  /** Single-flight connect queuing: multiple paths (activation, event
   * reconnect, backfill chain) may want a socket before any connect has
   * STARTED — the connecting flag alone guards execution, not the queue,
   * and double connects used to create duplicate shares + init storms
   * (live-caught in the S11 repro: ws#1 create AND ws#2 create). */
  const queueConnect = (st: SessionState, r: RemoteState) => {
    if (st.closed || r.connectQueued || r.connecting || r.authBlocked || r.collided) return
    r.connectQueued = true
    chain = chain
      .then(() => {
        r.connectQueued = false
        return connect(st, r)
      })
      .catch((e) => logError("connect error", (e as Error)?.message || e))
  }

  /** Connect every target (activation, resume) — remotes materialize from
   * targets ∪ binding (a share bound on a no-longer-active server keeps
   * receiving updates until explicitly unshared there). Opted-out servers
   * (this session) are skipped entirely. */
  const queueConnectAll = (st: SessionState) => {
    if (st.closed) return
    for (const t of targets) {
      if (st.optOuts.has(t.url)) continue
      queueConnect(st, remoteFor(st, t.url))
    }
    for (const r of st.remotes.values()) {
      if (st.optOuts.has(r.url)) continue
      queueConnect(st, r)
    }
  }

  /** Re-read the session's binding map for per-server opt-outs (written by
   * the TUI: "stop sharing here" deletes the share then opts out; "leave
   * as-is" just opts out). Live remotes for newly opted-out servers are
   * retired — the share keeps living server-side until its TTL.
   * Also resolves collisions the TUI answered: entry removed → re-arm the
   * remote (fresh create + backfill) unless opted out. */
  const refreshOptOuts = async (st: SessionState) => {
    if (!st.client) return
    try {
      const info = await sessionInfo(st.client, st.sid)
      const raw = info?.metadata?.[METADATA_KEY]
      if (!raw || typeof raw !== "object") return
      const servers = (raw as Record<string, unknown>).servers
      if (!servers || typeof servers !== "object") return
      const entryUrls = new Set<string>()
      for (const [url, e] of Object.entries(servers as Record<string, unknown>)) {
        entryUrls.add(url)
        const out = !!(e && typeof e === "object" && (e as Record<string, unknown>).optedOut === true)
        if (out) st.optOuts.add(url)
        else st.optOuts.delete(url)
      }
      // retire remotes that just got opted out (socket closed; spool
      // dropped — the share is out of our hands by the TUI's choice)
      for (const url of [...st.optOuts]) {
        const r = st.remotes.get(url)
        if (!r) continue
        if (debugEvents) log(`remote ${url.slice(0, 24)} opted out for ${st.sid.slice(0, 18)} - retiring`)
        r.intentionalClose = true
        try {
          r.ws?.close(1000, "opted out")
        } catch {}
        spoolClear(st, r)
        st.remotes.delete(url)
      }
      // collisions resolved by the TUI: the binding entry for the server
      // was removed — re-arm unless the same patch also opted out
      for (const r of [...st.remotes.values()]) {
        if (!r.collided || st.optOuts.has(r.url)) continue
        if (entryUrls.has(r.url)) continue
        if (debugEvents) log(`collision on ${r.url.slice(0, 24)} resolved - re-arming`)
        r.collided = null
        r.shareId = null
        r.secret = null
        r.ackedRev = 0
        r.pending = []
        r.announced = false
        queueConnect(st, r)
      }
    } catch {}
  }

  const connect = async (st: SessionState, r: RemoteState) => {
    if (st.closed || r.connecting || r.authBlocked || r.collided) return
    // "connecting" spans the WHOLE handshake: socket open + init ack. It
    // is only cleared on init-ok, socket death or the init timeout — an
    // event arriving mid-handshake must NEVER spawn a second socket (the
    // old connect() returned after merely SENDING init; a second socket
    // raced it, and the loser's late init-ok poisoned the winner's state
    // — live-caught: duplicate shares, mismatch storms, empty pages).
    r.connecting = true
    r.socketSeq += 1
    const seq = r.socketSeq
    // supersede any previous socket: its frames are dead to us now
    if (r.ws) {
      const old = r.ws
      try {
        old.close(4000, "superseded")
      } catch {}
    }
    try {
      await readBinding(st)
      spoolLoad(st, r)
      askPolicy(r.url)
      // was this socket's init an ATTACH (resume) or a CREATE? A create
      // ack legitimately starts at rev 0 — the mismatch guard is for
      // attaches only (live-caught: create-ack rev 0 tripped it and
      // spawned a fresh husk share with the content dropped).
      r.initWasAttach = !!(r.shareId && r.secret)
      if (debugEvents) log(`ws ${r.url.slice(0, 24)} #${seq} opening (${r.initWasAttach ? `attach ${r.shareId}` : "create"})`)
      // creates need a credential (enrolls on demand — first contact with
      // a server); attaches ride the share secret alone when tokenless
      const cred = credOf(r.url)
      const token = r.initWasAttach ? cred.credential : cred.credential || (await ensureCredential(r.url))
      if (!r.initWasAttach && !token && cred.error) {
        // the server is reachable but enrollment is impossible (private,
        // no valid code / enroll refused). A tokenless create would just
        // be refused in a loop — block this remote, surface once.
        r.authBlocked = true
        r.connecting = false
        r.ws = null
        logError(`sharing to ${r.url} disabled (no credential): ${cred.error}`)
        return
      }
      const ws = new WebSocket(`${wsUrl(r.url)}/api/ws?token=${encodeURIComponent(token ?? "")}`)
      r.ws = ws
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("ws open timeout")), 15000)
        ws.addEventListener("open", () => {
          clearTimeout(t)
          resolve(undefined)
        }, { once: true })
        ws.addEventListener("error", () => {
          clearTimeout(t)
          reject(new Error("ws open error"))
        }, { once: true })
      })
      ws.addEventListener("message", (ev) => {
        // stale sockets never touch live state (defense in depth: even a
        // superseded socket that still delivers frames is dropped here)
        if (seq !== r.socketSeq) return
        let frame
        try {
          frame = JSON.parse((ev as MessageEvent).data as string)
        } catch {
          return
        }
        handleFrame(st, r, frame).catch((e) => logError("frame error", (e as Error)?.message || e))
      })
      ws.addEventListener("close", () => {
        if (seq !== r.socketSeq) return
        r.wsReady = false
        r.connecting = false
        // a deliberate turn-mode drop must not trigger the reconnect
        // backoff loop — the next event reconnects on demand
        if (r.intentionalClose) {
          r.intentionalClose = false
          return
        }
        if (!st.closed) scheduleReconnect(st, r)
      })

      if (r.initWasAttach) {
        wsSend(r, { op: "init", attach: { id: r.shareId, secret: r.secret, ...authFrame(st) } })
      } else {
        wsSend(r, { op: "init", create: { sessionID: st.sid, ttlDays: ttlFor(st), ...authFrame(st) } })
      }

      // handshake deadline: init sent but no ack (silent worker death)
      // — close, let the close listener reconnect us
      r.initTimer = setTimeout(() => {
        if (seq !== r.socketSeq) return
        logError(`ws ${r.url.slice(0, 24)} #${seq} init ack timeout`)
        r.connecting = false
        try {
          ws.close(4000, "init timeout")
        } catch {}
        if (!st.closed) scheduleReconnect(st, r)
      }, 20000)
    } catch (e) {
      r.connecting = false
      logError("socket failed:", (e as Error)?.message || e, "- falling back to HTTP, will retry")
      r.wsReady = false
      void flushViaHttp(st, r).catch(() => {})
      scheduleReconnect(st, r)
      return
    }
  }

  const scheduleReconnect = (st: SessionState, r: RemoteState) => {
    if (st.closed || r.reconnectTimer) return
    const wait = r.backoff
    r.backoff = Math.min(r.backoff * 2, 60000)
    r.reconnectTimer = setTimeout(() => {
      r.reconnectTimer = null
      queueConnect(st, r)
    }, wait)
  }

  // ---- turn-scoped socket lifecycle (server policy "turn") ---------------
  const dropSocket = (st: SessionState, r: RemoteState, why: string) => {
    if (debugEvents) log(`turn: drop socket (${why}) ${r.url.slice(0, 24)} sid=${st.sid.slice(0, 18)}`)
    r.wsReady = false
    r.intentionalClose = true
    try {
      r.ws?.close(1000, why)
    } catch {}
    r.ws = null
  }

  const cancelSettleDrop = (r: RemoteState) => {
    if (r.settleTimer) {
      clearTimeout(r.settleTimer)
      r.settleTimer = null
    }
  }

  const armSettleDrop = (st: SessionState) => {
    for (const r of st.remotes.values()) {
      const p = policyOf(r.url)
      if (p.mode !== "turn" || p.turnGraceMs <= 0) continue
      cancelSettleDrop(r)
      r.settleTimer = setTimeout(() => {
        r.settleTimer = null
        if (st.closed || !r.ws) return
        dropSocket(st, r, "turn end")
      }, p.turnGraceMs)
    }
  }

  const armIdleDrop = (st: SessionState) => {
    for (const r of st.remotes.values()) {
      const p = policyOf(r.url)
      if (p.mode !== "turn" || p.idleDropMs <= 0) continue
      if (r.idleDropTimer) clearTimeout(r.idleDropTimer)
      r.idleDropTimer = setTimeout(() => {
        r.idleDropTimer = null
        if (st.closed || !r.ws) return
        // no signal for idleDropMs (incl. hosts that never emit idle):
        // drop; the next event reconnects and the spool replays the gap
        dropSocket(st, r, "idle timeout")
      }, p.idleDropMs)
    }
  }

  /** Any activity: the turn is alive — cancel the settle drop, reset the
   * no-signal fallback timer (per server). */
  const touch = (st: SessionState) => {
    for (const r of st.remotes.values()) cancelSettleDrop(r)
    armIdleDrop(st)
  }

  /** An event arrived with no live socket (post-drop or post-fallback):
   * reconnect now — the queue rides the normal flush path afterwards.
   * Target-set refresh is throttled (config files on disk per event would
   * be heavy); 5s catches TUI server switches quickly enough. */
  let lastTargetsCheck = 0
  const ensureConnected = (st: SessionState) => {
    if (st.closed) return
    if (Date.now() - lastTargetsCheck > 5000) {
      lastTargetsCheck = Date.now()
      refreshConfig()
    }
    for (const t of targets) {
      if (st.optOuts.has(t.url)) continue
      const r = remoteFor(st, t.url)
      if (r.connecting || r.reconnectTimer || r.wsReady || r.authBlocked || r.collided) continue
      queueConnect(st, r)
    }
    for (const r of st.remotes.values()) {
      if (st.optOuts.has(r.url)) continue
      if (r.connecting || r.reconnectTimer || r.wsReady || r.authBlocked || r.collided) continue
      queueConnect(st, r)
    }
  }

  const handleFrame = async (st: SessionState, r: RemoteState, frame: Record<string, unknown>) => {
    if (frame.op === "init") {
      if (!frame.ok) {
        const err = String(frame.error ?? "")
        if (/frozen/i.test(err)) {
          // owner frozen: every control path is severed server-side.
          // Re-enrolling would orphan the shares — surface and stop.
          r.authBlocked = true
          logError(`${r.url}: share frozen by the hoster (owner frozen) - edits refused; contact the server admin`)
          try {
            r.ws?.close(4000, "frozen")
          } catch {}
          return
        }
        if (/forbidden|bad secret/i.test(err) && r.initWasAttach && r.secret) {
          // COLLISION: the binding's secret no longer opens this share and
          // the socket token doesn't own it either (share recreated by a
          // later run? host-side restore?). Auto-recreating could dupe a
          // share someone else now owns — stop, mark, let the TUI offer
          // copy-debug / share-on-new / don't-share (headless: share-new).
          r.collided = err
          r.connecting = false
          logError(`${r.url}: attach refused (${err}) - credential collision on share ${r.shareId}; not auto-recreating`)
          try {
            r.ws?.close(4000, "collision")
          } catch {}
          // persist the collision into the binding so the TUI can offer
          // the choice; writeBinding marks collided remotes
          st.wroteBinding = false
          chain = chain.then(() => writeBinding(st)).catch(() => {})
          // headless (all-mode): resolve as "share on a new share"
          if (mode === "all") resolveCollision(st, r)
          return
        }
        if (/token|credential/i.test(err) && !r.initWasAttach) {
          // our token was rejected (revoked/expired): drop it, re-enroll
          // (60s-gated; public server or a fresh code), reconnect. A
          // legacy root token never lands here.
          const cred = credOf(r.url)
          if (cred.credential) {
            cred.credential = ""
            logError(`${r.url}: server rejected our token - re-enrolling`)
          }
          try {
            r.ws?.close(4000, "auth")
          } catch {}
          r.connecting = false
          if (!st.closed) queueConnect(st, r)
          return
        }
        // share swept / removed / revoked: start fresh, never merge into a
        // bad base (mismatch protocol). Content REPLAYS to the new share —
        // pending is never dropped on a reset (live-caught: the recreate
        // husk had the title but zero messages).
        logError(`${r.url}: init refused:`, frame.error, "- creating fresh share")
        deleteAbandoned(r)
        r.shareId = null
        r.secret = null
        r.ackedRev = 0
        wsSend(r, { op: "init", create: { sessionID: st.sid, ttlDays: ttlFor(st), ...authFrame(st) } })
        return
      }
      if (r.initWasAttach && typeof frame.rev === "number" && frame.rev < r.ackedRev) {
        // worker lost data behind our back (ATTACH only — a create ack
        // legitimately starts at rev 0; the old guard misread that as
        // data loss and spawned a fresh husk, live-caught)
        logError(`${r.url}: mismatch: worker rev ${frame.rev} < acked ${r.ackedRev} - recreating`)
        deleteAbandoned(r)
        r.shareId = null
        r.secret = null
        r.ackedRev = 0
        wsSend(r, { op: "init", create: { sessionID: st.sid, ttlDays: ttlFor(st), ...authFrame(st) } })
        return
      }
      const wasFanoutCreate = !r.initWasAttach && st.everConnected
      const shareChanged = !!frame.id && frame.id !== r.shareId
      if (shareChanged) r.announced = false
      r.shareId = (frame.id as string) ?? r.shareId
      r.secret = (frame.secret as string) ?? r.secret
      r.ackedRev = (frame.rev as number) ?? 0
      r.wsReady = true
      r.connecting = false
      r.initWasAttach = false
      r.collided = null
      if (r.initTimer) {
        clearTimeout(r.initTimer)
        r.initTimer = null
      }
      r.backoff = 1000
      st.everConnected = true
      if (frame.policy) applyPolicy(frame.policy, r.url)
      r.intentionalClose = false
      touch(st)
      announceUrl(st, r)
      // first binding write is immediate (the TUI waits on the URL in
      // session metadata); ack-driven rev updates stay debounced
      if (!st.wroteBinding) {
        chain = chain.then(() => writeBinding(st)).catch(() => {})
      } else {
        scheduleBindingWrite(st)
      }
      spoolSave(st, r)
      if (r.pending.length) {
        for (const f of r.pending) sendSync(r, f)
      } else if (st.queue.size) {
        flush(st)
      }
      if (wasFanoutCreate) {
        // a server joined an ALREADY-live session (fan-out add, or a
        // post-mismatch recreate): its fresh share needs the full history —
        // backfill is keyed-idempotent, other servers just re-upsert
        chain = chain.then(() => backfill(st)).catch((e) => logError("fan-out backfill error", (e as Error)?.message || e))
      }
      return
    }
    if (frame.op === "ack") {
      r.ackedRev = (frame.rev as number) ?? r.ackedRev
      r.pending = []
      spoolSave(st, r)
      scheduleBindingWrite(st)
      return
    }
    if (frame.op === "nack" || frame.op === "error") {
      logError(`${r.url}: worker refused frame:`, JSON.stringify(frame).slice(0, 200))
      // the control socket lost its attach state (worker-side eviction of
      // the control DO): force a reconnect — init attach replays pending
      if (frame.op === "error" && r.wsReady && !st.closed) {
        r.wsReady = false
        try {
          r.ws?.close()
        } catch {}
        scheduleReconnect(st, r)
      }
    }
  }

  /** Collision resolution "share on a new share": forget the dead binding
   * entry for this server (debug info logged first), delete the husk if
   * we still can, and reconnect — the create path makes a fresh share and
   * the fan-out backfill fills it. */
  const resolveCollision = (st: SessionState, r: RemoteState) => {
    logError(`collision debug: server=${r.url} share=${r.shareId} rev=${r.ackedRev} sid=${st.sid}`)
    deleteAbandoned(r)
    r.collided = null
    r.shareId = null
    r.secret = null
    r.ackedRev = 0
    r.pending = []
    r.announced = false
    queueConnect(st, r)
  }

  // ---- flush -------------------------------------------------------------
  const frameFrom = (st: SessionState) => {
    const items = Array.from(st.queue.values())
    st.queue.clear()
    const statusChanged = st.status !== st.lastSentStatus
    if (!items.length && !statusChanged) {
      if (debugEvents) log(`flush skip (no items, status ${st.status}==${st.lastSentStatus})`)
      return null
    }
    st.lastSentStatus = st.status
    if (debugEvents) log(`frame: ${items.length} items, status ${st.status}`)
    return { items, status: st.status }
  }

  // returns a promise when the frame goes out via HTTP (the dispose path
  // awaits it - an unawaited fetch dies with the exiting process and the
  // final status never lands, live-caught as shares stuck on "live")
  const flush = (st: SessionState): Promise<unknown> | undefined => {
    if (st.closed) return
    const f = frameFrom(st)
    if (!f) return
    // fan out to every remote; each carries its own pending copy and acks
    // independently. Remotes mid-handshake or auth-blocked just buffer.
    let httpWork: Promise<unknown> | undefined
    for (const r of st.remotes.values()) {
      // never send syncs before the init ack: the worker's per-socket
      // ControlDO has no attach until OUR init completes, and a racing
      // sync dies as "unknown op" (live-caught: post-drop reconnects
      // lost whole turns). The init-ok handler flushes pending itself.
      r.pending.push(f)
      spoolSave(st, r)
      if (r.ws && !r.wsReady) continue
      if (r.wsReady) {
        sendSync(r, f)
        continue
      }
      const viaHttp = flushViaHttp(st, r)
      if (viaHttp) httpWork = (httpWork ?? Promise.resolve()).then(() => viaHttp)
    }
    if (st.remotes.size) st.lastFlushAt = Date.now()
    return httpWork
  }

  const flushViaHttp = async (st: SessionState, r: RemoteState) => {
    if (!r.shareId || !r.pending.length) return
    // ALL pending frames, merged (keyed upserts — later wins). Sending
    // only the last frame dropped every earlier batch's items whenever
    // the HTTP fallback carried more than one (live-caught class:
    // content loss on reconnect paths).
    const items: unknown[] = []
    let status: string | undefined
    for (const f of r.pending) {
      for (const it of f.items as unknown[]) items.push(it)
      if (f.status) status = f.status
    }
    const cred = credOf(r.url)
    const res = await fetch(`${r.url}/api/share/${r.shareId}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cred.credential ? { authorization: `Bearer ${cred.credential}` } : {}) },
      body: JSON.stringify({ secret: r.secret ?? "", data: items, status }),
      signal: AbortSignal.timeout(15000),
    }).catch(() => null)
    if (res && res.ok) {
      const body = (await res.json().catch(() => ({}))) as { rev?: number }
      r.ackedRev = body.rev ?? r.ackedRev
      r.pending = []
      spoolSave(st, r)
    }
  }

  const scheduleFlush = (st: SessionState) => {
    if (st.timer) return
    // sync interval is a rate limit anchored at the PREVIOUS flush: an
    // event arriving after the interval already elapsed flushes
    // immediately; one arriving right after a flush waits the remainder.
    // The very first batch flushes as soon as it exists (a viewer that
    // just opened the link sees the opening prompt fast).
    const elapsed = Date.now() - st.lastFlushAt
    const wait = Math.max(0, cfg.debounceMs - elapsed)
    st.timer = setTimeout(() => {
      st.timer = null
      if (debugEvents) log(`flush timer fired sid=${st.sid.slice(0, 18)} queue=${st.queue.size} remotes=${st.remotes.size}`)
      chain = chain.then(() => flush(st)).catch((e) => logError("flush error", (e as Error)?.message || e))
    }, wait)
  }

  const enqueue = (st: SessionState, entry: ItemEntry | undefined) => {
    if (!st || !entry) return
    st.queue.set(entry.key, entry.item)
    if (debugEvents) log(`enqueue sid=${st.sid.slice(0, 18)} ${entry.item.type} queue=${st.queue.size}`)
    touch(st)
    ensureConnected(st)
    scheduleFlush(st)
  }

  const remove = (st: SessionState) => {
    st.closed = true
    st.activated = false
    if (st.timer) clearTimeout(st.timer)
    if (st.metaTimer) clearTimeout(st.metaTimer)
    if (st.completedTimer) {
      clearTimeout(st.completedTimer)
      st.completedTimer = null
    }
    for (const r of st.remotes.values()) {
      r.connecting = false
      r.connectQueued = false
      if (r.initTimer) {
        clearTimeout(r.initTimer)
        r.initTimer = null
      }
      if (r.reconnectTimer) {
        clearTimeout(r.reconnectTimer)
        r.reconnectTimer = null
      }
      cancelSettleDrop(r)
      if (r.idleDropTimer) {
        clearTimeout(r.idleDropTimer)
        r.idleDropTimer = null
      }
      if (r.wsReady) wsSend(r, { op: "delete" })
      else if (r.shareId && r.secret) {
        // turn mode may have dropped the socket after the last settle; the
        // goodbye still must land — say it over HTTP
        void fetch(`${r.url}/api/share/${r.shareId}`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ secret: r.secret }),
          signal: AbortSignal.timeout(8000),
        }).catch(() => {})
      }
    }
    setTimeout(() => {
      for (const r of st.remotes.values()) {
        try {
          r.ws?.close()
        } catch {}
      }
    }, 1000)
    for (const r of st.remotes.values()) spoolClear(st, r)
    sessions.delete(st.sid)
    try {
      chain = chain.then(async () => {
        if (!st.client) return
        const res = await st.client.session
          .get({
            path: { id: st.sid },
            ...(deps.directory ? { query: { directory: deps.directory } } : {}),
          })
          .catch(() => null)
        const info = (res as { data?: SessionInfo })?.data ?? (res as SessionInfo)
        if (info?.metadata?.[METADATA_KEY]) {
          const metadata = { ...info.metadata }
          delete metadata[METADATA_KEY]
          await st.client.session
            .update({
              path: { id: st.sid },
              body: { metadata },
              ...(deps.directory ? { query: { directory: deps.directory } } : {}),
            })
            .catch(() => {})
        }
      })
    } catch {}
  }

  // ---- manual-mode backfill ----------------------------------------------
  // Activation may happen mid-session: fetch the whole session tree
  // through the client and enqueue everything through the same keyed
  // queue (idempotent; live events keep overwriting the same keys).
  const PAGE_SIZE = 100
  const MAX_PAGES = 50

  const query = () => (deps.directory ? { directory: deps.directory } : {})

  async function fetchMessages(client: ClientApi, sid: string): Promise<Message[]> {
    if (typeof client.session.messages !== "function") return []
    const out: Message[] = []
    let before: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const q: Record<string, unknown> = { ...query(), limit: PAGE_SIZE }
      if (before !== undefined) q.before = before
      const result = unwrap(
        await client.session.messages({
          path: { id: sid },
          query: q,
        }),
      )
      if (!Array.isArray(result) || result.length === 0) break
      out.push(...(result as Message[]))
      if (result.length < PAGE_SIZE) break
      const last = result[result.length - 1] as Message
      const nextBefore =
        typeof last?.info?.id === "string" ? (last.info.id as string) : typeof (last as unknown as { id?: string })?.id === "string" ? ((last as unknown as { id: string }).id as string) : undefined
      if (!nextBefore || nextBefore === before) break
      before = nextBefore
    }
    return out
  }

  const backfillSession = async (st: SessionState, client: ClientApi, sid: string, info?: SessionInfo) => {
    const sessionInfoValue = info ?? (await sessionInfo(client, sid))
    if (sessionInfoValue) enqueue(st, itemFor("session", redact(sessionInfoValue), sid))

    const messages = await fetchMessages(client, sid)
    let modelSeen = false
    for (const message of messages) {
      const m = (message.info ?? message) as MessageInfo
      if (!m || typeof m.id !== "string") continue
      enqueue(st, itemFor("message", m, sid))
      if (m.role === "user" && m.model) {
        modelSeen = true
        const label = formatLabel(st.opts?.modelLabel ?? cfg.modelLabel, m.model)
        enqueue(
          st,
          itemFor("model", [{ id: m.model.modelID, providerID: m.model.providerID, name: label }], sid),
        )
      }
      for (const part of message.parts ?? []) {
        const p = part as PartInfo
        if (!p || typeof p.id !== "string" || typeof p.messageID !== "string") continue
        if (p.state?.status === "error") st.badSignal = true
        enqueue(st, itemFor("part", p, sid))
      }
    }
    if (!modelSeen && sessionInfoValue?.model) {
      // hosts whose user messages carry no model (v2): label from the
      // session's own model
      const label = formatLabel(st.opts?.modelLabel ?? cfg.modelLabel, sessionInfoValue.model as SessionModel)
      enqueue(
        st,
        itemFor("model", [{ id: (sessionInfoValue.model as SessionModel).modelID, providerID: (sessionInfoValue.model as SessionModel).providerID, name: label }], sid),
      )
    }
    return messages
  }

  const backfill = async (st: SessionState, info?: SessionInfo) => {
    const client = st.client
    if (!client) return
    const messages = await backfillSession(st, client, st.sid, info)
    if (messages.length === 0 && !info) {
      // nothing synced yet and no info in hand: the session item is the
      // one thing a viewer always needs — fetch it explicitly
      const fetched = await sessionInfo(client, st.sid)
      if (fetched) enqueue(st, itemFor("session", redact(fetched), st.sid))
    }

    // children (subagent sessions) share the parent's page
    if (typeof client.session.list === "function") {
      try {
        const result = unwrap(await client.session.list({ query: query() }))
        if (Array.isArray(result)) {
          for (const raw of result as SessionInfo[]) {
            if (!raw || typeof raw.id !== "string") continue
            if (raw.parentID !== st.sid) continue
            childToParent.set(raw.id, st.sid)
            await backfillSession(st, client, raw.id, raw)
          }
        }
      } catch (e) {
        log("backfill child list failed:", (e as Error)?.message || e)
      }
    }

    if (typeof client.session.diff === "function") {
      try {
        const diff = unwrap(
          await client.session.diff({
            path: { id: st.sid },
            query: query(),
          }),
        )
        if (diff !== undefined) enqueue(st, itemFor("session_diff", diff, st.sid))
      } catch {
        // diff is best-effort
      }
    }

    // seeded "completed" but history contains errors -> "error"
    if (st.status === "completed" && st.badSignal) st.status = "error"
  }

  // ---- events ------------------------------------------------------------
  const debugEvents = !!process.env.OPENSHARE_DEBUG_EVENTS

  const trackChild = (sid: string, info: SessionInfo | undefined) => {
    if (info?.parentID) {
      const parent = childToParent.get(sid) ?? info.parentID
      childToParent.set(sid, parent)
      return parent
    }
    return null
  }

  /** A child session whose events arrived BEFORE its session.created got
   * created as a bogus MAIN st (own share). When the parent relationship
   * is finally known, merge: move queued items into the parent's share
   * and retire the bogus one (worker delete + metadata cleanup). */
  const adoptStrayChild = (childSid: string, parentSid: string) => {
    const stray = sessions.get(childSid)
    const parent = sessions.get(parentSid)
    if (!stray || stray.closed) return
    if (parent && parent !== stray) {
      for (const [key, item] of stray.queue) parent.queue.set(key, item)
      stray.queue.clear()
      // a stray's remotes may hold shares/pending the parent should adopt:
      // merge per-server state so the parent's fan-out covers them
      for (const [url, sr] of stray.remotes) {
        const pr = remoteFor(parent, url)
        if (!pr.shareId && sr.shareId) {
          pr.shareId = sr.shareId
          pr.secret = sr.secret
          pr.ackedRev = sr.ackedRev
        }
        for (const frame of sr.pending) pr.pending.push(frame)
        sr.pending = []
        sr.shareId = null
        sr.secret = null
      }
      scheduleFlush(parent)
    }
    for (const sr of stray.remotes.values()) {
      if (sr.shareId) log(`stray child share ${sr.shareId} (${sr.url}) -> merging into ${parentSid}`)
    }
    remove(stray)
  }

  const handleSessionEvent = (t: string, sid: string, info: SessionInfo | undefined) => {
    const parent = trackChild(sid, info)

    if (mode === "manual") {
      if (parent) {
        // children follow their parent's share; a child event never
        // activates anything on its own
        const st = sessions.get(parent)
        if (st?.activated && !st.closed) {
          if (!st.prefsSent) {
            st.prefsSent = true
            enqueue(st, itemFor("prefs", { openTasksInNewTab: cfg.openTasksInNewTab !== false }, sid))
          }
          if (info) enqueue(st, itemFor("session", redact(info), sid))
        }
        return
      }
      const flag = shareFlag(info)
      const st = sessions.get(sid)
      if (flag.enabled) {
        if (st?.activated && !st.closed) {
          // already sharing: opts updates apply, flag removal handled below
          if (flag.opts) st.opts = flag.opts
          if (!st.prefsSent) {
            st.prefsSent = true
            enqueue(st, itemFor("prefs", { openTasksInNewTab: cfg.openTasksInNewTab !== false }, sid))
          }
          if (info) enqueue(st, itemFor("session", redact(info), sid))
          if (t === "session.updated") chain = chain.then(() => refreshOptOuts(st)).catch(() => {})
          return
        }
        activate(sid, flag.opts, info)
        const fresh = sessions.get(sid)
        if (fresh && !fresh.prefsSent) {
          fresh.prefsSent = true
          enqueue(fresh, itemFor("prefs", { openTasksInNewTab: cfg.openTasksInNewTab !== false }, sid))
        }
        return
      }
      if (st?.activated && !st.closed && t === "session.updated") {
        // flag removed -> unshare (same path as session.deleted)
        log(`share disabled for ${sid} - removing`)
        chain = chain.then(() => remove(st)).catch((e) => logError("remove error", (e as Error)?.message || e))
        return
      }
      return
    }

    // all-mode: NEW sessions share automatically; sessions that predate
    // plugin start share only when explicitly opted in (metadata flag) or
    // already carrying a binding (resume keeps the same share). This is
    // critical: attaching the plugin to a long-lived server must never
    // retro-share the user's entire session history on first prompt.
    const main = parent ?? sid
    if (parent && parent !== sid && sessions.has(sid)) {
      // stray child discovered: its events created a bogus main share
      // before the parentID was known — fold it into the parent's
      if (!sessions.has(main)) {
        const created = newSt(main)
        created.activated = true
        sessions.set(main, created)
        queueConnectAll(created)
      }
      adoptStrayChild(sid, main)
    }
    let st = sessions.get(main)
    if (!st && !parent) {
      const flag = shareFlag(info)
      const hasBinding = !!(info as SessionInfo | undefined)?.metadata?.[METADATA_KEY]
      const createdMs = (info as SessionInfo | undefined)?.time?.created
      const isPreExisting = typeof createdMs === "number" && createdMs < bootTime
      if (isPreExisting && !flag.enabled && !hasBinding) {
        if (!preExistingRetired.has(main)) {
          preExistingRetired.add(main)
          log(`session ${main} predates plugin start - not shared (set the share flag to share it)`)
        }
        return
      }
      if (flag.enabled) {
        // explicit opt-in on a pre-existing session: full gated activation
        // (status seed + backfill + connect) so the page carries history
        activate(main, flag.opts, info, { gated: true })
        st = sessions.get(main)
      } else {
        const created = newSt(main)
        created.activated = true
        sessions.set(main, created)
        st = created
        queueConnectAll(created)
      }
    }
    if (!st) return
    if (!st.prefsSent) {
      st.prefsSent = true
      enqueue(st, itemFor("prefs", { openTasksInNewTab: cfg.openTasksInNewTab !== false }, sid))
    }
    if (info) enqueue(st, itemFor("session", redact(info), sid))
    if (t === "session.updated" && st.activated && !st.closed) {
      chain = chain.then(() => refreshOptOuts(st)).catch(() => {})
    }
  }

  return {
    mode,
    config: () => cfg,
    hooks: {
      event: async ({ event }) => {
        const t = event?.type
        const p = event?.properties || {}
        const sid = p.sessionID as string | undefined
        if (!sid) return
        if (debugEvents) {
          const par = (p.info as SessionInfo | undefined)?.parentID
          log(`event: ${t} ${sid}${par ? ` (child of ${par})` : ""}`)
        }

        if (t === "session.created" || t === "session.updated") {
          handleSessionEvent(t, sid, p.info as SessionInfo)
        } else if (t === "session.status") {
          const st = stFor(sid)
          if (!st) return
          const type = (p.status as { type?: string } | undefined)?.type
          touch(st)
          if (type === "busy") {
            // work resumed: a pending completed flip is cancelled (opencode
            // idles between sequential automation prompts — that is NOT
            // "done"), a recovered retry is forgiven, share is live again.
            // The busy epoch is the completed-flip guard: only WORK
            // invalidates a pending settle (v1.18 republishes the
            // status/idle pair on failure paths — a repeated idle must
            // NOT void it, live-caught as a share stuck on live forever)
            st.statusEpoch++
            if (st.completedTimer) {
              clearTimeout(st.completedTimer)
              st.completedTimer = null
            }
            st.badSignal = false
            st.status = "live"
            ensureConnected(st)
            scheduleFlush(st)
          } else if (type === "idle") {
            // opencode's idle is authoritative turn end (v1 holds busy
            // through steps, tool runs and permission waits). CONTENT
            // flushes now — turn-end batches must not ride the sync
            // interval (live-caught: subagent finals lagged one interval).
            // Only the completed flip waits out completedDelayMs, guarded
            // by the busy epoch: work resuming voids it, repeated idle
            // publications do not. Dispose flushes a pending flip, so CI
            // runs still land their final status.
            if (st.timer) clearTimeout(st.timer)
            st.timer = null
            chain = chain
              .then(() => flush(st))
              .catch((e) => logError("idle flush error", (e as Error)?.message || e))
            const epoch = st.statusEpoch
            const settle = () => {
              st.status = st.badSignal ? "error" : "completed"
              st.badSignal = false
              if (st.timer) clearTimeout(st.timer)
              st.timer = null
              chain = chain
                .then(() => flush(st))
                .then(() => {
                  armSettleDrop(st)
                })
                .catch((e) => logError("settle flush error", (e as Error)?.message || e))
            }
            if (cfg.completedDelayMs <= 0) {
              settle()
            } else if (!st.completedTimer && !st.closed) {
              st.completedTimer = setTimeout(() => {
                st.completedTimer = null
                if (st.closed || st.statusEpoch !== epoch) return
                settle()
              }, cfg.completedDelayMs)
            }
          } else if (type === "retry") {
            // scheduled backoff retry (attempt/next): NOT terminal — busy
            // forgiveness above clears it when work resumes and completes
            st.badSignal = true
          }
        } else if (t === "session.error") {
          // terminal turn error (aborted run, context overflow): the share
          // says error at the following idle; recovered retries never set it
          const st = stFor(sid)
          if (st) {
            st.badSignal = true
            touch(st)
          }
        } else if (t === "message.removed" || t === "message.part.removed") {
          // opencode undo: revert() only marks the session (the viewer
          // hides the range); the NEXT prompt hard-deletes the reverted
          // messages/parts via cleanup() and publishes these events.
          // The worker's store is upsert-only, so without an explicit
          // tombstone the deleted items live forever and reappear the
          // moment the revert marker clears (live-caught in production).
          const st = stFor(sid)
          if (!st || !st.activated || st.closed) return
          const messageID = p.messageID as string | undefined
          if (!messageID) return
          if (t === "message.removed") {
            enqueue(st, { key: `message/${messageID}`, item: { type: "message", del: true, data: { id: messageID } } })
          } else {
            const partID = p.partID as string | undefined
            if (!partID) return
            enqueue(st, { key: `part/${messageID}/${partID}`, item: { type: "part", del: true, data: { id: partID, messageID } } })
          }
        } else if (t === "message.updated") {
          // resumed sessions may emit the user message BEFORE any session.*
          // event — in all-mode an unknown sid is optimistically treated as
          // main and VERIFIED against the session record (children announce
          // via session.created+parentID first); in manual-mode unknown
          // sids are dropped (the flag-bearing session.updated activates,
          // and backfill fills the past)
          const main = childToParent.get(sid) ?? sid
          let st = sessions.get(main)
          if (!st && mode === "all" && !preExistingRetired.has(main)) {
            const created = newSt(main)
            created.activated = true
            sessions.set(main, created)
            st = created
            // pre-existing-session gate for the no-info path: verify
            // against the session record BEFORE connecting (a retired
            // session never reaches the worker, never announces, never
            // writes the url file); a pass connects, and queued events
            // ride the normal pending replay
            if (!verifying.has(main)) {
              verifying.add(main)
              chain = chain
                .then(async () => {
                  if (created.closed) return
                  const info = await sessionInfo(created.client, main)
                  verifying.delete(main)
                  if (created.closed) return
                  const flag = shareFlag(info)
                  const hasBinding = !!(info as SessionInfo | undefined)?.metadata?.[METADATA_KEY]
                  const createdMs = (info as SessionInfo | undefined)?.time?.created
                  const isPreExisting = typeof createdMs === "number" && createdMs < bootTime
                  if (debugEvents) {
                    log(
                      `verify ${main}: created=${createdMs} boot=${bootTime} pre=${isPreExisting} flag=${flag.enabled} binding=${hasBinding} infoMissing=${!info}`,
                    )
                  }
                  if (isPreExisting && !flag.enabled && !hasBinding) {
                    preExistingRetired.add(main)
                    log(`session ${main} predates plugin start - not shared (set the share flag to share it)`)
                    remove(created)
                    return
                  }
                  queueConnectAll(created)
                })
                .catch((e) => {
                  verifying.delete(main)
                  logError("verify error", (e as Error)?.message || e)
                })
            }
          }
          if (!st || !st.activated || st.closed) return
          enqueue(st, itemFor("message", p.info, sid))
          const info = p.info as MessageInfo
          if (info?.role === "user" && info?.model) {
            const label = formatLabel(st.opts?.modelLabel ?? cfg.modelLabel, info.model)
            enqueue(st, itemFor("model", [{ id: info.model.modelID, providerID: info.model.providerID, name: label }], sid))
          }
          // an assistant message that DIED (finish:"error") — e.g. all
          // retries exhausted — surfaces as a 200 response with an errored
          // message, NOT as session.error (live-caught in the suite); the
          // share must still say error
          if (info?.role === "assistant" && (info as { finish?: string }).finish === "error") {
            st.badSignal = true
          }
        } else if (t === "message.part.updated") {
          const st = stFor(sid)
          if (!st || !st.activated || st.closed) return
          const part = p.part as PartInfo
          if (part?.state?.status === "error") st.badSignal = true
          enqueue(st, itemFor("part", part, sid))
        } else if (t === "session.diff") {
          const st = stFor(sid)
          if (!st || !st.activated || st.closed) return
          enqueue(st, itemFor("session_diff", p.diff, sid))
        } else if (t === "session.deleted") {
          // a CHILD session ending (task done, gc) must NEVER take the
          // parent's share down with it — the page keeps the subagent's
          // output; only the MAIN session's deletion unshares
          const isChild = childToParent.has(sid)
          if (isChild) {
            if (debugEvents) log("event: child session.deleted (ignored)", sid)
            return
          }
          const st = sessions.get(sid)
          if (!st) return
          chain = chain.then(() => remove(st)).catch((e) => logError("remove error", (e as Error)?.message || e))
        }
      },

      dispose: async () => {
        for (const st of sessions.values()) {
          if (st.completedTimer) {
            // a pending idle never got its delay: resolve now so the
            // final status lands even though the process is exiting
            // (the timer existing implies idle was the last signal; the
            // epoch guard is satisfied by definition — nothing newer ran)
            clearTimeout(st.completedTimer)
            st.completedTimer = null
            st.status = st.badSignal ? "error" : "completed"
            st.badSignal = false
          }
          if (st.timer) clearTimeout(st.timer)
          st.timer = null
          for (const r of st.remotes.values()) {
            if (r.initTimer) {
              clearTimeout(r.initTimer)
              r.initTimer = null
            }
            cancelSettleDrop(r)
            if (r.idleDropTimer) {
              clearTimeout(r.idleDropTimer)
              r.idleDropTimer = null
            }
          }
          const flushed = flush(st)
          if (flushed && typeof (flushed as Promise<unknown>).then === "function") await flushed.catch(() => {})
          // dispose with a mid-handshake socket: the deferred pending
          // would die with the process — land it over HTTP instead
          for (const r of st.remotes.values()) {
            if (!r.wsReady && r.shareId && r.pending.length) {
              await flushViaHttp(st, r).catch(() => {})
            }
          }
          if (st.metaTimer) clearTimeout(st.metaTimer)
          st.metaTimer = null
          await writeBinding(st).catch(() => {})
        }
        for (const st of sessions.values()) {
          for (const r of st.remotes.values()) {
            try {
              r.ws?.close()
            } catch {}
          }
        }
      },
    },
  }
}

