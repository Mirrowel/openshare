// casefile: the investigation-dossier skin over the shared base. Prompts
// are MEMO blocks, tool calls are exhibit-numbered evidence rows, reasoning
// is an annotations block, responses are report prose. Chrome: a folder-tab
// header with a rotated status stamp, settings as an index-card drawer from
// the right, an archive-line footer.
import { Show, createSignal } from "solid-js"
import { BaseSessionView, type Skin, type SkinWrappers } from "./base-view"
import { useView } from "./view-context"
import { SkinHeader, SkinFooter } from "./chrome"
import { SkinSettingsPopover } from "../settings-panel"
import type { ViewEntry } from "./registry"
import type { SessionSection } from "./session-data"
import { Icon } from "@opencode/ui/icon"
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
  const view = useView()
  const info = view.info
  const stampColor = () =>
    props.status === "live"
      ? "text-icon-strong-base border-icon-strong-base"
      : props.status === "error"
        ? "text-icon-critical-base border-icon-critical-base"
        : "text-text-weaker border-border-strong-base"
  return (
    <>
      <Title>{info()?.title} | {props.source.branding().name || "openshare"}</Title>
      <SkinHeader
        class="shrink-0 px-5 pt-3 bg-background-stronger border-b border-border-weak-base relative z-30"
        leadClass="flex items-end gap-3 min-w-0"
        titleClass="text-16-medium text-text-strong truncate pb-1"
        metaClass="flex items-center gap-3 pb-1.5 shrink-0"
        afterBack={
          <div class="px-3 py-1 rounded-t-lg border border-b-0 border-border-weak-base bg-background-base text-12-mono text-text-weaker self-end">
            CASE {fileNo(props.sessionID)}
          </div>
        }
        statusRender={(status) => (
          <span
            class="text-12-mono uppercase tracking-widest border rounded px-1.5 py-0.5 rotate-[-2deg]"
            classList={{ [stampColor()]: true }}
          >
            {status}
          </span>
        )}
        settingsTrigger={
          <SkinSettingsPopover
            settings={props.settings}
            update={props.updateSettings}
            branding={props.source.branding()}
            search={props.search}
            onSearch={props.onSearch}
            gearClass="flex items-center gap-1.5 bg-transparent border border-border-weak-base rounded px-2 py-1 text-12-regular text-text-weaker hover:text-text-base hover:border-border-strong-base cursor-pointer transition-colors duration-150"
            gearLabel="index"
          />
        }
      />
    </>
  )
}

function ArchiveLine(_props: Parameters<NonNullable<SkinWrappers["Footer"]>>[0]) {
  return (
    <div class="shrink-0 px-6 py-3 border-t border-border-weak-base bg-background-base">
      <SkinFooter class="max-w-[52rem] mx-auto flex items-center justify-between gap-4 text-12-mono text-text-weaker" />
    </div>
  )
}

export const casefileSkin: Skin = {
  id: "casefile",
  mode: "composed",
  columnClass: "max-w-[52rem] mx-auto px-6 py-6",
  wrappers: {
    Header: CasefileHeader,
    Footer: ArchiveLine,
    TurnWrap: (p) => (
      <article class="py-7 border-b border-border-weak-base last:border-none">
        <Show when={p.index === 0}>
          <div class="text-12-mono text-text-weaker opacity-70 mb-6">FILED {filedLine(p.section)}</div>
        </Show>
        {p.children}
      </article>
    ),
    PromptWrap: (p) => (
      <div class="flex items-start gap-4 mb-3">
        <span class="shrink-0 text-12-mono text-text-weaker border border-border-weak-base rounded px-1.5 py-0.5">
          MEMO {pad(p.section.index)}
        </span>
        <div class="flex-1 min-w-0">{p.children}</div>
      </div>
    ),
    ToolWrap: (p) => (
      <div class="flex items-start gap-3 my-2">
        <span class="hidden sm:flex flex-col items-end gap-1 shrink-0 pt-1.5 w-20">
          <span class="text-12-mono text-text-weaker opacity-60">evidence</span>
          <span class="text-12-mono text-text-weaker border border-border-weak-base rounded px-1">E-{pad(p.index)}</span>
        </span>
        <div class="flex-1 min-w-0">{p.children}</div>
      </div>
    ),
    ReasoningWrap: (p) => (
      <div class="flex items-start gap-3 my-1">
        <span class="hidden sm:block text-12-mono text-text-weaker opacity-60 shrink-0 pt-1 w-20 text-right">annot.</span>
        <div class="flex-1 min-w-0">{p.children}</div>
      </div>
    ),
    ResponseWrap: (p) => <div class="report-prose">{p.children}</div>,
  },
}

