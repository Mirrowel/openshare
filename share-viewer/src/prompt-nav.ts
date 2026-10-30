// Prompt navigation: ONE keyboard path for next/previous prompt.
//
// j/k and [ ] are aliases of the same action. Two independent listeners had
// diverged: [ ] lived in the rail (paged: switch page; continuous: instant
// virtualizer jump) while j/k lived at App level (smooth scrollIntoView that
// found no target in classic continuous, whose virtualized rows carry
// neither [data-message-id] nor a section key).
//
// The active view registers its implementation on mount (classic's
// ClassicBody, or BaseSessionView for skins); the listener dispatches to
// whoever is mounted. Views without prompts registered are no-ops.
import { onCleanup } from "solid-js"

export type PromptNav = {
  next: () => void
  prev: () => void
}

let active: PromptNav | undefined

export function registerPromptNav(nav: PromptNav) {
  active = nav
  onCleanup(() => {
    if (active === nav) active = undefined
  })
}

const INPUTS = "input, textarea, select, [contenteditable='true'], [role='menu'], [role='dialog']"

export function promptNavKey(e: KeyboardEvent): PromptNav | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined
  if (e.key !== "j" && e.key !== "k" && e.key !== "[" && e.key !== "]") return undefined
  if (e.target instanceof Element && e.target.closest(INPUTS)) return undefined
  return active
}
