// PromptNav (owner round 2026-10-25): ONE prompt navigation control, two
// states - a sidebar column (192px, content shifts right for it) or the
// floating pill at the left edge (vertically centered, 40% visible at
// rest). The setting `promptNav` picks the state; the toggle lives IN the
// control (sidebar header collapse button / pill popover expand button) -
// the pill is never removable, one of the two states is always present
// while a session has more than one prompt.
//
// Shared by classic and every skin (BaseSessionView). Selection logic is
// the caller's: paged pages the turn, continuous jumps the virtualizer
// (j/k and [ ] dispatch through src/prompt-nav.ts to the same handlers).
//
// Hover previews: each row previews its response (first text of the
// following assistant message / the section's response) in a card anchored
// to the row's right edge, rendered at the panel level so it never clips
// in the scrolling list.
import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"

const IconPanel = (props: { class?: string }) => (
  // panel-left glyph: a framed rectangle with a left column bar - drawn,
  // not fonted, so it renders identically everywhere (no emoji, no ligature)
  <svg viewBox="0 0 16 16" class={props.class} width="14" height="14" aria-hidden="true" fill="none">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" stroke-width="1.25" />
    <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" stroke-width="1.25" />
  </svg>
)
const IconCollapse = (props: { class?: string }) => (
  <svg viewBox="0 0 16 16" class={props.class} width="14" height="14" aria-hidden="true" fill="none">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" stroke-width="1.25" />
    <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" stroke-width="1.25" />
    <polyline points="9 6.5 11.5 8 9 9.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" />
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

export type PromptNavVariant = "pill" | "sidebar"

export function PromptNav(props: {
  count: number
  /** currently active prompt index (paged) or undefined (continuous) */
  active?: number
  label: (i: number) => string | undefined
  /** response preview for hover cards; undefined = no preview */
  preview?: (i: number) => string | undefined
  onSelect: (i: number) => void
  /** shift+click (or the row's hover focus button) opens the turn in
   *  focus mode - the overlay over the transcript (classic) */
  onFocusTurn?: (i: number) => void
  /** skin custom rows (replaces the default list). undefined = default */
  children?: JSX.Element
  /** compact heading (skin name etc.) */
  title?: string
  /** subagent pages: the persistent "back to parent" row pinned above the
   *  prompt list (sidebar and popover both) */
  parentLink?: { label: string; onParent: () => void }
  variant: PromptNavVariant
  onSetVariant: (v: PromptNavVariant) => void
}) {
  // the sidebar state only applies on desktop widths; below md the control
  // is always the pill (a 192px column would eat a phone)
  const desktop = createMediaQuery("(min-width: 768px)")
  const sidebar = () => props.variant === "sidebar" && desktop()
  return (
    <Show when={sidebar()} fallback={<Pill {...props} />}>
      <Sidebar {...props} />
    </Show>
  )
}

/** one prompt row - shared by the sidebar and the pill popover so both
 *  states read as the same control. number + label + accent marker;
 *  shift+click focuses the turn when the host supports it; the sidebar
 *  variant adds a hover-revealed focus button for discoverability. */
function NavRow(props: {
  i: number
  active: boolean
  label: string | undefined
  onHover?: (i: number, el: HTMLElement) => void
  onSelect: (i: number) => void
  onFocus?: (i: number) => void
  focusAffordance?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      class="osh-pnav-row group relative w-full flex items-center gap-2 min-h-7 px-2 py-1 rounded-md border-none cursor-pointer text-left"
      classList={{
        "bg-surface-raised-base text-text-strong": props.active,
        "bg-transparent text-text-base hover:bg-surface-base": !props.active,
      }}
      aria-current={props.active ? "true" : undefined}
      onMouseEnter={(e) => props.onHover?.(props.i, e.currentTarget)}
      onClick={(e) => {
        if (e.shiftKey && props.onFocus) {
          props.onFocus(props.i)
          return
        }
        props.onSelect(props.i)
      }}
      title={props.onFocus ? "click: jump here · shift+click: focus this turn" : undefined}
    >
      <span
        class="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-full transition-opacity duration-150"
        classList={{ "opacity-100": props.active, "opacity-0": !props.active }}
        style={{ background: "var(--openshare-accent, var(--text-base))" }}
      />
      <span class="text-12-mono text-text-weaker w-5 shrink-0 tabular-nums">{String(props.i + 1).padStart(2, "0")}</span>
      <span class="truncate text-13-regular">{props.label ?? "prompt"}</span>
      <Show when={props.onFocus && props.focusAffordance}>
        {/* non-interactive affordance (interactive content inside a button
            is invalid): the icon marks shift+click; the row's title says it */}
        <span
          class="ml-auto shrink-0 flex items-center justify-center size-5 text-text-weaker opacity-0 group-hover:opacity-100 transition-opacity duration-150"
          aria-hidden="true"
        >
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none">
            <circle cx="8" cy="8" r="4.5" stroke="currentColor" stroke-width="1.25" />
            <line x1="8" y1="0.5" x2="8" y2="3.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
            <line x1="8" y1="12.5" x2="8" y2="15.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
            <line x1="0.5" y1="8" x2="3.5" y2="8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
            <line x1="12.5" y1="8" x2="15.5" y2="8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
          </svg>
        </span>
      </Show>
    </button>
  )
}

/** the hover preview card, anchored past the list's right edge. `top` and
 *  `left` come from rects (the popover's right edge minus the wrapper's
 *  left) because `left: 100%` resolves against the WRAPPER - which is
 *  only pill-wide, painting the preview straight over the rows
 *  (vision-caught). Rendered at the wrapper level, never inside the
 *  scrolling list. */
function PreviewCard(props: { label: string | undefined; text: string; top: number; left: number }) {
  return (
    <div
      class="osh-pnav-preview absolute z-50 w-72 max-w-[calc(100vw-5rem)] p-3 rounded-lg border border-border-weak-base bg-background-base shadow-lg pointer-events-none"
      style={{ top: `${props.top}px`, left: `${props.left}px` }}
      role="note"
    >
      <div class="text-12-medium text-text-strong line-clamp-2">{props.label ?? "prompt"}</div>
      <div class="pt-0.5 text-12-regular text-text-weak line-clamp-3">{props.text}</div>
    </div>
  )
}

/** the persistent back-to-parent row pinned above the prompt list */
function ParentRow(props: { label: string; onParent: () => void; compact?: boolean }) {
  return (
    <button
      type="button"
      class="flex items-center gap-2 w-full min-h-7 px-2 py-1 rounded-md bg-transparent border-none cursor-pointer text-left text-12-regular text-text-weaker hover:text-text-base hover:bg-surface-base"
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

// ------------------------------------------------------------- sidebar ----
function Sidebar(props: Parameters<typeof PromptNav>[0]) {
  const [preview, setPreview] = createSignal<{ i: number; top: number; left: number } | undefined>()
  let panel: HTMLDivElement | undefined
  let list: HTMLDivElement | undefined

  const onHover = (i: number, el: HTMLElement) => {
    if (!props.preview || !panel) return setPreview(undefined)
    const text = props.preview(i)
    if (!text) return setPreview(undefined)
    const pr = panel.getBoundingClientRect()
    const er = el.getBoundingClientRect()
    setPreview({ i, top: er.top - pr.top, left: pr.width + 8 })
  }

  return (
    <aside ref={panel} class="relative flex flex-col h-full w-48 shrink-0 border-r border-border-weak-base bg-background-base" aria-label="prompts">
      <div class="flex items-center justify-between h-8 px-3 shrink-0">
        <span class="text-11-mono text-text-weaker uppercase tracking-wider">Prompts</span>
        <button
          type="button"
          class="flex items-center justify-center size-5 rounded text-text-weaker hover:text-text-base hover:bg-surface-base bg-transparent border-none cursor-pointer"
          onClick={() => props.onSetVariant("pill")}
          title="collapse to the floating pill"
          aria-label="collapse prompt sidebar"
        >
          <IconCollapse />
        </button>
      </div>
      <div
        ref={list}
        class="flex-1 min-h-0 overflow-y-auto p-1.5 flex flex-col gap-0.5"
        role="menu"
        aria-label="prompts"
        onMouseLeave={() => setPreview(undefined)}
        onScroll={() => setPreview(undefined)}
      >
        <Show when={props.parentLink}>
          {(p) => <ParentRow label={p().label} onParent={p().onParent} />}
        </Show>
        <Show
          when={props.children}
          fallback={
            <For each={Array.from({ length: props.count }, (_, i) => i)}>
              {(i) => (
                <NavRow
                  i={i}
                  active={props.active === i}
                  label={props.label(i)}
                  onHover={onHover}
                  onSelect={(i) => props.onSelect(i)}
                  onFocus={props.onFocusTurn}
                  focusAffordance
                />
              )}
            </For>
          }
        >
          {props.children}
        </Show>
        <Show when={props.count === 0}>
          <div class="px-2 py-1 text-12-regular text-text-weaker">no prompts match</div>
        </Show>
      </div>
      <div class="flex items-center justify-between h-7 px-3 shrink-0 text-10-mono text-text-weaker border-t border-border-weak-base/60">
        <span class="tabular-nums">{String(props.count).padStart(2, "0")} prompts</span>
        <span class="flex items-center gap-1"><Kbd>J</Kbd><Kbd>K</Kbd></span>
      </div>
      <Show when={preview()}>{(p) => <PreviewCard label={props.label(p().i)} text={props.preview?.(p().i) ?? ""} top={p().top} left={p().left} />}</Show>
    </aside>
  )
}

// ---------------------------------------------------------------- pill ----
function Pill(props: Parameters<typeof PromptNav>[0]) {
  const [near, setNear] = createSignal(false)
  const [open, setOpen] = createSignal(false)
  const [preview, setPreview] = createSignal<{ i: number; top: number; left: number } | undefined>()
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  let panel: HTMLDivElement | undefined
  let popEl: HTMLDivElement | undefined

  const stripEnter = () => {
    if (hideTimer) clearTimeout(hideTimer)
    setNear(true)
  }
  const stripLeave = () => {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      setNear(false)
      setOpen(false)
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

  return (
    <>
      {/* invisible proximity strip: NEAR raises opacity only, never
          expands. Narrow (8px) and BELOW the pill in stacking - a wide
          strip covered the pill and swallowed its hover (gate-caught) */}
      <div
        class="fixed left-0 top-0 bottom-0 z-30 w-2"
        onMouseEnter={stripEnter}
        onMouseLeave={stripLeave}
        aria-hidden="true"
      />
      <div
        role="navigation"
        aria-label="prompts"
        ref={panel}
        onMouseEnter={pillEnter}
        onMouseLeave={stripLeave}
        class="fixed left-2 top-1/2 -translate-y-1/2 z-40"
      >
        {/* the pill: 40% visible at rest, full when near */}
        <button
          type="button"
          class="relative flex flex-col items-center gap-1 rounded-xl border border-border-weak-base bg-background-base/95 backdrop-blur px-1 py-2.5 cursor-pointer shadow-md"
          classList={{ "osh-rail-pill-open": open() }}
          style={{
            opacity: near() ? 1 : 0.4,
            transition: "opacity 160ms ease, border-color 140ms ease",
          }}
          onClick={() => (open() ? stripLeave() : pillEnter())}
          aria-label={`prompts (${props.count})`}
          aria-expanded={open()}
        >
          <span class="text-10-mono text-text-weaker leading-none">{String(props.count).padStart(2, "0")}</span>
          <span class="flex flex-col gap-[3px] py-0.5">
            <For each={Array.from({ length: Math.min(3, props.count) })}>
              {() => <span class="block h-px w-3.5 rounded-full bg-text-weaker/70" />}
            </For>
          </span>
          <Show when={props.active !== undefined}>
            <span class="text-10-mono leading-none" style={{ color: "var(--openshare-accent, var(--text-base))" }}>
              {String((props.active ?? 0) + 1).padStart(2, "0")}
            </span>
          </Show>
        </button>

        {/* the popover: anchored to the pill's right edge, animated in */}
        <Show when={open()}>
          <div
            ref={popEl}
            class="osh-rail-pop absolute left-full bottom-0 z-50 w-80 rounded-xl border border-border-weak-base bg-background-base shadow-2xl overflow-hidden"
            style={{ "margin-left": "6px" }}
            role="menu"
            aria-label="prompts"
          >
            <div class="flex items-center justify-between h-8 px-3 border-b border-border-weak-base/60">
              <span class="flex items-center gap-2 min-w-0">
                <span class="text-11-mono text-text-weaker uppercase tracking-wider truncate">{props.title ?? "Prompts"}</span>
                <span class="text-10-mono text-text-weaker tabular-nums shrink-0">{String(props.count).padStart(2, "0")}</span>
              </span>
              <button
                type="button"
                class="flex items-center gap-1.5 h-6 px-1.5 rounded text-12-regular text-text-weaker hover:text-text-base hover:bg-surface-base bg-transparent border-none cursor-pointer"
                onClick={() => {
                  props.onSetVariant("sidebar")
                  setOpen(false)
                }}
                title="keep prompts as a sidebar column"
                aria-label="expand to sidebar"
              >
                <IconPanel />
                <span class="hidden sm:inline">sidebar</span>
              </button>
            </div>
            <div
              class="max-h-[56vh] overflow-y-auto p-1.5 flex flex-col gap-0.5"
              onMouseLeave={() => setPreview(undefined)}
              onScroll={() => setPreview(undefined)}
            >
              <Show when={props.parentLink}>
                {(p) => <ParentRow label={p().label} onParent={() => { p().onParent(); setOpen(false) }} />}
              </Show>
              <Show
                when={props.children}
                fallback={
                  <For each={Array.from({ length: props.count }, (_, i) => i)}>
                    {(i) => (
                      <NavRow
                        i={i}
                        active={props.active === i}
                        label={props.label(i)}
                        onHover={onHover}
                        onSelect={(i) => {
                          props.onSelect(i)
                          setOpen(false)
                          setPreview(undefined)
                        }}
                        onFocus={(i) => {
                          props.onFocusTurn?.(i)
                          setOpen(false)
                          setPreview(undefined)
                        }}
                      />
                    )}
                  </For>
                }
              >
                {props.children}
              </Show>
            </div>
            <div class="flex items-center justify-between h-7 px-3 border-t border-border-weak-base/60 text-10-mono text-text-weaker">
              <Show when={props.active !== undefined} fallback={<span>jump</span>}>
                <span class="tabular-nums">
                  {String((props.active ?? 0) + 1).padStart(2, "0")} / {String(props.count).padStart(2, "0")}
                </span>
              </Show>
              <span class="flex items-center gap-1">
                <Kbd>J</Kbd><Kbd>K</Kbd><span class="px-0.5">prompts</span><Kbd>ESC</Kbd><span class="px-0.5">close</span>
              </span>
            </div>
          </div>
          {/* the hover preview renders at the WRAPPER level: the popover is
              overflow-hidden (rounded header/footer) and would clip it */}
          <Show when={preview()}>{(p) => <PreviewCard label={props.label(p().i)} text={props.preview?.(p().i) ?? ""} top={p().top} left={p().left} />}</Show>
        </Show>
      </div>
    </>
  )
}
