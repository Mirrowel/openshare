// casefile: the investigation-dossier skin over the shared base. Prompts
// are MEMO blocks, tool calls are exhibit-numbered evidence rows, reasoning
// is an annotations block, responses are report prose. Chrome: a folder-tab
// header with a rotated status stamp, settings as an index-card drawer from
// the right, an archive-line footer.
import { Show } from "solid-js"
import { BaseSessionView, type Skin, type SkinWrappers } from "./base-view"
import type { ViewEntry } from "./registry"
import type { SessionSection } from "./session-data"
import { Icon } from "@opencode/ui/icon"
import { Mark } from "@opencode/ui/logo"
import { DateTime } from "luxon"
import { Title } from "@solidjs/meta"

const pad = (n: number) => String(n + 1).padStart(2, "0")

const fileNo = (sessionID: string) =>
  (sessionID.replace(/^ses_/, "").slice(0, 8) || "00000000").toUpperCase()

function modelLabel(s: SessionSection) {
  if (s.model?.providerID && s.model?.id) return `${s.model.providerID}/${s.model.id}`
  return s.model?.id ?? ""
}

function filedLine(s: SessionSection) {
  const at = DateTime.fromMillis(s.at ?? Date.now()).toFormat("dd MMM yyyy HH:mm")
  const model = modelLabel(s)
  return model ? `${at} · ${model}` : at
}

function CasefileHeader(props: Parameters<NonNullable<SkinWrappers["Header"]>>[0]) {
  const info = () => (props.data.session as any[]).find((s) => s.id === props.sessionID)
  return (
    <>
      <Title>{info()?.title} | {props.source.branding().name || "openshare"}</Title>
      <div class="shrink-0 h-7 px-4 flex items-center justify-between gap-3 bg-background-stronger border-b border-border-weak-base relative z-20">
        <div class="flex items-center gap-2 min-w-0">
          <Show when={props.isSub && props.onBack}>
            <button
              class="flex items-center gap-1 h-6 px-1.5 rounded-md bg-transparent border-none cursor-pointer text-12-regular text-text-weaker hover:text-text-base hover:bg-surface-base shrink-0 transition-colors duration-150"
              onClick={() => props.onBack?.()}
            >
              <Icon name="arrow-left" size="small" />
              main
            </button>
          </Show>
          <div class="px-1.5 rounded-sm bg-surface-base text-12-mono text-text-weaker shrink-0">
            {fileNo(props.sessionID)}
          </div>
          <h1 class="text-14-medium text-text-strong truncate">{info()?.title ?? "session"}</h1>
        </div>
        <div class="flex items-center gap-3 shrink-0 text-12-mono text-text-weaker">
          <span class="flex items-center gap-1.5">
            <Mark class="h-3" />
            v{info()?.version ?? "?"}
          </span>
          <Show when={props.model}>
            <span class="hidden sm:inline truncate max-w-48">{props.model}</span>
          </Show>
        </div>
      </div>
    </>
  )
}

function ArchiveLine(props: Parameters<NonNullable<SkinWrappers["Footer"]>>[0]) {
  const b = () => props.source.branding()
  return (
    <div class="shrink-0 px-4 py-1.5 border-t border-border-weak-base bg-background-base">
      <div class="max-w-[52rem] mx-auto flex items-center justify-between gap-4 text-12-mono text-text-weaker">
        <span class="flex items-center gap-2 min-w-0">
          <Show when={b().logoUrl}>
            <img src={b().logoUrl} alt="" class="h-4 rounded-sm" />
          </Show>
          <span class="truncate">
            {b().wordmarkUrl ? "" : `${b().name ? b().name + " · " : ""}Open(code)Share`}
          </span>
          <Show when={b().wordmarkUrl}>
            <img src={b().wordmarkUrl} alt="" class="h-3.5" />
          </Show>
        </span>
      </div>
    </div>
  )
}

export const casefileSkin: Skin = {
  id: "casefile",
  mode: "composed",
  columnClass: "max-w-[52rem] mx-auto px-6 py-4",
  wrappers: {
    Header: CasefileHeader,
    Footer: ArchiveLine,
    TurnWrap: (p) => (
      <article class="py-5 border-b border-border-weak-base last:border-none">
        <Show when={p.index === 0}>
          <div class="text-12-mono text-text-weaker mb-4">FILED {filedLine(p.section)}</div>
        </Show>
        {p.children}
      </article>
    ),
    PromptWrap: (p) => (
      <div class="flex items-start gap-3 mb-2">
        <span class="shrink-0 text-12-mono text-text-weaker bg-surface-base rounded px-1.5 mt-1.5">
          MEMO {pad(p.section.index)}
        </span>
        <div class="flex-1 min-w-0">{p.children}</div>
      </div>
    ),
    ToolWrap: (p) => (
      <div class="flex items-start gap-3 my-1">
        <span class="hidden sm:flex items-center justify-end shrink-0 pt-1.5 w-12">
          <span class="text-12-mono text-text-weaker">E-{pad(p.index)}</span>
        </span>
        <div class="flex-1 min-w-0">{p.children}</div>
      </div>
    ),
    ReasoningWrap: (p) => (
      <div class="flex items-start gap-3 my-0.5">
        <span class="hidden sm:block text-12-mono text-text-weaker shrink-0 pt-1 w-12 text-right">note</span>
        <div class="flex-1 min-w-0">{p.children}</div>
      </div>
    ),
    ResponseWrap: (p) => <div class="report-prose">{p.children}</div>,
  },
}

export function CasefileView(props: Parameters<ViewEntry["component"]>[0]) {
  return <BaseSessionView {...props} skin={casefileSkin} />
}

export const casefile = {
  id: "casefile",
  label: "casefile",
  component: CasefileView,
}
