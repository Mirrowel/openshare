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
//    opts: { ttlHours?, authLogin?, authPassword?, modelLabel? } optional
//    per-session overrides (capture at activation; modelLabel applies
//    immediately, the rest at create/attach).
//  - The plugin strips this key from everything it syncs — the write
//    secret must never reach viewers.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { createHash } from "node:crypto"
import { isAbsolute, join } from "node:path"
import { METADATA_KEY, DEFAULTS, configHomePath, configSourceMap, loadConfig, resolveShareMode, spoolDirFor, URL_FILE_NONE, resolveServer, saveServerToken, type ShareConfig, type ShareMode, type ServerEntry } from "./config.js"
import { CONTRACT_VERSION, cursorFor, isV2NativeMessage, messageTombstone, normalizeV1Diff, normalizeV1Message } from "./contract.js"
import { queueBindingWrite } from "./binding-queue.js"
import { activeRules, redactItem, type RedactionHit } from "./redact.js"
import { newScopeState, scopeItem, scopeSkipsChildren, type ScopeState, type ShareScope } from "./scope.js"

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
  ttlHours?: number
  /** Partial-share scope (Wave 3), fixed at create */
  scope?: ShareScope
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
  /** deferred backoff reset: released after 30s of socket stability or a
   * second acked sync — never right after init (init-then-drop servers
   * would cycle at 1/s otherwise) */
  backoffResetTimer: ReturnType<typeof setTimeout> | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  intentionalClose: boolean
  connectQueued: boolean
  /** identity dead-end for THIS server (frozen owner, unenrollable
   * private server): stop reconnecting it; other servers unaffected. */
  authBlocked: boolean
  pending: Array<{ items: unknown[]; status: string; seq?: number; wire?: string }> // chunk-frames awaiting ack (spool; wire = prebuilt frame string)
  frozenRemote?: boolean // server froze the owner mid-session: stop writing
  warnedNoGate?: boolean // B2: one-shot "requested gate missing" warning sent
  spoolAppendFailed?: boolean // last append errored: memory-only frame exists
  spoolSaveTimer: ReturnType<typeof setTimeout> | null // debounced ack-path spool rewrite
  authWaiter?: (() => void) | undefined // frame-auth handshake resolver
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
  /** last create/attach refusal reason surfaced to the TUI (cleared on a
   * successful init-ok); rides the session binding so /share failures can
   * say WHY instead of a generic timeout */
  lastError: string | null
  /** server/token policy clamped our requested TTL: {requested, effective} */
  ttlClamped: { requested: number; effective: number } | null
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
  /** contract v2 merge state: v1 hosts stream parts separately; the v2
   * item embeds content, so the engine holds the assembled view per
   * message and re-emits the normalized whole on every update */
  merged: Map<string, { info?: Record<string, unknown>; parts: Map<string, Record<string, unknown>> }>
  /** content hash of the LAST item enqueued per key: identical re-feeds
   * (v2 hosts re-sync the whole transcript on every refresh; unchanged
   * session info on every session.updated) are skipped instead of being
   * flushed to every remote, bumping rev and re-folding every viewer.
   * Cleared on activation — re-activation re-backfills by design. */
  sentHash: Map<string, string>
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
  if (type === "session") return { key: `session/${(data as SessionInfo)?.id ?? ""}`, item: { type, sessionID, data } }
  // v2 messages carry no sessionID inside data (v1 infos did); the item
  // envelope stamps it so multi-session folds (parent + subagents) can
  // group without guessing
  if (type === "message") return { key: `message/${(data as MessageInfo)?.id ?? ""}`, item: { type, sessionID, data } }
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

/** Wave 3 data-inventory split: machine-local facts leave the PUBLIC
 * session item. Viewers recover them from the envelope's private block
 * (gated+authenticated shares only); anonymous shares never store them. */
function stripLocalFacts<T>(info: T): T {
  if (!info || typeof info !== "object") return info
  const out = { ...(info as Record<string, unknown>) }
  let changed = false
  for (const k of ["directory", "worktree"]) {
    if (out[k] !== undefined) {
      delete out[k]
      changed = true
    }
  }
  return changed ? (out as T) : info
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
    // legacy days-shaped opts migrate x24 (old bindings)
    if (typeof o.ttlHours === "number" && o.ttlHours > 0) opts.ttlHours = Math.floor(o.ttlHours)
    if (o.scope && typeof o.scope === "object") {
      const sc = o.scope as Record<string, unknown>
      const scope: ShareScope = {}
      const ft = Math.floor(Number(sc.fromTurn))
      if (Number.isFinite(ft) && ft > 1) scope.fromTurn = ft
      for (const k of ["reasoning", "tools", "subagents", "fileContents"] as const) {
        if (typeof sc[k] === "boolean") scope[k] = sc[k] as boolean
      }
      if (Object.keys(scope).length) opts.scope = scope
    }
    else if (typeof o.ttlDays === "number" && o.ttlDays > 0) opts.ttlHours = Math.floor(o.ttlDays * 24)
    if (typeof o.authLogin === "string") opts.authLogin = o.authLogin
    if (typeof o.authPassword === "string") opts.authPassword = o.authPassword
    if (typeof o.modelLabel === "string") opts.modelLabel = o.modelLabel
  }
  return { enabled: true, opts: Object.keys(opts).length ? opts : undefined }
}

/** The LIVE engine's resolved target urls (shared module state: the TUI
 * entry reads this so surfaces that gate on "is anything configured" agree
 * with what the engine actually targets - file config alone can miss
 * plugin-options-layer config the TUI cannot see). */
let liveTargets: string[] = []
// the live engine registers its counter here (the TUI imports the
// accessor without holding the engine instance)
let statsProvider: ((sid: string) => { messages: number; toolCalls: number }) | null = null

// Wave 3 preflight ledger: per-session redaction hits (count + first
// samples, verbatim, so false positives are visible in the consent
// preview before anything is published)
const redactionLedger = new Map<string, { count: number; samples: RedactionHit[] }>()

/** Preflight stats for the consent dialog: message/tool counts plus the
 * redaction ledger (what would be stripped before publishing). */
export function sessionStatsFor(sid: string): { messages: number; toolCalls: number; redaction: { count: number; samples: RedactionHit[] } } {
  const led = redactionLedger.get(sid) ?? { count: 0, samples: [] as RedactionHit[] }
  const counts = statsProvider ? statsProvider(sid) : { messages: 0, toolCalls: 0 }
  return { ...counts, redaction: led }
}

