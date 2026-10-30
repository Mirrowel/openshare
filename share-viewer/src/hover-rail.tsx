// PromptNav: ONE turn navigation control, two states - a sidebar column
// (default 192px, drag the edge to resize, content shifts right for it) or the
// floating pill at the left edge (vertically centered, 40% visible at rest).
// The setting `promptNav` picks the state; the toggle lives IN the control
// (sidebar header collapse button / pill popover expand button) - the pill is
// never removable, one of the two states is always present while a session has
// more than one turn.
//
// Vocabulary: everything user-facing says "turn(s)" - one word for the nav,
// the focus overlay ("Turn N of M") and the context menu.
//
// Focus mode affordances (classic): the reticle glyph on a row is CLICKABLE
// (span, not button - a button inside a button is invalid HTML; click handler
// + stopPropagation), right-click opens a "Focus on turn" menu, and ctrl+click
// works anywhere on the row. The reticle renders FILLED and always visible on
// the turn currently in the focus overlay, following focus switches.
//
// Hover previews: each row previews its response in a card anchored past the
// list's right edge, rendered at the panel level so it never clips in the
// scrolling list.
import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { createMediaQuery } from "@solid-primitives/media"
import { Popover } from "@kobalte/core/popover"
import { Icon } from "@opencode/ui/icon"
import { navRowsSignal, setNavSearchBar, setRowLines } from "./settings"

// panel-left glyph: a framed rectangle with a left column bar - drawn,
// not fonted, so it renders identically everywhere (no emoji, no ligature)
const IconPanel = (props: { class?: string }) => (
  <svg viewBox="0 0 16 16" class={props.class} width="14" height="14" aria-hidden="true" fill="none">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" stroke-width="1.25" />
    <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" stroke-width="1.25" />
  </svg>
)
/** the settings glyph on both nav config triggers: the older panel glyph read
 * as a light bulb, and the kit's settings gear is the settings affordance
 * everywhere else in the viewer */
const IconGear = (props: { class?: string }) => (
  <Icon name="settings-gear" size="small" class={props.class} />
)
// collapse (sidebar open): the chevron points LEFT, the direction the panel
// collapses toward; pointing right reads as "expand"
const IconCollapse = (props: { class?: string }) => (
  <svg viewBox="0 0 16 16" class={props.class} width="14" height="14" aria-hidden="true" fill="none">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" stroke-width="1.25" />
    <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" stroke-width="1.25" />
    <polyline points="7 6.5 4.5 8 7 9.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
)

/** the kbd chip: mono glyph on a hairline chip - the styled replacement
 *  for raw "[ ] switch" text and link-styled actions */
function Kbd(props: { children: JSX.Element }) {
  return (
    <kbd class="inline-flex items-center justify-center min-w-4 h-4 px-1 rounded border border-border-weak-base bg-surface-base text-10-mono text-text-weaker leading-none">
      {props.children}
    </kbd>
  )
}

/** the right-click "Focus on turn" card - hand-rolled: fixed at the cursor,
 *  closed by any outside pointerdown or Escape. The kit's Menu (a Kobalte
 *  dropdown) never renders its content when opened programmatically without a
 *  Trigger, and a one-item menu does not need the machinery.
 *  PORTALED to document.body: inside the pill popover the card was trapped in
 *  a transformed z-40 stacking context (the wrapper's entry animation keeps a
 *  transform forever) alongside the hover preview, so it painted beneath it
 *  and right-click on a popover row looked dead while the sidebar's copy
 *  worked. At body level no ancestor can clip, stack, or contain it. */
export function TurnContextMenu(props: { x: number; y: number; onClose: () => void; onFocus: () => void }) {
  let card: HTMLDivElement | undefined
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose() }
  const onDown = (e: PointerEvent) => { if (card && !card.contains(e.target as Node)) props.onClose() }
  onMount(() => {
    window.addEventListener("keydown", onKey)
    window.addEventListener("pointerdown", onDown, true)
  })
  onCleanup(() => {
    window.removeEventListener("keydown", onKey)
    window.removeEventListener("pointerdown", onDown, true)
  })
  const left = Math.min(props.x, window.innerWidth - 180)
  const top = Math.min(props.y, window.innerHeight - 56)
  return (
    <Portal mount={document.body}>
      <div
        ref={card}
        role="menu"
        aria-label="turn actions"
        class="fixed z-[80] min-w-36 p-1 rounded-lg border border-border-weak-base bg-background-base shadow-lg"
        style={{ left: `${left}px`, top: `${top}px` }}
      >
        <button
          type="button"
          role="menuitem"
          class="w-full text-left px-3 py-1.5 rounded-md text-12-regular text-text-base hover:bg-surface-base cursor-pointer border-none bg-transparent"
          onClick={() => {
            props.onClose()
            props.onFocus()
          }}
        >
          Focus on turn
        </button>
      </div>
    </Portal>
  )
}

export type PromptNavVariant = "pill" | "sidebar"

