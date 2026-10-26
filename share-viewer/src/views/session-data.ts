// Shared session-data model for views. Turns the folded v2 messages into
// prompt-anchored sections so every view starts from the same shape:
// sections[i] = one user prompt + the assistant content that answered it.
import { createMemo, type Accessor } from "solid-js"
import type { ShareData } from "../fold"
import { visibleMessages } from "../fold"

export type AnyPart = { type: string; text?: string; name?: string; state?: any; [k: string]: any }

export type ToolEntry = {
  kind: "tool"
  tool: string
  title: string
  output?: string
  input?: Record<string, unknown>
  // the v2 content block (type:"tool") — carries name/state/time
  part: AnyPart
  state?: any
  status?: string
  // the vendored per-tool rule (edit/write/patch open naturally unless
  // deletion-only); the toolOutput toggle adds the rest on top
  defaultOpen?: boolean
}

export type ReasoningEntry = { kind: "reasoning"; text: string; part: AnyPart; /** host message + per-message ordinal: the kit's synthesized part id is `${messageID}:reasoning:${ordinal}` */ messageID?: string; ordinal?: number }

// a completion text block, positioned in the sequence where it occurred
export type TextEntry = { kind: "text"; text: string; part: AnyPart }

export type SessionSection = {
  id: string
  index: number
  prompt: string
  model?: { providerID?: string; id?: string }
  tools: ToolEntry[]
  reasoning: ReasoningEntry[]
  response: string
  // tools + reasoning in the order they actually occurred (the typed
  // arrays above are for views that group by kind; this one preserves
  // the interleaved sequence)
  ordered: (ToolEntry | ReasoningEntry | TextEntry)[]
  // per-prompt presentation facts (mode/model/time), classic-style
  mode?: string
  at?: number
}

export function useSessionSections(data: ShareData, sessionID: string): Accessor<SessionSection[]> {
  return createMemo(() => {
    const msgs = visibleMessages(data, sessionID)
    const out: SessionSection[] = []
    let current: SessionSection | undefined
    for (const m of msgs as any[]) {
      if (m?.type === "user") {
        current = {
          id: m.id,
          index: out.length,
          prompt: typeof m.text === "string" ? m.text.trim() : "",
          model: m.metadata?.model,
          tools: [],
          reasoning: [],
          response: "",
          ordered: [],
          mode: capitalize(m.metadata?.agent),
          at: m.time?.created,
        }
        out.push(current)
        continue
      }
      if (m?.type === "compaction") {
        // a compaction boundary inside the timeline: surface it as its own
        // mini-section so views can mark it
        if (!current) continue
        current.ordered.push({ kind: "text", text: `— session compacted —\n\n${m.summary ?? ""}`, part: m })
        continue
      }
      if (m?.type !== "assistant" || !current) continue
      // per-message ordinals for text/reasoning: the kit's projection
      // synthesizes part ids as `${message.id}:${type}:${ordinal}` for
      // non-tool content (projection.ts contentEntries) - the search
      // engine targets rows by that scheme
      const ordinals = { text: 0, reasoning: 0 }
      for (const c of m.content ?? []) {
        if (c?.type === "text") {
          const ordinal = ordinals.text++
          current.response += (current.response ? "\n\n" : "") + (c.text ?? "")
          current.ordered.push({ kind: "text", text: c.text ?? "", part: c })
        } else if (c?.type === "tool") {
          // the subagent tool's output is the child's final response -
          // redundant in the share, never shown (even with the toggle on)
          const isTask = (c.name ?? "") === "subagent"
          const state = c.state ?? {}
          const entry: ToolEntry = {
            kind: "tool",
            tool: c.name ?? "tool",
            title: String(state.input?.description ?? state.title ?? c.name ?? "tool"),
            output: isTask ? undefined : toolOutputText(state),
            input: normalizeInput(state.input),
            part: c,
            state,
            status: state.status,
          }
          entry.defaultOpen = isTask ? false : toolDefaultOpen(entry)
          current.tools.push(entry)
          current.ordered.push(entry)
        } else if (c?.type === "reasoning") {
          const ordinal = ordinals.reasoning++
          const entry: ReasoningEntry = { kind: "reasoning", text: c.text ?? "", part: c, messageID: m.id, ordinal }
          current.reasoning.push(entry)
          current.ordered.push(entry)
        }
      }
    }
    return out
  })
}

function normalizeInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>
  return {}
}

export function toolOutputText(state: any): string | undefined {
  // our v1 normalization emits content[]; v2 hosts may emit output
  for (const key of ["content", "output"]) {
    const out = state?.[key]
    if (out == null) continue
    if (typeof out === "string") return out.trim() || undefined
    if (Array.isArray(out)) {
      const text = out.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("").trim()
      if (text) return text
      continue
    }
    try {
      return JSON.stringify(out, null, 2)
    } catch {
      return String(out)
    }
  }
  return undefined
}

