// Shared clock for the subagent running-sweep. Every card's two pseudos run
// the same 2.6s keyframes; pausing an offscreen card (IntersectionObserver)
// freezes its phase, and cards re-entering view at different times drift
// apart. All cards are phase-LOCKED to one page-wide timeline instead: at
// mount and at every re-entry, the card restarts its animations with
// animation-delay = -(elapsed mod 2600ms), so every visible card sweeps in
// unison and pausing never desyncs them.
const DUR = 2600
const T0 = performance.now()

let installed = false

export function installSubagentMotion() {
  if (installed) return
  installed = true

  const relock = (el: HTMLElement) => {
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const delay = -((performance.now() - T0) % DUR)
    el.style.setProperty("--osh-phase", `${delay}ms`)
    // animation-delay only applies at start: kill and restart the pseudos'
    // animations so the new delay takes; two rAFs guarantee the kill
    // committed before the restart
    el.setAttribute("data-osh-relock", "")
    requestAnimationFrame(() => requestAnimationFrame(() => el.removeAttribute("data-osh-relock")))
  }

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
