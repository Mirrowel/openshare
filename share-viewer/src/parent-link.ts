// Parent-turn resolution for subagent pages: which turn of the PARENT
// session spawned this child. The plugin stamps `metadata.sessionID` on
// task tool parts (authoritative), so the child page can find the parent's
// task call, walk back to its user message, and return to EXACTLY that
// turn - not the session top. Client-side by construction (pushState +
// popstate), no page reload.
import { visibleMessages, type ShareData } from "./fold"

export type ParentTurn = {
  /** the parent's user message that started the turn */
  userID: string
  /** that prompt's first line (the link label) */
  label: string
  /** the parent session id */
  sessionID: string
}

export function findParentTurn(data: ShareData, childSessionID: string, parentSessionID: string | undefined): ParentTurn | undefined {
  if (!parentSessionID) return undefined
  const msgs = visibleMessages(data, parentSessionID)
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i] as any
    if (m?.type !== "assistant") continue
    for (const c of m.content ?? []) {
      if (c?.type !== "tool") continue
      const meta = c.state?.metadata ?? (c as any).metadata
      if (meta?.sessionID === childSessionID || meta?.sessionId === childSessionID) {
        // walk back to the user message that opened this turn
        for (let j = i; j >= 0; j--) {
          const u = msgs[j] as any
          if (u?.type === "user") {
            return {
              userID: u.id,
              label: typeof u.text === "string" ? u.text.trim().split("\n")[0].slice(0, 60) : "parent turn",
              sessionID: parentSessionID,
            }
          }
        }
      }
    }
  }
  return undefined
}
