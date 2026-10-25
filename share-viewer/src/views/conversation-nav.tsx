// TurnNav — ported from the conversation-view PR (OpeOginni), near
// verbatim: the left column of numbered turns with hover previews, a
// context menu, a collapsible 40px tick rail (major tick every 5), and a
// mobile popover fallback. The "back to parent" row pins to the top of
// the list on subagent pages. This is the conversation view's own
// navigation surface - the PromptNav pill/sidebar belongs to the other
// views; the two designs coexist deliberately.
import { createMediaQuery } from "@solid-primitives/media"
import { Popover } from "@kobalte/core/popover"
import { HoverCard } from "@kobalte/core/hover-card"
import { Menu } from "@opencode/ui/menu"
import { Icon } from "@opencode/ui/icon"
import { createSignal, For, Show } from "solid-js"
import { TurnContextMenu } from "../hover-rail"
import type { V2Message } from "../fold"

export function TurnNav(props: {
  messages: V2Message[]
  filtered: V2Message[]
  current?: string
  focused: boolean
  onSelect: (message: V2Message) => void
  onFocus: (message: V2Message) => void
  parent?: { label: string; href: string }
  onParent: () => void
  collapsed: boolean
  onToggle: () => void
  getPreview: (messageID: string) => string
}) {
  const desktop = createMediaQuery("(min-width: 768px)")
  const [open, setOpen] = createSignal(false)
  const compact = () => desktop() && props.collapsed
  const currentIndex = () => props.messages.findIndex((m) => m.id === props.current)
  const TurnEntry = (p: { message: V2Message; number: number }) => {
    const [menuOpen, setMenuOpen] = createSignal(false)
    const [menuAt, setMenuAt] = createSignal<{ x: number; y: number } | undefined>()
    const [previewOpen, setPreviewOpen] = createSignal(false)
    let row: HTMLDivElement | undefined
    const label = () => p.message.text?.trim().split("\n")[0] || "Untitled prompt"
    const focus = () => {
      props.onFocus(p.message)
      setOpen(false)
    }
    return (
      <>
      <Menu open={menuOpen()} onOpenChange={setMenuOpen} getAnchorRect={() => row?.getBoundingClientRect()}>
        <div ref={row} class="flex items-center rounded-md hover:bg-surface-base" classList={{ "bg-surface-base": !compact() && props.current === p.message.id }}
          onContextMenu={(event) => {
            event.preventDefault()
            setMenuAt({ x: event.clientX, y: event.clientY })
          }}>
          <HoverCard open={compact() && previewOpen() && !menuOpen()} onOpenChange={setPreviewOpen} placement="right" gutter={12} openDelay={200} closeDelay={80}>
          <HoverCard.Trigger as="button"
            role="button"
            type="button"
            class={compact() ? "osh-turn-tick" : "flex items-center gap-2 flex-1 min-w-0 min-h-7 px-2 text-left text-12-regular text-text-base bg-transparent border-none cursor-pointer rounded-md"}
            aria-current={props.current === p.message.id ? "step" : undefined}
            aria-label={compact() ? `Turn ${p.number}: ${label()}` : undefined}
            title={compact() ? undefined : label()}
            onClick={() => {
              props.onSelect(p.message)
              setOpen(false)
              setPreviewOpen(false)
            }}
            onKeyDown={(event) => {
              if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                event.preventDefault()
                setMenuOpen(true)
              }
            }}
          >
            <Show when={compact()} fallback={<><span class="text-text-weaker shrink-0">{p.number}</span><span class="truncate">{label()}</span></>}>
              <span class="osh-turn-tick-line" data-major={p.number % 5 === 0 || undefined} />
            </Show>
          </HoverCard.Trigger>
          <Show when={compact()}>
            <HoverCard.Portal>
              <HoverCard.Content class="osh-turn-preview z-[80] w-72 max-w-[calc(100vw-5rem)] p-3 rounded-lg border border-border-weak-base bg-background-base shadow-lg">
                <div class="text-14-medium text-text-strong line-clamp-2">{label()}</div>
                <Show when={props.getPreview(p.message.id)}>{(preview) => <div class="pt-0.5 text-12-regular text-text-weak line-clamp-3">{preview()}</div>}</Show>
              </HoverCard.Content>
            </HoverCard.Portal>
          </Show>
          </HoverCard>
          <Show when={!compact()}>
          <Menu.Trigger class="osh-turn-button shrink-0" aria-label={`Actions for turn ${p.number}`}>
            <span aria-hidden="true">···</span>
          </Menu.Trigger>
          </Show>
        </div>
        <Menu.Portal>
          <Menu.Content class="z-[80]">
            <Menu.Item onSelect={focus}>Focus on turn</Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
      <Show when={menuAt()}>
        <TurnContextMenu x={menuAt()!.x} y={menuAt()!.y} onClose={() => setMenuAt(undefined)} onFocus={focus} />
      </Show>
      </>
    )
  }
  const list = () => (
    <nav aria-label="Conversation turns" class="overflow-y-auto min-h-0" classList={{ "p-1.5": !compact(), "flex-1 flex flex-col": compact() }}>
      <Show when={props.parent} keyed>
        {(parent) => (
          <a
            href={parent.href}
            class="flex items-center gap-2 px-2 min-h-7 rounded-md text-12-regular text-text-weaker hover:text-text-base hover:bg-surface-base no-underline"
            aria-label={`Back to parent turn: ${parent.label}`}
            title={parent.label}
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
              event.preventDefault()
              props.onParent()
              setOpen(false)
            }}
          >
            <Icon name="arrow-left" size="small" />
            <span classList={{ "truncate": !compact(), "sr-only": compact() }}>{parent.label}</span>
          </a>
        )}
      </Show>
      <ul class="flex flex-col m-0 p-0 list-none" style={compact() ? { "margin-block": "auto" } : undefined} classList={{ "gap-0.5": !compact(), "ml-3 pl-2 border-l border-border-weak-base": !!props.parent && !compact() }}>
        <For each={props.filtered}>
          {(message) => <li><TurnEntry message={message} number={props.messages.indexOf(message) + 1} /></li>}
        </For>
      </ul>
      <Show when={props.filtered.length === 0}>
        <p class="px-2 py-1 text-12-regular text-text-weaker" classList={{ "sr-only": compact() }}>{props.messages.length ? "No prompts match." : "No prompts yet."}</p>
      </Show>
    </nav>
  )
  return (
    <Show when={desktop()} fallback={
      <Popover open={open()} onOpenChange={setOpen} placement="bottom-start" gutter={4}>
        <Popover.Trigger class="osh-turn-button justify-between w-full px-3 border-b border-border-weak-base rounded-none" aria-label="Choose a turn">
          <span>{props.focused ? "Focused" : "Turn"} {currentIndex() + 1} of {props.messages.length}</span>
          <Icon name="chevron-down" size="small" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content class="z-50 w-72 max-w-[calc(100vw-2rem)] max-h-[60dvh] overflow-y-auto rounded-lg border border-border-weak-base bg-background-base shadow-lg" aria-label="Conversation turns">
            {list()}
          </Popover.Content>
        </Popover.Portal>
      </Popover>
    }>
      <aside aria-label="Turns" class="relative shrink-0 min-h-0 flex flex-col border-r border-border-weak-base" style={{ width: props.collapsed ? "40px" : "192px" }}>
        <Show when={!props.collapsed}><div class="flex items-center h-8 shrink-0 pl-3 text-12-medium text-text-weaker">Turns</div></Show>
        <button class="osh-turn-button osh-turns-toggle" aria-label={props.collapsed ? "Expand Turns" : "Collapse Turns"} title={props.collapsed ? "Expand Turns" : "Collapse Turns"} aria-expanded={!props.collapsed} onClick={props.onToggle}>
          <Icon name={props.collapsed ? "chevron-right" : "chevron-left"} size="small" />
        </button>
        {list()}
      </aside>
    </Show>
  )
}
