/**
 * Partial share (Wave 3): a scope fixed at create. The engine applies it
 * at enqueue (the single choke point: backfill and live events both flow
 * through it), so nothing excluded ever leaves the machine.
 *
 * Semantics:
 * - fromTurn: share turns N.. (a turn = a user message plus everything
 *   until the next user message; ranks follow stream order, which is
 *   chronological for backfill pages and for live events).
 * - reasoning/tools: drop those content entries from messages; an
 *   assistant message left with no content is dropped entirely.
 * - subagents: drop every item whose sessionID is not the root session
 *   (the engine also skips backfilling children).
 * - fileContents: strip file BODIES and diffs (read/write/edit/patch
 *   tool output + edit metadata patches + the session_diff item) while
 *   keeping the call itself (name, input, status) visible.
 */

export type ShareScope = {
  fromTurn?: number
  reasoning?: boolean
  tools?: boolean
  subagents?: boolean
  fileContents?: boolean
}

/** Per-session bookkeeping for turn ranking (message id -> turn). */
export type ScopeState = { turn: number; rank: Map<string, number> }

export function newScopeState(): ScopeState {
  return { turn: 0, rank: new Map() }
}

const FILE_TOOLS = new Set(["read", "write", "edit", "patch", "multiedit"])

/** True when the scope excludes everything from non-root sessions. */
export function scopeSkipsChildren(scope: ShareScope | undefined): boolean {
  return scope?.subagents === false
}

/**
 * Apply the scope to one contract item. Returns null to drop it, or the
 * (possibly cloned and trimmed) item to keep. The input is never mutated
 * when dropped or unchanged.
 */
export function scopeItem(
  item: { type?: string; sessionID?: string; data?: unknown } | undefined,
  scope: ShareScope | undefined,
  state: ScopeState,
  mainSid: string,
): typeof item | null {
  if (!item) return item
  if (!scope) return item
  if (scope.subagents === false && item.sessionID && item.sessionID !== mainSid) return null
  if (item.type === "session_diff") return scope.fileContents === false ? null : item
  if (item.type !== "message") return item
  const data = item.data as Record<string, unknown> | undefined
  if (!data || typeof data !== "object") return item
  const id = typeof data.id === "string" ? data.id : ""
  const role = (data.role ?? data.type) as string | undefined
  if (role === "user" && id && !state.rank.has(id)) {
    state.turn += 1
    state.rank.set(id, state.turn)
  }
  const turn = id && state.rank.has(id) ? (state.rank.get(id) as number) : Math.max(1, state.turn)
  if (scope.fromTurn && scope.fromTurn > 1 && turn < scope.fromTurn) return null
  // category filters
  if (scope.reasoning === false || scope.tools === false || scope.fileContents === false) {
    const content = data.content
    if (Array.isArray(content)) {
      let touched = false
      const out: unknown[] = []
      for (const entry of content) {
        const c = entry as Record<string, unknown> | null
        const ctype = c?.type
        if (ctype === "reasoning" && scope.reasoning === false) {
          touched = true
          continue
        }
        if (ctype === "tool" && scope.tools === false) {
          touched = true
          continue
        }
        if (ctype === "tool" && scope.fileContents === false) {
          const name = String(c?.name ?? "")
          if (FILE_TOOLS.has(name)) {
            const clone = { ...(c as Record<string, unknown>) }
            const st = clone.state && typeof clone.state === "object" ? { ...(clone.state as Record<string, unknown>) } : null
            if (st && "output" in st) {
              delete st.output
              clone.state = st
              touched = true
            }
            const meta = clone.metadata && typeof clone.metadata === "object" ? { ...(clone.metadata as Record<string, unknown>) } : null
            if (meta) {
              let metaTouched = false
              for (const k of ["diff", "files", "filediff", "patch"]) {
                if (k in meta) {
                  delete meta[k]
                  metaTouched = true
                }
              }
              if (metaTouched) {
                clone.metadata = meta
                touched = true
              }
            }
            out.push(clone)
            continue
          }
        }
        out.push(entry)
      }
      if (touched) {
        // an assistant left with nothing to render is dropped; a user
        // message keeps its (possibly emptied) shell only when it had
        // text - user text is never a filtered category, so an empty
        // user content means the source was empty
        if (out.length === 0 && role !== "user") return null
        return { ...item, data: { ...data, content: out } }
      }
    }
  }
  return item
}
