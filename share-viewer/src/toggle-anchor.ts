// Toggle anchoring (owner round 2026-10-24): opening a tool/thought near
// the top pushed its title UP (Chrome's scroll anchoring picked an anchor
// INSIDE the growing body), and closing a tall block whose bottom passed
// the viewport clamped scrollTop and flung the view up ("the bigger the
// element, the more it pushes you up").
//
// Two mechanisms:
// 1. CSS: overflow-anchor:none inside collapsible bodies (app.css) - the
//    browser can no longer anchor inside growing content, so opening
//    extends downward and the title stays put.
// 2. This module: armAnchor() captures the trigger + its viewport Y at
//    click time (document capture, once); settleAnchor() runs after the
//    state write and reflows, pinning the trigger back to its viewport
//    position in whatever scroller contains it (transcript scroller or
//    window). Closing then collapses toward the trigger instead of
//    letting the clamp fling the reader.
let lastTrigger: HTMLElement | undefined
let lastViewportTop = 0
let armed = false

/** the virtualizer row key of the row the user last toggled (captured at
 *  click time from the trigger's [data-row-key] ancestor). tanstack's
 *  size-compensation must SKIP this row: compensating the row the user
 *  is expanding scrolls by its growth delta and shoves its own trigger
 *  up out of view (the near-the-top expansion bug - live-caught). The
 *  key TTLs after 1.5s so genuine later re-measures behave normally. */
let lastToggledRowKey: string | undefined
let lastToggledAt = 0

export function getLastToggledRowKey(): string | undefined {
  if (Date.now() - lastToggledAt > 1500) return undefined
  return lastToggledRowKey
}

export function armToggleAnchor() {
  if (armed) return
  armed = true
  document.addEventListener(
    "click",
    (e) => {
      const el = e.target instanceof Element ? e.target : null
      const t = el?.closest("[data-slot='collapsible-trigger']")
      if (t instanceof HTMLElement) {
        lastTrigger = t
        lastViewportTop = t.getBoundingClientRect().top
        lastToggledRowKey = t.closest("[data-row-key]")?.getAttribute("data-row-key") ?? undefined
        lastToggledAt = Date.now()
      } else {
        lastTrigger = undefined
        lastToggledRowKey = undefined
      }
    },
    { capture: true },
  )
}

/** call right after a disclosure state write triggered by a user click.
 *  COMPOSED views only (the virtualized path is tanstack's). Runs ONE
 *  correction, delayed past Kobalte's expand/collapse spring (~300ms) -
 *  an earlier double-rAF settle pinned the trigger against a transient
 *  spring-bounce delta and scrolled by it (live-caught flicker +
 *  pushed-up titles; headless automation skips springs and never saw
 *  it). Measuring once after the spring lands is bounce-proof. */
export function settleToggleAnchor() {
  const trigger = lastTrigger
  const wasTop = lastViewportTop
  if (!trigger) return
  lastTrigger = undefined
  setTimeout(() => {
    if (!trigger.isConnected) return
    const scroller = trigger.closest<HTMLElement>("[data-transcript-scroll]")
    const nowTop = trigger.getBoundingClientRect().top
    const delta = nowTop - wasTop
    if (Math.abs(delta) < 2) return
    if (scroller && scroller.scrollHeight > scroller.clientHeight) {
      const max = scroller.scrollHeight - scroller.clientHeight
      scroller.scrollTop = Math.max(0, Math.min(max, scroller.scrollTop + delta))
    } else {
      const max = document.documentElement.scrollHeight - window.innerHeight
      window.scrollTo({ top: Math.max(0, Math.min(max, window.scrollY + delta)) })
    }
  }, 360)
}
