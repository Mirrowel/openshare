// HoverRail v4 (owner directive 2026-10-24 night round): NO gutter column,
// no border - a floating fixed pill at the left edge, vertically centered
// on the viewport. Three states:
//   rest        - opacity 0.4 (60% invisible)
//   near        - an invisible left-edge proximity strip brings the pill to
//                 FULL opacity WITHOUT expanding
//   hover pill  - the popover expands, animated (scale+slide 150ms)
// Always present when there is more than one user message, in BOTH modes:
//   paged      - selecting pages to that prompt (the only mouse pager; the
//                hide setting is ignored here)
//   continuous - selecting JUMPS to that user message (fast-skip); the pill
//                can be hidden via showRail (settings row + the popover
//                footer's own "hide" action)
// Keyboard: [ / ] previous / next, Escape closes.
import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js"

export function HoverRail(props: {
  count: number
  /** currently active prompt index (paged) or undefined */
  active?: number
  label: (i: number) => string | undefined
  onSelect: (i: number) => void
  /** skin custom content (replaces the default list). undefined = default */
  children?: JSX.Element
  /** compact heading for the popover (skin name etc.) */
  title?: string
  /** "continuous" shows the hide action in the footer (paged never hides) */
  mode?: "paged" | "continuous"
  /** the hide action's callback (continuous mode only) */
  onHide?: () => void
}) {
  const [near, setNear] = createSignal(false)
  const [open, setOpen] = createSignal(false)
  let hideTimer: ReturnType<typeof setTimeout> | undefined

  const stripEnter = () => {
    if (hideTimer) clearTimeout(hideTimer)
    setNear(true)
  }
  const stripLeave = () => {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      setNear(false)
      setOpen(false)
    }, 220)
  }
  const pillEnter = () => {
    if (hideTimer) clearTimeout(hideTimer)
    setNear(true)
    setOpen(true)
  }
  const step = (dir: 1 | -1) => {
    const cur = props.active ?? 0
    const next = Math.min(props.count - 1, Math.max(0, cur + dir))
    if (next !== cur || props.active === undefined) props.onSelect(next)
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
      {/* invisible proximity strip: NEAR raises opacity only, never expands */}
      <div
        class="fixed left-0 top-0 bottom-0 z-40 w-9"
        onMouseEnter={stripEnter}
        onMouseLeave={stripLeave}
        aria-hidden="true"
      />
      <div
        role="navigation"
        aria-label="prompts"
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
          title="prompts - [ ] keys switch"
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
            class="osh-rail-pop absolute left-full bottom-0 z-50 w-80 max-h-[68vh] overflow-y-auto p-2 rounded-xl border border-border-weak-base bg-background-base shadow-2xl"
            style={{ "margin-left": "6px" }}
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
            <div class="pt-1.5 px-2 pb-0.5 flex items-center justify-between text-10-mono text-text-weaker">
              <Show when={props.active !== undefined} fallback={<span>jump</span>}>
                <span>
                  {String((props.active ?? 0) + 1).padStart(2, "0")} / {String(props.count).padStart(2, "0")}
                </span>
              </Show>
              <span class="flex items-center gap-2">
                <Show when={props.mode === "continuous" && props.onHide}>
                  <button
                    type="button"
                    class="bg-transparent border-none cursor-pointer text-text-weaker hover:text-text-base underline decoration-dotted"
                    onClick={() => props.onHide?.()}
                    title="hide the rail in scroll mode (settings can bring it back)"
                  >
                    hide
                  </button>
                </Show>
                <span>[ ] switch - esc close</span>
              </span>
            </div>
          </div>
        </Show>
      </div>
    </>
  )
}
