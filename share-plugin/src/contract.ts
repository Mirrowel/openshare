// OpenShare transcript contract v2.
//
// A share is a set of keyed items (session / message / session_diff /
// model / prefs) with tombstone deletes. The CONTENT model is the opencode
// v2 session-message shapes, promoted into OUR envelope: other clients
// (pi, anything) can emit these shapes without running opencode, unknown
// message types degrade as notices in the viewer, and the share carries
// `v: 2` so consumers can dispatch on it. v1 hosts normalize at ingestion
// (below); v2 hosts pass messages through verbatim.
//
// Item set (envelope v2):
//   session      data = session info {id, title?, time, parentID?, ...}
//   message      data = v2 session message (see V2Message) — content is
//                embedded; there are no separate part items
//   session_diff data = FileDiffInfo[] (v2 review shapes)
//   model        data = [{id, providerID, name?}]
//   prefs        data = viewer preferences
// Tombstones: {type, del: true, data: {id}} — a message tombstone removes
// the whole message (parts are embedded; no cascade needed).

export const CONTRACT_VERSION = 2

// --- v2 content shapes (loose on purpose: the viewer's vendored v2
// session-ui validates what it renders; we only guarantee field names) ---

export type V2ToolState =
  | { status: "streaming"; input: string }
  | { status: "running"; input: Record<string, unknown>; metadata: Record<string, unknown> }
  | { status: "completed"; input: Record<string, unknown>; content: Array<{ type: "text"; text: string }>; metadata?: Record<string, unknown> }
  | { status: "error"; input: Record<string, unknown>; error: { type: string; message: string }; content?: Array<{ type: "text"; text: string }>; metadata?: Record<string, unknown> }

export type V2Content =
  | { type: "text"; text: string; state?: string }
  | { type: "reasoning"; text: string; state?: string; time?: { created?: number; completed?: number } }
  | { type: "tool"; id: string; name: string; executed?: boolean; state: V2ToolState; time: { created?: number; ran?: number; completed?: number } }

export type V2FileAttachment = { data: string; mime: string; source: { type: "inline" } | { type: "uri"; uri: string }; name?: string }

export interface V2UserMessage {
  id: string
  type: "user"
  time: { created: number }
  text: string
  files?: V2FileAttachment[]
  agents?: Array<{ name: string }>
  metadata?: Record<string, unknown>
}

export interface V2AssistantMessage {
  id: string
  type: "assistant"
  agent: string
  model: { id: string; providerID: string; variant?: string }
  time: { created: number; streamed?: number; completed?: number }
  content: V2Content[]
  cost?: number
  tokens?: Record<string, unknown>
  finish?: string
  error?: { type: string; message: string; status?: number }
  retry?: { attempt: number; at: number; error?: { type: string; message: string } }
}

export interface V2CompactionMessage {
  id: string
  type: "compaction"
  status: "completed"
  reason: "auto" | "manual"
  summary: string
  recent: string
  time: { created: number }
}

export type V2Message = V2UserMessage | V2AssistantMessage | V2CompactionMessage | Record<string, unknown>

// --- v1 → v2 normalization (the ingestion edge for v1 hosts) ---------------

/** True when the object is already a v2 session message (v2 hosts pass
 * messages through verbatim; v1 infos carry `role`). */
export function isV2NativeMessage(x: unknown): boolean {
  if (!x || typeof x !== "object") return false
  const r = x as Record<string, unknown>
  return typeof r.type === "string" && r.type !== "" && r.role === undefined && typeof r.id === "string"
}

const TOOL_NAME_MAP: Record<string, string> = {
  bash: "shell",
  task: "subagent",
}

// v1 read/edit/write carry `filePath`; v2 renderers read `path`
const INPUT_KEY_MAP: Record<string, string> = {
  filePath: "path",
}

function normalizeToolInput(input: Record<string, unknown>, title?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input ?? {})) out[INPUT_KEY_MAP[k] ?? k] = v
  // v1 completed tools carry a human title ("Read src/app.tsx"); v2
  // derives titles from inputs — surface ours through `description`
  if (title && out.description === undefined) out.description = title
  return out
}

