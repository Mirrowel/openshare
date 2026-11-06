// Live memory profiler, console-driven: __oshMem.start() before the
// suspicious activity, __oshMem.stop() after; stop() logs a JSON series
// (copy it out for analysis). Samples the renderer heap, DOM size, open
// thinking panels with painted content heights, and scroll activity.
export {}

type Sample = {
  t: number
  jsMB?: number
  jsTotalMB?: number
  nodes: number
  dpr: number
  scrolls: number
  openPanels: number
  tallBodies: string[]
}

declare global {
  interface Window {
    __oshMem?: {
      start: (label?: string) => void
      stop: () => Sample[]
    }
  }
}

let timer: ReturnType<typeof setInterval> | undefined
let label = ""
const samples: Sample[] = []
let scrollCount = 0

const sample = (): Sample => {
  // Chrome-only legacy API; absent elsewhere (and in every other browser)
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory
  const open = document.querySelectorAll("[data-component='reasoning-part'] [data-slot='collapsible-trigger'][aria-expanded='true']")
  const tallBodies: string[] = []
  for (const t of open) {
    const body = t.closest("[data-component='reasoning-part']")?.querySelector<HTMLElement>(".osh-think-body")
    if (body && body.scrollHeight > 1500) tallBodies.push(`${body.scrollHeight}px in ${body.clientHeight}px window`)
  }
  return {
    t: Math.round(performance.now()),
    jsMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : undefined,
    jsTotalMB: mem ? Math.round(mem.totalJSHeapSize / 1048576) : undefined,
    nodes: document.querySelectorAll("*").length,
    dpr: window.devicePixelRatio,
    scrolls: scrollCount,
    openPanels: open.length,
    tallBodies,
  }
}

const onScroll = () => { scrollCount++ }

window.__oshMem = {
  start(l = "") {
    this.stop()
    label = l
    scrollCount = 0
    samples.length = 0
    document.addEventListener("scroll", onScroll, { capture: true, passive: true })
    timer = setInterval(() => samples.push(sample()), 2000)
    samples.push(sample())
    console.log(`[oshMem] capturing${label ? ` "${label}"` : ""} - run stop() when done`)
  },
  stop() {
    if (timer) clearInterval(timer)
    timer = undefined
    document.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions)
    if (!samples.length) return samples
    console.log(`[oshMem] ${label || "capture"}: ${samples.length} samples`)
    console.table(samples.map((s) => ({ t: s.t, jsMB: s.jsMB, nodes: s.nodes, scrolls: s.scrolls, openPanels: s.openPanels, tallBodies: s.tallBodies.length })))
    console.log(JSON.stringify(samples))
    return samples
  },
}
