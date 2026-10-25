// The ONE app header, shared by classic and every skin: brand chip,
// source status, copy, repo link, settings. Skins render below it and never
// own settings or navigation chrome, so the view switcher never moves.
import { Icon } from "@opencode/ui/icon"
import { Show } from "solid-js"
import type { Branding, useShareSource } from "./data-source"
import { SettingsPanel, closePanel } from "./settings-panel"
import { toggleInfoPanel } from "./views/info-panel"
import { visibleMessages, type ShareData } from "./fold"
import type { OshSettings } from "./settings"

// the product's own repo (fixed in source — the right header always
// promotes Open(code)Share; flip on extraction)
const OPENSHARE_REPO_URL = "https://github.com/Mirrowel/OpenShare"

// Brand-aware mark: configured image or the vendored default
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
    (message.content ?? []).filter((part) => part.type === "tool").map((part) => part.name),
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
          onClick={() => copySessionMarkdown(props.data, props.sessionID)}
        >
          <Icon name="copy" size="small" />
        </button>
        <a href={OPENSHARE_REPO_URL} target="_blank" rel="noreferrer" class="size-6 flex items-center justify-center rounded-md text-icon-base hover:text-icon-strong-base hover:bg-surface-base cursor-pointer" title="Open(code)Share">
          <Icon name="github" size="small" />
        </a>
        <button
          class="size-6 flex items-center justify-center rounded-md text-icon-base hover:text-icon-strong-base hover:bg-surface-base cursor-pointer bg-transparent border-none p-0"
          title="session info"
          onClick={() => {
            closePanel()
            toggleInfoPanel()
          }}
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

// serialize the visible session to markdown (clipboard)
async function copySessionMarkdown(data: ShareData, sessionID: string) {
  const info = data.session.find((s: any) => s.id === sessionID) as any
  const modelLabel = data.model[sessionID]?.[0]?.name ?? data.model[sessionID]?.[0]?.id ?? ""
  const parts: string[] = [
    `# ${info?.title ?? sessionID}`,
    "",
    `_model: ${modelLabel || "?"} · v${info?.version ?? "?"} · ${info?.directory ?? ""}_`,
    "",
  ]
  const toolOutputText = (state: any): string => {
    // our v1 normalization emits content[]; v2 hosts may emit output
    for (const key of ["content", "output"]) {
      const v = state?.[key]
      if (typeof v === "string") return v
      if (Array.isArray(v)) {
        const text = v.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("")
        if (text) return text
      }
    }
    return ""
  }
  for (const m of visibleMessages(data, sessionID)) {
    const msg = m as any
    if (msg?.type === "user") {
      if (msg.text) parts.push("## user", "", msg.text, "")
      continue
    }
    if (msg?.type === "compaction") {
      parts.push("> _compaction — session summarized_", "", String(msg.summary ?? ""), "")
      continue
    }
    if (msg?.type !== "assistant") continue
    parts.push("## assistant", "")
    for (const c of msg.content ?? []) {
      if (c?.type === "text" && c.text) parts.push(c.text, "")
      else if (c?.type === "reasoning" && c.text) parts.push("<details><summary>thinking</summary>", "", c.text, "", "</details>", "")
      else if (c?.type === "tool") {
        const st = c.state ?? {}
        const input = st.input ?? {}
        const inv =
          [input.query, input.command, input.prompt, input.pattern, input.path, input.description]
            .find((v: unknown) => typeof v === "string" && v.trim()) ??
          (c.name === "subagent" && Array.isArray(input.prompts) ? String(input.prompts[0] ?? "") : "")
        let out = toolOutputText(st)
        if (c.name === "subagent") out = ""
        if (out.length > 600) out = out.slice(0, 600) + "—"
        parts.push(`> _tool: ${c.name ?? "tool"}${inv ? ` — ${String(inv).slice(0, 120)}` : ""}_`, "")
        if (out) parts.push("> ```", out.split("\n").map((l: string) => "> " + l).join("\n"), "> ```", "")
      }
    }
  }
  await navigator.clipboard.writeText(parts.join("\n"))
}
