// Two-level virtualization for the composed views (reader, grove, atlas,
// cinema, teletype, letterpress, casefile, blueprint, terminal).
//
// The kit's virtual timeline covers classic (paged + continuous). The skins
// keep their own per-section structure (nav rails, grove's 2-column grid,
// scene layouts), so they virtualize through this module instead:
//
//   Level 1 - WindowedSections: only sections near the viewport mount;
//             far ones are spacers with measured (cached) heights.
//   Level 2 - WindowedEntries: inside a mounted section bigger than
//             INNER_THRESHOLD entries, only entries near the viewport
//             render; the rest are estimated spacers. Measured heights are
//             cached per entry id, so estimates converge on re-scroll.
//
// Every path ends up row-bounded: classic (kit timeline, paged + continuous)
// and every skin (K sections x min(M, inner window) entries) no matter how
// large the session or how giant a single turn is. Spacer divs carry
// .osh-win-spacer (grid-column: 1 / -1) so column layouts like grove's stay
// intact.
import { For, Show, createContext, createEffect, createMemo, createSignal, on, onCleanup, onMount, useContext, type JSX } from "solid-js"
import type { SessionSection } from "./views/session-data"

type Entry = SessionSection["ordered"][number]

// ---------------------------------------------------------------------------
// shared caches (bounded by session size, reused across view switches)

const sectionHeights = new Map<string, number>()
const entryHeights = new Map<string, number>()

const SECTION_ESTIMATE = 340
const ENTRY_ESTIMATE: Record<string, number> = { tool: 46, reasoning: 80, text: 150 }
/** sections at or below this size render plainly (zero behavior change) */
const INNER_THRESHOLD = 80

const round = (n: number) => Math.max(1, Math.round(n))

const partId = (e: Entry, i: number) => String((e as { part?: { id?: string } }).part?.id ?? i)

function entryHeight(prefix: string, sectionId: string, e: Entry, i: number): number {
  const cached = entryHeights.get(`${prefix}:${sectionId}:${partId(e, i)}`)
  if (cached !== undefined) return cached
  if (e.kind === "text") return Math.max(ENTRY_ESTIMATE.text, Math.ceil(e.text.length / 90) * 22)
  return ENTRY_ESTIMATE[e.kind] ?? 60
}

// ---------------------------------------------------------------------------
// contexts (WindowedEntries auto-wires under WindowedSections; standalone use
// passes scroller/top props instead)

const ScrollerContext = createContext<{ scroller: () => HTMLElement | undefined }>()
const FrameContext = createContext<{ top: () => number }>()

