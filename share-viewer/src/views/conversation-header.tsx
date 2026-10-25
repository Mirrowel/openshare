// AppHeader — ported from the conversation-view PR (OpeOginni), near
// verbatim: the conversation view's own top bar (brand chip, status,
// copy, repo, info, settings). Skins use SkinHeader; classic uses the
// shared chrome; this is the conversation view's signature header.
import { Icon } from "@opencode/ui/icon"
import { Show } from "solid-js"
import type { Branding } from "../data-source"
import { SettingsPanel } from "../settings-panel"
import { toggleInfoPanel } from "./info-panel"
import { visibleMessages, type ShareData } from "../fold"
import { copySessionMarkdown } from "../copy-markdown"
import type { OshSettings } from "../settings"
import type { useShareSource } from "../data-source"

const OPENSHARE_REPO_URL = "https://github.com/Mirrowel/OpenShare"

function BrandMark(props: { branding: Branding; class?: string }) {
  return (
    <Show when={props.branding.logoUrl} fallback={null}>
      <img src={props.branding.logoUrl} alt="" class={props.class} />
    </Show>
  )
}

const STATUS_DOT: Record<string, string> = {
  live: "#22c55e",
  completed: "#3b82f6",
  error: "#ef4444",
  interrupted: "#eab308",
  gone: "#6b7280",
  cached: "#8b5cf6",
  waiting: "#eab308",
  "login required": "#eab308",
}

function StatusLine(props: { status: string }) {
  return (
    <div class="flex items-center gap-1.5 text-12-mono text-text-weak whitespace-nowrap">
      <span
        classList={{ "status-dot": props.status === "live", "inline-block": true, "size-1.5": true, "rounded-full": true, "shrink-0": true }}
        style={props.status === "live" ? undefined : { "background-color": STATUS_DOT[props.status] ?? "#6b7280" }}
      />
      <span>{props.status}</span>
      <Show when={props.status === "live"}>
        <span class="animate-pulse">·</span>
      </Show>
    </div>
  )
}

export function AppHeader(props: {
  data: ShareData
  sessionID: string
  source: ReturnType<typeof useShareSource>
  settings: OshSettings
  updateSettings: (patch: Partial<OshSettings>) => void
  search: string
  onSearch: (v: string) => void
}) {
  const sessionTools = () => [...new Set(visibleMessages(props.data, props.sessionID).flatMap((message) =>
    (message.content ?? []).filter((part) => part.type === "tool").map((part) => (part as any).name),
  ))]
  return (
    <header class="h-7 px-4 flex items-center justify-between self-stretch shrink-0 bg-background-base border-b border-border-weak-base relative z-30">
      <Show when={props.source.branding().logoUrl}>
        <Show
          when={props.source.branding().linkUrl}
          fallback={
            <span class="p-0.5 flex items-center rounded-md border border-border-weak-base bg-background-base">
              <BrandMark branding={props.source.branding()} class="h-5 rounded" />
            </span>
          }
        >
          {(href) => (
            <a href={href()} target="_blank" rel="noreferrer" class="p-0.5 flex items-center rounded-md border border-border-weak-base bg-background-base hover:border-border-strong-base" title={props.source.branding().name || ""}>
              <BrandMark branding={props.source.branding()} class="h-5 rounded" />
            </a>
          )}
        </Show>
      </Show>
      <StatusLine status={props.source.status()} />
      <div class="flex items-center gap-1">
        <button
          class="size-6 flex items-center justify-center rounded-md text-icon-base hover:text-icon-strong-base hover:bg-surface-base cursor-pointer bg-transparent border-none p-0"
          title="copy session as markdown"
          onClick={() => void copySessionMarkdown(props.data, props.sessionID)}
        >
          <Icon name="copy" size="small" />
        </button>
        <a href={OPENSHARE_REPO_URL} target="_blank" rel="noreferrer" class="size-6 flex items-center justify-center rounded-md text-icon-base hover:text-icon-strong-base hover:bg-surface-base cursor-pointer" title="Open(code)Share">
          <Icon name="github" size="small" />
        </a>
        <button
          class="size-6 flex items-center justify-center rounded-md text-icon-base hover:text-icon-strong-base hover:bg-surface-base cursor-pointer bg-transparent border-none p-0"
          title="session info"
          onClick={() => toggleInfoPanel()}
        >
          <Icon name="information" size="small" />
        </button>
        <SettingsPanel
          settings={props.settings}
          update={props.updateSettings}
          branding={props.source.branding()}
          search={props.search}
          onSearch={props.onSearch}
          sessionTools={sessionTools()}
        />
      </div>
    </header>
  )
}
