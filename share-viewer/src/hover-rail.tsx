// HoverRail: the shared paged prompt switcher (owner directive 2026-10-23;
// redesigned 2026-10-24 as floating UI after live feedback).
//
// FLOATING (fixed to the viewport, never a layout slot): a proximity strip
// hugging the left edge reveals a vertical pill at viewport-center height;
// hovering/clicking the pill opens the popover. At rest NOTHING is rendered
// into the layout - the content never shifts and nothing is pinned to the
// content's top (live-caught: the column-slot version rode the timeline
// flex row, so it sat all the way up on long pages and pushed content
// right). The popover is opaque - a transparent one let page rows bleed
// through the menu (live-caught).
//
// One mechanism everywhere: classic paged (app.tsx) and every skin
// (base-view). Skins keep their identity by rendering their own Nav inside
// the popover; Nav-less skins use the default numbered list, which jumps by
// scrolling. Keyboard: [ / ] previous / next prompt, Escape closes.
import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js"

export function HoverRail(props: {
  /** total prompts */
  count: number
  /** currently active prompt index (paged) or undefined (scroll mode) */
  active?: number
  /** default list label for prompt i */
  label: (i: number) => string | undefined
  /** select: page (paged skins + classic) or scroll (reader/atlas) */
  onSelect: (i: number) => void
  /** skin custom content (replaces the default list body) */
  children?: JSX.Element
  /** compact heading for the popover (skin name etc.) */
  title?: string
}) {
  const [near, setNear] = createSignal(false)
  const [open, setOpen] = createSignal(false)
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  let strip: HTMLDivElement | undefined
  let pill: HTMLDivElement | undefined
  let pop: HTMLDivElement | undefined

  const enter = () => {
    if (hideTimer) clearTimeout(hideTimer)
    setNear(true)
    setOpen(true)
  }
  const leave = () => {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      setOpen(false)
      setNear(false)
    }, 220)
  }
  const step = (dir: 1 | -1) => {
    const cur = props.active ?? 0
    const next = Math.min(props.count - 1, Math.max(0, cur + dir))
    if (next !== cur || props.active === undefined) props.onSelect(next)
    if (open() && pop) pop.scrollTop = 0
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false)
      setNear(false)
      return
    }
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement | null)?.isContentEditable) return
    if (e.key === "[") step(-1)
    else if (e.key === "]") step(1)
  }
  onMount(() => window.addEventListener("keydown", onKey))
  onCleanup(() => {
    window.removeEventListener("keydown", onKey)
    if (hideTimer) clearTimeout(hideTimer)
  })

  return (
    <>
      {/* proximity strip: invisible, fixed to the viewport's left edge */}
      <div
        ref={strip}
        class="fixed left-0 top-0 bottom-0 z-40 w-7"
        onMouseEnter={enter}
        onMouseLeave={leave}
        aria-hidden="true"
      />
      {/* the pill: appears near the strip, viewport-center height */}
      <Show when={near() || open()}>
        <div
          ref={pill}
          class="fixed left-2 top-1/2 -translate-y-1/2 z-50 group"
          style={{ transition: "opacity 160ms ease, transform 160ms ease" }}
          onMouseEnter={enter}
          onMouseLeave={leave}
        >
          <button
            type="button"
            class="flex flex-col items-center gap-1 rounded-xl border border-border-weak-base bg-background-base/95 backdrop-blur px-1 py-2.5 cursor-pointer shadow-lg group-hover:border-border-strong-base"
            style={{ transition: "border-color 140ms ease" }}
            onClick={() => (open() ? leave() : enter())}
            aria-label={`prompts (${props.count})`}
            aria-expanded={open()}
            title={`prompts - [ ] keys switch`}
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
        </div>
      </Show>
      {/* the popover: opaque, floats beside the pill */}
      <Show when={open()}>
        <div
          ref={pop}
          class="fixed left-12 top-1/2 -translate-y-1/2 z-50 w-80 max-h-[68vh] overflow-y-auto p-2 rounded-xl border border-border-weak-base bg-background-base shadow-2xl"
          onMouseEnter={enter}
          onMouseLeave={leave}
          role="menu"
          aria-label="prompts"
        >
          <Show when={props.title}>
            <div class="px-2 pb-1.5 text-11-mono text-text-weaker uppercase tracking-wider">{props.title}</div>
          </Show>
          <Show
            when={props.children}
            fallback={
              <div class="flex flex-col">
                <For each={Array.from({ length: props.count }, (_, i) => i)}>
                  {(i) => (
                    <button
                      type="button"
                      role="menuitem"
                      classList={{
                        "group relative text-left text-13-regular pl-5 pr-2 py-1.5 rounded-md border-none cursor-pointer truncate": true,
                        "bg-surface-raised-base text-text-strong": props.active === i,
                        "bg-transparent text-text-base hover:bg-surface-base": props.active !== i,
                      }}
                      onClick={() => {
                        props.onSelect(i)
                        setOpen(false)
                      }}
                    >
                      <span
                        class="absolute left-1.5 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-full"
                        classList={{ "opacity-100": props.active === i, "opacity-0": props.active !== i }}
                        style={{ background: "var(--openshare-accent, var(--text-base))" }}
                      />
                      <span class="text-11-mono text-text-weaker mr-2">{String(i + 1).padStart(2, "0")}</span>
                      {props.label(i) ?? "prompt"}
                    </button>
                  )}
                </For>
              </div>
            }
          >
            {props.children}
          </Show>
          <div class="sticky bottom-0 pt-1.5 px-2 pb-0.5 flex items-center justify-between text-10-mono text-text-weaker bg-background-base border-t border-border-weaker-base mt-1.5" style={{ border: 0 }}>
            <Show when={props.active !== undefined} fallback={<span>jump</span>}>
              <span>
                {String((props.active ?? 0) + 1).padStart(2, "0")} / {String(props.count).padStart(2, "0")}
              </span>
            </Show>
            <span>[ ] switch - esc close</span>
          </div>
        </div>
      </Show>
    </>
  )
}