function normalizeToolMetadata(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (k === "filediff") out.files = [v]
    else if (k === "sessionId") out.sessionID = v
    else out[k] = v
  }
  return out
}

function toolContent(output: unknown): Array<{ type: "text"; text: string }> {
  const text = typeof output === "string" ? output : ""
  return [{ type: "text", text: text || " " }] // v2 content is NonEmpty
}

function normalizeToolState(state: Record<string, unknown>): V2ToolState {
  const status = String(state?.status ?? "pending")
  if (status === "pending") {
    return { status: "streaming", input: typeof state.raw === "string" ? state.raw : JSON.stringify(state.input ?? {}) }
  }
  if (status === "running") {
    return { status: "running", input: normalizeToolInput((state.input ?? {}) as Record<string, unknown>, state.title as string | undefined), metadata: normalizeToolMetadata(state.metadata as Record<string, unknown> | undefined) }
  }
  if (status === "completed") {
    return { status: "completed", input: normalizeToolInput((state.input ?? {}) as Record<string, unknown>, state.title as string | undefined), content: toolContent(state.output), metadata: normalizeToolMetadata(state.metadata as Record<string, unknown> | undefined) }
  }
  return {
    status: "error",
    input: normalizeToolInput((state.input ?? {}) as Record<string, unknown>),
    error: { type: "unknown", message: typeof state.error === "string" ? state.error : "tool failed" },
    metadata: normalizeToolMetadata(state.metadata as Record<string, unknown> | undefined),
  }
}

function normalizeFilePart(p: Record<string, unknown>): V2FileAttachment | undefined {
  const url = typeof p.url === "string" ? p.url : ""
  if (!url) return undefined
  const inline = url.startsWith("data:")
  const comma = url.indexOf(",")
  return {
    data: inline ? url.slice(comma + 1) : url,
    mime: typeof p.mime === "string" ? p.mime : "application/octet-stream",
    source: inline ? { type: "inline" } : { type: "uri", uri: url },
    ...(typeof p.filename === "string" ? { name: p.filename } : {}),
  }
}

/** v1 message + its parts → v2 message. Returns:
 *  - { message }          — emit as a message item
 *  - { refill, summary }  — v1 compaction summary assistant: do not emit;
 *                           rewrite the parent compaction message instead
 *  - undefined            — nothing to emit (should not happen in practice) */
