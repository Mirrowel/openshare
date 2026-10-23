// HoverRail: the shared paged prompt switcher (owner directive 2026-10-23).
// A thin hover zone hugging the left edge; hovering opens a floating
// popover listing the session's prompts (v1-style hover pop-up). One
// mechanism everywhere: classic paged (app.tsx) and every skin (base-view)
// — skins keep their identity by rendering their own Nav inside the
// popover, and Nav-less skins (reader, atlas) use the default list, which
// jumps by scrolling to the section instead of paging.
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
  const [open, setOpen] = createSignal(false)
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  let zone: HTMLDivElement | undefined
  let pop: HTMLDivElement | undefined

  const enter = () => {
    if (hideTimer) clearTimeout(hideTimer)
    setOpen(true)
  }
  const leave = () => {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => setOpen(false), 260)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false)
  }
  onMount(() => window.addEventListener("keydown", onKey))
  onCleanup(() => {
    window.removeEventListener("keydown", onKey)
    if (hideTimer) clearTimeout(hideTimer)
  })

  return (
    <div class="relative shrink-0">
      {/* the hover zone: a PERSISTENT slim handle (dotted hairline + ≡ tab
          at mid-height) so the switcher is discoverable at rest — the
          pure-hover original was invisible until stumbled into
          (live-caught). Brightens on approach. */}
      <div
        ref={zone}
        class="h-full w-4 cursor-pointer group"
        onMouseEnter={enter}
        onMouseLeave={leave}
        onClick={() => (open() ? leave() : enter())}
        role="navigation"
        aria-label="prompts"
        title="prompts"
      >
        <div
          class="absolute left-[3px] top-0 bottom-0 w-px opacity-45 group-hover:opacity-100 transition-opacity duration-150"
          style={{
            background:
              "repeating-linear-gradient(to bottom, var(--border-weak-base) 0 3px, transparent 3px 8px)",
          }}
        />
        <div
          class="absolute left-[1px] top-1/2 -translate-y-1/2 size-[18px] flex items-center justify-center rounded-md border border-border-weaker-base bg-surface-raised-base text-text-weaker text-[10px] leading-none opacity-60 group-hover:opacity-100 group-hover:text-text-base transition-all duration-150 group-hover:border-border-weak-base"
          style={{ "box-shadow": "0 1px 4px rgb(0 0 0 / 0.15)" }}
        >
          ≡
        </div>
      </div>
      <Show when={open()}>
        <div
          ref={pop}
          class="fixed left-4 top-1/2 -translate-y-1/2 z-50 w-72 max-h-[68vh] overflow-y-auto p-2 rounded-xl border border-border-weak-base bg-background-base shadow-xl"
          onMouseEnter={enter}
          onMouseLeave={leave}
          role="menu"
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
                        "text-left text-13-regular px-2 py-1.5 rounded-md border-none cursor-pointer truncate": true,
                        "bg-surface-raised-base text-text-strong": props.active === i,
                        "bg-transparent text-text-base hover:bg-surface-base": props.active !== i,
                      }}
                      onClick={() => {
                        props.onSelect(i)
                        setOpen(false)
                      }}
                    >
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
        </div>
      </Show>
    </div>
  )
}
