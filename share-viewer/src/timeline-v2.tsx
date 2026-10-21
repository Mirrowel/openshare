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
import { createEffect, createMemo, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createReactiveTimelineProjection, TimelineRow } from "@opencode/session-ui/timeline/projection"
import type { ReasoningMode } from "@opencode/session-ui/timeline/projection"
import type { TimelineDetail } from "@opencode/session-ui/timeline/detail"
import { createSessionTimelineRowRenderer, type SessionUserPresentation } from "@opencode/session-ui/timeline/row"
import type { SessionDocument } from "@opencode/session-ui/document"

// distance from the bottom that still counts as "at the end" (px)
const END_EPSILON = 4
const ESTIMATE = 90

const measurementCache = new Map<string, number>()

export function VirtualTimeline(props: {
  doc: SessionDocument
  sessionKey: string
  reasoningMode?: ReasoningMode
  shellToolDefaultOpen?: boolean
  editToolDefaultOpen?: boolean
  detail?: TimelineDetail
  presentation?: Record<string, SessionUserPresentation | undefined>
  header?: JSX.Element
  footer?: JSX.Element
  class?: string
}): JSX.Element {
  const projection = createReactiveTimelineProjection({
    sessionMessages: () => props.doc.messages,
    status: () => props.doc.status,
    reasoningMode: () => props.reasoningMode ?? "compact",
    shellToolDefaultOpen: () => props.shellToolDefaultOpen ?? false,
    editToolDefaultOpen: () => props.editToolDefaultOpen ?? false,
    timelineDetail: () => props.detail,
  })
  const [toolOpen, setToolOpen] = createStore<Record<string, boolean | undefined>>({})
  const renderer = createSessionTimelineRowRenderer({
    sessionID: () => props.doc.sessionID,
    status: () => props.doc.status,
    projection,
    presentation: (message) => props.presentation?.[message.id],
    reasoningMode: () => props.reasoningMode ?? "compact",
    shellToolDefaultOpen: () => props.shellToolDefaultOpen ?? false,
    editToolDefaultOpen: () => props.editToolDefaultOpen ?? false,
    disclosure: {
      value: (key) => toolOpen[key],
      set: (key, open) => setToolOpen(key, open),
    },
  })

  let scrollElement: HTMLDivElement | undefined
  const [pinned, setPinned] = createSignal(true)
  const rows = projection.rows
  const rowKeys = createMemo(() => (rows() ?? []).map(TimelineRow.key))

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return rowKeys().length
    },
    getScrollElement: () => scrollElement ?? null,
    estimateSize: (index: number) => measurementCache.get(rowKeys()[index]) ?? ESTIMATE,
    overscan: 24,
    getItemKey: (index: number) => rowKeys()[index] ?? `row:${index}`,
  })

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
  }

  // follow new content while pinned
  createEffect(() => {
    const count = rowKeys().length
    if (pinned() && count > 0 && scrollElement) {
      queueMicrotask(() => {
        const el = scrollElement
        if (el) el.scrollTop = el.scrollHeight
      })
    }
  })

  onCleanup(() => {
    if (measurementCache.size > 4000) measurementCache.clear()
  })

  const items = virtualizer.getVirtualItems()
  return (
    <div
      class={props.class}
      ref={(el) => {
        scrollElement = el
      }}
      onScroll={onScroll}
      style={{ "overflow-y": "auto", "min-height": "0" }}
    >
      {/* header/footer live in the scroll flow (normal flow, not absolute):
          the title scrolls away with the transcript and the footer is the
          last thing in the session — never pinned */}
      <Show when={props.header}>{props.header}</Show>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
        {items.map((item) => {
          const row = projection.rowByKey().get(String(item.key))
          if (!row) return null
          return (
            <div
              data-row-key={item.key}
              data-index={item.index}
              ref={(el) => {
                // tanstack's measureElement early-returns when the index is
                // outside the computed range, and at ref time (DOM creation)
                // the range is not computed yet — so nothing was ever
                // measured and every row sat on the 90px estimate
                // (live-caught: uniform ~46px gaps in continuous mode).
                // Defer the first measure; the virtualizer's observer takes
                // over from there.
                if (el) requestAnimationFrame(() => virtualizer.measureElement(el))
              }}
              style={{
                position: "absolute",
                top: "0",
                left: "0",
                width: "100%",
                transform: `translateY(${item.start}px)`,
              }}
            >
              <renderer.Row row={() => row} />
            </div>
          )
        })}
      </div>
      <Show when={props.footer}>{props.footer}</Show>
    </div>
  )
}