export function SectionFrame(props: {
  scroller: () => HTMLElement | undefined
  top: () => number
  children: JSX.Element
}) {
  return (
    <ScrollerContext.Provider value={{ scroller: props.scroller }}>
      <FrameContext.Provider value={{ top: props.top }}>{props.children}</FrameContext.Provider>
    </ScrollerContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// level 1: window the section list

export function WindowedSections(props: {
  sections: SessionSection[]
  /** ask to reveal a section outside the mounted window (prompt nav +
   *  search jumps): jump to its estimated offset, then align to the real
   *  element once it mounts */
  reveal?: () => { id: string; n: number } | undefined
  scroller: () => HTMLElement | undefined
  cachePrefix: string
  class?: string
  render: (section: SessionSection, index: number) => JSX.Element
}): JSX.Element {
  const [bump, setBump] = createSignal(0)
  const [frame, setFrame] = createSignal({ top: 0, height: 900 })

  // one shared ResizeObserver for mounted section wrappers (lazy: refs run
  // before onMount, so the observer is created on first use)
  let ro: ResizeObserver | undefined
  const getRo = () => {
    if (!ro) {
      ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement
          const key = el.dataset.sectionKey
          if (!key) continue
          const h = el.offsetHeight
          if (h > 0 && sectionHeights.get(key) !== h) {
            sectionHeights.set(key, h)
            setBump((n) => n + 1)
          }
        }
      })
    }
    return ro
  }

  // track the scroller's scroll position + viewport height (owner-scoped)
  createEffect(
    on(
      () => props.scroller(),
      (parent) => {
        if (!parent) return
        const update = () => setFrame({ top: parent.scrollTop, height: parent.clientHeight })
        update()
        parent.addEventListener("scroll", update, { passive: true })
        const size = new ResizeObserver(update)
        size.observe(parent)
        onCleanup(() => {
          parent.removeEventListener("scroll", update)
          size.disconnect()
        })
      },
    ),
  )

  const sectionH = (i: number) => {
    const key = `${props.cachePrefix}:${props.sections[i]?.id}`
    return sectionHeights.get(key) ?? SECTION_ESTIMATE
  }

  const geometry = createMemo(() => {
    void bump()
    const tops: number[] = new Array(props.sections.length)
    let acc = 0
    for (let i = 0; i < props.sections.length; i++) {
      tops[i] = acc
      acc += sectionH(i)
    }
    return { tops, total: acc }
  })

  // reveal a section that is not mounted yet: scroll to its estimated
  // offset so the window mounts it, then align to the real element
  let lastReveal = 0
  createEffect(() => {
    const req = props.reveal?.()
    if (!req || req.n === lastReveal) return
    lastReveal = req.n
    const idx = props.sections.findIndex((s) => s.id === req.id)
    const parent = props.scroller()
    if (idx < 0 || !parent) return
    const { tops } = geometry()
    parent.scrollTop = Math.max(0, tops[idx] - 4)
    const align = (tries: number) => {
      const el = parent.querySelector<HTMLElement>(
        `[data-section-key="${CSS.escape(`${props.cachePrefix}:${req.id}`)}"]`,
      )
      if (el) {
        el.scrollIntoView({ block: "start", behavior: "auto" })
        return
      }
      if (tries < 8) requestAnimationFrame(() => align(tries + 1))
    }
    requestAnimationFrame(() => align(0))
  })

  const window_ = createMemo(() => {
    const { tops, total } = geometry()
    if (tops.length === 0) return { first: 0, last: -1, top: 0, bottom: 0 }
    const buffer = Math.max(900, frame().height * 1.5)
    const viewTop = frame().top - buffer
    const viewBottom = frame().top + frame().height + buffer
    let first = 0
    while (first < tops.length - 1 && tops[first] + sectionH(first) <= viewTop) first++
    let last = first
    while (last < tops.length - 1 && tops[last] < viewBottom) last++
    return {
      first,
      last,
      top: tops[first],
      bottom: total - (tops[last] + sectionH(last)),
    }
  })

  return (
    <div class={props.class}>
      <div class="osh-win-spacer" style={{ height: `${round(window_().top)}px` }} />
      <For each={props.sections.slice(window_().first, window_().last + 1)}>
        {(section, i) => {
          const index = window_().first + i()
          const key = `${props.cachePrefix}:${section.id}`
          let wrapper: HTMLElement | undefined
          return (
            <div
              data-section-key={key}
              ref={(el) => {
                wrapper = el
                getRo().observe(el)
                onCleanup(() => ro?.unobserve(el))
              }}
            >
              <SectionFrame
                scroller={props.scroller}
                // the REAL content-box top (relative to the scroller) once the
                // wrapper exists - level 2 frames itself against this, not the
                // prefix estimate, so nested windows stay exact
                top={() => wrapper?.offsetTop ?? geometry().tops[index] ?? 0}
              >
                {props.render(section, index)}
              </SectionFrame>
            </div>
          )
        }}
      </For>
      <div class="osh-win-spacer" style={{ height: `${round(window_().bottom)}px` }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// level 2: window the entries INSIDE one section (only engages for big ones)

export function WindowedEntries(props: {
  sectionId: string
  cachePrefix: string
  entries: Entry[]
  render: (entry: Entry, index: number) => JSX.Element
  /** standalone use (paged mode): the scroller + the section's content top */
  scroller?: () => HTMLElement | undefined
  top?: () => number
}): JSX.Element {
  // small sections render plainly - the overwhelming majority
  const big = () => props.entries.length > INNER_THRESHOLD
  const [bump, setBump] = createSignal(0)
  const [frame, setFrame] = createSignal({ top: 0, height: 900 })
  const sctx = useContext(ScrollerContext)
  const fctx = useContext(FrameContext)
  const scroller = () => (props.scroller ?? sctx?.scroller)?.()
  const sectionTop = () => props.top ?? fctx?.top ?? (() => 0)

  createEffect(
    on(
      () => (big() ? scroller() : undefined),
      (parent) => {
        if (!parent) return
        const update = () => setFrame({ top: parent.scrollTop, height: parent.clientHeight })
        update()
        parent.addEventListener("scroll", update, { passive: true })
        const size = new ResizeObserver(update)
        size.observe(parent)
        onCleanup(() => {
          parent.removeEventListener("scroll", update)
          size.disconnect()
        })
      },
    ),
  )

  const measureEntry = (key: string, el: HTMLElement) => {
    // display:contents wrappers (grove's grid slots) have no box - fall back
    // to the children's boxes
    const h = el.offsetHeight || Array.from(el.children).reduce((n, c) => n + c.getBoundingClientRect().height, 0)
    if (h > 0 && entryHeights.get(key) !== h) {
      entryHeights.set(key, h)
      setBump((n) => n + 1)
    }
  }

  // one shared ResizeObserver so an entry that changes height after mount
  // (expanded tool, settled markdown) re-measures and the spacers stay true
  let ro: ResizeObserver | undefined
  const getRo = () => {
    if (!ro) {
      ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement
          const key = el.dataset.entryKey
          if (key) measureEntry(key, el)
        }
      })
    }
    return ro
  }

  const window_ = createMemo(() => {
    const count = props.entries.length
    if (count === 0) return { first: 0, last: -1, top: 0, bottom: 0 }
    if (count <= INNER_THRESHOLD) return { first: 0, last: count - 1, top: 0, bottom: 0 }
    void bump()
    const rel = frame().top - sectionTop()()
    const buffer = Math.max(900, frame().height * 1.5)
    const top = (i: number) => entryHeight(props.cachePrefix, props.sectionId, props.entries[i], i)
    const tops: number[] = new Array(count)
    let acc = 0
    for (let i = 0; i < count; i++) {
      tops[i] = acc
      acc += top(i)
    }
    let first = 0
    while (first < count - 1 && tops[first] + top(first) <= rel - buffer) first++
    let last = first
    while (last < count - 1 && tops[last] < rel + frame().height + buffer) last++
    return {
      first,
      last,
      top: tops[first],
      bottom: Math.max(0, acc - (tops[last] + top(last))),
    }
  })

  return (
    <Show
      when={big()}
      fallback={<For each={props.entries}>{(e, i) => props.render(e, i())}</For>}
    >
      <div class="osh-win-spacer" style={{ height: `${round(window_().top)}px` }} />
      <For each={props.entries.slice(window_().first, window_().last + 1)}>
        {(entry, i) => {
          const index = window_().first + i()
          const key = `${props.cachePrefix}:${props.sectionId}:${partId(entry, index)}`
          return (
            <div
              class="osh-entry-slot"
              data-entry-key={key}
              ref={(el) => {
                getRo().observe(el)
                onCleanup(() => ro?.unobserve(el))
              }}
            >
              {props.render(entry, index)}
            </div>
          )
        }}
      </For>
      <div class="osh-win-spacer" style={{ height: `${round(window_().bottom)}px` }} />
    </Show>
  )
}
