// Pause the subagent running-sweep for offscreen cards. The sweep is a
// compositor animation, but every running card carries two animating
// pseudos; a share with many subagents keeps them all animating while the
// reader is nowhere near them, and the layer churn costs real frames
// (live-caught in the gallery: passing the subagent previews lagged the
// page). An IntersectionObserver pauses the animation the moment a card
// leaves the viewport.
let installed = false

export function installSubagentMotion() {
  if (installed) return
  installed = true

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const el = e.target as HTMLElement
        if (e.isIntersecting) el.removeAttribute("data-osh-off")
        else el.setAttribute("data-osh-off", "")
      }
    },
    { rootMargin: "120px" },
  )

  const register = (root: ParentNode) => {
    for (const el of root.querySelectorAll<HTMLElement>(".osh-task-wrap")) {
      if (el.dataset.oshWatched) continue
      el.dataset.oshWatched = "1"
      io.observe(el)
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
