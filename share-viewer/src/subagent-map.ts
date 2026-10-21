// Child-session facts the tool rows need but the DataProvider store does not
// carry (it only holds sessions/status/diff/provider). Populated whenever the
// folded share data changes, read by the subagent renderer.
import type { ShareData } from "./fold"

type SubagentInfo = { agent?: string; title?: string }

const infos = new Map<string, SubagentInfo>()

export function setSubagentData(data: ShareData | undefined): void {
  infos.clear()
  if (!data) return
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