export function engineTargetUrls(): string[] {
  return liveTargets
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
    const hasServers = !!cfg.servers && Object.keys(cfg.servers).length > 0
    // layer-aware legacy rule: a FILE workerUrl beside a FILE servers
    // group would silently dual-home the session (live-caught surprise);
    // an ENV workerUrl is the highest-priority layer and always joins.
    const envWorker = !!process.env.OPENSHARE_WORKER_URL
    if (cfg.workerUrl && (!hasServers || envWorker)) merged[cfg.workerUrl] = { token: cfg.createToken || "", active: true }
    if (cfg.workerUrl && hasServers && !envWorker && !cfg.servers![cfg.workerUrl]) {
      log(`legacy workerUrl ${cfg.workerUrl} ignored: a servers group is configured - remove one of the two`)
    }
    if (cfg.servers) for (const [u, e] of Object.entries(cfg.servers)) merged[u] = { ...merged[u], ...e }
    const urls = Object.keys(merged)
    const actives = urls.filter((u) => merged[u].active)
    const chosen = actives.length ? actives : urls.slice(0, 1)
    return chosen.map((url) => ({ url, entry: merged[url] }))
  }
  let targets = resolveTargets()
  liveTargets = targets.map((t) => t.url)

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
  // B4 Class B (server-SUGGESTED modelLabel/shareMode): fetch once per
  // server per boot, adopt ONLY keys with no explicit local source, and
  // persist the adoption to the settings home (owner: no repeated CF
  // fetches). One flag per URL for the whole process lifetime.
  const setsFetched = new Set<string>()
  const adoptServerSuggestions = async (url: string, token: string) => {
    if (setsFetched.has(url)) return
    setsFetched.add(url)
    try {
      const r = await fetch(`${url}/api/token/sets`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      })
      const body = r.ok ? ((await r.json().catch(() => null)) as { sets?: Record<string, { modelLabel?: string; shareMode?: string }> } | null) : null
      const sets = body?.sets ?? {}
      const pick = sets[cfg.configSet ?? ""] ?? Object.values(sets)[0]
      if (!pick) return
      const wantModel = typeof pick.modelLabel === "string" && !pick.modelLabel ? undefined : pick.modelLabel
      const wantMode = pick.shareMode === "all" || pick.shareMode === "manual" ? pick.shareMode : undefined
      // adopt only what is UNSPECIFIED locally: modelLabel sits at the
      // default template, shareMode is unset and env carry no override
      const src = configSourceMap(deps.pluginDir ?? "")
      const modelUnset = cfg.modelLabel === DEFAULTS.modelLabel && !src.modelLabel
      const modeUnset = cfg.shareMode === undefined && !src.shareMode
      const adoptModel = wantModel && modelUnset
      const adoptMode = wantMode && modeUnset
      if (!adoptModel && !adoptMode) return
      // surgical write into the settings home: read, patch just these
      // keys when they are absent, write back (never clobber explicit
      // values that appeared since load)
      const home = configHomePath()
      if (!home) return
      let doc: Record<string, unknown> = {}
      try {
        doc = JSON.parse(readFileSync(home, "utf8"))
        if (!doc || typeof doc !== "object") doc = {}
      } catch {}
      let dirty = false
      if (adoptModel && doc.modelLabel === undefined) { doc.modelLabel = wantModel; dirty = true; log(`${url}: adopted modelLabel from the server config set`) }
      if (adoptMode && doc.shareMode === undefined) { doc.shareMode = wantMode; dirty = true; log(`${url}: adopted shareMode from the server config set`) }
      if (dirty) writeFileSync(home, JSON.stringify(doc, null, 2) + "\n")
    } catch {
      // suggestions are best-effort; a failed fetch never blocks sharing
    }
  }

  const ensureCredential = async (url: string): Promise<string> => {
    const c = credOf(url)
    const target = targets.find((t) => t.url === url)
    if (c.credential) {
      void adoptServerSuggestions(url, c.credential)
      return c.credential
    }
    if (Date.now() - c.lastEnrollAt < ENROLL_RETRY_MS) return ""
    c.lastEnrollAt = Date.now()
    // A configured code IS expressed onboarding intent (headless-safe:
    // CI carries it precisely to enroll). Without one, NEVER silently
    // auto-enroll (owner directive): public servers share anonymously
    // (the ask-once TUI flow offers an account), private ones refuse
    // until the user connects via /openshare.
    const code = target?.entry.code ?? ""
    if (!code) {
      try {
        const h = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) })
        const hb = h.ok ? ((await h.json().catch(() => null)) as { auth?: { mode?: string } } | null) : null
        if (hb?.auth?.mode === "public") {
          c.error = "" // anonymous standing - tokenless create works
          return ""
        }
        c.error = "private server - onboard via /openshare (needs an access code)"
      } catch (e) {
        c.error = `server unreachable: ${(e as Error)?.message || e}`
      }
      logError(`no credential for ${url}: ${c.error}`)
      return ""
    }
    try {
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
        void adoptServerSuggestions(url, c.credential)
        return c.credential
      }
      c.error = `enroll refused: ${b?.error ?? `HTTP ${r.status}`}`
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
        backoffResetTimer: null,
        spoolSaveTimer: null,
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
        // frame auth capability: the server accepts the token as the
        // first WS frame — lets us keep it off the query string (proxy
        // and access logs otherwise capture the full credential)
        if (b && typeof b === "object" && (b as { frameAuth?: unknown }).frameAuth) {
          frameAuthUrls.add(url)
        }
      })
      .catch(() => {
        // unreachable worker: defaults stay; the init ack will correct us
        policyAsked.delete(url)
      })
  }
  const frameAuthUrls = new Set<string>()
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
    lastError: null,
    ttlClamped: null,
    binding: null,
    bindingQueried: false,
    optOuts: new Set(),
    opts: undefined,
    activated: false,
    wroteBinding: false,
    everConnected: false,
    merged: new Map(),
    sentHash: new Map(),
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
      liveTargets = targets.map((t) => t.url)
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
    // re-activation re-backfills the whole session (unshare -> share
    // again): the enqueue dedupe must not skip the returning content
    st.sentHash.clear()
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
    // the read-modify-write runs inside the shared per-session queue: the
    // TUI patches the same metadata (opt-outs, collisions) and interleaved
    // RMWs silently lose one side's update (see binding-queue.ts)
    await queueBindingWrite(st.sid, async () => {
      try {
        const info = unwrap(
          await st.client!.session.get({
            path: { id: st.sid },
            ...(deps.directory ? { query: { directory: deps.directory } } : {}),
          }),
        )
        const metadata = { ...(info?.metadata ?? {}) }
        if (value === null) delete metadata[METADATA_KEY]
        else metadata[METADATA_KEY] = value
        unwrap(
          await st.client!.session.update({
            path: { id: st.sid },
            body: { metadata },
            ...(deps.directory ? { query: { directory: deps.directory } } : {}),
          }),
        )
      } catch (e) {
        log("metadata write failed (spool still covers reconnects):", (e as Error)?.message || e)
      }
    })
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
    if (st.lastError) value.lastError = st.lastError
    if (st.ttlClamped) value.ttlClamped = st.ttlClamped
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
      // the queue line IS the wire frame when prebuilt (single
      // serialization end-to-end); a pending frame without wire (legacy
      // spool load) serializes here
      writeFileSync(queuePath(st, r.url), r.pending.map((f) => f.wire ?? JSON.stringify(f)).join("\n") + (r.pending.length ? "\n" : ""))
      // the migrated content now lives in the new queue (or was acked):
      // retire the single-server-era files so they don't accumulate forever
      rmSync(legacyMetaPath(st), { force: true })
      rmSync(legacyQueuePath(st), { force: true })
    } catch (e) {
      logError("spool save failed", (e as Error)?.message || e)
    }
  }
  // hot path: appending one pending frame must not re-serialize the whole
  // queue (O(n^2) during backfill bursts) — append the line instead
  const spoolAppend = (st: SessionState, r: RemoteState, f: { items: unknown[]; status: string; seq?: number; wire?: string }) => {
    try {
      appendFileSync(queuePath(st, r.url), (f.wire ?? JSON.stringify(f)) + "\n")
    } catch (e) {
      // the frame lives ONLY in memory now — flag the remote so the next
      // spoolLoad does NOT replace in-memory pending with the shorter
      // disk queue (silent loss otherwise; live-caught class in review)
      r.spoolAppendFailed = true
      logError("spool append failed", (e as Error)?.message || e)
    }
  }
  /** Debounced ack-path spool rewrite: one ack per chunk during a
   * multi-chunk replay each rewrote the WHOLE queue file (O(n^2) —
   * ~160MB of sync disk churn on a 25-chunk outage recovery). A crash
   * inside the 300ms window only loses "these frames were acked" — the
   * next connect replays idempotent keyed upserts, which the protocol
   * already tolerates. init-ok keeps the immediate save (binding/
   * recovery info). */
  const scheduleSpoolSave = (st: SessionState, r: RemoteState) => {
    if (r.spoolSaveTimer) return
    r.spoolSaveTimer = setTimeout(() => {
      r.spoolSaveTimer = null
      if (!st.closed) spoolSave(st, r)
    }, 300)
  }
  const spoolLoad = (st: SessionState, r: RemoteState) => {
    // meta first (share binding recovery), in its OWN try: a missing meta
    // file is normal (it's only written after the first successful
    // handshake) and must NOT touch pending (live-caught class: the old
    // blanket catch wiped in-memory pending AND skipped the queue read,
    // so everything queued before the first successful connect was lost).
    try {
      const meta = JSON.parse(readFileSync(metaPath(st, r.url), "utf8"))
      // metadata binding (db) is authoritative when both exist and disagree
      if (!r.shareId && meta.shareId) {
        r.shareId = meta.shareId
        r.secret = meta.secret
        r.ackedRev = meta.ackedRev ?? 0
      }
    } catch {}
    try {
      if (existsSync(queuePath(st, r.url))) {
        // append-only spool: a crash mid-append can tear the LAST line —
        // keep the valid prefix instead of dropping the whole queue.
        // The disk queue is the authority: every in-memory frame was
        // appended before it was tracked, so replacing pending with the
        // parsed queue loses nothing. A FAILED read keeps in-memory
        // pending untouched.
        const disk: Array<{ items: unknown[]; status: string; seq?: number }> = []
        for (const line of readFileSync(queuePath(st, r.url), "utf8").split("\n")) {
          if (!line.trim()) continue
          try {
            disk.push(JSON.parse(line))
          } catch {
            log(`spool load: dropped torn tail line for ${st.sid.slice(0, 18)}`)
            break
          }
        }
        // seq hygiene: re-stamp pre-seq spool lines (an ack without seq
        // would otherwise clear ALL pending — the H2 wipe, once per
        // upgrade) and seed the counter past every restored seq (a
        // restart resetting to 0 would collide new frames with old ones)
        for (const f of disk) {
          if (typeof f.seq !== "number") f.seq = ++nextSeq
          else if (f.seq >= nextSeq) nextSeq = f.seq + 1
        }
        // a failed append means the disk queue can be SHORTER than
        // memory — the disk is only authoritative when every append
        // landed (otherwise the replace would drop the memory-only frame)
        if (!r.spoolAppendFailed) r.pending = disk
        else r.spoolAppendFailed = false
      }
    } catch {}
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
      if (r.spoolSaveTimer) {
        clearTimeout(r.spoolSaveTimer)
        r.spoolSaveTimer = null
      }
      rmSync(metaPath(st, r.url), { force: true })
      rmSync(queuePath(st, r.url), { force: true })
      // single-server-era files die with the session too
      rmSync(legacyMetaPath(st), { force: true })
      rmSync(legacyQueuePath(st), { force: true })
    } catch {}
  }

  // ---- websocket transport (per remote) ----------------------------------
  /** Monotonic client frame sequence: every chunk-frame gets one; the
   * server echoes it in the ack, and the plugin clears exactly that
   * chunk from pending. (Live-caught class: one logical frame split into
   * N chunks — the worker acks EACH chunk, and a blanket "pending = []"
   * on the first ack erased chunks 2..N; a socket death right there lost
   * them permanently.) */
  let nextSeq = 0

  const wsSend = (r: RemoteState, obj: unknown) => {
    if (debugEvents) log(`ws ${r.url.slice(0, 24)} #${r.socketSeq} send ${(obj as { op?: string })?.op} (ready=${r.wsReady})`)
    try {
      r.ws?.send(JSON.stringify(obj))
    } catch {
      return false
    }
    return true
  }

  /** Sync frames are chunked by BOTH item count and serialized bytes.
   * Count-only chunking could pack 200 large tool outputs into a frame
   * that exceeds the server's WS receive cap (CF 32 MiB, Bun 16 MB
   * default) and die wholesale. Budget keeps every frame cheap to apply
   * and rebroadcast; worker apply is keyed-idempotent, so chunks just
   * bump rev. An item larger than the whole budget rides alone in its
   * own frame (the worker fits oversize items to its storage cap).
   * Status rides each chunk; last write wins.
   * Returns each chunk's PREBUILT items JSON: the wire frame and the
   * spool line are derived from it by concatenation — every item used
   * to be serialized 3-5x per remote per flush (chunk measure, spool
   * append, ws send, sendSync re-chunk). */
  const chunkedFrames = (items: unknown[], maxItems: number, maxBytes: number): Array<{ items: unknown[]; json: string }> => {
    const chunks: Array<{ items: unknown[]; json: string }> = []
    let cur: unknown[] = []
    let curJson: string[] = []
    let curBytes = 0
    for (const it of items) {
      const j = JSON.stringify(it) ?? "null"
      if (cur.length && (cur.length >= maxItems || curBytes + j.length > maxBytes)) {
        chunks.push({ items: cur, json: "[" + curJson.join(",") + "]" })
        cur = []
        curJson = []
        curBytes = 0
      }
      cur.push(it)
      curJson.push(j)
      curBytes += j.length
    }
    if (cur.length) chunks.push({ items: cur, json: "[" + curJson.join(",") + "]" })
    return chunks
  }
  /** legacy chunker (count/byte split without prebuilt JSON) — replay
   * paths that only need the split */
  const chunkItems = (items: unknown[], maxItems: number, maxBytes: number): unknown[][] =>
    chunkedFrames(items, maxItems, maxBytes).map((c) => c.items)
  /** the wire sync frame, built by concatenation over the prebuilt items
   * JSON — byte-identical to JSON.stringify({op,items,status,seq}) */
  const syncFrameStr = (itemsJson: string, status: string, seq: number | undefined) =>
    `{"op":"sync","items":${itemsJson},"status":${JSON.stringify(status)}${seq !== undefined ? `,"seq":${seq}` : ""}}`
  const wsSendRaw = (r: RemoteState, s: string) => {
    if (debugEvents) log(`ws ${r.url.slice(0, 24)} #${r.socketSeq} send raw (${Math.round(s.length / 1024)}KB, ready=${r.wsReady})`)
    try {
      r.ws?.send(s)
    } catch {
      return false
    }
    return true
  }
  const sendSync = (r: RemoteState, f: { items: unknown[]; status: string; seq?: number; wire?: string }) => {
    if (!f.items.length) return wsSend(r, { op: "sync", items: [], status: f.status, seq: f.seq })
    // prebuilt wire (the hot flush path): one serialization total
    if (f.wire) return wsSendRaw(r, f.wire)
    // replayed/legacy frames: chunk-shaped by construction — only an
    // oversize one (a pre-chunking spool line) needs re-splitting
    const itemsJson = JSON.stringify(f.items)
    if (f.items.length <= 200 && itemsJson.length <= 512 * 1024) {
      return wsSendRaw(r, syncFrameStr(itemsJson, f.status, f.seq))
    }
    for (const c of chunkedFrames(f.items, 200, 512 * 1024)) wsSendRaw(r, syncFrameStr(c.json, f.status, f.seq))
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
      const file = cfg.urlFile
        ? isAbsolute(cfg.urlFile)
          ? cfg.urlFile
          : join(deps.directory ?? process.cwd(), cfg.urlFile)
        : join(deps.directory ?? process.cwd(), "openshare.urls.txt")
      try {
        // "json" format: one machine-readable object per line (CI parses
        // fields instead of URLs). Status is the engine's current signal
        // at announce time; the completed flip updates the SHARE, not
        // this file line.
        const line =
          cfg.urlFileFormat === "json"
            ? JSON.stringify({
                id: r.shareId,
                url,
                status: st.lastSentStatus ?? "waiting",
                gated: (st.opts?.authLogin ?? cfg.authLogin ?? "") !== "",
              }) + "\n"
            : url + "\n"
        appendFileSync(file, line)
        if (cfg.announceStderr && (file !== lastUrlFile || !urlFileAnnounced)) {
          urlFileAnnounced = true
          lastUrlFile = file
          log(`url file: ${file}`)
        }
      } catch (e) {
        // a CI pipeline reads this file after the process exits; a silent
        // failure means the run's share URL is simply gone
        logError(`url file write failed (${file}):`, (e as Error)?.message || e)
      }
    }
  }

  let halfAuthWarned = false
  const authFrame = (st: SessionState) => {
    // always send both (empty strings included): attach with empty values
    // REMOVES protection - an intentional owner action. Session opts
    // override the global config when set.
    const login = st.opts?.authLogin ?? cfg.authLogin ?? ""
    const password = st.opts?.authPassword ?? cfg.authPassword ?? ""
    // both-or-none: the server builds a gate only from a full pair, so a
    // half pair silently means "no gate" - refuse to send one and say so
    if ((login === "") !== (password === "")) {
      if (!halfAuthWarned) {
        halfAuthWarned = true
        logError("read auth needs BOTH a login and a password - gate disabled until fixed")
      }
      return { authLogin: "", authPassword: "" }
    }
    return { authLogin: login, authPassword: password }
  }

  const ttlFor = (st: SessionState) => st.opts?.ttlHours ?? cfg.ttlHours

  // free-form labels for team directories/admin listings: ${NAME} refs
  // resolve from the process env at send time; unresolved refs stay
  // literal (visible beats silently-empty). Cached env lookup, max 20
  // keys/500 chars per value (config loader caps the same).
  const metaFor = (): Record<string, string> | undefined => {
    if (!cfg.meta || typeof cfg.meta !== "object") return undefined
    const out: Record<string, string> = {}
    let n = 0
    for (const [k, v] of Object.entries(cfg.meta)) {
      if (n >= 20) break
      out[k] = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => process.env[name] ?? m)
      n++
    }
    return Object.keys(out).length ? out : undefined
  }

  /** Apply a metadata opts update. On a CHANGED opts set for a session with
   * live sockets, re-send the attach frame over each open socket: the
   * worker's attach path applies read-auth retroactively (rotating viewer
   * tokens on change) and now also honors an explicit ttlHours override -
   * so settings heal immediately instead of waiting for a reconnect.
   * Re-attach is idempotent (no once-guard on init; earlySyncs empty at
   * steady state) and revalidates the token. */
  const applyOpts = (st: SessionState, opts: SessionOpts | undefined) => {
    if (!opts) return
    const prev = st.opts ? JSON.stringify(st.opts) : ""
    st.opts = opts
    if (prev === JSON.stringify(opts)) return
    for (const [url, r] of st.remotes) {
      if (!r.shareId || !r.secret || !r.wsReady) continue
      const attach: Record<string, unknown> = { id: r.shareId, secret: r.secret, ...authFrame(st) }
      if (st.opts?.ttlHours) attach.ttlHours = st.opts.ttlHours
      const sent = wsSend(r, { op: "init", attach })
      if (sent) log(`opts re-synced to ${url.slice(0, 24)}${st.opts?.ttlHours ? ` (ttl ${st.opts.ttlHours}h)` : ""}`)
    }
  }

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
      // was removed - re-arm unless the same patch also opted out
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
      // re-share after "leave as-is": the entry kept its id/secret and the
      // opt-out marker is gone - re-arm a remote that ATTACHES the same
      // page (same URL), then backfill so the frozen gap catches up
      // (dedupe hashes describe the OLD remote set, not this revival)
      let rearmed = false
      for (const [url, e] of Object.entries(servers as Record<string, unknown>)) {
        if (st.optOuts.has(url) || st.remotes.has(url)) continue
        const ee = e as Record<string, unknown>
        if (typeof ee.id !== "string" || typeof ee.secret !== "string" || !ee.id) continue
        const r = remoteFor(st, url)
        r.shareId = ee.id
        r.secret = ee.secret
        r.ackedRev = typeof ee.rev === "number" ? ee.rev : 0
        log(`re-share: re-arming ${url.slice(0, 24)} on share ${ee.id}`)
        queueConnect(st, r)
        rearmed = true
      }
      if (rearmed) {
        st.sentHash.clear()
        chain = chain.then(() => backfill(st)).catch((e) => logError("re-share backfill error", (e as Error)?.message || e))
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
      // frame auth: when the server advertises it, keep the token off the
      // URL (query strings land in proxy/access logs). The auth frame
      // rides the socket in order — the server sets its identity before
      // our init arrives. Old servers fall back to ?token=.
      const useFrameAuth = !!token && frameAuthUrls.has(r.url)
      const ws = new WebSocket(`${wsUrl(r.url)}/api/ws${useFrameAuth ? "" : `?token=${encodeURIComponent(token ?? "")}`}`)
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

      if (useFrameAuth) {
        wsSend(r, { op: "auth", token })
        // the auth and init frames can interleave in the worker's
        // concurrent webSocketMessage invocations — wait for the authed
        // ack before authenticating anything (timeout -> fall back to a
        // query-token reconnect)
        const authed = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(false), 3000)
          r.authWaiter = () => {
            clearTimeout(t)
            resolve(true)
          }
        })
        r.authWaiter = undefined
        if (!authed) {
          logError(`ws ${r.url.slice(0, 24)}: frame-auth ack timeout - reconnecting with query token`)
          frameAuthUrls.delete(r.url)
          try {
            ws.close(4000, "auth timeout")
          } catch {}
          if (!st.closed) scheduleReconnect(st, r)
          return
        }
      }

      if (r.initWasAttach) {
        wsSend(r, { op: "init", attach: { id: r.shareId, secret: r.secret, ...authFrame(st) } })
      } else {
        wsSend(r, { op: "init", create: { sessionID: st.sid, ttlHours: ttlFor(st), ...authFrame(st), ...(cfg.configSet ? { set: cfg.configSet } : {}), ...(metaFor() ? { meta: metaFor() } : {}) } })
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
    // jitter (±20%) so fan-out remotes and multiple sessions never sync
    // their retry storms onto the same second
    const wait = Math.max(250, Math.round(r.backoff * (0.8 + Math.random() * 0.4)))
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
    if (frame.op === "authed") {
      // frame-auth handshake ack: release the init (the auth and init
      // frames can interleave server-side — webSocketMessage invocations
      // run concurrently — so the init must WAIT for this, else it
      // authenticates as anonymous/tokenless)
      r.authWaiter?.()
      r.authWaiter = undefined
      return
    }
    if (frame.op === "init") {
      if (!frame.ok) {
        const err = String(frame.error ?? "")
        if (/frozen/i.test(err)) {
          // owner frozen: every control path is severed server-side.
          // Re-enrolling would orphan the shares - surface and stop.
          r.authBlocked = true
          st.lastError = `share frozen by the hoster (owner frozen) - contact the server admin`
          scheduleBindingWrite(st)
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
        if (/limit|too many|rate/i.test(err)) {
          // quota/429 ("max shares reached", "daily create limit", the
          // anonymous caps): an immediate re-init on the same socket is a
          // hot loop against the server - back off through the normal
          // reconnect cadence instead
          st.lastError = `create refused: ${frame.error ?? "rate limited"}`
          scheduleBindingWrite(st)
          logError(`${r.url}: create refused:`, frame.error, "- retrying with backoff")
          r.connecting = false
          try {
            r.ws?.close(4000, "rate limited")
          } catch {}
          if (!st.closed) scheduleReconnect(st, r)
          return
        }
        logError(`${r.url}: init refused:`, frame.error, "- creating fresh share")
        st.lastError = `init refused: ${frame.error ?? "unknown"}`
        scheduleBindingWrite(st)
        deleteAbandoned(r)
        r.shareId = null
        r.secret = null
        r.ackedRev = 0
        wsSend(r, { op: "init", create: { sessionID: st.sid, ttlHours: ttlFor(st), ...authFrame(st), ...(cfg.configSet ? { set: cfg.configSet } : {}), ...(metaFor() ? { meta: metaFor() } : {}) } })
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
        wsSend(r, { op: "init", create: { sessionID: st.sid, ttlHours: ttlFor(st), ...authFrame(st), ...(cfg.configSet ? { set: cfg.configSet } : {}), ...(metaFor() ? { meta: metaFor() } : {}) } })
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
      // a successful handshake proves write access: an admin unfreeze
      // revives the remote from here (frozenRemote is otherwise sticky)
      if (r.frozenRemote && !frame.error) r.frozenRemote = false
      if (r.initTimer) {
        clearTimeout(r.initTimer)
        r.initTimer = null
      }
      // backoff reset is DEFERRED until the socket proves stable: a
      // server that accepts init then immediately drops would otherwise
      // reconnect once per second forever (~1 cycle/s per session-server
      // pair, live-caught in the optimization audit). 30s alive (socket
      // still ready, no reconnect pending) or a second acked sync.
      if (r.backoffResetTimer) clearTimeout(r.backoffResetTimer)
      r.backoffResetTimer = setTimeout(() => {
        r.backoffResetTimer = null
        if (r.wsReady && !r.reconnectTimer) r.backoff = 1000
      }, 30000)
      st.everConnected = true
      if (frame.policy) applyPolicy(frame.policy, r.url)
      r.intentionalClose = false
      touch(st)
      // the ack carries the RESOLVED ttl: surface a server/token clamp to
      // the binding once, and a successful handshake clears any stale
      // refusal reason the TUI may be showing
      const ackTtl = typeof frame.ttlHours === "number" ? frame.ttlHours : (typeof frame.ttlDays === "number" ? frame.ttlDays * 24 : undefined)
      if (typeof ackTtl === "number") {
        const wanted = ttlFor(st)
        const clamp = wanted != null && ackTtl !== wanted ? { requested: wanted, effective: ackTtl } : null
        if (JSON.stringify(clamp) !== JSON.stringify(st.ttlClamped)) {
          st.ttlClamped = clamp
          scheduleBindingWrite(st)
        }
      }
      if (st.lastError) {
        st.lastError = null
        scheduleBindingWrite(st)
      }
      // ack-level gate assurance (B2): we asked for a gate (both fields
      // set) but the server reports none - the page is actually public.
      // Once per remote; the next init-ok re-checks after a fix.
      const wantedGate = (st.opts?.authLogin ?? cfg.authLogin ?? "") !== "" && (st.opts?.authPassword ?? cfg.authPassword ?? "") !== ""
      if (wantedGate && frame.auth === false && !r.warnedNoGate) {
        r.warnedNoGate = true
        logError(`${r.url}: read auth requested but the page has NO gate - check the server's auth handling`)
      } else if (frame.auth === true) {
        r.warnedNoGate = false
      }
      // Wave 3 pmeta: machine-local facts (directory/worktree) ride their
      // OWN tiny sync once per init-ok, only to remotes we hold a
      // credential for - anonymous (ownerless) shares never store them.
      // Server-side they land in the private block, readable with share
      // auth. Idempotent upsert; rides no shared frame so fan-out
      // remotes with mixed identity each get exactly their due.
      if (credOf(r.url).credential) {
        const priv: Record<string, string> = {}
        const dir = (deps.directory ?? "") as string
        if (dir) priv.directory = dir
        if (deps.worktree) priv.worktree = String(deps.worktree)
        if (Object.keys(priv).length) {
          const seq = ++nextSeq
          wsSend(r, { op: "sync", items: [{ type: "pmeta", sessionID: st.sid, data: priv }], status: undefined, seq })
        }
      }
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
        // backfill is keyed-idempotent, other servers just re-upsert.
        // The enqueue dedupe must step aside: those hashes say "already
        // entered the machinery", but the NEW remote never received any
        // of it (live-caught by F3: the join's backfill was fully
        // deduped away and the joined share stayed empty).
        st.sentHash.clear()
        chain = chain.then(() => backfill(st)).catch((e) => logError("fan-out backfill error", (e as Error)?.message || e))
      }
      return
    }
    if (frame.op === "ack") {
      r.ackedRev = (frame.rev as number) ?? r.ackedRev
      // a second acked sync also proves the socket stable — release the
      // backoff reset timer early (complements the 30s-alive timer)
      if (r.backoffResetTimer) {
        clearTimeout(r.backoffResetTimer)
        r.backoffResetTimer = null
        r.backoff = 1000
      }
      // seq-scoped retirement: an ack identifies the chunk it applied.
      // An ack WITHOUT seq = old server: legacy clear-all (correct there —
      // old servers acked the whole pending batch together).
      if (typeof frame.seq === "number") {
        r.pending = r.pending.filter((p) => p.seq !== frame.seq)
      } else {
        r.pending = []
      }
      scheduleSpoolSave(st, r)
      scheduleBindingWrite(st)
      return
    }
    if (frame.op === "nack" || frame.op === "error") {
      const errText = String(frame.error ?? "")
      if (frame.op === "nack") {
        // classify: the share dying server-side under a live socket
        // (sweeper TTL, admin delete, purge) surfaces as nacks — the
        // socket is "healthy" so nothing else recovers it. Same reset as
        // the init-refused path: fresh create + content replay.
        if (/not found|gone/i.test(errText)) {
          logError(`${r.url}: share vanished server-side (nack: ${errText}) - recreating`)
          deleteAbandoned(r)
          r.shareId = null
          r.secret = null
          r.ackedRev = 0
          try {
            r.ws?.close(4000, "share gone")
          } catch {}
          if (!st.closed) queueConnect(st, r)
          return
        }
        if (/frozen/i.test(errText)) {
          // owner frozen mid-session: every write is refused. Stop
          // spooling NEW frames for this remote (unbounded growth) but
          // KEEP what's already queued — an unfreeze revives the remote
          // on the next successful handshake (init-ok clears the flag)
          // and the backlog replays from there.
          r.frozenRemote = true
          logError(`${r.url}: share frozen by the hoster - edits refused; contact the server admin`)
          return
        }
      }
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
    // stamps run at frame time: the whole family's data is indexed by now
    // (child prompts are created during the task call, well inside the
    // flush debounce), and any re-enqueued message lands in this frame
    stampsPass(st)
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
    // PENDING IS CHUNK-SHAPED (seq-tagged): one logical frame becomes N
    // chunk-frames so a partial-ack can never erase unsent chunks
    // (live-caught class: chunk-1 ack + socket death erased chunks 2..N).
    const chunks: Array<{ items: unknown[]; json: string }> = f.items.length ? chunkedFrames(f.items, 200, 512 * 1024) : []
    let httpWork: Promise<unknown> | undefined
    for (const r of st.remotes.values()) {
      if (r.frozenRemote) continue // refused server-side; stop spooling
      const fresh: Array<{ items: unknown[]; status: string; seq: number; wire?: string }> = []
      if (chunks.length) {
        for (const c of chunks) {
          const seq = ++nextSeq
          const cf = { items: c.items, status: f.status, seq, wire: syncFrameStr(c.json, f.status, seq) }
          fresh.push(cf)
          r.pending.push(cf)
          spoolAppend(st, r, cf)
        }
      } else {
        // status-only frame (empty items): one chunk-less frame
        const seq = ++nextSeq
        const cf = { items: [] as unknown[], status: f.status, seq }
        fresh.push(cf)
        r.pending.push(cf)
        spoolAppend(st, r, cf)
      }
      // never send syncs before the init ack: the worker's per-socket
      // ControlDO has no attach until OUR init completes, and a racing
      // sync dies as "unknown op" (live-caught: post-drop reconnects
      // lost whole turns). The init-ok handler flushes pending itself.
      if (r.ws && !r.wsReady) continue
      if (r.wsReady) {
        for (const cf of fresh) sendSync(r, cf)
        continue
      }
      const viaHttp = flushViaHttp(st, r)
      if (viaHttp) httpWork = (httpWork ?? Promise.resolve()).then(() => viaHttp)
    }
    if (st.remotes.size) st.lastFlushAt = Date.now()
    // the HTTP work runs detached from the flush chain (one dead server
    // must not stall the fan-out); dispose awaits its own final flush
    if (httpWork) void httpWork.catch((e) => logError("http flush error", (e as Error)?.message || e))
    return httpWork
  }

  /** Client-side key derivation mirroring the server's itemKey — used only
   * for deduping the HTTP fallback batch (keyed upserts: the LAST item
   * for a key wins, matching apply() semantics). */
  const httpDedupeKey = (it: unknown): string | null => {
    if (!it || typeof it !== "object") return null
    const o = it as { type?: string; data?: { id?: string; messageID?: string; sessionID?: string }; sessionID?: string }
    switch (o.type) {
      case "session": return "session/" + (o.data?.id ?? "")
      case "session_diff": return "session_diff/" + (o.sessionID ?? o.data?.sessionID ?? "")
      case "message": return "message/" + (o.data?.id ?? "")
      case "part": return "part/" + (o.data?.messageID ?? "") + "/" + (o.data?.id ?? "")
      case "model": return "model/" + (o.sessionID ?? o.data?.sessionID ?? "")
      case "prefs": return "prefs"
      default: return null
    }
  }

  const flushViaHttp = async (st: SessionState, r: RemoteState) => {
    if (!r.shareId || !r.pending.length) return
    // ALL pending frames, merged (keyed upserts — later wins). Sending
    // only the last frame dropped every earlier batch's items whenever
    // the HTTP fallback carried more than one (live-caught class:
    // content loss on reconnect paths). DEDUPE BY KEY before chunking:
    // a streaming message appearing in k pending frames shipped k
    // copies (up to 25x on a replay burst) — every duplicate was also a
    // server row-write + a rebroadcast frame.
    const byKey = new Map<string, unknown>()
    const unkeyed: unknown[] = []
    let status: string | undefined
    const sentSeqs = new Set<number>()
    for (const f of r.pending) {
      for (const it of f.items as unknown[]) {
        const k = httpDedupeKey(it)
        if (k) byKey.set(k, it)
        else unkeyed.push(it)
      }
      if (f.status) status = f.status
      if (typeof f.seq === "number") sentSeqs.add(f.seq)
    }
    const items = [...byKey.values(), ...unkeyed]
    const cred = credOf(r.url)
    // chunked like WS frames: one unbounded body is a whole-backlog
    // bomb after a mid-backfill socket drop (backfill = full history).
    // Failure stops the loop with pending intact — replaying already-
    // applied chunks is idempotent.
    // status-only frames (items empty, e.g. the terminal completed
    // flush in HTTP-only mode) still need ONE request or the status
    // never lands (the share stays "live" forever)
    const chunks = items.length ? chunkItems(items, 500, 4 * 1024 * 1024) : [[]]
    for (const chunk of chunks) {
      const res = await fetch(`${r.url}/api/share/${r.shareId}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cred.credential ? { authorization: `Bearer ${cred.credential}` } : {}) },
        body: JSON.stringify({ secret: r.secret ?? "", data: chunk, status }),
        signal: AbortSignal.timeout(15000),
      }).catch(() => null)
      if (!res || !res.ok) return
      const body = (await res.json().catch(() => ({}))) as { rev?: number }
      r.ackedRev = body.rev ?? r.ackedRev
    }
    // retire EXACTLY what this run sent: a concurrent flush may have
    // queued new frames while our fetches were in flight (the HTTP work
    // is deliberately detached from the flush chain) — a blanket clear
    // would erase them before anything transmitted them
    r.pending = r.pending.filter((p) => !sentSeqs.has(p.seq as number))
    scheduleSpoolSave(st, r)
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
      // NOTE: the flush's HTTP-fallback promise is deliberately NOT
      // chained — one black-holing server (15s timeout per chunk) must
      // not stall every other remote's flushes behind it. Dispose awaits
      // its own final flush explicitly.
      chain = chain
        .then(() => {
          flush(st)
        })
        .catch((e) => logError("flush error", (e as Error)?.message || e))
    }, wait)
  }

  const homeDir = (() => { try { return homedir() } catch { return "" } })()
  const userPatterns = (cfg as { redact?: { patterns?: unknown } }).redact?.patterns
  const redactionRules = activeRules(userPatterns)

  // Wave 3 partial share: per-session turn ranking for scope.fromTurn
  const scopeStates = new Map<string, ScopeState>()
  const enqueue = (st: SessionState, entry: ItemEntry | undefined) => {
    if (!st || !entry) return
    // content dedupe at the machinery boundary: an identical re-feed has
    // either entered the queue already or been flushed into every
    // remote's pending/spool (the per-remote delivery machinery owns it
    // from there) — re-sending it bumps rev, rewrites storage and
    // re-folds every viewer for nothing. This is the engine-side home
    // the v2-adapter dedupe lacked (an adapter-side cache poisoned while
    // dormant and skipped the flag-time content — live-caught).
    let h: string
    try {
      h = createHash("sha256").update(JSON.stringify(entry.item)).digest("hex")
    } catch {
      h = ""
    }
    if (h && st.sentHash.get(entry.key) === h) {
      if (debugEvents) log(`enqueue dedupe ${entry.item.type} ${entry.key.slice(0, 40)}`)
      return
    }
    if (h) st.sentHash.set(entry.key, h)
    // Wave 3 trust pass: redaction on UNGATED shares only (a gated share
    // is private from casual observers already; the server owner sees
    // content either way until encryption lands). The light path
    // transform applies regardless. Zero-copy when nothing matches.
    {
      const gate = authFrame(st)
      const gated = gate.authLogin !== "" && gate.authPassword !== ""
      const pass = redactItem(entry.item, { rules: redactionRules, home: homeDir, enabled: !gated })
      if (pass.item !== entry.item) entry = { ...entry, item: pass.item as typeof entry.item }
      if (pass.hits.length) {
        const led = redactionLedger.get(st.sid) ?? { count: 0, samples: [] as RedactionHit[] }
        led.count += pass.hits.length
        for (const hit of pass.hits) {
          if (led.samples.length < 5 && !led.samples.some((x) => x.kind === hit.kind)) led.samples.push(hit)
        }
        redactionLedger.set(st.sid, led)
      }
    }
    // Wave 3 partial share: the scope filter runs at the same choke
    // point as redaction - backfill and live events both pass here, so
    // excluded content never reaches a queue, a spool or a wire
    {
      const scope = st.opts?.scope
      if (scope) {
        const prevScope = scopeStates.get(st.sid) ?? newScopeState()
        scopeStates.set(st.sid, prevScope)
        const kept = scopeItem(entry.item as unknown as { type?: string; sessionID?: string; data?: unknown }, scope, prevScope, st.sid)
        if (!kept) {
          if (debugEvents) log("scope drop", (entry.item as { type?: string }).type, entry.key.slice(0, 40))
          return
        }
        entry = { ...entry, item: kept as unknown as typeof entry.item }
      }
    }
    st.queue.set(entry.key, entry.item)
    indexMessage(entry)
    if (debugEvents) log(`enqueue sid=${st.sid.slice(0, 18)} ${entry.item.type} queue=${st.queue.size}`)
    touch(st)
    ensureConnected(st)
    scheduleFlush(st)
  }

  // Wave 3 preflight counts: the module-level accessor delegates here
  statsProvider = (sid: string) => {
    const st = sessions.get(sid)
    let messages = 0
    let toolCalls = 0
    if (st) {
      for (const [, merged] of st.merged) {
        messages++
        const content = (merged as { content?: unknown }).content
        if (Array.isArray(content)) toolCalls += content.filter((c: unknown) => !!c && (c as { type?: string }).type === "tool").length
      }
      for (const it of st.queue.values()) {
        if ((it as { type?: string })?.type === "message") messages++
      }
    }
    return { messages, toolCalls }
  }

  // ---- authoritative stamps ----------------------------------------------
  // The viewer renders stamped facts and never re-derives them (owner
  // directive). Both stamps are computed at frame time across the whole
  // share family - the engine sees every session of the family regardless
  // of host generation, so this is the only place with the full picture.

  type IndexedMessage = {
    sid: string
    role: string
    agent?: string
    created: number
    data: Record<string, unknown>
  }
  const msgIndex = new Map<string, IndexedMessage>() // `${sid}:${messageID}`
  /** message ids tombstoned this run: stampsPass must never re-upsert an
   * undone message (live-caught class: dropMergedMessage removed the
   * merged entry but msgIndex kept the corpse; a neighboring-segment
   * change recomputed its stamps and reEnqueueMessage resurrected the
   * deleted turn server-side). */
  const tombstoned = new Set<string>()

  const indexMessage = (entry: ItemEntry) => {
    if (entry.item.type !== "message") return
    const d = entry.item.data as Record<string, any> | undefined
    if (!d || typeof d.id !== "string") return
    const role = String(d.type ?? "")
    if (role !== "user" && role !== "assistant") return
    const key = `${entry.item.sessionID}:${d.id}`
    const prev = msgIndex.get(key)
    msgIndex.set(key, {
      sid: String(entry.item.sessionID ?? ""),
      role: role as string,
      agent:
        role === "assistant"
          ? typeof d.agent === "string"
            ? d.agent
            : prev?.agent
          : typeof d.metadata?.agent === "string"
            ? d.metadata.agent
            : prev?.agent,
      created: Number(d.time?.created ?? prev?.created ?? 0),
      data: d as Record<string, unknown>,
    })
  }

  const sessionStateOf = (sid: string): SessionState | undefined =>
    sessions.get(childToParent.get(sid) ?? sid)

  const reEnqueueMessage = (m: IndexedMessage) => {
    // tombstone guard: an undone message stays dead even if a stamp pass
    // recomputes its segment metadata
    if (tombstoned.has(`${m.sid}:${m.data.id}`)) return
    const st = sessionStateOf(m.sid)
    if (st) enqueue(st, itemFor("message", m.data, m.sid))
  }

  /** segment agent for a user prompt: the prompt's own recorded agent (v1
   * hosts stamp it on every user message), else the first assistant
   * response inside the segment (v2 hosts), else carry-forward. */
  const segmentAgent = (ordered: IndexedMessage[], at: number): string | undefined => {
    const own = ordered[at]?.agent
    if (own) return own
    for (let i = at + 1; i < ordered.length; i++) {
      if (ordered[i].role === "assistant" && ordered[i].agent) return ordered[i].agent
      if (ordered[i].role === "user") break // next segment already began
    }
    return undefined
  }

  /** user messages whose segment runs a DIFFERENT agent than the previous
   * segment carry metadata.agentSwitch = <agent> - the viewer renders the
   * transition chip from the stamp alone. */
  const stampAgentSwitches = (bySession: Map<string, IndexedMessage[]>) => {
    for (const [, list] of bySession) {
      list.sort((a, b) => a.created - b.created)
      const users = list.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0)
      let prev: string | undefined
      for (let k = 0; k < users.length; k++) {
        const agent = segmentAgent(list, users[k])
        const d = list[users[k]].data as Record<string, any>
        const want = k > 0 && agent && prev && agent !== prev ? agent : undefined
        // only touch metadata when the stamp actually CHANGES — a blanket
        // `d.metadata ??= {}` polluted every user message (including the
        // host's live objects on v2 pass-through) with an empty metadata
        // object, which re-emitted the message once per refresh (rev churn
        // per feed — live-caught by the enqueue-dedupe rev check)
        if (want !== (d.metadata?.agentSwitch as string | undefined)) {
          if (want) {
            const meta = (d.metadata ??= {}) as Record<string, unknown>
            meta.agentSwitch = want
          } else if (d.metadata) {
            delete d.metadata.agentSwitch
          }
          reEnqueueMessage(list[users[k]])
        }
        if (agent) prev = agent
      }
    }
  }

  /** task/subagent tool calls get metadata.agent = the agent that actually
   * ran for THAT call: the child's first prompt created at/after the call
   * started (v1 prompts carry the agent; v2 resolves via the response).
   * Rank-free pairing - a resumed child's second call lands on its second
   * prompt by construction time. */
  const stampTaskAgents = (bySession: Map<string, IndexedMessage[]>) => {
    for (const list of bySession.values()) list.sort((a, b) => a.created - b.created)
    for (const m of msgIndex.values()) {
      if (m.role !== "assistant") continue
      const content = (m.data as any).content
      if (!Array.isArray(content)) continue
      let mutated = false
      for (const part of content) {
        if (!part || part.type !== "tool") continue
        if (part.name !== "task" && part.name !== "subagent") continue
        const state = part.state
        const meta = state?.metadata
        const childSid = typeof meta?.sessionID === "string" ? meta.sessionID : undefined
        if (!childSid || typeof meta.agent === "string") continue
        const partStart = Number(part.time?.created ?? 0)
        const child = bySession.get(childSid)
        if (!child) continue
        let agent: string | undefined
        for (const c of child) {
          if (c.created < partStart) continue
          if (c.role === "user" && c.agent) {
            agent = c.agent
            break
          }
        }
        if (!agent) {
          for (const c of child) {
            if (c.created < partStart) continue
            if (c.role === "assistant" && c.agent) {
              agent = c.agent
              break
            }
          }
        }
        if (agent) {
          meta.agent = agent
          mutated = true
        }
      }
      if (mutated) reEnqueueMessage(m)
    }
  }

  /** file tools get metadata.language (shiki lang id, from the path the
   * call touched) - the viewer highlights from the stamp and never guesses
   * (owner directive; the viewer's extension map is an old-share fallback) */
  const LANG_BY_EXT: Record<string, string> = {
    ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
    js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
    json: "json", jsonc: "json", md: "markdown", mdx: "mdx",
    py: "python", rs: "rust", go: "go", java: "java", rb: "ruby",
    css: "css", scss: "scss", html: "html", xml: "xml", yaml: "yaml", yml: "yaml",
    toml: "toml", sh: "shellscript", bash: "shellscript", ps1: "powershell",
    sql: "sql", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp",
    swift: "swift", kt: "kotlin", php: "php", lua: "lua", vue: "vue", svelte: "svelte",
  }
  const FILE_TOOLS = new Set(["read", "write", "edit", "patch"])
  const stampFileLanguages = () => {
    for (const m of msgIndex.values()) {
      if (m.role !== "assistant") continue
      const content = (m.data as any).content
      if (!Array.isArray(content)) continue
      let mutated = false
      for (const part of content) {
        if (!part || part.type !== "tool") continue
        if (!FILE_TOOLS.has(part.name)) continue
        const state = part.state
        const meta = state?.metadata
        if (!meta) continue
        const raw = state.input?.path ?? state.input?.filePath
        // language stamp (shiki id from the path)
        if (typeof meta.language !== "string" && typeof raw === "string") {
          const ext = raw.split(".").pop()?.toLowerCase() ?? ""
          const lang = LANG_BY_EXT[ext]
          if (lang) {
            meta.language = lang
            mutated = true
          }
        }
        // lineStart stamp: reads sliced from an offset keep REAL file line
        // numbers in the viewer's unified file card (pierre numbers from 1;
        // the viewer shifts by this stamp, authoritatively)
        if (typeof meta.lineStart !== "number" && part.name === "read") {
          const off = state.input?.offset
          if (typeof off === "number" && off >= 0 && off > 0) {
            meta.lineStart = off + 1
            mutated = true
          }
        }
      }
      if (mutated) reEnqueueMessage(m)
    }
  }

  const stampsPass = (st: SessionState) => {
    // skip entirely when this flush carries no message items: every
    // index mutation rides a message item through the queue (inserts via
    // enqueue, deletes via tombstones — both are type "message"), so no
    // message in the queue means the stamps' inputs are unchanged. A
    // status-only/model/prefs/diff flush costs zero stamp work.
    let any = false
    for (const it of st.queue.values()) {
      if ((it as { type?: string }).type === "message") {
        any = true
        break
      }
    }
    if (!any) return
    // one grouping + one sort shared by both passes (each used to build
    // and sort its own identical bySession map per flush)
    const bySession = new Map<string, IndexedMessage[]>()
    for (const m of msgIndex.values()) {
      const list = bySession.get(m.sid)
      if (list) list.push(m)
      else bySession.set(m.sid, [m])
    }
    for (const list of bySession.values()) list.sort((a, b) => a.created - b.created)
    stampAgentSwitches(bySession)
    stampTaskAgents(bySession)
    stampFileLanguages()
  }

  // ---- contract v2 message assembly --------------------------------------
  // v1 hosts stream parts as separate events; the v2 item embeds content.
  // The engine keeps the assembled view per message and re-emits the
  // normalized whole (the keyed queue dedupes across a debounce window,
  // so intermediate re-emissions collapse).

  const mergeEntry = (st: SessionState, messageID: string) => {
    let e = st.merged.get(messageID)
    if (!e) {
      e = { parts: new Map() }
      st.merged.set(messageID, e)
    }
    return e
  }

  /** (Re-)emit the v2 message item for a merged v1 message. */
  const emitMerged = (st: SessionState, sid: string, messageID: string) => {
    const e = st.merged.get(messageID)
    if (!e?.info) return // parts arriving before their message: wait
    const res = normalizeV1Message(e.info, [...e.parts.values()])
    if (!res) return
    if ("refill" in res) {
      // v1 compaction summary assistant → rewrite the parent compaction
      // message with the summary text; the summary message itself is not
      // emitted as its own item
      const parent = st.merged.get(res.refill)
      if (parent?.info) {
        const compaction = normalizeV1Message(parent.info, [...parent.parts.values()])
        if (compaction && "message" in compaction) {
          const msg = compaction.message as Record<string, unknown>
          msg.summary = res.summary
          enqueue(st, itemFor("message", msg, sid))
        }
      }
      return
    }
    enqueue(st, itemFor("message", res.message, sid))
  }

  /** message.updated / part.updated ingestion for v1 hosts; v2 hosts call
   * with v2-native messages (pass-through, no merge). */
  const ingestMessageInfo = (st: SessionState, sid: string, info: Record<string, unknown>) => {
    if (isV2NativeMessage(info)) {
      enqueue(st, itemFor("message", info, sid))
      return
    }
    if (typeof info?.id !== "string") return
    const e = mergeEntry(st, info.id)
    e.info = info
    emitMerged(st, sid, info.id)
  }

  const ingestPart = (st: SessionState, sid: string, part: Record<string, unknown>) => {
    if (typeof part?.id !== "string" || typeof part.messageID !== "string") return
    const e = mergeEntry(st, part.messageID)
    e.parts.set(part.id, part)
    emitMerged(st, sid, part.messageID)
  }

  const dropMergedMessage = (st: SessionState, messageID: string, evSid?: string) => {
    // the index corpse must go too: stampsPass iterates msgIndex, and a
    // re-stamp of a deleted message would re-upsert it (resurrection).
    // Key by the EVENT's session (children tombstone under their own sid;
    // the merged map is per main session)
    const sid = evSid ?? st.sid
    st.merged.delete(messageID)
    msgIndex.delete(`${sid}:${messageID}`)
    tombstoned.add(`${sid}:${messageID}`)
  }

  const dropMergedPart = (st: SessionState, sid: string, messageID: string, partID: string) => {
    const e = st.merged.get(messageID)
    if (!e) return
    e.parts.delete(partID)
    if (e.info) emitMerged(st, sid, messageID)
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
      if (r.backoffResetTimer) {
        clearTimeout(r.backoffResetTimer)
        r.backoffResetTimer = null
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
      // wsReady delete only when THIS remote still owns a share: a stray
      // child teardown clears shareId after adopting into the parent —
      // the ControlDO's server-side attach would otherwise delete the
      // very share the parent just inherited (live-caught adoption churn)
      if (r.wsReady && r.shareId) {
        wsSend(r, { op: "delete" })
        // backstop: the WS delete is fire-and-forget on the wire — a
        // socket dying right after leaves the page public until TTL. The
        // HTTP goodbye is idempotent (404/ok both fine).
        if (r.shareId && r.secret) {
          const sid = r.shareId
          const sec = r.secret
          setTimeout(() => {
            void fetch(`${r.url}/api/share/${sid}`, {
              method: "DELETE",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ secret: sec }),
              signal: AbortSignal.timeout(8000),
            }).catch(() => {})
          }, 2000)
        }
      } else if (r.shareId && r.secret) {
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
    // memory hygiene: the session is gone — its index corpses, tombstone
    // guards and child routing must not linger (msgIndex/tombstoned are
    // engine-global and otherwise only grow; sentHash rides the session
    // state and dies with it)
    const stSid = st.sid
    const pfx = `${stSid}:`
    for (const k of msgIndex.keys()) if (k.startsWith(pfx)) msgIndex.delete(k)
    for (const k of tombstoned) if (k.startsWith(pfx)) tombstoned.delete(k)
    for (const [child, parent] of childToParent) if (parent === stSid || child === stSid) childToParent.delete(child)
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

  async function fetchMessages(client: ClientApi, sid: string, onPage?: (page: Message[]) => void): Promise<Message[]> {
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
      // stream pages as they arrive: enqueue (and the rate-limited flush)
      // starts with page 1 while later pages are still loading — a huge
      // session backfills progressively instead of after a full collect
      if (onPage) {
        try {
          onPage(result as Message[])
        } catch {}
      }
      if (result.length < PAGE_SIZE) break
      const last = result[result.length - 1] as Message
      const lastInfo = (last?.info ?? last) as Record<string, unknown> | undefined
      const lastID = typeof lastInfo?.id === "string" ? lastInfo.id : undefined
      // `before` is an OPAQUE cursor: base64url({id, time}) of the page
      // tail (message-v2.ts codec). A bare message id 400s on hosts with
      // cursor pagination — every v1 backfill silently truncated to one
      // 100-message page (live-caught).
      const lastTime = (lastInfo?.time as Record<string, unknown> | undefined)?.created
      if (!lastID || typeof lastTime !== "number") break
      const nextBefore = cursorFor(lastID, lastTime)
      if (nextBefore === before) break
      before = nextBefore
    }
    // the page cap is a hard truncation: surface it instead of silently
    // sharing a partial history (oldest pages dropped)
    if (out.length >= MAX_PAGES * PAGE_SIZE) {
      logError(`backfill truncated at ${out.length} messages (page cap) for ${sid.slice(0, 18)} — oldest history not shared`)
    }
    return out
  }

  const backfillSession = async (st: SessionState, client: ClientApi, sid: string, info?: SessionInfo) => {
    const sessionInfoValue = info ?? (await sessionInfo(client, sid))
    if (sessionInfoValue) enqueue(st, itemFor("session", stripLocalFacts(redact(sessionInfoValue)), sid))

    let modelSeen = false
    const consume = (messages: Message[]) => {
      for (const message of messages) {
        const m = ((message.info ?? message) as MessageInfo) as Record<string, unknown> | undefined
        if (!m || typeof m.id !== "string") continue
        // seed the merge state, then emit the assembled v2 message
        const e = mergeEntry(st, m.id)
        e.info = m
        for (const rawPart of (message.parts ?? []) as Array<Record<string, unknown>>) {
          const p = rawPart as PartInfo
          if (!p || typeof p.id !== "string" || typeof p.messageID !== "string") continue
          if (p.state?.status === "error") st.badSignal = true
          e.parts.set(p.id, p as Record<string, unknown>)
        }
        emitMerged(st, sid, m.id)
        if (m.role === "user" && m.model) {
          modelSeen = true
          const label = formatLabel(st.opts?.modelLabel ?? cfg.modelLabel, m.model as SessionModel)
          enqueue(
            st,
            itemFor("model", [{ id: (m.model as SessionModel).modelID, providerID: (m.model as SessionModel).providerID, name: label }], sid),
          )
        }
      }
    }
    const messages = await fetchMessages(client, sid, (page) => consume(page))
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
      if (fetched) enqueue(st, itemFor("session", stripLocalFacts(redact(fetched)), st.sid))
    }

    // children (subagent sessions) share the parent's page, unless the
    // partial-share scope excludes them (then don't even fetch them)
    if (!scopeSkipsChildren(st.opts?.scope) && typeof client.session.list === "function") {
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
          if (info) enqueue(st, itemFor("session", stripLocalFacts(redact(info)), sid))
        }
        return
      }
      const flag = shareFlag(info)
      const st = sessions.get(sid)
      if (flag.enabled) {
        if (st?.activated && !st.closed) {
          // already sharing: opts updates apply, flag removal handled below
          if (flag.opts) applyOpts(st, flag.opts)
          if (info) enqueue(st, itemFor("session", stripLocalFacts(redact(info)), sid))
          if (t === "session.updated") chain = chain.then(() => refreshOptOuts(st)).catch(() => {})
          return
        }
        activate(sid, flag.opts, info)
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
    if (info) enqueue(st, itemFor("session", stripLocalFacts(redact(info)), sid))
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
            // detached flush (HTTP fallback off the shared chain — one
            // black-holing server must not stall the fan-out; same rule
            // as scheduleFlush)
            chain = chain
              .then(() => {
                flush(st)
              })
              .catch((e) => logError("idle flush error", (e as Error)?.message || e))
            const epoch = st.statusEpoch
            const settle = () => {
              st.status = st.badSignal ? "error" : "completed"
              st.badSignal = false
              if (st.timer) clearTimeout(st.timer)
              st.timer = null
              chain = chain
                .then(() => {
                  flush(st)
                })
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
          // A message tombstone removes the whole v2 message (content is
          // embedded); a part removal re-emits the merged message minus
          // the part.
          const st = stFor(sid)
          if (!st || !st.activated || st.closed) return
          const messageID = p.messageID as string | undefined
          if (!messageID) return
          if (t === "message.removed") {
            // key/tombstone by the EVENT's session id (a child's message
            // must not be keyed onto the parent — the worker deletes the
            // item but the viewer's tombstone key would miss and the
            // msgIndex corpse could re-upsert it)
            dropMergedMessage(st, messageID, sid)
            enqueue(st, { key: `message/${messageID}`, item: messageTombstone(sid, messageID) })
          } else {
            const partID = p.partID as string | undefined
            if (!partID) return
            dropMergedPart(st, sid, messageID, partID)
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
          ingestMessageInfo(st, sid, p.info as Record<string, unknown>)
          const info = p.info as MessageInfo
          if (info?.role === "user" && info?.model) {
            const label = formatLabel(st.opts?.modelLabel ?? cfg.modelLabel, info.model)
            enqueue(st, itemFor("model", [{ id: info.model.modelID, providerID: info.model.providerID, name: label }], sid))
          }
          // an assistant message that DIED (finish:"error") — e.g. all
          // retries exhausted — surfaces as a 200 response with an errored
          // message, NOT as session.error (live-caught in the suite); the
          // share must still say error. Works for v2-native messages too
          // (finish lives on the message itself).
          if ((info as { finish?: string; role?: string })?.finish === "error") {
            st.badSignal = true
          }
        } else if (t === "message.part.updated") {
          const st = stFor(sid)
          if (!st || !st.activated || st.closed) return
          const part = p.part as PartInfo
          if (part?.state?.status === "error") st.badSignal = true
          ingestPart(st, sid, part as Record<string, unknown>)
        } else if (t === "session.diff") {
          const st = stFor(sid)
          if (!st || !st.activated || st.closed) return
          enqueue(st, itemFor("session_diff", normalizeV1Diff(p.diff), sid))
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
          // would die with the process - land it over HTTP instead
          for (const r of st.remotes.values()) {
            if (!r.wsReady && r.shareId && r.pending.length) {
              await flushViaHttp(st, r).catch(() => {})
            }
          }
          // resolve any pending debounced spool rewrite before exit: the
          // queue lines are already on disk (appends are sync), but the
          // meta's ackedRev and the compacted queue should be final
          for (const r of st.remotes.values()) {
            if (r.spoolSaveTimer) {
              clearTimeout(r.spoolSaveTimer)
              r.spoolSaveTimer = null
              spoolSave(st, r)
            }
          }
          if (st.metaTimer) clearTimeout(st.metaTimer)
          st.metaTimer = null
          await writeBinding(st).catch(() => {})
        }
        // URL-at-exit barrier: a very short `opencode run` can exit before
        // the create handshake finishes, and CI reads the urlFile the
        // moment the process ends. Bounded 5s wait for every share that is
        // mid-handshake or not yet announced (a dead worker costs exactly
        // the cap; a healthy one is instant).
        const barrierStart = Date.now()
        while (Date.now() - barrierStart < 5000) {
          let pendingAnnounce = false
          for (const st of sessions.values()) {
            for (const r of st.remotes.values()) {
              if (r.authBlocked || r.collided) continue
              if ((r.shareId && !r.announced) || (!r.shareId && (r.ws || r.connecting))) pendingAnnounce = true
            }
          }
          if (!pendingAnnounce) break
          await new Promise((res) => setTimeout(res, 100))
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

