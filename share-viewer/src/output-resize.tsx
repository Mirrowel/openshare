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

// load-bench counters (gallery reads them via window.__oshOutStats)
const outStats = { bursts: 0, syncs: 0 }
if (import.meta.env.DEV) (window as any).__oshOutStats = outStats

const scrollerOf = (card: Element | null) => card?.querySelector<HTMLElement>("[data-osh-scroll]") ?? null

type CardState = { clipped: boolean; up: boolean; down: boolean }

/** Read-only: one layout read per card, no writes. */
function measureCard(card: Element): CardState | null {
  const sc = scrollerOf(card)
  if (!sc) return null
  const overflowY = sc.scrollHeight - sc.clientHeight > 2
  return {
    clipped: overflowY,
    up: sc.scrollTop > 2,
    down: overflowY && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 2,
  }
}

/** Write-only: applies a measured state to the card's attributes. */
function applyCard(card: Element, m: CardState) {
  card.toggleAttribute("data-osh-clipped", m.clipped)
  if (card.getAttribute("data-osh-out") === "file") {
    card.toggleAttribute("data-more-up", m.up)
    card.toggleAttribute("data-more-down", m.down)
  }
}

function syncCard(card: Element) {
  const m = measureCard(card)
  if (m) applyCard(card, m)
}

/** Sweep mounted cards; cheap and called after data/scroll changes. */
export function syncOutputCards(root: ParentNode = document) {
  outStats.syncs++
  // reads first, then writes: interleaving them forces a reflow per card
  const cards = [...root.querySelectorAll("[data-osh-out]")]
  const states = cards.map(measureCard)
  cards.forEach((c, i) => {
    const m = states[i]
    if (m) applyCard(c, m)
  })
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

  // Chevron/clipped state derives from the scroller's layout, and the
  // observable signal for "the scrollable content changed size" is a
  // ResizeObserver on the content - the same moment a scrollbar would
  // appear or grow. Previous designs polled (mutation bursts, document
  // walks, trailing timers): they missed cold shadow paints and stole
  // main-thread time during load. This one never walks the document:
  //   - a MutationObserver inspects only added/removed nodes and wires
  //     each card once (cards mount collapsed; the scroller arrives when
  //     the content opens, so wiring retries until it exists)
  //   - the shared ResizeObserver watches the scroller box plus a short
  //     first-child chain, crossing into pierre's shadow root, so row
  //     layout inside it re-measures exactly that card
  //   - card removal unobserves everything (RO holds strong refs)
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const card = (e.target as Element).closest("[data-osh-out]")
      if (card) markDirty(card)
    }
  })
  const cardTargets = new Map<Element, Element[]>()
  const cardObservers = new Map<Element, MutationObserver>()
  const pending = new Set<Element>()
  // one batched measure pass per frame: observer bursts touch many cards and
  // measuring each inside the callback interleaves layout reads with the
  // attribute writes of the previous card (a forced reflow per card)
  const dirty = new Set<Element>()
  let flushQueued = false
  const flush = () => {
    flushQueued = false
    const cards = [...dirty]
    dirty.clear()
    const states = cards.map(measureCard)
    cards.forEach((c, i) => {
      const m = states[i]
      if (m) applyCard(c, m)
    })
    if (cards.length) outStats.syncs++
  }
  const markDirty = (card: Element) => {
    dirty.add(card)
    if (flushQueued) return
    flushQueued = true
    requestAnimationFrame(flush)
  }

  const targetsFor = (card: Element): Element[] => {
    const sc = scrollerOf(card)
    if (!sc) return []
    const out: Element[] = [sc]
    let node: Element | null = sc
    for (let d = 0; d < 3 && node; d++) {
      node = node.firstElementChild
      if (node) out.push(node)
    }
    for (const t of [...out]) {
      const sr = (t as HTMLElement).shadowRoot
      if (!sr) continue
      let n: Element | null = sr.firstElementChild
      for (let d = 0; d < 3 && n; d++) {
        out.push(n)
        n = n.firstElementChild
      }
    }
    return out
  }

  const wire = (card: Element) => {
    const sc = scrollerOf(card)
    if (!sc) {
      // deferred content: retry on the next mutation under this card
      pending.add(card)
      return
    }
    pending.delete(card)
    // scoped structural watch: pierre mounts its shadow shell and rows
    // after the card opens, and none of that reaches the document-level
    // observer — a per-card MutationObserver (scroller subtree + every
    // discovered shadow root) re-exands the observed chain when new
    // content appears and re-measures just this card
    const mo = new MutationObserver(() => refresh(card))
    mo.observe(sc, { childList: true, subtree: true })
    cardObservers.set(card, mo)
    refresh(card)
  }

  const refresh = (card: Element) => {
    const known = cardTargets.get(card) ?? []
    const seen = new Set(known)
    const targets = targetsFor(card)
    if (!targets.length) return
    const mo = cardObservers.get(card)
    for (const t of targets) {
      if (!seen.has(t)) ro.observe(t)
      const sr = (t as HTMLElement).shadowRoot
      if (sr && mo && !(sr as unknown as { __oshCardMo?: boolean }).__oshCardMo) {
        ;(sr as unknown as { __oshCardMo?: boolean }).__oshCardMo = true
        mo.observe(sr, { childList: true, subtree: true })
      }
    }
    cardTargets.set(card, targets)
    markDirty(card)
  }

  const unwire = (card: Element) => {
    const targets = cardTargets.get(card)
    if (targets) for (const t of targets) ro.unobserve(t)
    cardTargets.delete(card)
    cardObservers.get(card)?.disconnect()
    cardObservers.delete(card)
    pending.delete(card)
  }

  new MutationObserver((records) => {
    outStats.bursts++
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (!(n instanceof Element)) continue
        if (n.hasAttribute("data-osh-out")) wire(n)
        else for (const c of n.querySelectorAll("[data-osh-out]")) wire(c)
      }
      for (const n of r.removedNodes) {
        if (!(n instanceof Element)) continue
        if (n.hasAttribute("data-osh-out")) unwire(n)
        else for (const c of n.querySelectorAll("[data-osh-out]")) unwire(c)
      }
    }
    if (pending.size) for (const card of [...pending]) wire(card)
  }).observe(document.body, { childList: true, subtree: true })
  for (const card of document.querySelectorAll("[data-osh-out]")) wire(card)
  window.addEventListener("resize", () => syncOutputCards())
}
