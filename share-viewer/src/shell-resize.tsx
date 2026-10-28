// Resizable shell output. The kit caps shell output at 240px and hides its
// scrollbar, so a long result looked like a static block with nothing
// suggesting more content. The shell card carries a drag handle on its
// bottom edge (per card, not persisted) plus a fade while the content is
// clipped. One delegated listener serves every view, because classic and
// the composed views both render the kit's shell card.
const MIN = 80
const maxHeight = () => Math.round(window.innerHeight * 0.8)

let installed = false

function scrollerOf(card: Element | null) {
  return card?.querySelector<HTMLElement>('[data-slot="bash-scroll"]') ?? null
}

function syncClipped(card: Element) {
  const sc = scrollerOf(card)
  if (!sc) return
  card.toggleAttribute("data-osh-clipped", sc.scrollHeight - sc.clientHeight > 2)
}

/** Sweep every mounted shell card; cheap, called after data/scroll changes. */
export function syncShellCards(root: ParentNode = document) {
  root.querySelectorAll("[data-osh-shell]").forEach(syncClipped)
}

/** Install the delegated drag/resize listeners once per page. */
export function installShellResize() {
  if (installed) return
  installed = true

  let card: HTMLElement | null = null
  let startY = 0
  let startH = 0

  document.addEventListener(
    "pointerdown",
    (e) => {
      const grip = (e.target as Element | null)?.closest<HTMLElement>("[data-osh-shell-grip]")
      if (!grip) return
      const owner = grip.closest<HTMLElement>("[data-osh-shell]")
      const sc = scrollerOf(owner)
      if (!owner || !sc) return
      e.preventDefault()
      grip.setPointerCapture(e.pointerId)
      card = owner
      startY = e.clientY
      startH = sc.getBoundingClientRect().height
      owner.setAttribute("data-osh-resizing", "")
    },
    true,
  )

  document.addEventListener(
    "pointermove",
    (e) => {
      if (!card) return
      const next = Math.max(MIN, Math.min(maxHeight(), startH + (e.clientY - startY)))
      card.style.setProperty("--osh-shell-h", `${Math.round(next)}px`)
      syncClipped(card)
    },
    true,
  )

  const stop = () => {
    if (!card) return
    card.removeAttribute("data-osh-resizing")
    card = null
  }
  document.addEventListener("pointerup", stop, true)
  document.addEventListener("pointercancel", stop, true)

  document.addEventListener(
    "dblclick",
    (e) => {
      const grip = (e.target as Element | null)?.closest<HTMLElement>("[data-osh-shell-grip]")
      const owner = grip?.closest<HTMLElement>("[data-osh-shell]")
      if (!owner) return
      e.preventDefault()
      owner.style.removeProperty("--osh-shell-h")
      syncClipped(owner)
    },
    true,
  )

  // keep the fade honest: output can stream in and the reader can scroll
  document.addEventListener(
    "scroll",
    (e) => {
      const sc = e.target as Element | null
      if (sc?.getAttribute?.("data-slot") !== "bash-scroll") return
      const owner = sc.closest("[data-osh-shell]")
      if (owner) syncClipped(owner)
    },
    true,
  )

  const mo = new MutationObserver(() => syncShellCards())
  mo.observe(document.body, { childList: true, subtree: true })
  window.addEventListener("resize", () => syncShellCards())
}
