// terminal: the scrollback skin over the shared base - tmux-style
// statusbars top and bottom, everything monospace, prompts as ^ lines.
import { Show, createSignal } from "solid-js"
import { BaseSessionView, type Skin, type SkinWrappers } from "./base-view"
import type { ViewEntry } from "./registry"
import { MetaLine } from "./meta-line"
import { Icon } from "@opencode/ui/icon"
import { Mark } from "@opencode/ui/logo"
import type { SessionSection } from "./session-data"

function StatusBar(props: Parameters<NonNullable<SkinWrappers["Header"]>>[0]) {
  const info = () => (props.data.session as any[]).find((s) => s.id === props.sessionID)
  return (
    <div class="h-7 px-4 flex items-center justify-between gap-4 bg-background-stronger border-b border-border-weak-base shrink-0 text-12-mono text-text-weaker font-mono relative z-20">
      <div class="flex items-center gap-2 min-w-0">
        <Show when={props.isSub && props.onBack}>
          <button
            class="flex items-center gap-1 h-6 px-1.5 rounded-md bg-transparent border-none cursor-pointer text-12-mono text-text-weaker hover:text-text-base hover:bg-surface-base shrink-0"
            onClick={() => props.onBack?.()}
          >
            &lt; main
          </button>
        </Show>
        <span class="text-text-strong truncate">{info()?.title ?? "session"}</span>
      </div>
      <div class="flex items-center gap-3 shrink-0">
        <span class="flex items-center gap-1.5">
          <Mark class="h-3" />
          <span class="text-text-base">v{info()?.version}</span>
        </span>
        <Show when={props.model}>
          <span class="truncate max-w-56 text-text-base hidden sm:inline">{props.model}</span>
        </Show>
      </div>
    </div>
  )
}

function StatusLine(props: Parameters<NonNullable<SkinWrappers["Footer"]>>[0]) {
  const b = () => props.source.branding()
  return (
    <div class="h-6 px-3 flex items-center justify-between gap-4 bg-background-stronger border-t border-border-weak-base shrink-0 text-12-mono text-text-weaker font-mono">
      <div class="flex items-center gap-2 min-w-0">
        <Show when={b().logoUrl}>
          <img src={b().logoUrl} alt="" class="h-3 rounded-sm" />
        </Show>
        <span class="truncate">
          {b().wordmarkUrl ? "" : `${b().name ? b().name + " · " : ""}Open(code)Share`}
        </span>
        {b().wordmarkUrl ? <img src={b().wordmarkUrl} alt="" class="h-3.5" /> : null}
      </div>
      <div class="shrink-0 flex items-center gap-3">
        <span>terminal</span>
      </div>
    </div>
  )
}

export const terminalSkin: Skin = {
  id: "terminal",
  mode: "composed",
  columnClass: "max-w-[72rem] mx-auto px-5 py-4 font-mono flex flex-col gap-5",
  wrappers: {
    Header: StatusBar,
    Footer: StatusLine,
    PromptWrap: (p) => (
      <div class="mb-1">
        <span class="text-icon-strong-base opacity-70 mr-1">❯</span>
        {p.children}
      </div>
    ),
    ToolWrap: (p) => <div class="pl-3 border-l border-border-weak-base my-0.5">{p.children}</div>,
    ReasoningWrap: (p) => <div class="pl-3 opacity-80">{p.children}</div>,
    ResponseWrap: (p) => <div class="pl-3 my-1">{p.children}</div>,
  },
}

export function TerminalView(props: Parameters<ViewEntry["component"]>[0]) {
  return <BaseSessionView {...props} skin={terminalSkin} />
}

export const terminal = {
  id: "terminal",
  label: "terminal",
  component: TerminalView,
}
