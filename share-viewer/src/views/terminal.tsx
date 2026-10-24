// terminal: the scrollback skin over the shared base - tmux-style
// statusbars top and bottom, everything monospace, prompts as ^ lines.
// Phase-2 chrome: StatusBar/StatusLine are thin SkinHeader/SkinFooter
// stylings - the structure (back, title, version, model, status, GitHub,
// settings) is written once in chrome.tsx.
import { Show } from "solid-js"
import { type Skin, type SkinWrappers } from "./base-view"
import { useView } from "./view-context"
import { SkinHeader, SkinFooter } from "./chrome"
import { SkinSettingsPopover } from "../settings-panel"
import { DateTime } from "luxon"

function StatusBar(props: Parameters<NonNullable<SkinWrappers["Header"]>>[0]) {
  const view = useView()
  return (
    <SkinHeader
      class="h-7 px-3 flex items-center justify-between gap-4 bg-background-stronger border-b border-border-weak-base shrink-0 text-12-mono text-text-weaker font-mono relative z-30"
      leadClass="flex items-center gap-3 min-w-0"
      titleClass="text-text-strong truncate"
      metaClass="flex items-center gap-3 shrink-0"
      title={view.info()?.title ?? "session"}
      settingsTrigger={
        <SkinSettingsPopover
          settings={props.settings}
          update={props.updateSettings}
          branding={props.source.branding()}
          search={props.search}
          onSearch={props.onSearch}
          gearClass="bg-transparent border border-border-weak-base rounded px-1.5 text-12-mono text-text-weaker hover:text-text-base hover:border-border-strong-base cursor-pointer transition-colors duration-150"
          gearTitle=":set"
          gearSize="small"
        />
      }
    />
  )
}

function StatusLine(_props: Parameters<NonNullable<SkinWrappers["Footer"]>>[0]) {
  return (
    <SkinFooter
      class="h-6 px-3 flex items-center justify-between gap-4 bg-background-stronger border-t border-border-weak-base shrink-0 text-12-mono text-text-weaker font-mono"
      label="terminal"
    />
  )
}

export const terminalSkin: Skin = {
  id: "terminal",
  columnClass: "max-w-[72rem] mx-auto px-5 py-4 font-mono flex flex-col gap-5",
  wrappers: {
    Header: StatusBar,
    Footer: StatusLine,
    PromptWrap: (p) => (
      <div class="mb-1">
        <Show when={p.section.at}>
          <span class="text-12-mono text-text-weaker opacity-60 mr-2">
            {DateTime.fromMillis(p.section.at!).toFormat("HH:mm")}
          </span>
        </Show>
        <span class="text-icon-strong-base opacity-70 mr-1">❯</span>
        {p.children}
      </div>
    ),
    ToolWrap: (p) => <div class="pl-3 border-l border-border-weak-base my-0.5">{p.children}</div>,
    ReasoningWrap: (p) => <div class="pl-3 opacity-80">{p.children}</div>,
    ResponseWrap: (p) => <div class="pl-3 my-1">{p.children}</div>,
  },
}

