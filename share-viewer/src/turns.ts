// Turn grouping: consecutive user messages with nothing between them are ONE
// turn (parallel prompts fired in a single run). The leader is the first
// prompt. Display stays per-message (every prompt renders its own bubble);
// only counting surfaces (nav lists, pill, focus mode, search jump lists)
// count groups, so a 3-prompt burst reads as turn 6, not turns 6-8.

export type TurnGroup = {
  /** the first prompt of the burst; the group's identity for nav/active */
  leader: any
  /** every consecutive user message in the burst (leader first, >= 1) */
  prompts: any[]
  /** index of the leader inside the message list */
  startIdx: number
  /** exclusive end: the next group's startIdx, or messages.length */
  endIdx: number
}

export function buildTurns(messages: any[]): TurnGroup[] {
  const groups: TurnGroup[] = []
  let i = 0
  while (i < messages.length) {
    if (messages[i]?.type !== "user") {
      i++
      continue
    }
    const prompts = [messages[i]]
    let j = i + 1
    while (j < messages.length && messages[j]?.type === "user") {
      prompts.push(messages[j])
      j++
    }
    groups.push({ leader: messages[i], prompts, startIdx: i, endIdx: messages.length })
    i = j
  }
  for (let k = groups.length - 1; k > 0; k--) groups[k - 1].endIdx = groups[k].startIdx
  return groups
}

/** the leader of whichever group contains this prompt id (non-leader
 *  prompts of a burst resolve to their leader; unknown ids to undefined) */
export function leaderOf(groups: TurnGroup[], id: string | undefined): any | undefined {
  if (!id) return undefined
  for (const g of groups) {
    if (g.leader.id === id) return g.leader
    if (g.prompts.some((p) => p.id === id)) return g.leader
  }
  return undefined
}

/** the group whose leader has this id */
export function groupOfLeader(groups: TurnGroup[], id: string | undefined): TurnGroup | undefined {
  if (!id) return undefined
  return groups.find((g) => g.leader.id === id)
}
