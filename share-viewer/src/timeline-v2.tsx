// Virtualized continuous timeline — lean port of the v2 app's
// createTimelineVirtualizer behaviors that matter for a share page:
//   - measured rows (per-share measurement cache, honest heights after
//     first paint; estimates for never-seen rows)
//   - pinned-to-end anchoring: new content follows while the reader is
//     at the end (tight epsilon — a nudge up unpins deliberately)
//   - generous overscan for fast scrolling
// Drives the vendored session-ui projection + row renderer, so rendering
// is identical to the non-virtualized timeline.
import { createVirtualizer } from "@tanstack/solid-virtual"
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, createRoot, type JSX , For } from "solid-js"
import { createStore } from "solid-js/store"
import { createReactiveTimelineProjection, TimelineRow } from "@opencode/session-ui/timeline/projection"
import { armToggleAnchor, getLastToggledRowKey } from "./toggle-anchor"
import { copyRowLink, rowKeyFromHash } from "./deep-link"
import { claimDisclosure, disclosureOwned, dismissSearchKey, engineClicking, releaseDisclosure, searchKeyDismissed, searchOwnsDisclosure } from "./search-state"
import type { ReasoningMode } from "@opencode/session-ui/timeline/projection"
import type { TimelineDetail } from "@opencode/session-ui/timeline/detail"
import { createSessionTimelineRowRenderer, type SessionUserPresentation } from "@opencode/session-ui/timeline/row"
import type { SessionDocument } from "@opencode/session-ui/document"

// distance from the bottom that still counts as "at the end" (px)
const END_EPSILON = 4
const ESTIMATE = 90

const measurementCache = new Map<string, number>()

// Disclosure (open/closed tool rows) persisted per sessionKey across
// component remounts and data refolds (smart-sync: an update must never
// close what the reader opened). Bounded LRU by insertion.
const disclosureMemory = new Map<string, Record<string, boolean | undefined>>()
function readDisclosure(key: string) {
  const hit = disclosureMemory.get(key)
  if (hit) {
    disclosureMemory.delete(key)
    disclosureMemory.set(key, hit)
    return hit
  }
  return {}
}
function writeDisclosure(key: string, store: Record<string, boolean | undefined>) {
  disclosureMemory.set(key, { ...store })
  while (disclosureMemory.size > 12) {
    const oldest = disclosureMemory.keys().next().value as string | undefined
    if (oldest === undefined) break
    disclosureMemory.delete(oldest)
  }
}

// Exact restore across remounts/settings changes: tanstack snapshots the
// measured rows, and replaying the snapshot plus the scroll offset makes the
// layout identical to what the reader left. Without this a settings change
// re-measured rows, the total height shrank under the scroll position and the
// page appeared to jump (probed and confirmed on the live build).
type RowSnapshot = { index: number; key: string; start: number; size: number }
type Snapshot = { items: RowSnapshot[]; offset: number; width?: number; atEnd?: boolean; topKey?: string; topDelta?: number }
const snapshotMemory = new Map<string, Snapshot>()
// v2: v1 child-session snapshots were poisoned atEnd by the pre-remount
// clamp (a carried main-page scrollTop clamped into the shorter child
// transcript and got saved as a bottom position); the bump gives every
// session a clean slate
const snapshotKey = (sessionKey: string) => `osh:vrows2:${sessionKey}`
// deep links consumed this page load (see the deep-link effect): bounded by
// the reader's own navigation, a Set of small strings
const consumedDeepLinks = new Set<string>()
// scrollbar-stable viewport width: window.innerWidth changes by the
// scrollbar's width between "content overflowing" (save time) and "fresh
// load before render" (read time), which made the width gate reject
// restores nondeterministically
const viewportWidth = () => document.documentElement.clientWidth
function readSnapshot(sessionKey: string): Snapshot | undefined {
  const memory = snapshotMemory.get(sessionKey)
  if (memory) return memory
  try {
    const raw = sessionStorage.getItem(snapshotKey(sessionKey))
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Snapshot
    snapshotMemory.set(sessionKey, parsed)
    return parsed
  } catch {
    return undefined
  }
}
function writeSnapshot(sessionKey: string, snapshot: Snapshot) {
  snapshotMemory.set(sessionKey, snapshot)
  try {
    sessionStorage.setItem(snapshotKey(sessionKey), JSON.stringify(snapshot))
  } catch {}
}