export function PromptNav(props: {
  count: number
  /** currently active turn index (paged) or undefined (continuous) */
  active?: number
  /** the turn currently shown in the focus overlay, if any - its row
   *  renders the reticle filled and always visible */
  focusedIndex?: number
  label: (i: number) => string | undefined
  /** response preview for hover cards; undefined = no preview */
  preview?: (i: number) => string | undefined
  onSelect: (i: number) => void
  /** focus mode (classic): ctrl+click, the reticle, or the right-click
   *  menu opens the turn as an overlay over the transcript */
  onFocusTurn?: (i: number) => void
  /** skin custom rows (replaces the default list). undefined = default */
  children?: JSX.Element
  /** compact heading (skin name etc.) */
  title?: string
  /** subagent pages: the persistent "back to parent" row pinned above the
   *  turn list (sidebar and popover both) */
  parentLink?: { label: string; onParent: () => void }
  variant: PromptNavVariant
  onSetVariant: (v: PromptNavVariant) => void
  /** sidebar width in px (drag-resized; persisted by the caller) */
  width?: number
  onResize?: (w: number) => void
  /** hover-preview clamp line counts (configured from the sidebar gear) */
  previewLines?: { prompt: number; response: number }
  onSetPreviewLines?: (v: { prompt: number; response: number }) => void
  /** which variants THIS placement renders: call sites put the nav in
   * different slots - the sidebar/pill slot is a stretch flex ROW (the
   * sidebar wants h-full) where an in-flow narrow bar stretches to the
   * full row height, so the narrow bar needs a column-flow slot. A
   * placement passes only="desktop" (sidebar/pill) or only="narrow"
   * (the Turn N of M bar); default renders whichever fits the width. */
  only?: "desktop" | "narrow"
  /** ghost mode: the pill rests invisible until approached (pill
   *  placement only; the config toggle is shared with the sidebar) */
  pillGhost?: boolean
  onSetPillGhost?: (v: boolean) => void
}) {
  // the sidebar state only applies on desktop widths; below 900px the control
  // is the compact "Turn N of M" top bar (the conversation view's narrow
  // pattern, triggered well before md: 768px needs absurd zoom levels)
  const desktop = createMediaQuery("(min-width: 900px)")
  const showDesktopSide = () => desktop() && props.only !== "narrow"
  const showNarrow = () => !desktop() && props.only !== "desktop"
  return (
    <Show when={showNarrow()} fallback={
      <Show when={showDesktopSide()}>
        <Show when={props.variant === "sidebar"} fallback={<Pill {...props} />}>
          <Sidebar {...props} />
        </Show>
      </Show>
    }>
      <NarrowBar {...props} />
    </Show>
  )
}

/** the narrow-viewport state: a full-width "Turn N of M" bar at the top of
 *  the transcript opening a dropdown of the turn rows - the conversation
 *  view's own narrow pattern, which classic matches when zoomed in or on a
 *  phone. */