// The invocation label the classic view shows: "Called `tool` <query part>"
export function toolCallLabel(entry: ToolEntry): string {
  return toolInvocation(entry) || entry.tool
}

// What the agent actually asked the tool to do. Known argument keys
// first, then the first string value.
export function toolInvocation(entry: ToolEntry): string {
  const input = entry.input
  if (input && typeof input === "object") {
    for (const key of ["query", "command", "description", "prompt", "pattern", "q", "search", "path", "file", "url", "content"]) {
      const v = input[key]
      if (typeof v === "string" && v.trim()) return clip(v.trim())
    }
    for (const v of Object.values(input)) {
      if (typeof v === "string" && v.trim()) return clip(v.trim())
    }
  }
  return ""
}

// The per-tool default-open rule: the edit/write/patch family opens
// naturally unless the change is deletion-only; shell follows a flag;
// everything else stays collapsed until clicked.
const EDIT_FAMILY = new Set(["edit", "write", "patch", "apply_patch"])
function deletionOnly(meta: any): boolean {
  const files = meta?.files
  if (Array.isArray(files) && files.length > 0) {
    return files.every((f: any) => !!f && typeof f === "object" && "type" in f && f.type === "delete")
  }
  return false
}

export function toolDefaultOpen(entry: ToolEntry, shell = false, edit = true): boolean {
  if (entry.tool === "bash" || entry.tool === "shell") return shell
  if (EDIT_FAMILY.has(entry.tool)) {
    if (!edit) return false
    return !deletionOnly(entry.state?.metadata)
  }
  return false
}

function clip(s: string, n = 140): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}

function capitalize(s?: string): string | undefined {
  if (!s) return undefined
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// The model string for a session: the plugin syncs model items whose
// `name` carries the configured label; fall back to the session info's
// model object, then to the first message that carries one.
export function sessionModelLabel(data: ShareData, sessionID: string): string {
  const items = (data.model as any)?.[sessionID]
  if (Array.isArray(items) && items.length) {
    const it = items[items.length - 1]
    if (typeof it?.name === "string" && it.name) return it.name
    if (it?.providerID && it?.id) return `${it.providerID}/${it.id}`
  }
  const info = data.session.find((s: any) => s.id === sessionID) as any
  const m = info?.model
  if (m?.providerID && m?.modelID) return `${m.providerID}/${m.modelID}`
  return ""
}

/** every tool name this session used (the auto-expand picker appends
 *  them to the known vocabulary: mcp, ctx_*, custom tools) */
export function sessionToolNamesOf(data: ShareData, sessionID: string): string[] {
  const out = new Set<string>()
  for (const m of (data.message as any)?.[sessionID] ?? []) {
    for (const c of m?.content ?? []) {
      if (c?.type === "tool" && typeof c.name === "string") out.add(c.name)
    }
  }
  return [...out]
}

// Aggregate facts for the info panel: tokens, cost, counts, timing.
export type SessionUsage = {
  prompts: number
  toolCalls: number
  reasoningBlocks: number
  responses: number
  tokensIn: number
  tokensOut: number
  tokensReasoning: number
  cacheRead: number
  cacheWrite: number
  tokensTotal: number
  cost: number
  firstAt?: number
  lastAt?: number
}

export function sessionUsage(data: ShareData, sessionID: string): SessionUsage {
  const u: SessionUsage = {
    prompts: 0, toolCalls: 0, reasoningBlocks: 0, responses: 0,
    tokensIn: 0, tokensOut: 0, tokensReasoning: 0, cacheRead: 0, cacheWrite: 0,
    tokensTotal: 0, cost: 0,
  }
  let first = Infinity
  let last = 0
  for (const s of data.session as any[]) {
    if (s?.parentID || s?.id !== sessionID) continue
    if (s?.time?.created) first = Math.min(first, s.time.created)
    if (s?.time?.completed || s?.time?.updated) last = Math.max(last, s.time.completed ?? s.time.updated ?? 0)
  }
  for (const m of visibleMessages(data, sessionID) as any[]) {
    if (m.time?.created) {
      first = Math.min(first, m.time.created)
      last = Math.max(last, m.time.created)
    }
    if (m.time?.completed) last = Math.max(last, m.time.completed)
    if (m?.type === "user") u.prompts++
    if (m?.type === "assistant") {
      u.responses++
      const t = m.tokens
      if (t) {
        u.tokensIn += t.input ?? 0
        u.tokensOut += t.output ?? 0
        u.tokensReasoning += t.reasoning ?? 0
        u.cacheRead += t.cache?.read ?? 0
        u.cacheWrite += t.cache?.write ?? 0
        u.tokensTotal += t.total ?? 0
      }
      u.cost += Number(m.cost ?? 0)
      for (const c of m.content ?? []) {
        if (c?.type === "tool") u.toolCalls++
        if (c?.type === "reasoning") u.reasoningBlocks++
      }
    }
  }
  if (first !== Infinity) {
    u.firstAt = first
    u.lastAt = last || first
  }
  return u
}
