// Subagent task cards render at ONE shared width: the widest mounted
// card's natural width, clamped, monotonically non-shrinking for the
// session (owner round 2026-10-26: "always match the longest one, and
// clamp how long it can be"). Implemented as a body-level
// MutationObserver because the cards render from the vendored kit - a
// scan marks each .osh-task-wrap, measures its card's natural width
// BEFORE any shared width applies, and every live card then carries the
// same width. Virtualized remounts re-measure (fresh elements);
// removals drop out of the set.

const CLAMP_MAX = 640 // 40rem
const live = new Map<HTMLElement, number>() // card -> natural width
let appliedWidth = 0

function apply() {
  let max = 0
  for (const w of live.values()) if (w > max) max = w
  const target = Math.min(max, CLAMP_MAX)
  // monotonic: a long card unmounting must not narrow the others
  if (target <= appliedWidth) return
  appliedWidth = target
  for (const card of live.keys()) card.style.width = `${target}px`
}

function scan(root: ParentNode) {
  for (const wrap of Array.from(root.querySelectorAll(".osh-task-wrap"))) {
    const card = (wrap as HTMLElement).querySelector('[data-component="task-tool-card"]') as HTMLElement | null
    if (card && !live.has(card)) {
      live.set(card, card.getBoundingClientRect().width)
    }
  }
  apply()
}

export function watchTaskCards() {
  if (typeof window === "undefined" || watchTaskCards.seen) return
  watchTaskCards.seen = true
  const mo = new MutationObserver((muts) => {
    let touched = false
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n instanceof HTMLElement && (n.matches(".osh-task-wrap") || n.querySelector(".osh-task-wrap"))) touched = true
      }
      for (const n of m.removedNodes) {
        if (n instanceof HTMLElement) {
          if (n.matches('[data-component="task-tool-card"]')) { live.delete(n); touched = true }
          for (const card of Array.from(n.querySelectorAll('[data-component="task-tool-card"]'))) { live.delete(card as HTMLElement); touched = true }
        }
      }
    }
    if (touched) scan(document.body)
  })
  mo.observe(document.body, { childList: true, subtree: true })
  scan(document.body)
}
watchTaskCards.seen = false
