// Resizable output cards. Tall tool output used to be a dead end: the kit
// capped shell at 240px with a hidden scrollbar, text results at 32rem, and
// file cards not at all. Every card now shares one behavior set:
//   - `[data-osh-out]` marks the card, `[data-osh-scroll]` its scroller
//   - a bottom-edge grip resizes THAT card (not persisted; dblclick resets)
//   - a fade marks clipped content
//   - file cards get up/down chevrons instead of a scrollbar
// Delegated listeners serve classic and every skin, because they all render
// the same cards.
const MIN = 80
const maxHeight = () => Math.round(window.innerHeight * 0.8)

let installed = false

const scrollerOf = (card: Element | null) => card?.querySelector<HTMLElement>("[data-osh-scroll]") ?? null

function syncCard(card: Element) {
  const sc = scrollerOf(card)
  if (!sc) return
  const overflowY = sc.scrollHeight - sc.clientHeight > 2
  card.toggleAttribute("data-osh-clipped", overflowY)
  const kind = card.getAttribute("data-osh-out")
  if (kind === "file") {
    card.toggleAttribute("data-more-up", sc.scrollTop > 2)
    card.toggleAttribute("data-more-down", overflowY && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 2)
  }
}

/** Sweep mounted cards; cheap and called after data/scroll changes. */
export function syncOutputCards(root: ParentNode = document) {
  root.querySelectorAll("[data-osh-out]").forEach(syncCard)
}

/** Install the delegated drag/resize listeners once per page. */
export function installOutputResize() {
  if (installed) return
  installed = true

  let card: HTMLElement | null = null
  let startY = 0
  let startH = 0

  document.addEventListener(
    "pointerdown",
    (e) => {
      const grip = (e.target as Element | null)?.closest<HTMLElement>("[data-osh-out-grip]")
      if (!grip) return
      const owner = grip.closest<HTMLElement>("[data-osh-out]")
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
      card.style.setProperty("--osh-out-h", `${Math.round(next)}px`)
      syncCard(card)
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
      const grip = (e.target as Element | null)?.closest<HTMLElement>("[data-osh-out-grip]")
      const owner = grip?.closest<HTMLElement>("[data-osh-out]")
      if (!owner) return
      e.preventDefault()
      owner.style.removeProperty("--osh-out-h")
      syncCard(owner)
    },
    true,
  )

  // output can stream in and the reader can scroll: keep both markers honest
  document.addEventListener(
    "scroll",
    (e) => {
      const sc = e.target as Element | null
      if (!sc?.hasAttribute?.("data-osh-scroll")) return
      const owner = sc.closest("[data-osh-out]")
      if (owner) syncCard(owner)
    },
    true,
  )

  // pierre paints file bodies inside shadow roots, so a document-level
  // MutationObserver never sees the paint that gives a card its scroll
  // geometry: on a cold first load the chevrons/clipped markers stayed
  // missing until the reader scrolled (live-caught); a warm reload painted
  // fast enough to race the mount timers. Watch every discovered shadow
  // root too, coalesced to one sweep per frame — plus TRAILING sweeps:
  // a body that finished painting before this frame's shadow watcher
  // attached never mutates again, so re-measure a few times after each
  // burst (live-caught: the first tall card opened by click stayed
  // chevron-less until a page reload).
  let scheduled = false
  let trailing: number[] = []
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      watchShadows()
      syncOutputCards()
      for (const t of trailing) clearTimeout(t)
      trailing = [300, 1000, 3000].map((ms) =>
        window.setTimeout(() => {
          watchShadows()
          syncOutputCards()
        }, ms),
      )
    })
  }
  const watched = new WeakSet<Node>()
  const watchShadows = () => {
    for (const el of document.querySelectorAll<HTMLElement>("*")) {
      const shadow = el.shadowRoot
      if (!shadow || watched.has(shadow)) continue
      watched.add(shadow)
      new MutationObserver(schedule).observe(shadow, { childList: true, subtree: true, characterData: true })
    }
  }
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true })
  window.addEventListener("resize", () => syncOutputCards())
}