function NarrowBar(props: Parameters<typeof PromptNav>[0]) {
  const [open, setOpen] = createSignal(false)
  // the popover anchors to the LABEL, not the full-width trigger button:
  // bottom-start on a w-full trigger opens the list at the viewport's far left
  let labelEl: HTMLSpanElement | undefined
  const current = () => props.active ?? props.focusedIndex ?? 0
  return (
    <Popover open={open()} onOpenChange={setOpen} placement="bottom-start" gutter={4} anchorRef={() => labelEl}>
      <Popover.Trigger class="osh-turn-button justify-between w-full px-3 border-b border-border-weak-base rounded-none" aria-label="Choose a turn">
        <span ref={labelEl} class="inline-flex items-center gap-1.5">
          <span>{props.focusedIndex !== undefined ? "Focused" : "Turn"} {current() + 1} of {props.count}</span>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
            <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="z-50 w-72 max-w-[calc(100vw-2rem)] max-h-[60dvh] overflow-y-auto p-1.5 rounded-lg border border-border-weak-base bg-background-base shadow-lg" aria-label="turns">
          <Show when={props.parentLink}>
            {(p) => <ParentRow label={p().label} onParent={() => { p().onParent(); setOpen(false) }} />}
          </Show>
          <For each={Array.from({ length: props.count }, (_, i) => i)}>
            {(i) => (
              <NavRow
                i={i}
                active={props.active === i}
                filled={props.focusedIndex === i}
                label={props.label(i)}
                onSelect={(i) => {
                  if (props.onFocusTurn && props.active === undefined && props.focusedIndex !== undefined) {
                    // continuous + focused: switch the focused turn
                    props.onFocusTurn(i)
                  } else {
                    props.onSelect(i)
                  }
                  setOpen(false)
                }}
                onFocus={(i) => {
                  props.onFocusTurn?.(i)
                  setOpen(false)
                }}
              />
            )}
          </For>
          <Show when={props.count === 0}>
            <div class="px-2 py-1 text-12-regular text-text-weaker">no turns match</div>
          </Show>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}

/** one-shot: the next pill mount pings ONCE (set when the sidebar
 *  collapses to a pill mid-session - that transition needs a hello, not
 *  the full double pulse a page load carries) */
let singlePulseNext = false
function flagSinglePulse() {
  singlePulseNext = true
}
function consumeSinglePulse() {
  const v = singlePulseNext
  singlePulseNext = false
  return v
}

/** one turn row - shared by the sidebar and the pill popover so both states
 *  read as the same control. plain number in a fixed 2ch column (no leading
 *  zero; no staircase at 10+, 100+ may widen), tight gap, 12px text - matched
 *  to the conversation view's nav so the rows do not read oversized next to
 *  it. */
function NavRow(props: {
  i: number
  active: boolean
  filled?: boolean
  label: string | undefined
  /** response preview text - shown INLINE when rowResponseLines > 0 */
  response?: string
  /** the rail context (pill pop-open): the active marker spans the whole
   *  row (the rail's one indicator); the sidebar keeps the short marker */
  markerFull?: boolean
  onHover?: (i: number, el: HTMLElement) => void
  onSelect: (i: number) => void
  onFocus?: (i: number) => void
}) {
  const [menuAt, setMenuAt] = createSignal<{ x: number; y: number } | undefined>()
  // signal reads live INLINE in the JSX below: a body-level read is a
  // one-time snapshot and the rows never re-render on setting changes
  const clampStyle = (n: number) => ({
    display: "-webkit-box" as const,
    "-webkit-box-orient": "vertical" as const,
    "-webkit-line-clamp": String(n),
    overflow: "hidden" as const,
  })
  const button = (
    <button
      type="button"
      role="menuitem"
      class="osh-pnav-row group relative w-full flex items-baseline gap-1.5 min-h-6 px-2 py-0.5 rounded-md border-none cursor-pointer text-left"
      classList={{
        "bg-surface-raised-base text-text-strong": props.active,
        "bg-transparent text-text-base hover:bg-surface-base": !props.active,
      }}
      aria-current={props.active ? "true" : undefined}
      onMouseEnter={(e) => props.onHover?.(props.i, e.currentTarget)}
      onContextMenu={(e) => {
        if (!props.onFocus) return
        e.preventDefault()
        setMenuAt({ x: e.clientX, y: e.clientY })
      }}
      onClick={(e) => {
        if (e.ctrlKey && props.onFocus) {
          props.onFocus(props.i)
          return
        }
        props.onSelect(props.i)
      }}
      title={props.onFocus ? "click: jump here - ctrl+click or the reticle: focus this turn - right-click: menu" : undefined}
    >
      <span
        classList={{
          // markerFull (rail context): spans the active row's whole
          // height, growing/shrinking with it - the rail's one indicator
          "absolute left-0 rounded-full transition-opacity duration-150": true,
          "inset-y-0.5 w-[3px]": !!props.markerFull,
          "top-1/2 -translate-y-1/2 w-[3px] h-4": !props.markerFull,
          "opacity-100": props.active,
          "opacity-0": !props.active,
        }}
        style={props.active ? { background: "var(--openshare-accent, var(--text-base))" } : undefined}
      />
      {/* baseline-aligned with the label's first line: a centered BOX
          still reads high because digit ink rides the top of its line
          box; sharing the baseline is ink-exact at any row height */}
      <span class="text-12-mono text-text-weaker w-[2ch] shrink-0 tabular-nums">{props.i + 1}</span>
      <span class="min-w-0 flex-1 flex flex-col gap-0.5 py-px">
        <span class="text-12-regular" style={navRowsSignal().promptLines > 1 ? clampStyle(navRowsSignal().promptLines) : undefined} classList={{ truncate: navRowsSignal().promptLines <= 1 }}>
          {props.label ?? "turn"}
        </span>
        <Show when={navRowsSignal().responseLines > 0 && props.response}>
          <span class="text-12-regular text-text-weaker leading-4" style={clampStyle(navRowsSignal().responseLines)}>{props.response}</span>
        </Show>
      </span>
      <Show when={props.onFocus}>
        {/* the focus reticle: a span (interactive content inside a button
            is invalid HTML) - clickable via handler + stopPropagation.
            FILLED and always visible on the turn in the focus overlay,
            following focus switches; otherwise revealed on hover only */}
        <span
          class="ml-auto shrink-0 flex items-center justify-center size-5 cursor-pointer transition-opacity duration-150"
          classList={{ "opacity-100": props.filled, "opacity-0 group-hover:opacity-100": !props.filled }}
          style={props.filled ? { color: "var(--openshare-accent, var(--text-base))" } : undefined}
          onClick={(e) => {
            e.stopPropagation()
            props.onFocus?.(props.i)
          }}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none">
            <circle cx="8" cy="8" r="4.5" stroke="currentColor" stroke-width="1.25" fill={props.filled ? "currentColor" : "none"} />
            <line x1="8" y1="0.5" x2="8" y2="3.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
            <line x1="8" y1="12.5" x2="8" y2="15.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
            <line x1="0.5" y1="8" x2="3.5" y2="8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
            <line x1="12.5" y1="8" x2="15.5" y2="8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
          </svg>
        </span>
      </Show>
    </button>
  )
  return (
    <>
      {button}
      <Show when={menuAt() && props.onFocus}>
        <TurnContextMenu
          x={menuAt()!.x}
          y={menuAt()!.y}
          onClose={() => setMenuAt(undefined)}
          onFocus={() => props.onFocus?.(props.i)}
        />
      </Show>
    </>
  )
}

/** the hover preview card, anchored past the list's right edge. `top` and
 *  `left` come from rects (the popover's right edge minus the wrapper's
 *  left) because `left: 100%` resolves against the WRAPPER - which is
 *  only pill-wide, painting the preview straight over the rows
 *  (vision-caught). Rendered at the wrapper level, never inside the
 *  scrolling list. Line counts are the user's preview-size choice
 *  (sidebar gear), clamped via inline -webkit-line-clamp. */
function PreviewCard(props: { label: string | undefined; text: string; top: number; left: number; promptLines?: number; responseLines?: number }) {
  const clamp = (n?: number) => ({
    display: "-webkit-box" as const,
    "-webkit-box-orient": "vertical" as const,
    "-webkit-line-clamp": String(n ?? 3),
    overflow: "hidden" as const,
  })
  return (
    <div
      class="osh-pnav-preview absolute z-50 w-80 max-w-[calc(100vw-5rem)] p-3 rounded-lg border border-border-weak-base bg-background-base shadow-lg pointer-events-none"
      style={{ top: `${props.top}px`, left: `${props.left}px` }}
      role="note"
    >
      <div class="text-12-medium text-text-strong" style={clamp(props.promptLines ?? 3)}>{props.label ?? "turn"}</div>
      <div class="pt-0.5 text-12-regular text-text-weak" style={clamp(props.responseLines ?? 4)}>{props.text}</div>
    </div>
  )
}

/** the persistent back-to-parent row pinned above the turn list */
function ParentRow(props: { label: string; onParent: () => void; compact?: boolean }) {
  return (
    <button
      type="button"
      class="flex items-center gap-1.5 w-full min-h-6 px-2 py-0.5 rounded-md bg-transparent border-none cursor-pointer text-left text-12-regular text-text-weaker hover:text-text-base hover:bg-surface-base"
      onClick={props.onParent}
      title={`back to parent: ${props.label}`}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" class="shrink-0">
        <path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span class="truncate">{props.label}</span>
    </button>
  )
}

/** "- [n] +" stepper: the number is editable directly (type a value,
 *  clamp on change/blur), the buttons step by 1. Range defaults 1..10;
 *  row-content steppers pass their own (e.g. response lines 0..5).
 *  Exported for the settings panel (card width). */
export function LineStepper(props: { label: string; value: number; onSet: (n: number) => void; min?: number; max?: number }) {
  const min = props.min ?? 1
  const max = props.max ?? 10
  const clamp = (n: number) => Math.max(min, Math.min(max, n))
  const btn =
    "flex items-center justify-center size-6 rounded border border-border-weak-base bg-transparent text-text-weaker hover:text-text-base hover:bg-surface-base cursor-pointer text-14-regular leading-none"
  return (
    <span class="flex items-center gap-1.5">
      <button type="button" class={btn} aria-label={`fewer ${props.label}`} disabled={props.value <= min} onClick={() => props.onSet(clamp(props.value - 1))}>
        −
      </button>
      <input
        type="number"
        min={min}
        max={max}
        value={props.value}
        aria-label={props.label}
        class="w-[3ch] p-0 h-6 text-center rounded border border-border-weak-base bg-transparent text-12-mono text-text-base [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        onChange={(e) => props.onSet(clamp(parseInt((e.target as HTMLInputElement).value, 10) || min))}
      />
      <button type="button" class={btn} aria-label={`more ${props.label}`} disabled={props.value >= max} onClick={() => props.onSet(clamp(props.value + 1))}>
        +
      </button>
    </span>
  )
}

/** the nav's OWN config popover (not the shared settings panel): the knobs
 *  that shape the prompt views - hover-preview sizes, row content
 *  (prompt/response line counts), the search bar, and ghost mode. Anchored
 *  beside its trigger (sidebar: to the right; pill: FIXED past the POPOVER's
 *  right edge, because the pill's own wrapper is pill-wide and puts the panel
 *  straight over the rows). Closed by outside pointerdown/Escape, EXCEPT
 *  pointerdowns on the gear itself, which the gear's click handler turns into
 *  a clean toggle (the capture-close fires first and the click re-opens it,
 *  so every second click closes and reopens). */
/** the nav settings CONTROLS - shared by the sidebar's side popover and the
 *  pill pop-open (where they REPLACE the turn list). Every dynamic value
 *  reads its signal INLINE in JSX: reading a signal in the component body is
 *  a one-time snapshot, nothing subscribes, and the controls display
 *  mount-time values forever while steppers compute from the stale original
 *  (a second click still only subtracts one). */
function NavSettingsBody(props: {
  previewLines: { prompt: number; response: number }
  onSet: (v: { prompt: number; response: number }) => void
  ghost?: boolean
  onSetGhost?: (v: boolean) => void
}) {
  return (
    <div class="p-3 flex flex-col gap-1">
      <div class="text-12-medium text-text-weaker pb-1">Hover preview</div>
      <div class="flex items-center justify-between pb-1.5">
        <span class="text-12-regular text-text-base">prompt lines</span>
        <LineStepper label="prompt lines" value={props.previewLines.prompt} onSet={(prompt) => props.onSet({ ...props.previewLines, prompt })} />
      </div>
      <div class="flex items-center justify-between pb-2">
        <span class="text-12-regular text-text-base">response lines</span>
        <LineStepper label="response lines" value={props.previewLines.response} onSet={(response) => props.onSet({ ...props.previewLines, response })} />
      </div>
      <div class="border-t border-border-weak-base pt-2">
        <div class="text-12-medium text-text-weaker pb-1.5">Rows</div>
        <div class="flex items-center justify-between pb-1.5">
          <span class="text-12-regular text-text-base">prompt lines</span>
          <LineStepper label="row prompt lines" min={1} max={5} value={navRowsSignal().promptLines} onSet={(promptLines) => setRowLines({ promptLines })} />
        </div>
        <div class="flex items-center justify-between pb-1.5">
          <span class="text-12-regular text-text-base">response lines</span>
          <LineStepper label="row response lines" min={0} max={5} value={navRowsSignal().responseLines} onSet={(responseLines) => setRowLines({ responseLines })} />
        </div>
        <button
          type="button"
          class="flex items-center justify-between gap-2 w-full bg-transparent border-none cursor-pointer text-left"
          onClick={() => setNavSearchBar(!navRowsSignal().searchBar)}
          title="show the filter field in the pill pop-open and the sidebar"
        >
          <span class="text-12-regular text-text-base">search bar</span>
          <span
            classList={{
              "relative shrink-0 w-8 h-4.5 rounded-full transition-colors duration-200": true,
              "bg-icon-strong-base": navRowsSignal().searchBar,
              "bg-border-strong-base": !navRowsSignal().searchBar,
            }}
          >
            <span
              classList={{
                "absolute top-0.5 size-3.5 rounded-full bg-background-base shadow-sm transition-transform duration-200": true,
                "translate-x-0.5": !navRowsSignal().searchBar,
                "translate-x-4": navRowsSignal().searchBar,
              }}
            />
          </span>
        </button>
      </div>
      <Show when={props.onSetGhost}>
        <div class="border-t border-border-weak-base pt-2">
          <button
            type="button"
            class="flex items-center justify-between gap-2 w-full bg-transparent border-none cursor-pointer text-left"
            onClick={() => props.onSetGhost!(!props.ghost)}
            title="the pill rests invisible until the cursor approaches (applies to the pill)"
          >
            <span class="text-12-regular text-text-base">ghost mode</span>
            <span
              classList={{
                "relative shrink-0 w-8 h-4.5 rounded-full transition-colors duration-200": true,
                "bg-icon-strong-base": props.ghost,
                "bg-border-strong-base": !props.ghost,
              }}
            >
              <span
                classList={{
                  "absolute top-0.5 size-3.5 rounded-full bg-background-base shadow-sm transition-transform duration-200": true,
                  "translate-x-0.5": !props.ghost,
                  "translate-x-4": props.ghost,
                }}
              />
            </span>
          </button>
        </div>
      </Show>
    </div>
  )
}

/** the sidebar's config popover: the shared settings body, anchored to
 *  the sidebar's right edge. Closed by outside pointerdown/Escape -
 *  EXCEPT pointerdowns on the gear itself (the gear's own click toggles;
 *  the capture-close fired first and the click re-opened it). */
function SidebarConfig(props: {
  previewLines: { prompt: number; response: number }
  onSet: (v: { prompt: number; response: number }) => void
  onClose: () => void
  ghost?: boolean
  onSetGhost?: (v: boolean) => void
}) {
  let panel: HTMLDivElement | undefined
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose() }
  const onDown = (e: PointerEvent) => {
    const t = e.target as Element
    if (t?.closest?.('button[aria-label="turn nav settings"]')) return
    if (panel && !panel.contains(t as Node)) props.onClose()
  }
  onMount(() => {
    window.addEventListener("keydown", onKey)
    window.addEventListener("pointerdown", onDown, true)
  })
  onCleanup(() => {
    window.removeEventListener("keydown", onKey)
    window.removeEventListener("pointerdown", onDown, true)
  })
  return (
    <div
      ref={panel}
      class="absolute top-8 z-30 w-56 rounded-lg border border-border-weak-base bg-background-base shadow-xl overflow-hidden"
      style={{ left: "calc(100% + 8px)" }}
      role="dialog"
      aria-label="turn nav settings"
    >
      <NavSettingsBody previewLines={props.previewLines} onSet={props.onSet} ghost={props.ghost} onSetGhost={props.onSetGhost} />
    </div>
  )
}

