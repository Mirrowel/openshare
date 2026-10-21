// vendor shim: re-export the generated client types + the single
// runtime helper session-ui imports (isShellNotFoundError).
export * from "./generated/types.js"
export const isShellNotFoundError = (e: unknown): e is { _tag: "ShellNotFoundError" } =>
  typeof e === "object" && e !== null && (e as { _tag?: unknown })._tag === "ShellNotFoundError"