export function normalizeV1Message(
  info: Record<string, unknown>,
  parts: Array<Record<string, unknown>>,
): { message: V2Message } | { refill: string; summary: string } | undefined {
  if (!info || typeof info.id !== "string") return undefined
  const id = info.id
  const created = ((info.time as Record<string, unknown> | undefined)?.created as number) ?? 0

  if (info.role === "user") {
    // compaction trigger user message → v2 compaction message (summary
    // refilled when the summary assistant arrives)
    const compaction = parts.find((p) => p?.type === "compaction") as Record<string, unknown> | undefined
    if (compaction) {
      const message: V2CompactionMessage = {
        id,
        type: "compaction",
        status: "completed",
        reason: compaction.auto === false ? "manual" : "auto",
        summary: "",
        recent: "",
        time: { created },
      }
      return { message }
    }
    const text = parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n")
    const files = (parts.filter((p) => p?.type === "file") as Array<Record<string, unknown>>)
      .map(normalizeFilePart)
      .filter((f): f is V2FileAttachment => f !== undefined)
    const agents = (parts.filter((p) => p?.type === "agent") as Array<Record<string, unknown>>)
      .map((p) => ({ name: String(p.name ?? "") }))
      .filter((a) => a.name)
    const model = info.model as Record<string, unknown> | undefined
    const message: V2UserMessage = {
      id,
      type: "user",
      time: { created },
      text,
      ...(files.length ? { files } : {}),
      ...(agents.length ? { agents } : {}),
      metadata: {
        ...(info.agent !== undefined ? { agent: String(info.agent) } : {}),
        ...(model ? { model: { id: String(model.modelID ?? ""), providerID: String(model.providerID ?? "") } } : {}),
      },
    }
    return { message }
  }

  if (info.role === "assistant") {
    const time = info.time as Record<string, unknown> | undefined
    // the v1 compaction summary assistant folds INTO the compaction
    // message that precedes it (its parentID)
    if (info.summary === true && info.mode === "compaction") {
      const summary = parts
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n")
      return { refill: String(info.parentID ?? ""), summary }
    }

    const content: V2Content[] = []
    let cost = typeof info.cost === "number" ? info.cost : 0
    let tokens: Record<string, unknown> | undefined
    let retry: V2AssistantMessage["retry"]
    for (const p of parts) {
      switch (p?.type) {
        case "text":
          content.push({ type: "text", text: String(p.text ?? "") })
          break
        case "reasoning": {
          const rt = p.time as Record<string, unknown> | undefined
          content.push({ type: "reasoning", text: String(p.text ?? ""), time: { created: (rt?.start as number) ?? undefined, completed: (rt?.end as number) ?? undefined } })
          break
        }
        case "tool": {
          const st = p.state as Record<string, unknown> | undefined
          const tt = (st?.time ?? {}) as Record<string, unknown>
          content.push({
            type: "tool",
            id: String(p.id ?? ""),
            name: TOOL_NAME_MAP[String(p.tool ?? "unknown")] ?? String(p.tool ?? "unknown"),
            state: normalizeToolState(st ?? {}),
            time: { created: (tt.start as number) ?? undefined, completed: (tt.end as number) ?? undefined },
          })
          break
        }
        case "retry": {
          const err = p.error as Record<string, unknown> | undefined
          retry = {
            attempt: Number(p.attempt ?? 0),
            at: ((p.time as Record<string, unknown> | undefined)?.created as number) ?? 0,
            error: { type: "unknown", message: String(err?.message ?? err?.name ?? "retry") },
          }
          break
        }
        case "step-finish": {
          // fold step aggregates into the message
          if (typeof p.cost === "number") cost += p.cost
          if (p.tokens && typeof p.tokens === "object") tokens = p.tokens as Record<string, unknown>
          break
        }
        // step-start / snapshot / patch / subtask / agent / assistant
        // file parts have no v2 content equivalent — dropped by design
      }
    }
    const finish = typeof info.finish === "string" ? info.finish : undefined
    const errObj = info.error as Record<string, unknown> | undefined
    const message: V2AssistantMessage = {
      id,
      type: "assistant",
      agent: String(info.agent ?? "build"),
      model: { id: String(info.modelID ?? ""), providerID: String(info.providerID ?? "") },
      time: { created, streamed: (time?.started as number) ?? undefined, completed: (time?.completed as number) ?? undefined },
      content,
      cost,
      ...(tokens ? { tokens } : {}),
      ...(finish ? { finish } : {}),
      ...(errObj ? { error: { type: String(errObj.name ?? "UnknownError"), message: String(errObj.message ?? "turn failed") } } : {}),
      ...(retry ? { retry } : {}),
    }
    return { message }
  }
  return undefined
}

/** v1 session diff (FileDiff.Info[]) → v2 FileDiffInfo[]: the v2 shape
 * REQUIRES numeric additions/deletions (renderers read them unguarded) —
 * compute from the patch when the host didn't provide counts. */
export function normalizeV1Diff(diff: unknown): unknown {
  if (!Array.isArray(diff)) return diff
  return diff.map((d) => {
    if (!d || typeof d !== "object") return d
    const r = d as Record<string, unknown>
    if (typeof r.additions === "number" && typeof r.deletions === "number") return r
    const patch = typeof r.patch === "string" ? r.patch : ""
    let additions = 0
    let deletions = 0
    for (const line of patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++
    }
    return { ...r, additions: typeof r.additions === "number" ? r.additions : additions, deletions: typeof r.deletions === "number" ? r.deletions : deletions }
  })
}

/** v1 hosts paginate messages with an opaque cursor: base64url of
 * {id, time} where time = the page tail's time_created (message-v2.ts
 * cursor codec). A bare message id is rejected with 400 — that silently
 * truncated every v1 backfill to one page (live-caught). */
export function cursorFor(id: string, time: number): string {
  return Buffer.from(JSON.stringify({ id, time })).toString("base64url")
}