// ------------------------------------------------------------- sidebar ----
function Sidebar(props: Parameters<typeof PromptNav>[0]) {
  const [preview, setPreview] = createSignal<{ i: number; top: number; left: number } | undefined>()
  const [configOpen, setConfigOpen] = createSignal(false)
  const [sbFilter, setSbFilter] = createSignal("")
  let panel: HTMLDivElement | undefined

  const onHover = (i: number, el: HTMLElement) => {
    if (!props.preview || !panel) return setPreview(undefined)
    const text = props.preview(i)
    if (!text) return setPreview(undefined)
    const pr = panel.getBoundingClientRect()
    const er = el.getBoundingClientRect()
    setPreview({ i, top: er.top - pr.top, left: pr.width + 8 })
  }

  // drag-resize: pointer capture on the edge handle, width clamped, the
  // caller persists it on release
  const startResize = (e: PointerEvent) => {
    e.preventDefault()
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const w = Math.max(160, Math.min(400, ev.clientX - panel!.getBoundingClientRect().left))
      props.onResize?.(Math.round(w))
    }
    const up = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId)
      target.removeEventListener("pointermove", move)
      target.removeEventListener("pointerup", up)
    }
    target.addEventListener("pointermove", move)
    target.addEventListener("pointerup", up)
  }

  return (
    <aside ref={panel} class="relative flex flex-col h-full shrink-0 border-r border-border-weak-base bg-background-base" style={{ width: `${props.width ?? 192}px` }} aria-label="turns">
      <div class="flex items-center justify-between h-8 px-3 shrink-0">
        <span class="text-12-medium text-text-weaker">Turns</span>
        <span class="flex items-center gap-1">
          <button
            type="button"
            class="flex items-center justify-center size-5 rounded text-text-weaker hover:text-text-base hover:bg-surface-base bg-transparent border-none cursor-pointer"
            onClick={() => setConfigOpen((v) => !v)}
            title="turn nav settings"
            aria-label="turn nav settings"
            aria-expanded={configOpen()}
          >
            <IconGear />
          </button>
          <button
            type="button"
            class="flex items-center justify-center size-5 rounded text-text-weaker hover:text-text-base hover:bg-surface-base bg-transparent border-none cursor-pointer"
            onClick={() => { flagSinglePulse(); props.onSetVariant("pill") }}
            title="collapse to the floating pill"
            aria-label="collapse turn sidebar"
          >
            <IconCollapse />
          </button>
        </span>
      </div>
      {/* the search field (nav config toggle) */}
      <Show when={navRowsSignal().searchBar}>
        <div class="px-2 pt-2 shrink-0">
          <input
            type="text"
            value={sbFilter()}
            onInput={(e) => setSbFilter(e.currentTarget.value)}
            placeholder="filter turns…"
            class="w-full box-border px-2 py-1 rounded-md border border-border-weak-base bg-background-stronger text-text-base text-12-regular outline-none focus:border-icon-strong-base transition-colors duration-150"
            aria-label="filter turns"
          />
        </div>
      </Show>
      <div
        class="flex-1 min-h-0 overflow-y-auto osh-thin-scroll p-1.5 flex flex-col gap-0.5"
        role="menu"
        aria-label="turns"
        onMouseLeave={() => setPreview(undefined)}
        onScroll={() => setPreview(undefined)}
      >
        <Show when={props.parentLink}>
          {(p) => <ParentRow label={p().label} onParent={p().onParent} />}
        </Show>
        <Show
          when={props.children}
          fallback={
            <For each={sbFilter().trim() ? Array.from({ length: props.count }, (_, i) => i).filter((i) => (props.label(i) ?? "").toLowerCase().includes(sbFilter().trim().toLowerCase())) : Array.from({ length: props.count }, (_, i) => i)}>
              {(i) => (
                <NavRow
                  i={i}
                  active={props.active === i}
                  filled={props.focusedIndex === i}
                  label={props.label(i)}
                  response={props.preview?.(i)}
                  onHover={onHover}
                  onSelect={(i) => props.onSelect(i)}
                  onFocus={props.onFocusTurn}
                />
              )}
            </For>
          }
        >
          {props.children}
        </Show>
        <Show when={navRowsSignal().searchBar && sbFilter().trim() && props.count > 0 && !props.children}>
          <div class="px-2 py-1 text-12-regular text-text-weaker">no turns match</div>
        </Show>
      </div>
      <div class="flex items-center justify-between h-7 px-3 shrink-0 text-10-mono text-text-weaker border-t border-border-weak-base/60">
        <span class="tabular-nums">{props.count} turns</span>
        <span class="flex items-center gap-1"><Kbd>J</Kbd><Kbd>K</Kbd></span>
      </div>
      <Show when={preview()}>{(p) => <PreviewCard label={props.label(p().i)} text={props.preview?.(p().i) ?? ""} top={p().top} left={p().left} promptLines={props.previewLines?.prompt} responseLines={props.previewLines?.response} />}</Show>
      <Show when={configOpen() && props.onSetPreviewLines}>
        <SidebarConfig
          previewLines={props.previewLines ?? { prompt: 3, response: 4 }}
          onSet={props.onSetPreviewLines!}
          onClose={() => setConfigOpen(false)}
          ghost={props.pillGhost}
          onSetGhost={props.onSetPillGhost ? (v) => props.onSetPillGhost!(v) : undefined}
        />
      </Show>
      {/* the resize handle: a hairline grab zone on the right edge */}
      <div class="absolute top-0 bottom-0 right-0 w-1.5 cursor-col-resize hover:bg-border-weak-base/60 z-10" onPointerDown={startResize} aria-hidden="true" />
    </aside>
  )
}

