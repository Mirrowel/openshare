// Shared clock for the subagent running-sweep. Every card's two pseudos run
// the same keyframes; pausing an offscreen card (IntersectionObserver)
// freezes its phase, and cards re-entering view at different times drift
// apart. All cards are phase-LOCKED to one page-wide timeline instead: at
// mount and at every re-entry, the card restarts its animations with
// animation-delay = -(elapsed mod period), so every visible card sweeps in
// unison and pausing never desyncs them. The period follows the sweep mode:
// 2.6s continuous, 4s in cadence mode (one pass then rest).
const T0 = performance.now()
const period = () => (document.documentElement.dataset.oshSweep === "cadence" ? 4000 : 2600)

let installed = false
const registered = new Set<HTMLElement>()

/** Re-lock every registered card (called when the sweep mode changes). */
export function relockSubagentMotion() {
  for (const el of registered) relock(el)
}

const relock = (el: HTMLElement) => {
  if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return
  const delay = -((performance.now() - T0) % period())
  el.style.setProperty("--osh-phase", `${delay}ms`)
  // animation-delay only applies at start: kill and restart the pseudos'
  // animations so the new delay takes; two rAFs guarantee the kill
  // committed before the restart
  el.setAttribute("data-osh-relock", "")
  requestAnimationFrame(() => requestAnimationFrame(() => el.removeAttribute("data-osh-relock")))
}

export function installSubagentMotion() {
  if (installed) return
  installed = true

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const el = e.target as HTMLElement
        if (e.isIntersecting) {
          el.removeAttribute("data-osh-off")
          relock(el)
        } else {
          el.setAttribute("data-osh-off", "")
        }
      }
    },
    { rootMargin: "120px" },
  )

  const register = (root: ParentNode) => {
    for (const el of root.querySelectorAll<HTMLElement>(".osh-task-wrap")) {
      if (el.dataset.oshWatched) continue
      el.dataset.oshWatched = "1"
      registered.add(el)
      io.observe(el)
      relock(el)
    }
  }

  let scheduled = false
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      register(document)
    })
  }
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true })
  register(document)
}
