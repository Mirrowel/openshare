// Shared TimelineDetail construction: grouping is PER RESPONSE (one
// assistant message = one response) and never merges thinking. OFF = every
// tool call its own row. Always passed so ungrouped rows keep content
// spacing. Used by the classic timeline and the gallery timeline so the
// settings flips behave identically in both.
import type { OshSettings } from "./settings"

export function buildTimelineDetail(settings: OshSettings) {
  const mode = settings.toolGrouping
  const picks = new Set(settings.groupTools ?? [])
  const gp = (tool: string) => mode === "all" || (mode === "custom" && picks.has(tool))
  // per-tool auto-expand drives everything (renderer's toolDefaultOpen,
  // consulted before categories); category details stay collapsed so
  // unlisted tools never open
  const details = "collapsed" as const
  return {
    shell: { placement: gp("shell") ? "grouped" : "separate", details },
    edit: { placement: gp("edit") ? "grouped" : "separate", details },
    thinking: { placement: "separate", details: settings.reasoningOpen ? "expanded" : "collapsed" },
    subagents: { placement: gp("task") ? "grouped" : "separate" },
    notices: { placement: "separate" },
    tools: { placement: mode === "off" ? "separate" : "grouped", ...(mode === "custom" ? { only: [...picks] } : {}) },
    commentary: { placement: "separate" },
  } as any
}
