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
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, createRoot, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createReactiveTimelineProjection, TimelineRow } from "@opencode/session-ui/timeline/projection"
import { armToggleAnchor, getLastToggledRowKey } from "./toggle-anchor"
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
type Snapshot = { items: RowSnapshot[]; offset: number }
const snapshotMemory = new Map<string, Snapshot>()
const snapshotKey = (sessionKey: string) => `osh:vrows:${sessionKey}`
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
    readDisclosure(props.sessionKey),
  )
  onCleanup(() => writeDisclosure(props.sessionKey, toolOpen))
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
          writeDisclosure(props.sessionKey, toolOpen)
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
        writeDisclosure(props.sessionKey, toolOpen)
        // NO JS scroll compensation here, ever (owner round 2026-10-24):
        // tanstack's shouldAdjustScrollPositionOnItemSizeChange owns the
        // virtualized path (its predicate never scrolls for growth below
        // the fold). The JS settle pinned the trigger against a TRANSIENT
        // spring-bounce delta and scrolled by it - live-caught as "opening
        // the 3-edit cluster pushes the title up out of reach" (headless
        // runs skip the spring, so automation never saw it).
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

  const restored = readSnapshot(props.sessionKey)
  const initialMeasurementsCache = restored?.items.map((item) => ({
    index: item.index,
    key: item.key,
    start: item.start,
    size: item.size,
    end: item.start + item.size,
    lane: 0,
  }))

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return rowKeys().length
    },
    getScrollElement: () => scrollElement ?? null,
    estimateSize: (index: number) => measurementCache.get(rowKeys()[index]) ?? ESTIMATE,
    overscan: 40,
    getItemKey: (index: number) => rowKeys()[index] ?? `row:${index}`,
    initialMeasurementsCache,
  })
  // keep the reader's anchor when a row above the viewport is re-measured
  // (the option is a Virtualizer field, not an option in this version).
  // NEVER compensate the row the user just toggled: its growth should
  // extend downward from its own trigger (the anchor the user cares
  // about), not push the trigger up out of view - live-caught as the
  // near-the-top expansion bug.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    item.key !== getLastToggledRowKey() && item.start < (instance.scrollOffset ?? 0)

  // measure through tanstack's own measureElement (it owns the resize
  // observer and writes real heights back per index). The old hand-rolled
  // rAF/ResizeObserver + measure() path left rows placed by the estimate,
  // which showed up as a uniform ~46px gap between rows in continuous mode
  // only (classic boxes are adjacent) — live-caught 2026-10-21.
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

  // imperative controls for the parent (focus mode, hotkeys, rail)
  onMount(() => {
    props.onReady?.({ scrollToMessage: (id) => scrollToMessage(id) })
  })

  // pin state: at end → pinned (follows new content); nudge up → unpinned
  const onScroll = () => {
    const el = scrollElement
    if (!el) return
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= END_EPSILON
    if (atEnd !== pinned()) setPinned(atEnd)
    setScrollTick((n) => n + 1)
    saveSnapshot()
  }

  // debounced snapshot of measured rows + offset (restores exact layout)
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  const saveSnapshot = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      const el = scrollElement
      if (!el) return
      writeSnapshot(props.sessionKey, {
        items: virtualizer.takeSnapshot() as Snapshot["items"],
        offset: el.scrollTop,
      })
    }, 200)
  }

  // follow new content while pinned, but never on the first run when a
  // restored offset exists (that would snap a returning reader to the end)
  let lastCount = 0
  createEffect(() => {
    const count = rowKeys().length
    const grew = count > lastCount
    const first = lastCount === 0
    lastCount = count
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
    const el = scrollElement
    if (el && el.scrollHeight > 0) {
      writeSnapshot(props.sessionKey, { items: virtualizer.takeSnapshot() as Snapshot["items"], offset: el.scrollTop })
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
              ref={(el) => {
                // tanstack's measureElement early-returns when the index
                // is outside the computed range, and at ref time the range
                // is not computed yet - defer the first measure; the
                // virtualizer's observer takes over from there. GUARD:
                // skip detached nodes - measuring one reports 0, poisons
                // the size cache and feeds the measure/remount churn.
                requestAnimationFrame(() => {
                  if (el.isConnected) virtualizer.measureElement(el)
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
                  deletion and the prune effect (never null mid-render). */}
              {(() => {
                let last: unknown = null
                return <renderer.Row row={() => (last = projection.rowByKey().get(key) ?? last) as never} />
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
      if (node.isConnected) virtualizer.measureElement(node)
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
        if (!restored?.offset) return
        // replay the saved position once the snapshot's heights are in place
        queueMicrotask(() => {
          el.scrollTop = restored.offset
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight <= END_EPSILON)
        })
      }}
      onScroll={onScroll}
      data-transcript-scroll
      data-osh-gutter
      style={{ "overflow-y": "auto", "min-height": "0" }}
    >
      {/* header/footer live in the scroll flow (normal flow, not absolute):
          the title scrolls away with the transcript and the footer is the
          last thing in the session — never pinned */}
      <Show when={props.header}>{props.header}</Show>
      <div
        ref={(el) => (host = el)}
        data-transcript-content
        style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}
      />
      <Show when={props.footer}>{props.footer}</Show>
    </div>
  )
}