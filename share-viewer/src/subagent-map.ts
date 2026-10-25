// Child-session facts the tool rows need but the DataProvider store does not
// carry (it only holds sessions/status/diff/provider). Populated whenever the
// folded share data changes, read by the subagent renderer.
//
// The agent label is AUTHORITATIVE plugin data: the plugin stamps
// metadata.agent on every task tool call (rank-joined to the child's
// prompts). This module REWRITES part.input.agent from that stamp at fold
// time - the kit's task rows then read one field, upstream's own code path,
// with no side registry (the old call-id registry was deleted with its
// vendor patches). The segment fallback below covers OLD shares that
// predate the stamp - computed once per fold, never at render time.
import type { ShareData } from "./fold"

type SubagentInfo = { agent?: string; title?: string }

const infos = new Map<string, SubagentInfo>()

const isTaskTool = (name: unknown) => name === "task" || name === "subagent"

/** write the resolved agent onto the task call's state.input - the single
 * field the kit's task renderers read (single rows via upstream's own
 * taskAgent(props.input.agent); grouped rows via our one vendor patch).
 * currentToolInput() sources props.input from tool.state.input. */
function writeAgent(part: unknown, agent: string): void {
  if (!part || typeof part !== "object") return
  const p = part as { state?: { input?: Record<string, unknown> } }
  const state = (p.state ??= {}) as { input?: Record<string, unknown> }
  if (!state.input || typeof state.input !== "object") state.input = {}
  state.input.agent = agent
}

/** OLD-SHARE FALLBACK ONLY: k-th call to a child -> k-th segment's agent.
 * Segment agent: the segment prompt's own agent (v1 hosts stamp it on user
 * messages), else that segment's first assistant response (v2 hosts). */
function fallbackAgentsForCalls(
  calls: Array<{ id: string; child: string; created: number; part: unknown }>,
  data: ShareData,
): void {
  const byChild = new Map<string, Array<{ id: string; created: number; part: unknown }>>()
  for (const call of calls) {
    const list = byChild.get(call.child)
    if (list) list.push({ id: call.id, created: call.created, part: call.part })
    else byChild.set(call.child, [{ id: call.id, created: call.created, part: call.part }])
  }
  for (const [child, list] of byChild) {
    list.sort((a, b) => a.created - b.created)
    const messages = ((data.message[child] ?? []) as any[]).slice().sort((a, b) => {
      const ta = Number(a?.time?.created ?? 0)
      const tb = Number(b?.time?.created ?? 0)
      return ta - tb
    })
    const users = messages.filter((m) => m?.type === "user")
    let prevAgent: string | undefined
    list.forEach((call, k) => {
      const user = users[k]
      if (!user) {
        if (prevAgent) writeAgent(call.part, prevAgent)
        return
      }
      const created = Number(user.time?.created ?? 0)
      let agent: string | undefined = typeof user.metadata?.agent === "string" ? user.metadata.agent : undefined
      if (!agent) {
        for (const m of messages) {
          const t = Number(m?.time?.created ?? 0)
          if (m?.type === "assistant" && typeof m.agent === "string" && t >= created) {
            agent = m.agent
            break
          }
          if (m?.type === "user" && t > created) break
        }
      }
      if (agent) {
        writeAgent(call.part, agent)
        prevAgent = agent
      } else if (prevAgent) {
        writeAgent(call.part, prevAgent)
      }
    })
  }
}

export function setSubagentData(data: ShareData | undefined): void {
  infos.clear()
  if (!data) return

  // 1. authoritative stamps: metadata.agent on task tool calls
  // 2. collect unstamped calls for the old-share fallback
  const unstamped: Array<{ id: string; child: string; created: number; part: unknown }> = []
  for (const messages of Object.values(data.message)) {
    for (const message of messages as any[]) {
      if (message?.type !== "assistant" || !Array.isArray(message.content)) continue
      for (const part of message.content) {
        if (!part || part.type !== "tool" || !isTaskTool(part.name)) continue
        const id = typeof part.id === "string" ? part.id : undefined
        const child = typeof part.state?.metadata?.sessionID === "string" ? part.state.metadata.sessionID : undefined
        if (!id) continue
        const stamped = typeof part.state?.metadata?.agent === "string" ? part.state.metadata.agent : undefined
        if (stamped && child) writeAgent(part, stamped)
        else if (child) unstamped.push({ id, child, created: Number(part.time?.created ?? 0), part })
      }
    }
  }
  if (unstamped.length) fallbackAgentsForCalls(unstamped, data)

  for (const session of data.session) {
    if (!session.parentID) continue
    const messages = (data.message[session.id] ?? []) as any[]
    let agent: string | undefined
    for (const message of messages) {
      const value = message?.agent ?? message?.metadata?.agent
      if (typeof value === "string" && value) {
        agent = value
        break
      }
    }
    infos.set(session.id, { agent, title: session.title })
  }
}

export function subagentInfo(sessionID: string | undefined): SubagentInfo | undefined {
  return sessionID ? infos.get(sessionID) : undefined
}
