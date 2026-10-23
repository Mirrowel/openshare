// Fold: contract-v2 share items → the viewer's data model.
//
// Items arrive from the data source (live worker or embedded snapshot):
//   session      {id, title?, time, parentID?, ...}
//   message      sessionID-stamped envelope around a v2 session message
//                (user / assistant / compaction / notices — content
//                embedded; the OpenShare transcript contract)
//   session_diff FileDiffInfo[]
//   model        [{id, providerID, name?}] per session
//   prefs        viewer preferences
import type { SessionStatus } from "@opencode/client/promise"

export type V2Message = Record<string, any>

export type SessionLite = {
  id: string
  parentID?: string
  title?: string
  time?: { created?: number; updated?: number }
  directory?: string
  revert?: { messageID?: string }
  [k: string]: unknown
}

export type FileDiffInfo = Record<string, any>

/** v2 renderers read additions/deletions unguarded — guarantee the counts
 * (compute from the patch when absent) so no share can crash the page.
 * Cached per source object: an unchanged session_diff item yields the
 * SAME normalized array across folds, so downstream memos skip work
 * (smart-sync: only what changed re-renders). */
const diffCache = new WeakMap<object, any>()
function normalizeDiff(d: any) {
  if (!d || typeof d !== "object") return d
  if (typeof d.additions === "number" && typeof d.deletions === "number") return d
  const hit = diffCache.get(d)
  if (hit) return hit
  const patch = typeof d.patch === "string" ? d.patch : ""
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++
  }
  const out = { ...d, additions: typeof d.additions === "number" ? d.additions : additions, deletions: typeof d.deletions === "number" ? d.deletions : deletions }
  diffCache.set(d, out)
  return out
}

export type ProviderCatalog = {
  all: Map<string, { models: Record<string, { name: string }> }>
  default: Record<string, string>
  connected: string[]
}

export type ShareData = {
  shareID: string
  sessionID: string
  session: SessionLite[]
  message: { [sessionID: string]: V2Message[] }
  session_diff: { [sessionID: string]: FileDiffInfo[] }
  model: { [sessionID: string]: Array<{ id: string; providerID: string; name?: string }> }
  provider: ProviderCatalog
  status: string
}

export type SubSession = {
  index: number
  sessionID: string
  session: SessionLite
}

export function fold(items: { type: string; data?: any; sessionID?: string }[], sessionID: string, shareID: string, status = "live"): ShareData {
  const result: ShareData = {
    shareID,
    sessionID,
    session: [],
    message: {},
    session_diff: {},
    model: {},
    provider: { all: new Map(), default: {}, connected: [] },
    status,
  }
  for (const item of items) {
    switch (item.type) {
      case "session":
        result.session.push(item.data)
        break
      case "session_diff":
        result.session_diff[item.sessionID ?? sessionID] = Array.isArray(item.data) ? item.data.map(normalizeDiff) : []
        break
      case "message": {
        const sid = item.sessionID ?? (item.data?.sessionID as string | undefined) ?? sessionID
        ;(result.message[sid] ??= []).push(item.data)
        break
      }
      case "model": {
        const sid = item.sessionID ?? sessionID
        const list = Array.isArray(item.data) ? item.data : []
        result.model[sid] = list
        for (const m of list) {
          if (!m?.id || !m?.providerID) continue
          const entry = result.provider.all.get(m.providerID) ?? { models: {} }
          entry.models[m.id] = { name: typeof m.name === "string" && m.name ? m.name : m.id }
          result.provider.all.set(m.providerID, entry)
        }
        break
      }
    }

  // The kit's message renderer reads `message.model.providerID` unguarded;
  // a producer that omits the model must degrade to an empty label, never
  // crash the whole transcript.
  for (const list of Object.values(result.message)) {
    for (const m of list as Array<Record<string, unknown>>) {
      if (m?.type === "assistant" && !m.model) m.model = { id: "", providerID: "" }
    }
  }
  }
  return result
}

/** Share status → the v2 session status union: a live share may still
 * grow (busy shows the progress affordances); settled shares idle. */
export function sessionStatus(shareStatus: string): SessionStatus {
  return shareStatus === "live" ? { type: "busy" } : { type: "idle" }
}

export function readPrefs(items: { type: string; data?: any }[]): { openTasksInNewTab?: boolean } {
  for (const item of items) {
    if (item.type === "prefs" && item.data && typeof item.data === "object") return item.data
  }
  return {}
}

/** Messages of one session in timeline order, with opencode's undo
 * semantics applied (session.revert hides everything from the marker on;
 * the hard delete + tombstones follow on the next prompt). */
export function visibleMessages(data: ShareData, sessionID: string): V2Message[] {
  const msgs = [...(data.message[sessionID] ?? [])].sort((a, b) => (a?.time?.created ?? 0) - (b?.time?.created ?? 0))
  const info = data.session.find((s) => s.id === sessionID)
  const rev = info?.revert
  if (!rev?.messageID) return msgs
  const idx = msgs.findIndex((m) => m?.id === rev.messageID)
  return idx < 0 ? msgs : msgs.slice(0, idx)
}

/** Subagent sessions bound to the main session, in task-appearance order
 * (subagent tool content carries metadata.sessionID). */
export function children(data: ShareData): SubSession[] {
  const byId = new Map<string, SessionLite>()
  for (const s of data.session) if (s.id) byId.set(s.id, s)
  const order: string[] = []
  const seen = new Set<string>()
  for (const m of data.message[data.sessionID] ?? []) {
    for (const c of m?.content ?? []) {
      if (c?.type !== "tool") continue
      const child = c?.state?.metadata?.sessionID ?? c?.state?.metadata?.sessionId ?? c?.metadata?.sessionID
      if (typeof child === "string" && byId.has(child) && byId.get(child)!.parentID === data.sessionID && !seen.has(child)) {
        seen.add(child)
        order.push(child)
      }
    }
  }
  for (const s of byId.values()) {
    if (s.parentID === data.sessionID && !seen.has(s.id)) {
      seen.add(s.id)
      order.push(s.id)
    }
  }
  return order.map((sid, i) => ({ index: i + 1, sessionID: sid, session: byId.get(sid)! }))
}
