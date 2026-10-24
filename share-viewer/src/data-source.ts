// Data source. Two modes, identical downstream:
//   live    — served by the share worker at /s/<id>[/<sub>]: one GET /data,
//             then a hibernating WebSocket; every plugin sync pushes
//             {op:"frame", status, rev, items}; items merge client-side by
//             key and the fold re-runs. Polling (5s) only if WS fails.
//             Auth-gated shares: 401 {authRequired} -> login flow, then
//             everything resumes exactly as before.
//   local   — served by the decrypt tool's localhost server at /s/<id>:
//             window.__MIRROBOT_SNAPSHOT__ carries {items, sessionID} inline.
import { createSignal } from "solid-js"
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

  if (embedded) {
    merge(embedded.items ?? [])
    setStatus("cached")
    const all = () => Array.from(items().values())
    const sessionID = () => embedded.sessionID
    return {
      mode: "local",
      shareID,
      sub,
      data: () => fold(all(), sessionID(), shareID, status()),
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
    shareID, sub, items, status, rev, error, needsAuth, authState, brand, merge,
    setItems, setStatus, setRev, setError, setNeedsAuth, setAuthState, setBrand,
    all: () => Array.from(items().values()),
    sessionID: () => {
      for (const it of Array.from(items().values())) if (it.type === "session" && !it.data?.parentID) return it.data.id as string
      return shareID
    },
  })
}

function liveSource(ctx: any): Source {
  const { shareID, sub, status, rev, error, needsAuth, authState, brand, merge, setNeedsAuth, setStatus, setRev, setError, setAuthState } = ctx
  let stopped = false
  let ws: WebSocket | undefined
  let pollTimer: any
  let wsRetryTimer: any

  const wire = () => {
    if (needsAuth()) return
    try {
      // local http workers (bun server, wrangler dev) speak plain ws://
      const proto = location.protocol === "https:" ? "wss" : "ws"
      // `since`: we already hold /data at rev — the worker answers with an
      // empty frame when nothing changed instead of the full first frame
      const r = typeof rev === "function" ? rev() : 0
      const since = Number.isFinite(r) && r > 0 ? `?since=${r}` : ""
      ws = new WebSocket(`${proto}://${location.host}/api/share/${shareID}/ws${since}`)
    } catch {
      startPolling()
      return
    }
    ws.addEventListener("message", (ev) => {
      let frame: any
      try { frame = JSON.parse(ev.data) } catch { return }
      if (frame.op !== "frame") return
      merge(frame.items ?? [])
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
      const r = await fetch(`/api/share/${shareID}/data`, { cache: "no-store" })
      if (r.status === 401) {
        const body = await r.json().catch(() => ({}))
        if (body.authRequired) {
          setNeedsAuth(true)
          setStatus("login required")
          stopped = true
          cleanup()
        }
        return
      }
      if (r.status === 404) {
        setStatus("gone")
        setError("not found")
        stopped = true
        cleanup()
        return
      }
      const body = await r.json()
      merge(body.data ?? [])
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

  tick().then(wire)
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !stopped && !needsAuth() && ws?.readyState !== WebSocket.OPEN) tick()
  })

  const all = ctx.all
  return {
    mode: "live" as const,
    shareID,
    sub,
    data: () => fold(all(), ctx.sessionID(), shareID, status()),
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
