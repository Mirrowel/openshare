// vendor shim: re-export the generated client types + the single
// runtime helper session-ui imports (isShellNotFoundError).
export * from "./generated/types.js"
// the beta re-exports Attachment/MediaFileAttachment from @opencode/schema/prompt
export type PromptMention = { start: number; end: number; text: string }
export type PromptFileSource = { type: "inline" } | { type: "uri"; uri: string }
export type PromptBase64 = string
export type PromptFileAttachment = { data: PromptBase64; mime: string; source: PromptFileSource; name?: string; description?: string; mention?: PromptMention }
export type PromptMediaFileAttachment = { mime: string; source: PromptFileSource; name?: string; description?: string; mention?: PromptMention; uri: string; bytes?: number; width?: number; height?: number }
export type PromptAttachment = PromptFileAttachment | PromptMediaFileAttachment
export type PromptAgentAttachment = { name: string; mention?: PromptMention }
export type PromptSkillAttachment = { id: string; name: string; text?: string; mention?: PromptMention }
export const isShellNotFoundError = (e: unknown): e is { _tag: "ShellNotFoundError" } =>
  typeof e === "object" && e !== null && (e as { _tag?: unknown })._tag === "ShellNotFoundError"
