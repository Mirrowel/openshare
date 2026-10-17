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
import { METADATA_KEY, loadConfig, resolveShareMode, spoolDirFor, type ShareConfig, type ShareMode } from "./config.js"

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

type SessionState = {
  sid: string
  client: ClientApi | undefined
  queue: Map<string, unknown> // key -> item (not yet sent)
  pending: Array<{ items: unknown[]; status: string }> // spool frames awaiting ack
  timer: ReturnType<typeof setTimeout> | null
  metaTimer: ReturnType<typeof setTimeout> | null
  shareId: string | null
  secret: string | null
  ackedRev: number
  ws: WebSocket | null
  wsReady: boolean
  socketSeq?: number
  backoff: number
  status: string
  badSignal: boolean
  lastSentStatus: string | null
  connecting: boolean
  closed: boolean
  prefsSent: boolean
  binding: Binding | null // mirrors what was written into session metadata
  bindingQueried: boolean
  reconnectTimer: ReturnType<typeof setTimeout> | null
  // manual-mode bookkeeping
  opts: SessionOpts | undefined
  activated: boolean
  announced: boolean
  wroteBinding: boolean
}

type Message = { info?: Record<string, unknown>; parts?: Record<string, unknown>[] }

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

const log = (...a: unknown[]) => {
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
  if (!cfg.workerUrl || !cfg.createToken) {
    log("disabled: workerUrl/createToken not configured")
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
  const wsUrl = () => cfg.workerUrl.replace(/^http/, "ws")
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
    pending: [],
    timer: null,
    metaTimer: null,
    shareId: null,
    secret: null,
    ackedRev: 0,
    ws: null,
    wsReady: false,
    backoff: 1000,
    status: "live",
    badSignal: false,
    lastSentStatus: null,
    connecting: false,
    closed: false,
    prefsSent: false,
    binding: null,
    bindingQueried: false,
    reconnectTimer: null,
    opts: undefined,
    activated: false,
    announced: false,
    wroteBinding: false,
  })

  const refreshConfig = () => {
    // settings may change between activations (the TUI writes the config
    // file); each activation re-reads. env always wins, so CI is stable.
    const next = loadConfig(deps.pluginDir, deps.options)
    if (next.workerUrl) {
      cfg = next
      spoolRoot = spoolDirFor(cfg)
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
      // phantom "live" badge. backfill follows, then the connection.
      chain = chain
        .then(() => seedManualStatus(st))
        .then(() => backfill(st, info))
        .then(() => connect(st))
        .catch((e) => log("activation error", (e as Error)?.message || e))
    } else {
      chain = chain
        .then(() => connect(st))
        .catch((e) => log("connect error", (e as Error)?.message || e))
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
        if (typeof record.id === "string" && typeof record.secret === "string") {
          st.shareId = record.id
          st.secret = record.secret
          st.ackedRev = typeof record.rev === "number" ? record.rev : 0
          if (mode === "manual") st.opts = shareFlag(info).opts ?? st.opts
          log(`binding recovered from session metadata: share ${st.shareId} rev ${st.ackedRev}`)
        }
      }
    } catch (e) {
      log("metadata read failed (degrading to spool):", (e as Error)?.message || e)
    }
  }

  async function writeBinding(st: SessionState) {
    if (!st.client || !st.shareId || !st.secret) return
    const value: Record<string, unknown> = {
      id: st.shareId,
      secret: st.secret,
      rev: st.ackedRev,
      url: `${cfg.workerUrl}/s/${st.shareId}`,
    }
    if (mode === "manual") {
      value.enabled = true
      if (st.opts) value.opts = st.opts
    }
    st.binding = value as Binding
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
  const metaPath = (st: SessionState) => join(spoolRoot, `${st.sid}.meta.json`)
  const queuePath = (st: SessionState) => join(spoolRoot, `${st.sid}.queue.jsonl`)

  const spoolSave = (st: SessionState) => {
    try {
      writeFileSync(metaPath(st), JSON.stringify({ shareId: st.shareId, secret: st.secret, ackedRev: st.ackedRev, sid: st.sid }))
      writeFileSync(queuePath(st), st.pending.map((f) => JSON.stringify(f)).join("\n") + (st.pending.length ? "\n" : ""))
    } catch (e) {
      log("spool save failed", (e as Error)?.message || e)
    }
  }
  const spoolLoad = (st: SessionState) => {
    try {
      const meta = JSON.parse(readFileSync(metaPath(st), "utf8"))
      // metadata binding (db) is authoritative when both exist and disagree
      if (!st.shareId && meta.shareId) {
        st.shareId = meta.shareId
        st.secret = meta.secret
        st.ackedRev = meta.ackedRev ?? 0
      }
      if (existsSync(queuePath(st))) {
        st.pending = readFileSync(queuePath(st), "utf8")
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l))
      }
    } catch {
      st.pending = []
    }
  }
  const spoolClear = (st: SessionState) => {
    try {
      rmSync(metaPath(st), { force: true })
      rmSync(queuePath(st), { force: true })
    } catch {}
  }

  // ---- websocket transport ----------------------------------------------
  const wsSend = (st: SessionState, obj: unknown) => {
    if (debugEvents) log(`ws#${st.socketSeq} send ${(obj as { op?: string })?.op} (ready=${st.wsReady})`)
    try {
      st.ws?.send(JSON.stringify(obj))
    } catch {
      return false
    }
    return true
  }

  const announceUrl = (st: SessionState) => {
    if (st.announced) return
    st.announced = true
    const url = `${cfg.workerUrl}/s/${st.shareId}`
    log(`live: ${url}`)
    if (mode === "all") {
      // default: the file lives where the session lives (its directory,
      // falling back to the process cwd) — never a fixed global path.
      // Explicit urlFile config/env wins. Append: CI reads the file after
      // each run; keeping every share URL lets one file serve a whole
      // workflow (the legacy original overwrote with the latest only).
      const file = cfg.urlFile || join(deps.directory ?? process.cwd(), "openshare.urls.txt")
      try {
        appendFileSync(file, url + "\n")
        if (file !== lastUrlFile || !urlFileAnnounced) {
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

  const connect = async (st: SessionState) => {
    if (st.closed || st.connecting) return
    st.connecting = true
    st.socketSeq = (st.socketSeq ?? 0) + 1
    const seq = st.socketSeq
    try {
      await readBinding(st)
      spoolLoad(st)
      if (debugEvents) log(`ws#${seq} opening (${st.shareId ? `attach ${st.shareId}` : "create"})`)
      const ws = new WebSocket(`${wsUrl()}/api/ws?token=${encodeURIComponent(cfg.createToken ?? "")}`)
      st.ws = ws
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
        let frame
        try {
          frame = JSON.parse((ev as MessageEvent).data as string)
        } catch {
          return
        }
        handleFrame(st, frame).catch((e) => log("frame error", (e as Error)?.message || e))
      })
      ws.addEventListener("close", () => {
        st.wsReady = false
        if (!st.closed) scheduleReconnect(st)
      })

      if (st.shareId && st.secret) {
        wsSend(st, { op: "init", attach: { id: st.shareId, secret: st.secret, ...authFrame(st) } })
      } else {
        wsSend(st, { op: "init", create: { sessionID: st.sid, ttlDays: ttlFor(st), ...authFrame(st) } })
      }
    } catch (e) {
      st.connecting = false
      log("socket failed:", (e as Error)?.message || e, "- falling back to HTTP, will retry")
      st.wsReady = false
      void flushViaHttp(st).catch(() => {})
      scheduleReconnect(st)
      return
    }
    st.connecting = false
  }

  const scheduleReconnect = (st: SessionState) => {
    if (st.closed || st.reconnectTimer) return
    const wait = st.backoff
    st.backoff = Math.min(st.backoff * 2, 60000)
    st.reconnectTimer = setTimeout(() => {
      st.reconnectTimer = null
      chain = chain
        .then(() => connect(st))
        .catch((e) => log("reconnect error", (e as Error)?.message || e))
    }, wait)
  }

  const handleFrame = async (st: SessionState, frame: Record<string, unknown>) => {
    if (frame.op === "init") {
      if (!frame.ok) {
        // share swept / removed / revoked: start fresh, never merge into a
        // bad base (mismatch protocol)
        log("init refused:", frame.error, "- creating fresh share")
        st.shareId = null
        st.secret = null
        st.ackedRev = 0
        st.pending = []
        wsSend(st, { op: "init", create: { sessionID: st.sid, ttlDays: ttlFor(st), ...authFrame(st) } })
        return
      }
      if (typeof frame.rev === "number" && frame.rev < st.ackedRev) {
        // worker lost data behind our back: treat as gone
        log(`mismatch: worker rev ${frame.rev} < acked ${st.ackedRev} - recreating`)
        st.shareId = null
        st.secret = null
        st.ackedRev = 0
        st.pending = []
        wsSend(st, { op: "init", create: { sessionID: st.sid, ttlDays: ttlFor(st), ...authFrame(st) } })
        return
      }
      st.shareId = (frame.id as string) ?? st.shareId
      st.secret = (frame.secret as string) ?? st.secret
      st.ackedRev = (frame.rev as number) ?? 0
      st.wsReady = true
      st.backoff = 1000
      announceUrl(st)
      // first binding write is immediate (the TUI waits on the URL in
      // session metadata); ack-driven rev updates stay debounced
      if (!st.wroteBinding) {
        chain = chain.then(() => writeBinding(st)).catch(() => {})
      } else {
        scheduleBindingWrite(st)
      }
      spoolSave(st)
      if (st.pending.length) {
        for (const f of st.pending) wsSend(st, { op: "sync", ...f })
      } else if (st.queue.size) {
        flush(st)
      }
      return
    }
    if (frame.op === "ack") {
      st.ackedRev = (frame.rev as number) ?? st.ackedRev
      st.pending = []
      spoolSave(st)
      scheduleBindingWrite(st)
      return
    }
    if (frame.op === "nack" || frame.op === "error") {
      log("worker refused frame:", JSON.stringify(frame).slice(0, 200))
      // the control socket lost its attach state (worker-side eviction of
      // the control DO): force a reconnect — init attach replays pending
      if (frame.op === "error" && st.wsReady && !st.closed) {
        st.wsReady = false
        try {
          st.ws?.close()
        } catch {}
        scheduleReconnect(st)
      }
    }
  }

  // ---- flush -------------------------------------------------------------
  const frameFrom = (st: SessionState) => {
    const items = Array.from(st.queue.values())
    st.queue.clear()
    const statusChanged = st.status !== st.lastSentStatus
    if (!items.length && !statusChanged) {
      if (debugEvents) log(`ws#${st.socketSeq ?? 0} flush skip (no items, status ${st.status}==${st.lastSentStatus})`)
      return null
    }
    st.lastSentStatus = st.status
    if (debugEvents) log(`ws#${st.socketSeq ?? 0} frame: ${items.length} items, status ${st.status} -> ${st.status === st.lastSentStatus ? "same" : "changed"}`)
    return { items, status: st.status }
  }

  // returns a promise when the frame goes out via HTTP (the dispose path
  // awaits it - an unawaited fetch dies with the exiting process and the
  // final status never lands, live-caught as shares stuck on "live")
  const flush = (st: SessionState): Promise<unknown> | undefined => {
    if (st.closed) return
    const f = frameFrom(st)
    if (!f) return
    st.pending.push(f)
    spoolSave(st)
    if (st.wsReady) {
      wsSend(st, { op: "sync", ...f })
      return
    }
    return flushViaHttp(st)
  }

  const flushViaHttp = async (st: SessionState) => {
    if (!st.shareId || !st.pending.length) return
    const f = st.pending[st.pending.length - 1]
    const r = await fetch(`${cfg.workerUrl}/api/share/${st.shareId}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: st.secret, data: f.items, status: f.status }),
    }).catch(() => null)
    if (r && r.ok) {
      const body = (await r.json().catch(() => ({}))) as { rev?: number }
      st.ackedRev = body.rev ?? st.ackedRev
      st.pending = []
      spoolSave(st)
    }
  }

  const scheduleFlush = (st: SessionState) => {
    if (st.timer) return
    const jitter = 0.8 + Math.random() * 0.4
    st.timer = setTimeout(() => {
      st.timer = null
      if (debugEvents) log(`flush timer fired sid=${st.sid.slice(0, 18)} queue=${st.queue.size} pending=${st.pending.length} ready=${st.wsReady}`)
      chain = chain.then(() => flush(st)).catch((e) => log("flush error", (e as Error)?.message || e))
    }, cfg.debounceMs * jitter)
  }

  const enqueue = (st: SessionState, entry: ItemEntry | undefined) => {
    if (!st || !entry) return
    st.queue.set(entry.key, entry.item)
    if (debugEvents) log(`enqueue sid=${st.sid.slice(0, 18)} ${entry.item.type} queue=${st.queue.size}`)
    scheduleFlush(st)
  }

  const remove = (st: SessionState) => {
    st.closed = true
    st.activated = false
    if (st.timer) clearTimeout(st.timer)
    if (st.metaTimer) clearTimeout(st.metaTimer)
    if (st.wsReady) wsSend(st, { op: "delete" })
    setTimeout(() => {
      try {
        st.ws?.close()
      } catch {}
    }, 1000)
    spoolClear(st)
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
      for (const frame of stray.pending) parent.pending.push(frame)
      stray.pending = []
      scheduleFlush(parent)
    }
    if (stray.shareId) log(`stray child share ${stray.shareId} -> merging into ${parentSid}`)
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
        chain = chain.then(() => remove(st)).catch((e) => log("remove error", (e as Error)?.message || e))
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
        chain = chain
          .then(() => connect(created))
          .catch((e) => log("connect error", (e as Error)?.message || e))
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
        chain = chain
          .then(() => connect(created))
          .catch((e) => log("connect error", (e as Error)?.message || e))
      }
    }
    if (!st) return
    if (!st.prefsSent) {
      st.prefsSent = true
      enqueue(st, itemFor("prefs", { openTasksInNewTab: cfg.openTasksInNewTab !== false }, sid))
    }
    if (info) enqueue(st, itemFor("session", redact(info), sid))
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
          if (type === "busy") {
            st.status = "live"
            scheduleFlush(st)
          } else if (type === "idle") {
            st.status = st.badSignal ? "error" : "completed"
            st.badSignal = false
            // terminal state: flush NOW, not on the debounce - the process
            // can exit before a 3s timer fires and the final status (the
            // whole "completed" signal) would be lost with it
            if (st.timer) clearTimeout(st.timer)
            st.timer = null
            flush(st)
          } else if (type === "retry") {
            st.badSignal = true
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
                  await connect(created)
                })
                .catch((e) => {
                  verifying.delete(main)
                  log("verify error", (e as Error)?.message || e)
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
          chain = chain.then(() => remove(st)).catch((e) => log("remove error", (e as Error)?.message || e))
        }
      },

      dispose: async () => {
        for (const st of sessions.values()) {
          if (st.timer) clearTimeout(st.timer)
          st.timer = null
          const flushed = flush(st)
          if (flushed && typeof (flushed as Promise<unknown>).then === "function") await flushed.catch(() => {})
          if (st.metaTimer) clearTimeout(st.metaTimer)
          st.metaTimer = null
          await writeBinding(st).catch(() => {})
        }
        for (const st of sessions.values()) {
          try {
            st.ws?.close()
          } catch {}
        }
      },
    },
  }
}

