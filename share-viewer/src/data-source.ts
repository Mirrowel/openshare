// Data source. Two modes, identical downstream:
//   live    — served by the share worker at /s/<id>[/<sub>]: one GET /data,
//             then a hibernating WebSocket; every plugin sync pushes
//             {op:"frame", status, rev, items}; items merge client-side by
//             key and the fold re-runs. Polling (5s) only if WS fails.
//             Auth-gated shares: 401 {authRequired} -> login flow, then
//             everything resumes exactly as before.
//   local   — served by the decrypt tool's localhost server at /s/<id>:
//             window.__MIRROBOT_SNAPSHOT__ carries {items, sessionID} inline.
import { createMemo, createSignal } from "solid-js"
import { fold, readPrefs, type ShareData } from "./fold"

export type Branding = {
  name?: string
  logoUrl?: string
  wordmarkUrl?: string
  linkUrl?: string
  accent?: string
  faviconUrl?: string
  backgroundUrl?: string
  /** one-line deployment description: login card subtitle + og:description */
  description?: string
  /** full custom embed/link-preview title (verbatim). Empty = the
   *  "<name> · Open(code)Share" template */
  ogTitle?: string
  /** social/link-preview image (og:image / twitter:image). Falls back to
   *  logoUrl when unset. Deployment-branded, never session content. */
  ogImage?: string
}

export type Source = {
  mode: "live" | "local"
  shareID: string
  sub: number | undefined
  data: () => ShareData | undefined
  ready: () => boolean
  status: () => string
  rev: () => number
  prefs: () => { openTasksInNewTab?: boolean }
  error: () => string | undefined
  needsAuth: () => boolean
  authState: () => { busy?: boolean; message?: string; retryAfterMs?: number }
  auth: (login: string, password: string) => Promise<void>
  branding: () => Branding
}

function parsePath(): { shareID: string; sub: number | undefined } {
  const parts = location.pathname.split("/").filter(Boolean)
  const i = parts.indexOf("s")
  const id = i >= 0 && parts[i + 1] ? parts[i + 1] : (parts.at(-1) ?? "")
  const sub = i >= 0 && parts[i + 2] && /^\d+$/.test(parts[i + 2]) ? Number(parts[i + 2]) : undefined
  return { shareID: id, sub }
}

let brandingCache: Branding | null = null
async function fetchBranding(): Promise<Branding> {
  if (brandingCache) return brandingCache
  try {
    // no force-cache: a stale /branding can point at assets the new deploy
    // deleted (live-caught — the logo 404'd invisibly for a whole session)
    const r = await fetch("/branding", { cache: "no-store" })
    if (r.ok) brandingCache = (await r.json()) as Branding
  } catch {}
  brandingCache = brandingCache ?? {}
  return brandingCache
}

