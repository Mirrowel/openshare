import { visibleMessages, type ShareData } from "./fold"

export function sessionModelLabel(data: ShareData, sessionID: string): string {
  const items = data.model[sessionID]
  if (items?.length) {
    const model = items[items.length - 1]
    if (model.name) return model.name
    if (model.providerID && model.id) return `${model.providerID}/${model.id}`
  }
  const model = data.session.find((s) => s.id === sessionID)?.model as any
  if (model?.providerID && model?.modelID) return `${model.providerID}/${model.modelID}`
  return ""
}

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
  const usage: SessionUsage = {
    prompts: 0, toolCalls: 0, reasoningBlocks: 0, responses: 0,
    tokensIn: 0, tokensOut: 0, tokensReasoning: 0, cacheRead: 0, cacheWrite: 0,
    tokensTotal: 0, cost: 0,
  }
  let first = Infinity
  let last = 0
  for (const session of data.session) {
    if (session.id !== sessionID) continue
    if (session.time?.created) first = Math.min(first, session.time.created)
    if (session.time?.updated) last = Math.max(last, session.time.updated)
  }
  for (const message of visibleMessages(data, sessionID)) {
    if (message.time?.created) {
      first = Math.min(first, message.time.created)
      last = Math.max(last, message.time.created)
    }
    if (message.time?.completed) last = Math.max(last, message.time.completed)
    if (message.type === "user") usage.prompts++
    if (message.type !== "assistant") continue
    usage.responses++
    const tokens = message.tokens
    if (tokens) {
      usage.tokensIn += tokens.input ?? 0
      usage.tokensOut += tokens.output ?? 0
      usage.tokensReasoning += tokens.reasoning ?? 0
      usage.cacheRead += tokens.cache?.read ?? 0
      usage.cacheWrite += tokens.cache?.write ?? 0
      usage.tokensTotal += tokens.total ?? 0
    }
    usage.cost += Number(message.cost ?? 0)
    for (const content of message.content ?? []) {
      if (content.type === "tool") usage.toolCalls++
      if (content.type === "reasoning") usage.reasoningBlocks++
    }
  }
  if (first !== Infinity) {
    usage.firstAt = first
    usage.lastAt = last || first
  }
  return usage
}