// ---------------------------------------------------------------- pill ----
function Pill(props: Parameters<typeof PromptNav>[0]) {
  const [near, setNear] = createSignal(false)
  const [open, setOpen] = createSignal(false)
  const [preview, setPreview] = createSignal<{ i: number; top: number; left: number } | undefined>()
  const [configOpen, setConfigOpen] = createSignal(false)
  const [filter, setFilter] = createSignal("")
  // ghost mode: first-visit pulse so the invisible pill is discoverable
  // once; remembered per browser
  const [pulse, setPulse] = createSignal(false)
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  let panel: HTMLDivElement | undefined
  let popEl: HTMLDivElement | undefined

  onMount(() => {
    // ghost mode pings on EVERY page load while enabled: a double pulse,
    // ping, short pause, ping. A pill that mounts mid-session (sidebar
    // collapsed to pill) pings ONCE (the toggle sets the one-shot flag below)
    if (props.pillGhost) {
      const single = consumeSinglePulse()
      setPulse(true)
      setTimeout(() => {
        setPulse(false)
        if (single) return
        setTimeout(() => {
          setPulse(true)
          setTimeout(() => setPulse(false), 1600)
        }, 600)
      }, 1600)
    }
  })

  const stripEnter = () => {
    if (hideTimer) clearTimeout(hideTimer)
    setNear(true)
  }
  const stripLeave = () => {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      setNear(false)
      setOpen(false)
      setConfigOpen(false)
      setPreview(undefined)
    }, 220)
  }
  const pillEnter = () => {
    if (hideTimer) clearTimeout(hideTimer)
    setNear(true)
    setOpen(true)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false)
      setNear(false)
      setConfigOpen(false)
      setPreview(undefined)
    }
  }
  onMount(() => window.addEventListener("keydown", onKey))
  onCleanup(() => {
    window.removeEventListener("keydown", onKey)
    if (hideTimer) clearTimeout(hideTimer)
  })

  const onHover = (i: number, el: HTMLElement) => {
    if (!props.preview || !panel) return setPreview(undefined)
    const text = props.preview(i)
    if (!text) return setPreview(undefined)
    const wr = panel.getBoundingClientRect()
    const er = el.getBoundingClientRect()
    // anchor past the POPOVER's right edge (its rect), not left:100% of the
    // wrapper - the wrapper is only pill-wide
    const popRect = popEl?.getBoundingClientRect() ?? wr
    setPreview({ i, top: er.top - wr.top, left: popRect.right - wr.left + 8 })
  }

  // the search field (nav config toggle) filters the rows in both states,
  // PROMPTS ONLY: the simple filter hides non-matching turns, while rich
  // multi-scope search is the header palette's job
  const filtered = () => {
    const q = filter().trim().toLowerCase()
    if (!q) return Array.from({ length: props.count }, (_, i) => i)
    return Array.from({ length: props.count }, (_, i) => i).filter((i) => (props.label(i) ?? "").toLowerCase().includes(q))
  }

  return (
    <>
      {/* invisible proximity strip: NEAR raises opacity only, never
          expands. Narrow (8px) and BELOW the pill in stacking, because a wide
          strip covers the pill and swallows its hover */}
      <div
        class="fixed left-0 top-0 bottom-0 z-30 w-2"
        onMouseEnter={stripEnter}
        onMouseLeave={stripLeave}
        aria-hidden="true"
      />
      <div
        role="navigation"
        aria-label="turns"
        ref={panel}
        onMouseEnter={pillEnter}
        onMouseLeave={stripLeave}
        class="fixed left-2 top-1/2 -translate-y-1/2 z-40"
      >
        {/* the capsule pill: 40% visible at rest, full when near (ghost
            mode: 0% at rest - only the proximity strip betrays it, plus the
            one-time pulse). Current position on TOP (accent), count at the
            BOTTOM */}
        <button
          type="button"
          class="relative flex flex-col items-center gap-1 rounded-xl border border-border-weak-base bg-background-base/95 backdrop-blur px-1 py-2.5 cursor-pointer shadow-md"
          classList={{ "osh-rail-pill-open": open(), "osh-pill-pulse": pulse() }}
          style={{
            opacity: near() ? 1 : props.pillGhost ? 0 : 0.4,
            transition: "opacity 160ms ease, border-color 140ms ease",
          }}
          onClick={() => (open() ? stripLeave() : pillEnter())}
          aria-label={`turns (${props.count})`}
          aria-expanded={open()}
        >
          <Show
            when={props.active !== undefined}
            fallback={<span class="text-10-mono text-text-weaker leading-none">{props.count}</span>}
          >
            <span class="text-10-mono leading-none" style={{ color: "var(--openshare-accent, var(--text-base))" }}>
              {(props.active ?? 0) + 1}
            </span>
          </Show>
          {/* the capsule track: a dot at the reading position, a filled
              block while focusing */}
          <Show
            when={props.active !== undefined}
            fallback={
              <span class="flex flex-col gap-[3px] py-0.5">
                <For each={Array.from({ length: Math.min(3, props.count) })}>
                  {() => <span class="block h-px w-3.5 rounded-full bg-text-weaker/70" />}
                </For>
              </span>
            }
          >
            <span class="relative block w-px h-7 rounded-full bg-text-weaker/40">
              <span
                class="absolute -left-[1px] w-[3px] h-[3px] rounded-full"
                style={{
                  top: `calc(${Math.min(0.97, ((props.active ?? 0) + 0.5) / props.count) * 100}% - 1.5px)`,
                  background: "var(--openshare-accent, var(--text-base))",
                }}
              />
              <Show when={props.focusedIndex !== undefined}>
                <span
                  class="absolute -left-[1px] w-[3px] h-[7px] rounded-sm"
                  style={{
                    top: `calc(${Math.min(0.96, ((props.focusedIndex ?? 0) + 0.5) / props.count) * 100}% - 3.5px)`,
                    background: "var(--openshare-accent, var(--text-base))",
                  }}
                />
              </Show>
            </span>
          </Show>
          <span class="text-10-mono text-text-weak leading-none tabular-nums">{props.count}</span>
        </button>

        {/* the popover: anchored to the pill's right edge, animated in */}
        <Show when={open()}>
          <div
            ref={popEl}
            class="osh-rail-pop absolute left-full z-50 w-60 rounded-xl border border-border-weak-base bg-background-base shadow-2xl overflow-hidden"
            style={{ "margin-left": "6px" }}
            role="menu"
            aria-label="turns"
          >
            <div class="flex items-center justify-between h-8 px-3 border-b border-border-weak-base/60">
              <span class="flex items-center gap-2 min-w-0">
                <span class="text-12-medium text-text-weaker truncate">{props.title ?? "Turns"}</span>
                <span class="text-10-mono text-text-weaker tabular-nums shrink-0">{props.count}</span>
              </span>
              <span class="flex items-center gap-1">
                <Show when={props.onSetPreviewLines}>
                  <button
                    type="button"
                    class="flex items-center justify-center size-5 rounded text-text-weaker hover:text-text-base hover:bg-surface-base bg-transparent border-none cursor-pointer"
                    onClick={() => setConfigOpen((v) => !v)}
                    title="turn nav settings"
                    aria-label="turn nav settings"
                    aria-expanded={configOpen()}
                  >
                    <IconGear />
                  </button>
                </Show>
                <button
                  type="button"
                  class="flex items-center gap-1.5 h-6 px-1.5 rounded text-12-regular text-text-weaker hover:text-text-base hover:bg-surface-base bg-transparent border-none cursor-pointer"
                  onClick={() => {
                    props.onSetVariant("sidebar")
                    setOpen(false)
                  }}
                  title="keep turns as a sidebar column"
                  aria-label="expand to sidebar"
                >
                  <IconPanel />
                  <span class="hidden sm:inline">sidebar</span>
                </button>
              </span>
            </div>

            {/* the settings REPLACE the list: the gear swaps the pop-open's
                body, so there is no stacked panel, no anchoring and nothing to
                travel the mouse to; the gear swaps back, and closing the
                pop-open resets to the list */}
            <Show
              when={!configOpen()}
              fallback={
                <Show when={props.onSetPreviewLines}>
                  <div class="max-h-[56vh] overflow-y-auto osh-thin-scroll">
                    <NavSettingsBody
                      previewLines={props.previewLines ?? { prompt: 3, response: 4 }}
                      onSet={props.onSetPreviewLines!}
                      ghost={props.pillGhost}
                      onSetGhost={props.onSetPillGhost}
                    />
                  </div>
                </Show>
              }
            >
            {/* the search field (nav config toggle) */}
            <Show when={navRowsSignal().searchBar}>
              <div class="px-2 pt-2">
                <input
                  type="text"
                  value={filter()}
                  onInput={(e) => setFilter(e.currentTarget.value)}
                  placeholder="filter turns…"
                  class="w-full box-border px-2 py-1 rounded-md border border-border-weak-base bg-background-stronger text-text-base text-12-regular outline-none focus:border-icon-strong-base transition-colors duration-150"
                  aria-label="filter turns"
                />
              </div>
            </Show>

            {/* the LIST region: one layout (mini) + the always-on progress
                rail (adopted from the annotated trial - reading position
                at a glance) */}
            <div
              class="max-h-[56vh] overflow-y-auto osh-thin-scroll p-1.5 flex flex-col"
              onMouseLeave={() => setPreview(undefined)}
              onScroll={() => setPreview(undefined)}
            >
              <div class="flex flex-col gap-0.5 min-w-0 flex-1 relative">
                {/* the rail: full-height track only - the position dot is
                    GONE; the active row's full-height block (below, in
                    NavRow) is the one indicator, spanning the selected
                    prompt's row like the capsule pill's focused block */}
                <Show when={props.active !== undefined}>
                  <div class="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-border-weak-base/60" />
                </Show>
                <Show when={props.parentLink}>
                  {(p) => <ParentRow label={p().label} onParent={() => { p().onParent(); setOpen(false) }} />}
                </Show>
                <Show
                  when={props.children}
                  fallback={
                    <For each={filtered()}>
                      {(i) => (
                        <NavRow
                          i={i}
                          active={props.active === i}
                          filled={props.focusedIndex === i}
                          label={props.label(i)}
                          response={props.preview?.(i)}
                          markerFull
                          onHover={onHover}
                          onSelect={(i) => {
                            // the popover STAYS OPEN after acting (owner
                            // round: closing on every click made
                            // multi-turn hopping needlessly heavy); Esc and
                            // clicking away still close it
                            props.onSelect(i)
                            setPreview(undefined)
                          }}
                          onFocus={(i) => {
                            props.onFocusTurn?.(i)
                            setPreview(undefined)
                          }}
                        />
                      )}
                    </For>
                  }
                >
                  {props.children}
                </Show>
                <Show when={navRowsSignal().searchBar && filtered().length === 0}>
                  <div class="px-2 py-1 text-12-regular text-text-weaker">no turns match</div>
                </Show>
              </div>
            </div>
            <div class="flex items-center justify-between h-7 px-3 border-t border-border-weak-base/60 text-10-mono text-text-weaker">
              <Show when={props.active !== undefined} fallback={<span>jump</span>}>
                <span class="tabular-nums">
                  {(props.active ?? 0) + 1} / {props.count}
                </span>
              </Show>
              <span class="flex items-center gap-1">
                <Kbd>J</Kbd><Kbd>K</Kbd><span class="px-0.5">turns</span><Kbd>ESC</Kbd><span class="px-0.5">close</span>
              </span>
            </div>
            </Show>
          </div>
          {/* the hover preview renders at the WRAPPER level: the popover is
              overflow-hidden (rounded header/footer) and would clip it */}
          <Show when={preview()}>{(p) => <PreviewCard label={props.label(p().i)} text={props.preview?.(p().i) ?? ""} top={p().top} left={p().left} promptLines={props.previewLines?.prompt} responseLines={props.previewLines?.response} />}</Show>
        </Show>
      </div>
    </>
  )
}
