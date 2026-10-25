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
  followLive?: boolean
  onReady?: (controls: { scrollToMessage: (id: string) => void }) => void
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
      value: (key) => toolOpen[key],
      set: (key, open) => {
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
  let headerElement: HTMLDivElement | undefined
  const [headerHeight, setHeaderHeight] = createSignal(0)
  const [pinned, setPinned] = createSignal(false)
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
    get scrollMargin() { return headerHeight() },
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

  // pin state: at end → pinned (follows new content); nudge up → unpinned
  const onScroll = () => {
    const el = scrollElement
    if (!el) return
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= END_EPSILON
    if (atEnd !== pinned()) setPinned(atEnd)
    const item = virtualizer.getVirtualItemForOffset(el.scrollTop + 24)
    const row = item && projection.rows()[item.index]
    if (row) props.onActiveMessageChange?.(row.userMessageID)
    saveSnapshot()
  }

  onMount(() => {
    const observer = new ResizeObserver(() => setHeaderHeight(headerElement?.offsetHeight ?? 0))
    if (headerElement) {
      setHeaderHeight(headerElement.offsetHeight)
      observer.observe(headerElement)
    }
    props.onReady?.({
      scrollToMessage: (id) => {
        const index = projection.rows().findIndex((row) => row._tag === "UserMessage" && row.userMessageID === id)
        if (index < 0) return
        setPinned(false)
        virtualizer.scrollToIndex(index, { align: "start" })
        requestAnimationFrame(() => {
          if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
          const target = scrollElement?.querySelector<HTMLElement>(`[data-row-key="user-message:${CSS.escape(id)}"] [data-slot="user-message-text"]`)
          if (!target) return
          target.getAnimations().forEach((animation) => animation.cancel())
          target.animate([
            { backgroundColor: "var(--surface-base-interactive-active)", boxShadow: "0 0 0 2px var(--border-strong-base)" },
            { backgroundColor: getComputedStyle(target).backgroundColor, boxShadow: "0 0 0 0 transparent" },
          ], { duration: 900, easing: "ease-out" })
        })
      },
    })
    onCleanup(() => observer.disconnect())
    requestAnimationFrame(onScroll)
  })

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
    virtualizer.getTotalSize()
    const first = lastCount === 0
    lastCount = count
    if (first || !pinned() || !props.followLive || props.doc.status.type !== "busy" || count === 0 || !scrollElement) return
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
              data-turn-id={projection.rowByKey().get(key)?.userMessageID}
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
      }
      entry.el.dataset.index = String(item.index)
      entry.el.style.transform = `translateY(${item.start - headerHeight()}px)`
      if (entry.el.parentElement !== h) {
        h.appendChild(entry.el)
        requestAnimationFrame(() => {
          if (entry.el.isConnected) virtualizer.measureElement(entry.el)
        })
      }
    }
    // Keep keyed component state without measuring or rendering off-window rows.
    for (const [key, entry] of rowEls) {
      if (!inWindow.has(key)) entry.el.remove()
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
      style={{ "overflow-y": "auto", "min-height": "0" }}
    >
      {/* header/footer live in the scroll flow (normal flow, not absolute):
          the title scrolls away with the transcript and the footer is the
          last thing in the session — never pinned */}
      <div ref={headerElement}><Show when={props.header}>{props.header}</Show></div>
      <div
        data-transcript-content
        ref={(el) => (host = el)}
        style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}
      />
      <Show when={props.footer}>{props.footer}</Show>
    </div>
  )
}
