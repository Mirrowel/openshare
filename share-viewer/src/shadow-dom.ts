// Shadow-DOM aware DOM helpers. The updated pierre renderer paints its file
// and diff bodies inside a shadow root, so a plain document.querySelector
// finds nothing: line numbers, token spans and content height all live one
// tree deeper (read offsets stop renumbering, the cold-pool guard never
// fires, chevrons never appear).
const SHOW_ALL = NodeFilter.SHOW_ELEMENT

/** Every element matching `selector` inside `root`, descending into any
 *  shadow root it meets along the way. */
export function deepQueryAll(root: ParentNode, selector: string): HTMLElement[] {
  const out: HTMLElement[] = []
  const walk = (node: ParentNode) => {
    for (const el of node.querySelectorAll<HTMLElement>(selector)) out.push(el)
    const all = node.querySelectorAll<HTMLElement>("*")
    for (const el of all) {
      const shadow = el.shadowRoot
      if (shadow) walk(shadow as unknown as ParentNode)
    }
  }
  walk(root)
  return out
}

/** Run `fn` once the element's shadow content settles: immediately, on a
 *  couple of animation frames, and whenever a shadow root under it mutates
 *  or resizes. Returns a disposer. */
export function onDeepChange(root: HTMLElement, fn: () => void): () => void {
  const observers: Array<MutationObserver | ResizeObserver> = []
  const timers: number[] = []
  const run = () => {
    try {
      fn()
    } catch {
      // a stale detached host mid-teardown is not an error worth surfacing
    }
  }
  run()
  timers.push(requestAnimationFrame(() => timers.push(requestAnimationFrame(run))))

  const watch = (scope: Document | ShadowRoot) => {
    const mo = new MutationObserver(run)
    mo.observe(scope as unknown as Node, { childList: true, subtree: true, characterData: true })
    observers.push(mo)
  }
  watch(root.ownerDocument)
  const attach = () => {
    for (const el of root.querySelectorAll<HTMLElement>("*")) {
      const shadow = el.shadowRoot
      if (!shadow || (shadow as any).__oshWatched) continue
      ;(shadow as any).__oshWatched = true
      watch(shadow)
    }
    const ro = new ResizeObserver(run)
    for (const el of root.querySelectorAll<HTMLElement>("*")) {
      if (el.shadowRoot) ro.observe(el)
    }
    observers.push(ro)
  }
  attach()
  timers.push(window.setTimeout(attach, 400))
  timers.push(window.setTimeout(run, 1200))

  return () => {
    for (const o of observers) o.disconnect()
    for (const t of timers) cancelAnimationFrame(t)
  }
}