export function useShareSource(): Source {
  const { shareID, sub } = parsePath()
  const embedded = (window as any).__MIRROBOT_SNAPSHOT__ as
    | { items: { type: string; data?: any; sessionID?: string }[]; sessionID: string }
    | undefined

  const [items, setItems] = createSignal<Map<string, any>>(new Map())
  const [status, setStatus] = createSignal("waiting")
  const [rev, setRev] = createSignal(0)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [needsAuth, setNeedsAuth] = createSignal(false)
  const [authState, setAuthState] = createSignal<{ busy?: boolean; message?: string; retryAfterMs?: number }>({})
  const [brand, setBrand] = createSignal<Branding>({})

  fetchBranding().then(setBrand).catch(() => {})

  const merge = (incoming: any[]) => {
    setItems((prev) => {
      // SMART SYNC: a no-op update (identical poll, empty since-frame,
      // re-delivery of the same item objects) must NOT produce a new Map
      // identity - the whole render chain keys off items() and a fresh
      // identity refolds + rebuilds every visible row (live-caught as
      // "tools close on their own, like on a timer" while the 5s poll
      // fallback ran). Only a real change (new/different item, or a
      // tombstone that actually deletes) creates the next container.
      if (!incoming || incoming.length === 0) return prev
      let changed = false
      const next = new Map(prev)
      for (const it of incoming) {
        const key = it.type === "session" ? `session/${it.data?.id ?? ""}`
          : it.type === "message" ? `message/${it.sessionID ?? it.data?.sessionID ?? ""}/${it.data?.id ?? ""}`
          : it.type === "model" ? `model/${it.sessionID ?? ""}`
          : it.type === "prefs" ? "prefs"
          : it.type === "session_diff" ? `session_diff/${it.sessionID ?? ""}`
          : null
        // tombstones (opencode undo → removed message): same key
        // derivation as the upsert, opposite effect; deleting a key that
        // is already gone is a no-op, not a change
        if (!key) continue
        if (it.del) {
          if (next.delete(key)) changed = true
        } else if (next.get(key) !== it) {
          next.set(key, it)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }

  // FULL-SET replace: /data responses and a WS socket's first frame carry
  // the COMPLETE live item set - they must prune keys the server no
  // longer has. A merge-only consumer keeps items deleted while its
  // socket was down, so an undone turn resurrected on every reconnect
  // until a hard reload (live-caught). Deltas (WS delta frames, poll
  // since-responses) keep using merge() - they carry tombstone markers
  // for what was deleted.
  const replaceFull = (incoming: any[]) => {
    setItems((prev) => {
      const next = new Map<string, any>()
      for (const it of incoming ?? []) {
        const key = it.type === "session" ? `session/${it.data?.id ?? ""}`
          : it.type === "message" ? `message/${it.sessionID ?? it.data?.sessionID ?? ""}/${it.data?.id ?? ""}`
          : it.type === "model" ? `model/${it.sessionID ?? ""}`
          : it.type === "prefs" ? "prefs"
          : it.type === "session_diff" ? `session_diff/${it.sessionID ?? ""}`
          : null
        if (key && !it.del) next.set(key, it)
      }
      if (next.size === prev.size) {
        let same = true
        for (const [k, v] of next) {
          if (prev.get(k) !== v) { same = false; break }
        }
        if (same) return prev
      }
      return next
    })
  }

  if (embedded) {
    merge(embedded.items ?? [])
    setStatus("cached")
    const all = () => Array.from(items().values())
    const sessionID = () => embedded.sessionID
    // memoized fold: data() was a plain function called many times per
    // update (8-10 call sites), each a full O(N) fold of every item —
    // the single largest viewer CPU item during live sessions. The memo
    // computes once per change epoch of its inputs.
    const dataMemo = createMemo(() => fold(all(), sessionID(), shareID, status()))
    return {
      mode: "local",
      shareID,
      sub,
      data: dataMemo,
      ready: () => all().some((i) => i.type === "session"),
      status,
      rev,
      prefs: () => readPrefs(all()),
      error,
      needsAuth,
      authState,
      auth: async () => {},
      branding: brand,
    }
  }
  return liveSource({
    shareID, sub, items, status, rev, error, needsAuth, authState, brand, merge, replaceFull,
    setItems, setStatus, setRev, setError, setNeedsAuth, setAuthState, setBrand,
    all: () => Array.from(items().values()),
    sessionID: () => {
      for (const it of Array.from(items().values())) if (it.type === "session" && !it.data?.parentID) return it.data.id as string
      return shareID
    },
  })
}

function liveSource(ctx: any): Source {
  const { shareID, sub, status, rev, error, needsAuth, authState, brand, merge, replaceFull, setNeedsAuth, setStatus, setRev, setError, setAuthState } = ctx
  let stopped = false
  let ws: WebSocket | undefined
  let pollTimer: any
  let wsRetryTimer: any
  // a socket's FIRST frame is the full item set, the empty since-hit, or
  // (when we announced delta=1) a DELTA — every later frame is a delta.
  // Full frames replace (pruning items deleted while we were away);
  // deltas merge (the merge path deletes on tombstones)
  let firstFrame = true

  const wire = () => {
    if (needsAuth()) return
    firstFrame = true // a fresh socket's first frame arrives per the since handshake below
    try {
      // local http workers (bun server, wrangler dev) speak plain ws://
      const proto = location.protocol === "https:" ? "wss" : "ws"
      // `since`: we already hold /data at rev — the server answers with an
      // empty frame (nothing changed) or a DELTA (only what we missed;
      // delta=1 announces we can merge it — an old cached bundle that
      // can't would prune everything not in the delta). No since (first
      // ever load) or a rewound server gets the full frame.
      const r = typeof rev === "function" ? rev() : 0
      const since = Number.isFinite(r) && r > 0 ? `?since=${r}&delta=1` : ""
      ws = new WebSocket(`${proto}://${location.host}/api/share/${shareID}/ws${since}`)
    } catch {
      startPolling()
      return
    }
    ws.addEventListener("message", (ev) => {
      let frame: any
      try { frame = JSON.parse(ev.data) } catch { return }
      if (frame.op !== "frame") return
      lastFrameAt = Date.now()
      const isFirst = firstFrame
      firstFrame = false
      // a delta first frame (kind:"delta") MERGES — replacing with it
      // would prune every item not in the delta (data-loss trap; the
      // server only sends kind:"delta" to delta=1 clients). Any other
      // non-empty first frame is the full set: replace, so items deleted
      // while we were disconnected get pruned instead of resurrecting
      // until a hard reload.
      if (isFirst && frame.kind !== "delta" && (frame.items ?? []).length > 0) replaceFull(frame.items)
      else merge(frame.items ?? [])
      setRev(frame.rev ?? 0)
      if (frame.status === "gone") {
        setStatus("gone")
        stopped = true
        cleanup()
        return
      }
      setStatus(frame.status ?? "live")
    })
    ws.addEventListener("open", () => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined }
    })
    ws.addEventListener("close", () => {
      if (stopped) return
      startPolling()
      wsRetryTimer = setTimeout(wire, 15000)
    })
  }

  const startPolling = () => {
    if (pollTimer) return
    pollTimer = setInterval(tick, 5000)
  }
  const cleanup = () => {
    if (pollTimer) clearInterval(pollTimer)
    if (wsRetryTimer) clearTimeout(wsRetryTimer)
    try { ws?.close() } catch {}
  }

  async function tick() {
    try {
      // `since`: an unchanged rev answers an empty set — the poll stops
      // re-transferring the whole share every 5s (same handshake as the WS)
      const r = typeof rev === "function" ? rev() : 0
      const since = Number.isFinite(r) && r > 0 ? `?since=${r}` : ""
      const res = await fetch(`/api/share/${shareID}/data${since}`, { cache: "no-store" })
      if (res.status === 401) {
        const body = await res.json().catch(() => ({}))
        if (body.authRequired) {
          setNeedsAuth(true)
          setStatus("login required")
          stopped = true
          cleanup()
        }
        return
      }
      if (res.status === 404) {
        setStatus("gone")
        setError("not found")
        stopped = true
        cleanup()
        return
      }
      const body = await res.json()
      // Two shapes by request: without `since` the answer is the FULL
      // live set — replace, so items deleted while we were disconnected
      // get pruned instead of resurrecting. With `since` and a changed
      // rev the answer is a DELTA (only items touched since, tombstones
      // included) — merge it; the merge path already deletes on
      // tombstones. Same rev = nothing changed: keep the container
      // identity (no refold, no traffic-shaped work)
      const curRev = typeof rev === "function" ? rev() : -1
      if (typeof body.rev === "number" && body.rev === curRev) {
        // unchanged
      } else if (since) {
        merge(body.data ?? [])
      } else {
        replaceFull(body.data ?? [])
      }
      setRev(body.rev ?? 0)
      setStatus(body.status ?? "live")
    } catch (e) {
      // a swallowed flush exception leaves the page half-updated forever
      // (live-caught: status stuck at its initial value while items
      // rendered) - always visible
      console.warn("[openshare] data tick failed:", e)
      // transient; WS or the next tick recovers
    }
  }

  const auth = async (login: string, password: string) => {
    setAuthState({ busy: true })
    try {
      const r = await fetch(`/api/share/${shareID}/auth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login, password }),
      })
      const body = await r.json().catch(() => ({}))
      if (r.ok) {
        setNeedsAuth(false)
        setAuthState({})
        stopped = false
        setStatus("waiting")
        await tick()
        wire()
        return
      }
      setAuthState({
        message: r.status === 429 ? "locked" : "wrong credentials",
        retryAfterMs: body.retryAfterMs,
      })
    } catch {
      setAuthState({ message: "network error" })
    }
  }

  let lastFrameAt = 0
  tick().then(wire)
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || stopped || needsAuth()) return
    // heal on user intent: a socket that is OPEN but silently dead (no
    // close event — sleep/wake, NAT timeout) freezes the page, because
    // polling is stopped while a socket is open. No background watchdog:
    // an always-on timer would bill idle pages (completed shares
    // legitimately never frame again) — the tab coming back to focus is
    // the free signal that it's time to check.
    if (ws?.readyState !== WebSocket.OPEN) {
      tick()
      return
    }
    if (lastFrameAt && Date.now() - lastFrameAt > 60000) {
      // stale open socket: force a poll + fresh wire; the since-handshake
      // makes the poll cheap (empty on unchanged rev)
      tick()
      try { ws.close() } catch {}
      wire()
    }
  })

  const all = ctx.all
  // memoized fold (see the local-source twin): one fold per change epoch
  // instead of one per call site per update
  const dataMemo = createMemo(() => fold(all(), ctx.sessionID(), shareID, status()))
  return {
    mode: "live" as const,
    shareID,
    sub,
    data: dataMemo,
    ready: () => all().some((i: any) => i.type === "session"),
    status,
    rev,
    prefs: () => readPrefs(all()),
    error,
    needsAuth,
    authState,
    auth,
    branding: brand,
  }
}