export function VirtualTimeline(props: {
  doc: SessionDocument
  sessionKey: string
  reasoningMode?: ReasoningMode
  shellToolDefaultOpen?: boolean
  editToolDefaultOpen?: boolean
  /** per-tool-name default-open (the auto-expand list); consulted before
   *  the category booleans. undefined = fall through to kit logic. */
  toolDefaultOpen?: (tool: { name: string }) => boolean | undefined
  timelineDetail?: TimelineDetail
  presentation?: Record<string, SessionUserPresentation | undefined>
  header?: JSX.Element
  footer?: JSX.Element
  class?: string
  /** "end" (default): continuous mode — start pinned to the bottom and
   * follow live content. "start": paged turns and static docs — open at
   * the top, no follow-live. */
  anchor?: "end" | "start"
  /** explicit live-follow override: false disables the pinned auto-scroll
   * (the reader navigated away on purpose); undefined falls back to the
   * anchor-derived behavior. */
  followLive?: boolean
  /** continuous-mode fast-skip: when this changes to a message id, scroll
   * to that user message's row (the rail's jump target). nonce makes
   * repeat jumps to the same message re-fire; behavior carries the
   * smooth-scroll setting (long jumps fall back to instant internally). */
  scrollTarget?: { id: string; nonce: number; behavior?: ScrollBehavior; force?: boolean }
  /** imperative controls handed to the parent once the virtualizer is
   * live (focus mode, hotkeys, rail jumps all scroll through this) */
  onReady?: (controls: { scrollToMessage: (id: string) => void }) => void
  /** reports the user message currently in view (the active turn) as the
   * user scrolls — drives the title's active-turn model and the rail's
   * active marker */
  onActiveMessageChange?: (id: string) => void
}): JSX.Element {
  // frozen at mount: the sessionKey prop is a live getter, and during the
  // cleanup of a session switch it already evaluates to the NEW session -
  // an unmount-save through the live prop would write one session's state
  // under the next session's key
  const mountKey = props.sessionKey
  const projection = createReactiveTimelineProjection({
    sessionMessages: () => props.doc.messages,
    status: () => props.doc.status,
    reasoningMode: () => props.reasoningMode ?? "compact",
    shellToolDefaultOpen: () => props.shellToolDefaultOpen ?? false,
    editToolDefaultOpen: () => props.editToolDefaultOpen ?? false,
    timelineDetail: props.timelineDetail && (() => props.timelineDetail!),
  })
  const [toolOpen, setToolOpen] = createStore<Record<string, boolean | undefined>>(
    // seed from the persistent disclosure map (survives remounts)
    readDisclosure(mountKey),
  )
  onCleanup(() => writeDisclosure(mountKey, toolOpen))
  // document-level click capture: records the toggled row key (used by the
  // compensation predicate above); idempotent
  armToggleAnchor()
  const renderer = createSessionTimelineRowRenderer({
    sessionID: () => props.doc.sessionID,
    status: () => props.doc.status,
    projection,
    presentation: (message) => props.presentation?.[message.id],
    reasoningMode: () => props.reasoningMode ?? "compact",
    shellToolDefaultOpen: () => props.shellToolDefaultOpen ?? false,
    editToolDefaultOpen: () => props.editToolDefaultOpen ?? false,
    toolDefaultOpen: props.toolDefaultOpen,
    disclosure: {
      // precedence: a live search PRE-OPENS its hits, so a matching row is
      // already open on its first paint (never clicked at arrival); a
      // manual collapse during that search wins for that search; then the
      // user's (and engine's) stored state
      value: (key) =>
        searchKeyDismissed(key)
          ? undefined
          : searchOwnsDisclosure(key)
            ? true
            : (toolOpen[key] ?? (disclosureOwned(key) ? true : undefined)),
      set: (key, open) => {
        if (engineClicking()) {
          // the engine clicks non-derivable rows (groups, patch cards):
          // record ownership so a clear closes them
          claimDisclosure(key, open)
          setToolOpen(key, open)
          writeDisclosure(mountKey, toolOpen)
          return
        }
        if (searchOwnsDisclosure(key)) {
          // the user toggled a search-owned row: record it for THIS search
          // (a new search re-expands) instead of writing persistent state
          dismissSearchKey(key, open)
          return
        }
        if (!open) releaseDisclosure(key)
        setToolOpen(key, open)
        writeDisclosure(mountKey, toolOpen)
        // NO JS scroll compensation here, ever: tanstack's
        // shouldAdjustScrollPositionOnItemSizeChange owns the virtualized path
        // (its predicate never scrolls for growth below the fold). A JS settle
        // pins the trigger against a TRANSIENT spring-bounce delta and scrolls
        // by it, so opening a tall cluster near the top pushes the title up out
        // of reach (headless runs skip the spring and never show it).
      },
    },
    // drives per-row default-open (Tool outputs / Expanded reasoning)
    timelineDetail: props.timelineDetail && (() => props.timelineDetail!),
  })

  let scrollElement: HTMLDivElement | undefined
  const [pinned, setPinned] = createSignal(props.anchor !== "start")
  // scroll pulse: the virtualizer is not a Solid store, so effects that
  // must re-run per scroll position subscribe to this counter (bumped in
  // onScroll) instead of hoping adapter property reads are tracked
  const [scrollTick, setScrollTick] = createSignal(0)
  const rows = projection.rows
  const rowKeys = createMemo(() => (rows() ?? []).map(TimelineRow.key))

  // a deep link owns the initial position: replaying the last session offset
  // would snap the reader back before/after the jump (the jump lands, then the
  // restored offset overwrites scrollTop)
  const deepAtMount = !!rowKeyFromHash(location.hash)
  // snapshots are all-or-nothing: the offset and the heights are a PAIR.
  // Restoring the offset without its heights plants the reader at a
  // position estimate-based layout cannot honor (tall rows born at 90px
  // get painted over until measured - the cut-off big prompt); restoring
  // heights from another wrap width mangles the layout. Same width ->
  // exact restore; different width -> fresh layout, position handled by
  // the hide/show anchor
  const snap = deepAtMount ? undefined : readSnapshot(mountKey)
  const restored = snap && snap.width != null && Math.abs(snap.width - viewportWidth()) <= 8 ? snap : undefined
  const initialMeasurementsCache = restored?.items.map((item) => ({
    index: item.index,
    key: item.key,
    start: item.start,
    size: item.size,
    end: item.start + item.size,
    lane: 0,
  }))
  const [cacheGrace, setCacheGrace] = createSignal(!!restored)

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return rowKeys().length
    },
    getScrollElement: () => scrollElement ?? null,
    estimateSize: (index: number) => {
      const key = rowKeys()[index]
      const known = measurementCache.get(key)
      if (known !== undefined) return known
      // an open reasoning panel mounts at a broadly known height; the
      // generic 90px estimate makes post-flip scroll-backs grow rows in
      // steps (scrollbar jumps "as if animating open"). Approximation
      // only: the real measure replaces it on mount
      if (key.includes(":reasoning:") && document.documentElement.dataset.oshReasoning === "open") return 420
      return ESTIMATE
    },
    overscan: 40,
    getItemKey: (index: number) => rowKeys()[index] ?? `row:${index}`,
    initialMeasurementsCache,
    // grace window after a snapshot restore: while on, measureElement
    // returns the SNAPSHOT size instead of reading the DOM, so the
    // instant-markdown fallback cannot override correct heights and the
    // rich parse cannot flip them back (the reload/maximize drift: every
    // flip bumps the scroll, compounding with depth, jumping at the end).
    // The snapshot was captured from the fully-rich layout at the same
    // width, so real heights EQUAL cached ones - the handoff back to live
    // measurement (first user input or 2s) moves nothing
    get useCachedMeasurements() {
      return cacheGrace()
    },
  })

  // keep the reader's anchor when a row above the viewport is re-measured
  // (the option is a Virtualizer field, not an option in this version).
  // NEVER compensate the row the user just toggled: its growth should extend
  // downward from its own trigger (the anchor the user cares about), not push
  // the trigger up out of view.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    item.key !== getLastToggledRowKey() && item.start < (instance.scrollOffset ?? 0)

  // restore-path detachers (end-chase, row-assert) register here: they
  // arm inside a queueMicrotask, which has NO solid owner, so an
  // onCleanup there silently no-ops and the listeners leak on unmount
  const restoreCleanups: Array<() => void> = []
  onCleanup(() => {
    for (const fn of restoreCleanups) {
      try { fn() } catch {}
    }
    restoreCleanups.length = 0
  })

  // Stale-size convergence: rows that mount or resize during fast scroll
  // lose their deferred measurement to the virtualizer's mid-scroll drop
  // guards, and the ResizeObserver never re-fires without another
  // transition — the row then keeps its 90px estimate forever while its
  // real height is hundreds or thousands of px, and every row below it
  // is positioned inside its content (probe on a live share: 15 rows
  // kept the estimate mid-pass, 9.3k px of cumulative error). At
  // scroll-settle no guard applies, so one pass of measureElement over
  // every mounted row converges the whole layout.
  let sweepTimer: ReturnType<typeof setTimeout> | undefined // legacy slot cleared on unmount
  // Cached-measurement handoff: tanstack's measureElement returns the
  // CACHE entry for any direct call while one exists (virtual-core
  // short-circuits before reading the DOM); only the ResizeObserver
  // entry path bypasses it, and RO fires solely on an actual height
  // CHANGE. A row whose height changed while measurement was frozen
  // (snapshot grace: tool expanded when saved, collapsed on reload)
  // therefore keeps its stale size forever. Invalidate exactly the
  // rows whose cache entry disagrees with the DOM: matching entries
  // survive untouched, so nothing estimates and nothing jiggles.
  // During the grace window only the LOST-DISCLOSURE class converges
  // early: a tool/reasoning row that mounts COLLAPSED (trigger present,
  // no mounted collapsible content - closed content unmounts) has no
  // async height future, so a large cached-minus-DOM gap is permanently
  // stale and converging at mount kills the phantom immediately. Every
  // other row (text parts between fallback and rich markdown, open tool
  // bodies awaiting pierre's first paint) still has height growth in
  // flight - the cached size is the FINAL one there, and converging to
  // the transient DOM height re-introduces blank-then-snap completions
  // and drags the reload anchor below its target.
  const convergeRow = (el: HTMLDivElement) => {
    if (!el.isConnected || el.dataset.index === undefined) return
    const v = virtualizer as any
    if (!v.itemSizeCache) return
    const index = Number(el.dataset.index)
    if (!Number.isFinite(index)) return
    // STALE-INDEX GUARD: cached out-of-window rows keep the data-index
    // they last rendered with; after any insertion/removal that index
    // maps to a DIFFERENT key, and an unguarded measure writes this
    // row's height onto the wrong item. Only trust the pairing when it
    // still resolves to this row's own key
    if (virtualizer.options.getItemKey(index) !== el.dataset.rowKey) return
    const key = el.dataset.rowKey as string
    const cached = v.itemSizeCache.get(key) as number | undefined
    if (cached === undefined) return
    const delta = Math.abs(cached - el.offsetHeight)
    if (delta <= 1) return
    if (cacheGrace()) {
      // only the collapsed-disclosure row, whose height is final NOW
      // (no mounted collapsible content): converging it at mount kills
      // the phantom gap immediately. Every other row (text parts between
      // fallback and rich markdown, open tool bodies awaiting pierre's
      // first paint) still has height growth in flight - the cached size
      // is the FINAL one there
      if (delta <= 80) return
      if (!el.querySelector('[data-component="tool-trigger"]')) return
      if (el.querySelector('[data-slot="collapsible-content"]')) return
    }
    v.itemSizeCache.delete(key)
    virtualizer.measureElement(el)
  }
  const sweep = () => {
    // read/compare per row and only invoke measureElement for a row whose
    // cached size is absent or differs: re-measuring every mounted row
    // issued one virtualizer notification for every unchanged height at
    // each scroll settle (several thousand redundant updates after a
    // traversal, and layout work on the browser's main thread)
    for (const { el } of rowEls.values()) {
      if (!el.isConnected || el.dataset.index === undefined) continue
      const key = el.dataset.rowKey as string
      if (virtualizer.options.getItemKey(Number(el.dataset.index)) !== key) continue
      const cached = (virtualizer as any).itemSizeCache?.get(key) as number | undefined
      if (cached !== undefined && Math.abs(cached - el.offsetHeight) <= 1) continue
      if (cached !== undefined) {
        convergeRow(el)
        measurementCache.set(key, (virtualizer as any).itemSizeCache.get(key) ?? el.offsetHeight)
        continue
      }
      // no cached slot yet: convergeRow needs one, so use the kit's normal
      // measurement path then keep the estimate cache in step
      virtualizer.measureElement(el)
      measurementCache.set(key, (virtualizer as any).itemSizeCache.get(key) ?? el.offsetHeight)
    }
  }
  // debounced arm for scroll-settle (same-delay re-arms coalesce) plus
  // independent passes for the flip's two-step convergence (a single
  // debounced timer made the 400ms pass silently vanish under the later
  // 1400ms one)
  const sweepTimers = new Set<ReturnType<typeof setTimeout>>()
  const scheduleSweep = (delay: number) => {
    const t = setTimeout(() => {
      sweepTimers.delete(t)
      sweep()
    }, delay)
    sweepTimers.add(t)
    return t
  }
  let sweepDebounce: ReturnType<typeof setTimeout> | undefined
  const armSweep = (delay = 180) => {
    if (sweepDebounce) clearTimeout(sweepDebounce)
    sweepDebounce = scheduleSweep(delay)
  }
  const measureRowSoon = (() => {
    // one in-flight loop per key: every onSizeChange used to start a
    // fresh 30-frame rAF chain, stacking overlapping loops during
    // streaming bursts
    const inflight = new Map<string, () => void>()
    return (key: string) => {
      // Retry a FIXED window (~30 frames): a measure that lands mid-scroll
      // is silently dropped by the virtualizer (isScrolling guard), and a
      // row mid expand/collapse ANIMATION reads "converged" at its
      // pre-animation height - stopping at first convergence misses the
      // whole animation, leaving rows below at stale offsets for the
      // first frames (probe: 79px overlap). Feeding the size every frame
      // for the animation's duration keeps the layout in step. Rows
      // outside the virtual window have no item to verify against; the
      // settle sweep owns those.
      inflight.get(key)?.()
      let tries = 0
      let stop = false
      const cancel = () => { stop = true }
      inflight.set(key, cancel)
      const tick = () => {
        if (stop) return
        const el = rowEls.get(key)?.el
        if (!el?.isConnected) {
          inflight.delete(key)
          return
        }
        virtualizer.measureElement(el)
        if (++tries < 30) requestAnimationFrame(tick)
        else inflight.delete(key)
      }
      requestAnimationFrame(tick)
    }
  })()

  // measure through tanstack's own measureElement (it owns the resize
  // observer and writes real heights back per index). A hand-rolled
  // rAF/ResizeObserver + measure() path leaves rows placed by the estimate,
  // which shows up as a uniform ~46px gap between rows in continuous mode
  // only (classic boxes are adjacent).
  onCleanup(() => {
    if (measurementCache.size > 4000) measurementCache.clear()
  })

  // scroll to a user message's row by id — shared by the scrollTarget
  // prop (reactive jumps) and the onReady controls (imperative calls).
  // Long smooth jumps fall back to instant: tanstack animates scrollTop
  // over estimate-based offsets and measurement corrections mid-flight
  // stutter badly across thousands of pixels.
  const scrollToMessage = (id: string, behavior?: ScrollBehavior, force?: boolean) => {
    const rows = projection.rows()
    const idx = rows.findIndex((row) => {
      const k = String((row as any)?._tag === "UserMessage" ? `user-message:${(row as any).userMessageID}` : "")
      return k === `user-message:${id}`
    })
    if (idx < 0) return
    if (!scrollElement) return
    let how = behavior
    if (how === "smooth" && !force) {
      // Neighbor-aware smoothing: smooth is for adjacent-turn moves (j/k,
      // rail stepping) measured from the ACTIVE turn - the first visible
      // row is a half-cut row that can belong to the previous turn, which
      // made the same jump smooth in one direction and instant in the
      // other. A far jump (search hit, palette, rail click across the
      // session) animating past dozens of turns was the "smooth scroll is
      // broken" report - snap instead. `force` (the smooth-scroll "always"
      // setting) keeps smooth regardless.
      try {
        const rank = userTurnRank(idx)
        const hereRank = lastActive !== undefined ? userTurnRankOfId(lastActive) : userTurnRank(virtualizer.getVirtualItems()[0]?.index ?? 0)
        const offset = virtualizer.getOffsetForIndex?.(idx, "start")
        const far = offset != null && scrollElement && Math.abs(offset[0] - scrollElement.scrollTop) > scrollElement.clientHeight * 4
        if (far || Math.abs(rank - hereRank) > 1) how = "auto"
      } catch {}
    }
    // a deliberate jump announces its turn immediately - the scroll spy
    // only corrects after the scroll settles (it cannot see intermediate
    // turns during an instant jump)
    const target = rows[idx] as any
    if (target?._tag === "UserMessage" && props.onActiveMessageChange) props.onActiveMessageChange(target.userMessageID)
    // tanstack's own offset math (estimate-based; the measurement pass
    // corrects around the jump)
    virtualizer.scrollToIndex(idx, { align: "start", behavior: how })
  }

  // which turn (0-based user-message rank) a row index belongs to
  const userTurnRank = (idx: number): number => {
    const rows = projection.rows()
    let rank = -1
    for (let i = 0; i <= Math.min(idx, rows.length - 1); i++) {
      if ((rows[i] as any)?._tag === "UserMessage") rank++
    }
    return rank
  }

  // the rank of a user-message id (its position among the turns)
  const userTurnRankOfId = (id: string): number => {
    const rows = projection.rows()
    let rank = -1
    for (const row of rows as any[]) {
      if (row?._tag !== "UserMessage") continue
      rank++
      if (row.userMessageID === id) break
    }
    return rank
  }

  // continuous-mode fast-skip: jump to a user message row by id
  createEffect(() => {
    const target = props.scrollTarget
    if (!target) return
    scrollToMessage(target.id, target.behavior, target.force)
  })

  // mass disclosure flips (settings.ts) re-render EVERY mounted row's
  // content, but the render loop only repositions rows inside the
  // current window: out-of-window mounted rows keep stale transforms
  // under grown painted heights and their boxes overlap the viewport
  // until a range-shifting scroll re-renders them (the post-flip
  // mangle). Disposing them is safe - the row cache is a scroll
  // convenience, disclosure state lives in the module map, and
  // scroll-back remounts rows already measured. Runs post-render (rAF)
  // so the flip's expansion has landed, then forces a re-measure pass
  // so the window's transforms and total size refresh in one notify.
  const onFlip = () => {
    // capture the reader's anchor BEFORE the flip reflows everything:
    // a mass collapse shrinks thousands of px above the viewport and the
    // compensation cascade dies in the reflow freeze, dropping the
    // reader tens of rows down the list. Re-pin after settle.
    const anchor = visualTopRow(true)
    const anchorIndex = anchor.index !== undefined && Number.isFinite(anchor.index) ? anchor.index : undefined
    const anchorKey = anchor.key
    requestAnimationFrame(() => {
      if (!rowEls.size) return
      const windowKeys = new Set(virtualizer.getVirtualItems().map((item) => String(item.key)))
      for (const [key, entry] of rowEls) {
        if (windowKeys.has(key)) continue
        entry.el.remove()
        entry.dispose()
        rowEls.delete(key)
        // re-measured on scroll-back remount; the stale entry would
        // re-seed the estimate at the pre-flip height
        measurementCache.delete(key)
      }
      virtualizer.measure()
      // convergence without a scroll nudge: the sweep normally rides on
      // scroll, but the reader has not scrolled - the flip did. Two
      // INDEPENDENT passes (armSweep debounces, which silently ate the
      // early pass when both went through it)
      scheduleSweep(400)
      scheduleSweep(1400)
      if (anchorIndex === undefined || !anchorKey) return
      let cancelled = false
      const onWheel = () => { cancelled = true }
      const onPointer = () => { cancelled = true }
      const onKey = () => { cancelled = true }
      window.addEventListener("wheel", onWheel, { passive: true })
      window.addEventListener("pointerdown", onPointer, { passive: true })
      window.addEventListener("keydown", onKey, { passive: true })
      // GLUE, not a late pin: re-pinning after the cascade shows the
      // reader a drift-then-snap. Hold the anchor row at the viewport
      // top every frame through the whole reflow instead - the position
      // never visibly moves. scrollToIndex is only a bootstrap for an
      // anchor that lost its element (estimate sums alone land wrong)
      const t0 = performance.now()
      let bootstrapped = false
      const detach = () => {
        window.removeEventListener("wheel", onWheel)
        window.removeEventListener("pointerdown", onPointer)
        window.removeEventListener("keydown", onKey)
      }
      const glue = () => {
        if (cancelled) {
          detach()
          return
        }
        const el = rowEls.get(anchorKey!)?.el
        if (el && el.isConnected && scrollElement) {
          const delta = el.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top
          if (Math.abs(delta) > 1) scrollElement.scrollTop += delta
        } else if (!bootstrapped && performance.now() - t0 > 250 && scrollElement) {
          bootstrapped = true
          virtualizer.scrollToIndex(anchorIndex, { behavior: "auto", align: "start" })
        }
        if (performance.now() - t0 < 2600) requestAnimationFrame(glue)
        else detach()
      }
      requestAnimationFrame(glue)
    })
  }
  window.addEventListener("osh-flip", onFlip)
  onCleanup(() => window.removeEventListener("osh-flip", onFlip))

  // imperative controls for the parent (focus mode, hotkeys, rail)
  onMount(() => {
    props.onReady?.({ scrollToMessage: (id) => scrollToMessage(id) })
    // the virtualizer learns the scroll offset ONLY from scroll events
    // that reach its listener (scrollOffset starts null and falls back
    // to 0 until the first one arrives; a synthetic dispatch DOES
    // update it, but only once the listener exists). Whatever sets
    // scrollTop before the listener attaches - the snapshot restore
    // microtask, the browser's own session restoration, a
    // resize-preserved position - leaves the instance believing offset 0
    // while the real scrollTop is thousands of px: it renders the TOP
    // rows over the viewport (the phantom overlay) and every out-of-range
    // measure is dropped, so nothing self-heals until the first real
    // scroll. A 1px round-trip (two real events, no visible movement)
    // forces the sync - retried on a schedule because the adapter
    // attaches its scroll listener at an unpredictable moment on fast
    // remounts (a viewport crossing mounts this component mid-resize)
    const jitterTimers: ReturnType<typeof setTimeout>[] = []
    const jitter = () => {
      try {
        const el = scrollElement
        if (!el || el.scrollTop <= 40) return
        const st = el.scrollTop
        el.scrollTop = st + 1
        el.scrollTop = st
      } catch {}
    }
    jitterTimers.push(setTimeout(jitter, 150), setTimeout(jitter, 400), setTimeout(jitter, 900), setTimeout(jitter, 1800))
    requestAnimationFrame(jitter)
    onCleanup(() => {
      for (const t of jitterTimers) clearTimeout(t)
    })
  })

  // ---- deep links (see src/deep-link.ts) --------------------------------
  // A row's projection key is the anchor. Jumping scrolls the row into view,
  // opens a collapsed row, and flashes it so the target is unmistakable.
  const jumpToRowKey = (key: string): boolean => {
    const rows = projection.rows()
    const idx = rows.findIndex((row) => TimelineRow.key(row as never) === key)
    if (idx < 0 || !scrollElement) return false
    const offset = virtualizer.getOffsetForIndex?.(idx, "start")
    if (offset) scrollElement.scrollTop = offset[0]
    // Measurement settles after the first paint (rows below/above were
    // estimates), which can shift the target. Re-assert the position from
    // the MEASURED offset a few times until it holds.
    const settle = (n: number) => {
      setTimeout(() => {
        if (!scrollElement) return
        const next = virtualizer.getOffsetForIndex?.(idx, "start")
        if (next && Math.abs(next[0] - scrollElement.scrollTop) > 4) scrollElement.scrollTop = next[0]
        if (n > 0) settle(n - 1)
      }, 220)
    }
    settle(4)
    // the row mounts a few frames after the scroll (tanstack re-windows),
    // so retry the reveal until it exists
    let tries = 0
    const reveal = () => {
      const el = host?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`)
      if (!el && tries++ < 20) {
        requestAnimationFrame(reveal)
        return
      }
      if (!el) return
      // a collapsed row would hide the very content the link promises -
      // open it when the row owns a disclosure trigger
      const trigger = el.querySelector<HTMLElement>('button[data-slot="collapsible-trigger"]')
      if (trigger && trigger.getAttribute("aria-expanded") === "false") trigger.click()
      el.classList.add("osh-deep-flash")
      setTimeout(() => el.classList.remove("osh-deep-flash"), 3600)
    }
    requestAnimationFrame(reveal)
    return true
  }

  let deepHash = ""
  createEffect(() => {
    // re-run when rows materialize (data arrival) and on hash changes.
    // Once per page load per hash: a widen remount (narrow -> desktop
    // unmounts this component) re-runs the effect, and re-jumping would
    // snap a reader who scrolled away back to the link target; a real
    // navigation or reload (fresh module state) jumps again
    const rows = projection.rows()
    const key = rowKeyFromHash(location.hash)
    if (!key || rows.length === 0) return
    if (deepHash === location.hash) return
    if (consumedDeepLinks.has(mountKey + location.hash)) {
      deepHash = location.hash
      return
    }
    if (jumpToRowKey(key)) {
      deepHash = location.hash
      consumedDeepLinks.add(mountKey + location.hash)
    }
  })
  onMount(() => {
    const onHash = () => {
      deepHash = ""
      const key = rowKeyFromHash(location.hash)
      if (key) jumpToRowKey(key)
    }
    window.addEventListener("hashchange", onHash)
    onCleanup(() => window.removeEventListener("hashchange", onHash))
  })

  // deep-link affordance: ctrl+click a message copies its link. No floating
  // button: a fixed chip pinned to the scroller edge flickers between
  // clickable and not while the pointer crosses it, and it covers content.
  // Holding Ctrl outlines message bodies so it is findable. Ctrl+click a
  // MESSAGE copies a link to where it starts: rows are finer than messages
  // (an assistant message is many part rows) and gap/spacer rows carry no
  // content, so both the outline and the copy resolve through the message's
  // first content row.
  const messageStartKey = (row: HTMLElement): string | undefined => {
    const key = row.dataset.rowKey ?? ""
    if (!key || !row.innerText.trim()) return undefined
    const marker = row.querySelector("[data-message-id]")?.getAttribute("data-message-id")
    const id = marker ?? key.match(/msg_[A-Za-z0-9]+/)?.[0]
    if (!id) return undefined
    if (key.startsWith("user-message:")) return key
    const host = row.closest("[data-transcript-content]") ?? document
    const first = [...host.querySelectorAll<HTMLElement>("[data-row-key]")].find(
      (el) => (el.dataset.rowKey ?? "").includes(id) && el.innerText.trim(),
    )
    return first?.dataset.rowKey
  }
  const onLinkClick = (event: MouseEvent) => {
    if (!event.ctrlKey) return
    const row = (event.target as Element | null)?.closest<HTMLElement>("[data-row-key]")
    if (!row) return
    const key = messageStartKey(row)
    if (!key) return
    event.preventDefault()
    event.stopPropagation()
    void copyRowLink(key)
  }
  // reveal the gesture: while Ctrl is held, one box per MESSAGE marks the
  // link targets. Rows are absolutely positioned by the virtualizer, so a
  // message's parts cannot share a CSS box; the boxes are computed from the
  // rendered rows and repainted on scroll.
  const [linkBoxes, setLinkBoxes] = createSignal<Array<{ id: string; top: number; height: number }>>([])
  const refreshLinkBoxes = () => {
    const sc = scrollElement
    if (!sc || !document.documentElement.hasAttribute("data-osh-linkmode")) return
    const base = sc.getBoundingClientRect()
    const groups = new Map<string, { top: number; bottom: number }>()
    for (const row of sc.querySelectorAll<HTMLElement>("[data-row-key]")) {
      const key = row.dataset.rowKey ?? ""
      if (!key.startsWith("user-message:") && !key.startsWith("assistant-part:")) continue
      if (!row.innerText.trim()) continue
      const id = key.match(/msg_[A-Za-z0-9]+/)?.[0]
      if (!id) continue
      const r = row.getBoundingClientRect()
      const top = r.top - base.top + sc.scrollTop
      const bottom = r.bottom - base.top + sc.scrollTop
      const g = groups.get(id)
      if (!g) groups.set(id, { top, bottom })
      else {
        g.top = Math.min(g.top, top)
        g.bottom = Math.max(g.bottom, bottom)
      }
    }
    setLinkBoxes([...groups].map(([id, g]) => ({ id, top: Math.round(g.top), height: Math.round(g.bottom - g.top) })))
  }
  onMount(() => {
    const root = document.documentElement
    const down = (e: KeyboardEvent) => {
      if (e.key !== "Control") return
      root.setAttribute("data-osh-linkmode", "")
      requestAnimationFrame(refreshLinkBoxes)
    }
    const up = (e: KeyboardEvent) => {
      if (e.key !== "Control") return
      root.removeAttribute("data-osh-linkmode")
      setLinkBoxes([])
    }
    const blur = () => {
      root.removeAttribute("data-osh-linkmode")
      setLinkBoxes([])
    }
    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    window.addEventListener("blur", blur)
    onCleanup(() => {
      window.removeEventListener("keydown", down)
      window.removeEventListener("keyup", up)
      window.removeEventListener("blur", blur)
      blur()
    })
  })
  // pin state: at end → pinned (follows new content); nudge up → unpinned
  const onScroll = () => {
    const el = scrollElement
    if (!el) return
    // keep the virtualizer's tracked offset equal to the REAL scrollTop:
    // its own scroll listener can die across hidden phases, and a stale
    // offset freezes the rendered range to the wrong window
    const v = virtualizer as any
    if (v.scrollOffset != null && Math.abs((v.scrollOffset as number) - el.scrollTop) > 0.5) {
      v.scrollOffset = el.scrollTop
      v.maybeNotify?.()
    }
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= END_EPSILON
    if (atEnd !== pinned()) setPinned(atEnd)
    setScrollTick((n) => n + 1)
    saveSnapshot()
    armSweep()
  }

  // debounced snapshot of measured rows + offset (restores exact layout)
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  // last anchor captured while rows were alive: solid runs cleanups LIFO,
  // so the row-dispose cleanup (registered later) runs BEFORE the unmount
  // save below and visualTopAnchor() would find no rows - cache the anchor
  // on every save and reuse it at unmount
  let lastAnchor: { key?: string; delta: number } = { delta: 0 }
  const anchorPayload = () => {
    const a = visualTopAnchor()
    if (a.key) lastAnchor = a
    return lastAnchor.key ? { topKey: lastAnchor.key, topDelta: lastAnchor.delta } : {}
  }
  const saveSnapshot = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      const el = scrollElement
      if (!el) return
      writeSnapshot(mountKey, {
        items: virtualizer.takeSnapshot() as Snapshot["items"],
        offset: el.scrollTop,
        width: viewportWidth(),
        // a bottom-clamped offset carries clamp error into the anchor
        // delta (the "lands a bit below" reload residue); at-end restores
        // pin to the end instead of asserting a row. Tolerance is loose:
        // the clamp can land while content is mid-measure, leaving the
        // saved position a few dozen px above the then-current end
        atEnd: el.scrollHeight - el.scrollTop - el.clientHeight <= 48,
        ...anchorPayload(),
      })
    }, 200)
  }

  // width changes need NO manual heal here: rows keep natural heights and
  // tanstack's per-row ResizeObserver re-measures each one as its content
  // re-wraps (probed: layout is coherent immediately after resize). The
  // one thing rows cannot heal is a REMOUNT replaying heights measured at
  // another width - that is what the snapshot width-gate above prevents.
  // A manual clear+measure here actively broke the layout: it reset the
  // already-corrected per-row measurements back to estimates, which read
  // as gapped/overlapping rows until the next scroll-settle sweep
  // re-measured them.

  // follow new content while pinned, but never on the first run when a
  // restored offset exists (that would snap a returning reader to the end)
  let lastCount = 0
  createEffect(() => {
    const count = rowKeys().length
    const grew = count > lastCount
    const first = lastCount === 0
    lastCount = count
    // data refolds (live growth, undo, settings) land rows whose real
    // heights differ from cached estimates — converge shortly after
    armSweep(400)
    if (first && restored) return
    if (props.followLive === false) return
    if (!grew || !pinned() || count === 0 || !scrollElement) return
    queueMicrotask(() => {
      const el = scrollElement
      if (el) el.scrollTop = el.scrollHeight
    })
  })

  onCleanup(() => {
    if (saveTimer) clearTimeout(saveTimer)
    if (sweepTimer) clearTimeout(sweepTimer)
    for (const t of sweepTimers) clearTimeout(t)
    sweepTimers.clear()
    const el = scrollElement
    if (el && el.scrollHeight > 0) {
      // same shape as the scroll-path save: the read gate rejects
      // width-less snapshots, so an unmount-save without width threw the
      // good scroll-save away and the next mount restored from stale data
      writeSnapshot(mountKey, {
        items: virtualizer.takeSnapshot() as Snapshot["items"],
        offset: el.scrollTop,
        width: viewportWidth(),
        atEnd: el.scrollHeight - el.scrollTop - el.clientHeight <= 48,
        // cached anchor: rows are already disposed by the LIFO cleanup
        // order, so visualTopAnchor() would read nothing here
        ...(lastAnchor.key ? { topKey: lastAnchor.key, topDelta: lastAnchor.delta } : {}),
      })
    }
    if (measurementCache.size > 4000) measurementCache.clear()
  })

  const items = virtualizer.getVirtualItems()

  // active turn tracking: the turn whose content spans the viewport CENTER
  // is "the turn you are reading" - a turn is its prompt AND its responses,
  // so the switch to the next turn happens when the center passes that
  // turn's prompt, not the viewport top. The title's model and the rail's
  // marker follow it. Emits only on change.
  // Resolved from the virtualizer's FULL measurement cache, not the
  // mounted window: during an instant jump the window teleports and the
  // turns it flew over are never mounted, so a window-based spy skipped
  // them (progress 1 -> 4, never 2/3). With full measurements every turn
  // boundary is visible even unmounted.
  let lastActive: string | undefined
  createEffect(() => {
    if (!props.onActiveMessageChange) return
    void scrollTick()
    const rows = projection.rows()
    const el = scrollElement
    const scrollTop = el?.scrollTop ?? 0
    // the virtualizer's offsets are relative to the CONTENT div, which sits
    // below the header block inside the scroller - convert to scroller
    // coordinates or every boundary lands ~headerHeight early
    const origin = host && el ? host.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop : 0
    const center = scrollTop + (el?.clientHeight ?? 0) / 2
    const cache = (virtualizer as any).measurementsCache as Array<{ start: number }> | undefined
    let current: string | undefined
    let last = ""
    for (const row of rows as any[]) {
      if (row?._tag === "UserMessage") last = row.userMessageID
    }
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as any
      if (row?._tag !== "UserMessage") continue
      const start = cache?.[i]?.start
      // unmeasured tail (estimates only): positions before the center are
      // settled, positions after are approximations
      const pos = start !== undefined ? origin + start : Number.POSITIVE_INFINITY
      if (pos > center && current) break
      current = row.userMessageID
    }
    // end of page: the last turn's prompt can never reach the center (not
    // enough content below it), so bottom-rest means the last turn.
    // Computed from the element - pinned()'s pre-scroll initial state
    // cannot be trusted here.
    const atEnd = !!el && el.scrollHeight - el.scrollTop - el.clientHeight <= END_EPSILON
    if (atEnd && last) current = last
    if (current && current !== lastActive) {
      lastActive = current
      props.onActiveMessageChange(current)
    }
  })

  // KEYED ROW CACHE (smart-sync): one component + DOM node per row key,
  // created in its own root and REUSED for the component's lifetime. A
  // data update repositions rows (transform) and lets the reactive row
  // accessor update content IN PLACE - it never remounts a row that still
  // exists, so open tools, expanded bodies and scroll anchors survive
  // every sync. Rows whose key leaves the projection entirely (revert /
  // tombstone deletion) are disposed. Replaces both the original unkeyed
  // items.map (remount storm, orphaned measurements) and the interim
  // <For> (keyed by virtual-item identity, which tanstack does not
  // guarantee across notifies).
  let host: HTMLDivElement | undefined
  const rowEls = new Map<string, { el: HTMLDivElement; dispose: () => void }>()
  const ROW_CACHE_CAP = 500

  // the visual-first row intersecting the viewport top, in VISUAL order
  // (rowEls is creation-ordered; DOM/map order reads a wrong row), plus
  // its signed offset from the viewport top. Used as the snapshot's
  // position anchor: heights saved alongside it can carry estimate-
  // poisoned slots (rows disposed by a mass flip and snapshotted before
  // remount), and a pixels-only restore then lands on the wrong row;
  // restoring BY ROW + DELTA is immune to that and reproduces partially-
  // scrolled positions exactly (a cut row's top belongs above the fold)
  // the visual-first row intersecting the viewport top, in VISUAL order
  // (rowEls is creation-ordered; DOM/map order reads a wrong row), plus
  // its signed offset from the viewport top. Shared by the snapshot
  // anchor and the flip's pre-capture; the flip additionally needs the
  // row's virtualizer index, so it passes withIndex
  const visualTopRow = (withIndex = false): { key?: string; delta: number; index?: number } => {
    const el = scrollElement
    if (!el) return { delta: 0 }
    const top = el.getBoundingClientRect().top
    const candidates = [...rowEls.values()]
      .map((entry) => ({ el: entry.el, r: entry.el.getBoundingClientRect() }))
      .filter((x) => x.r.height > 0 && x.r.bottom > top + 4)
      .sort((a, b) => a.r.top - b.r.top)
    const first = candidates[0]
    if (!first) return { delta: 0 }
    const idx = withIndex && first.el.dataset.index !== undefined ? Number(first.el.dataset.index) : undefined
    return { key: first.el.dataset.rowKey, delta: Math.round(first.r.top - top), index: idx }
  }
  const visualTopAnchor = (): { key?: string; delta: number } => {
    const { key, delta } = visualTopRow()
    return { key, delta }
  }

  createEffect(() => {
    const vis = items
    const h = host
    if (!h) return
    const inWindow = new Set<string>()
    for (const item of vis) {
      const key = String(item.key)
      inWindow.add(key)
      let entry = rowEls.get(key)
      if (!entry) {
        const [dispose, el] = createRoot((dispose) => {
          const node = (
            <div
              data-row-key={key}
              // rows that mount during a mass-disclosure flip (virtualizer
              // growth while hundreds of panels re-open) snap open with
              // the rest of the off-screen rows - see settings.ts
              // markMassDisclosureFlip
              class={document.documentElement.hasAttribute("data-osh-flip") ? "osh-snap-row" : undefined}
              ref={(el) => {
                // tanstack's measureElement early-returns when the index
                // is outside the computed range, and at ref time the range
                // is not computed yet - defer the first measure; the
                // virtualizer's observer takes over from there. GUARD:
                // skip detached nodes - measuring one reports 0, poisons
                // the size cache and feeds the measure/remount churn.
                requestAnimationFrame(() => {
                  if (el.isConnected) {
                    virtualizer.measureElement(el)
                    convergeRow(el)
                  }
                })
              }}
              style={{
                position: "absolute",
                top: "0",
                left: "0",
                width: "100%",
              }}
            >
              {/* reactive like the kit's own Row memo: re-reads the CURRENT
                  projection per update without remounting this row. Falls
                  back to the last known row object for the tick between a
                  deletion and the prune effect. A row whose key has not
                  landed in rowByKey yet (session swap: the virtualizer's
                  items can carry a new key before the projection memo
                  publishes) renders a zero-impact TurnGap for that tick; a NULL
                  row throws inside the renderer's TimelineRow.key Match
                  ("exhaustive: absurd") and kills the page on subagent pages. */}
              {(() => {
                let last: unknown = null
                return (
                  <renderer.Row
                    row={() => ((last = projection.rowByKey().get(key) ?? last) ?? new TimelineRow.TurnGap({ userMessageID: key })) as never}
                    // the kit signals async render completion through this
                    // (markdown worker done, media loaded, reasoning body
                    // rendered); the opening reasoning panel handles its
                    // own reservation in the vendored open handler (the
                    // row's height must not animate - RO intermediates lag
                    // the virtualizer a frame), everything else re-measures
                    // per frame for the animation's duration
                    onSizeChange={() => {
                      measureRowSoon(key)
                      armSweep()
                    }}
                  />
                )
              })()}
            </div>
          ) as HTMLDivElement
          return [dispose, node] as const
        })
        entry = { el, dispose }
        rowEls.set(key, entry)
        h.appendChild(el)
      }
      entry.el.dataset.index = String(item.index)
      entry.el.style.transform = `translateY(${item.start}px)`
    }
    // evict off-window entries when the cache grows past cap (scrolled-
    // away rows keep their components otherwise)
    if (rowEls.size > ROW_CACHE_CAP) {
      for (const [key, entry] of rowEls) {
        if (rowEls.size <= ROW_CACHE_CAP) break
        if (inWindow.has(key)) continue
        entry.el.remove()
        entry.dispose()
        rowEls.delete(key)
      }
    }
  })

  // rows removed from the projection (undo/revert tombstones) dispose
  // cleanly - their reactive roots must not linger
  createEffect(() => {
    const live = new Set(rowKeys())
    for (const [key, entry] of rowEls) {
      if (live.has(key)) continue
      entry.el.remove()
      entry.dispose()
      rowEls.delete(key)
    }
  })
  onCleanup(() => {
    for (const entry of rowEls.values()) entry.dispose()
    rowEls.clear()
  })

  // Expanding a tool row or a <details> changes the row height AFTER the
  // click. tanstack re-observes elements it measured, but a grouped row that
  // was never measured (freshly scrolled into view) would keep its estimate
  // and clip while the page scrolls - re-measure the affected row directly.
  const remeasureRow = (target: EventTarget | null) => {
    const node = target instanceof Element ? target.closest<HTMLDivElement>("[data-row-key]") : null
    if (!node) return
    // same detached-node hazard as the ref measure below
    requestAnimationFrame(() => {
      if (node.isConnected) {
        virtualizer.measureElement(node)
        measurementCache.set(String(node.dataset.rowKey), node.offsetHeight)
      }
    })
  }

  return (
    <div
      class={props.class}
      ref={(el) => {
        scrollElement = el
        if (!el) return
        el.addEventListener("click", (event) => remeasureRow(event.target), true)
        el.addEventListener("toggle", (event) => remeasureRow(event.target), true)
        // end the measurement grace on DIRECT user input (never on
        // programmatic scroll events - the cascade itself emits those) or
        // after 2s, whichever first. Wired for EVERY restored mount,
        // including one whose saved offset is 0: the grace freezes
        // measurement at snapshot sizes, and a grace that never ends
        // freezes streaming rows at their estimates forever
        if (restored) {
          const endGrace = () => {
            setCacheGrace(false)
            // hand the cached measurements over to live ones: rows whose
            // height changed while grace held (disclosure lost on reload)
            // keep stale sizes otherwise - measureElement returns the
            // cache entry for direct calls, and RO never fires without a
            // height change. Rows mounting later converge at ref time.
            for (const { el } of rowEls.values()) convergeRow(el)
          }
          const graceTimer = setTimeout(endGrace, 2000)
          const inputEnds = () => {
            clearTimeout(graceTimer)
            endGrace()
          }
          el.addEventListener("wheel", inputEnds, { once: true, passive: true })
          el.addEventListener("touchstart", inputEnds, { once: true, passive: true })
          el.addEventListener("pointerdown", inputEnds, { once: true, passive: true })
          const onKey = (e: KeyboardEvent) => {
            if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) {
              inputEnds()
              window.removeEventListener("keydown", onKey)
            }
          }
          window.addEventListener("keydown", onKey)
          onCleanup(() => {
            clearTimeout(graceTimer)
            window.removeEventListener("keydown", onKey)
          })
        }
        if (!restored?.offset) return
        // replay the saved position once the snapshot's heights are in place
        queueMicrotask(() => {
          el.scrollTop = restored.offset
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight <= END_EPSILON)
          if (restored.atEnd) {
            // end-pinned restores stay glued to the end (the chase is
            // idempotent while the grace window holds scrollHeight stable).
            // ANY direct input cancels the chase - a wheel-only cancel let
            // touch swipes, scrollbar drags and arrow keys get yanked back
            // to the bottom on the next timer tick
            const chase = () => {
              try {
                el.scrollTop = el.scrollHeight
                ;(virtualizer as any).scrollOffset = el.scrollTop
                ;(virtualizer as any).maybeNotify?.()
              } catch {}
            }
            chase()
            const timers = [600, 1400, 2600, 4200].map((ms) => setTimeout(chase, ms))
            const cancel = () => {
              for (const t of timers) clearTimeout(t)
              el.removeEventListener("wheel", cancel)
              el.removeEventListener("touchstart", cancel)
              el.removeEventListener("pointerdown", cancel)
              window.removeEventListener("keydown", keyCancel)
            }
            const keyCancel = (e: KeyboardEvent) => {
              if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) cancel()
            }
            el.addEventListener("wheel", cancel, { passive: true })
            el.addEventListener("touchstart", cancel, { passive: true })
            el.addEventListener("pointerdown", cancel, { passive: true })
            window.addEventListener("keydown", keyCancel)
            restoreCleanups.push(cancel)
          } else if (restored.topKey) {
            // the saved heights can disagree with the real DOM (estimate-
            // poisoned slots from a mass flip); the offset alone then
            // restores to the wrong row. Assert the saved ROW + its saved
            // delta against the live element - with honest heights the
            // correction is 0. Bounded, cancelled by any direct input
            let cancelled = false
            const detach = () => {
              cancelled = true
              el.removeEventListener("wheel", onIn)
              el.removeEventListener("touchstart", onIn)
              el.removeEventListener("pointerdown", onIn)
              window.removeEventListener("keydown", keyCancel)
            }
            const onIn = () => detach()
            const keyCancel = (e: KeyboardEvent) => {
              if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) detach()
            }
            el.addEventListener("wheel", onIn, { passive: true })
            el.addEventListener("touchstart", onIn, { passive: true })
            el.addEventListener("pointerdown", onIn, { passive: true })
            window.addEventListener("keydown", keyCancel)
            const t0 = performance.now()
            const assertRow = () => {
              if (cancelled) return
              const entry = rowEls.get(restored.topKey!)
              if (entry?.el?.isConnected) {
                const delta = entry.el.getBoundingClientRect().top - (el.getBoundingClientRect().top + (restored.topDelta ?? 0))
                if (Math.abs(delta) > 1) el.scrollTop += delta
              }
              if (performance.now() - t0 < 1800) requestAnimationFrame(assertRow)
              else detach()
            }
            requestAnimationFrame(assertRow)
            restoreCleanups.push(detach)
          }
        })
      }}
      onScroll={(event) => {
        onScroll()
        if (document.documentElement.hasAttribute("data-osh-linkmode")) requestAnimationFrame(refreshLinkBoxes)
      }}
      onClick={onLinkClick}
      data-transcript-scroll
      data-osh-gutter
      style={{ "overflow-y": "auto", "min-height": "0", position: "relative", display: "flex", "flex-direction": "column" }}
    >
      {/* header/footer live in the scroll flow (normal flow, not absolute):
          the title scrolls away with the transcript. The scroller is a
          flex column and the content row grows, so the footer lands at
          the real bottom even when the transcript is shorter than the
          viewport (focus mode on a small turn) — and long transcripts
          overflow exactly as before, the explicit height is the flex
          base size. */}
      <Show when={props.header}>{props.header}</Show>
      <div
        ref={(el) => (host = el)}
        data-transcript-content
        style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%", flex: "1 0 auto" }}
      />
      <Show when={props.footer}>{props.footer}</Show>
      {/* ctrl-held link targets: one box per message, never per part */}
      <Show when={linkBoxes().length > 0}>
        <div class="osh-link-overlay" aria-hidden="true">
          <For each={linkBoxes()}>
            {(box) => <div class="osh-link-box" style={{ top: `${box.top}px`, height: `${box.height}px` }} />}
          </For>
        </div>
      </Show>
    </div>
  )
}
