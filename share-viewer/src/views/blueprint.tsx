// BLUEPRINT VIEW: the session as an engineering drafting sheet, now a
// skin over the shared base. A fine token grid carries the sheet; each
// prompt is an issued VIEW item on a dimension line, reasoning is an
// ANNOT margin note, tool calls are D-numbered DETAIL boxes (chamfered
// corners, leader elbows off the sheet rail), responses are the NOTES
// block. Chrome: a drafting strip header with the status stamp, settings
// as a SHEET PARAMETERS drawer, a bill of materials nav, and a
// title-block footer. The base owns scroll, search, follow-live,
// navigation and the vendored tool pipeline; this file only arranges
// and decorates.
import { For, Show, createSignal, type JSX } from "solid-js"
import { Title } from "@solidjs/meta"
import { Icon } from "@opencode/ui/icon"
import { Mark } from "@opencode/ui/logo"
import { DateTime } from "luxon"
import { BaseSessionView, type Skin, type SkinWrappers } from "./base-view"
import type { ViewEntry } from "./registry"
import { sessionModelLabel, useSessionSections, type SessionSection } from "./session-data"

type HeaderProps = Parameters<NonNullable<SkinWrappers["Header"]>>[0]
type FooterProps = Parameters<NonNullable<SkinWrappers["Footer"]>>[0]
type NavProps = Parameters<NonNullable<SkinWrappers["Nav"]>>[0]
type TurnProps = Parameters<NonNullable<SkinWrappers["TurnWrap"]>>[0]
type ToolProps = Parameters<NonNullable<SkinWrappers["ToolWrap"]>>[0]

const pad = (n: number) => String(n + 1).padStart(2, "0")

const firstLine = (s: SessionSection) => s.prompt.split("\n")[0]?.slice(0, 90) || "(no prompt text)"

// hollow diamond leader elbow off the sheet rail
function Elbow(props: { solid?: boolean; top?: string }) {
  return (
    <span
      class="pointer-events-none absolute right-full hidden sm:flex items-center w-9 pr-1"
      style={{ top: props.top ?? "16px" }}
      aria-hidden="true"
    >
      <span class={`h-px flex-1 ${props.solid ? "bg-border-base" : "bg-border-weak-base"}`} />
      <span
        class={`size-[5px] rotate-45 shrink-0 ${
          props.solid ? "bg-border-strong-base" : "border border-border-base bg-background-base"
        }`}
      />
    </span>
  )
}

// drafting strip header: title block fields, status stamp, settings drawer
function DraftingHeader(props: HeaderProps) {
  const info = () => (props.data.session as any[]).find((s) => s.id === props.sessionID)
  const b = () => props.source.branding()
  const dwgNo = () => (props.sessionID.replace(/^ses_/, "").slice(0, 8) || "00000000").toUpperCase()
  return (
    <>
      <style>{`
        .bp-grid {
          background-image:
            linear-gradient(to right, color-mix(in oklab, var(--border-weak-base) 85%, transparent) 1px, transparent 1px),
            linear-gradient(to bottom, color-mix(in oklab, var(--border-weak-base) 85%, transparent) 1px, transparent 1px),
            linear-gradient(to right, color-mix(in oklab, var(--border-weak-base) 45%, transparent) 1px, transparent 1px),
            linear-gradient(to bottom, color-mix(in oklab, var(--border-weak-base) 45%, transparent) 1px, transparent 1px);
          background-size: 120px 120px, 120px 120px, 24px 24px, 24px 24px;
        }
        .bp-cut, .bp-cut-in {
          clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 0 100%);
        }
        .bp-dim {
          position: relative;
          height: 1px;
          background: var(--border-strong-base);
        }
        .bp-dim::before, .bp-dim::after {
          content: "";
          position: absolute;
          top: 50%;
          margin-top: -4px;
          border-top: 4px solid transparent;
          border-bottom: 4px solid transparent;
        }
        .bp-dim::before { left: 0; border-left: 7px solid var(--border-strong-base); }
        .bp-dim::after { right: 0; border-right: 7px solid var(--border-strong-base); }
        .bp-dim-l, .bp-dim-r {
          position: relative;
          height: 1px;
          background: var(--border-weak-base);
        }
        .bp-dim-l::before {
          content: "";
          position: absolute;
          top: 50%;
          margin-top: -4px;
          left: 0;
          border-top: 4px solid transparent;
          border-bottom: 4px solid transparent;
          border-right: 7px solid var(--border-weak-base);
        }
        .bp-dim-r::after {
          content: "";
          position: absolute;
          top: 50%;
          margin-top: -4px;
          right: 0;
          border-top: 4px solid transparent;
          border-bottom: 4px solid transparent;
          border-left: 7px solid var(--border-weak-base);
        }
        .bp-sheet::before {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;
          background-image:
            linear-gradient(var(--border-strong-base), var(--border-strong-base)),
            linear-gradient(var(--border-strong-base), var(--border-strong-base)),
            linear-gradient(var(--border-strong-base), var(--border-strong-base)),
            linear-gradient(var(--border-strong-base), var(--border-strong-base)),
            linear-gradient(var(--border-strong-base), var(--border-strong-base)),
            linear-gradient(var(--border-strong-base), var(--border-strong-base)),
            linear-gradient(var(--border-strong-base), var(--border-strong-base)),
            linear-gradient(var(--border-strong-base), var(--border-strong-base));
          background-repeat: no-repeat;
          background-size: 14px 2px, 2px 14px, 14px 2px, 2px 14px, 14px 2px, 2px 14px, 14px 2px, 2px 14px;
          background-position: left top, left top, right top, right top, left bottom, left bottom, right bottom, right bottom;
        }
      `}</style>
      <Title>{info()?.title ?? "session"} | {b().name || "openshare"}</Title>
      <div class="h-7 px-4 flex items-center gap-2 bg-background-stronger border-b border-border-base shrink-0 relative z-20">
        <Show when={props.isSub && props.onBack}>
          <button
            class="flex items-center gap-1 h-6 px-1.5 rounded-md bg-transparent border-none cursor-pointer text-12-mono text-text-weaker hover:text-text-base hover:bg-surface-base shrink-0"
            onClick={() => props.onBack?.()}
          >
            <Icon name="arrow-left" size="small" />
            main
          </button>
        </Show>
        <span class="hidden sm:inline text-12-mono text-text-weaker shrink-0">DWG {dwgNo()}</span>
        <span class="hidden sm:block h-4 w-px bg-border-weak-base shrink-0" />
        <h1 class="min-w-0 flex-1 truncate text-14-medium text-text-strong">{info()?.title ?? "session"}</h1>
        <span class="hidden sm:flex items-center gap-1.5 text-12-mono text-text-weaker shrink-0">
          <Mark class="h-3" />
          v{info()?.version}
        </span>
        <Show when={props.model}>
          <span class="hidden md:inline text-12-mono text-text-weaker truncate max-w-48 shrink-0">{props.model}</span>
        </Show>
      </div>
    </>
  )
}

// title block: the drafting sheet's corner stamp, as page chrome
function TitleBlockCell(props: { label: string; children: JSX.Element; span?: boolean; wide?: boolean }) {
  return (
    <div class="bg-background-base px-3 py-1 min-w-0" classList={{ "sm:col-span-2": props.span, "hidden sm:block": props.wide }}>
      <div class="text-12-mono text-text-weaker">{props.label}</div>
      <div class="text-12-mono text-text-base truncate">{props.children}</div>
    </div>
  )
}

function TitleBlockFooter(props: FooterProps) {
  const sections = useSessionSections(props.data, props.sessionID)
  const info = () => (props.data.session as any[]).find((s) => s.id === props.sessionID)
  const b = () => props.source.branding()
  const issued = () => DateTime.fromMillis(info()?.time?.created ?? Date.now()).toFormat("dd MMM yyyy HH:mm")
  const drawnBy = () => sessionModelLabel(props.data, props.sessionID) || "n/a"
  return (
    <div class="shrink-0 grid grid-cols-2 sm:grid-cols-5 gap-px bg-border-weak-base border-t border-border-base">
      <TitleBlockCell label="title" span>
        <span class="flex items-center gap-2 min-w-0">
          <Show when={b().logoUrl}>
            <img src={b().logoUrl} alt="" class="h-3.5 rounded-sm shrink-0" />
          </Show>
          <Show
            when={b().wordmarkUrl}
            fallback={
              <span class="truncate">
                {b().name ? b().name + " · " : ""}Open(code)Share
              </span>
            }
          >
            <img src={b().wordmarkUrl} alt="" class="h-3.5" />
          </Show>
        </span>
      </TitleBlockCell>
      <TitleBlockCell label="issue">{issued()}</TitleBlockCell>
      <TitleBlockCell label="drawn by" wide>{drawnBy()}</TitleBlockCell>
      <TitleBlockCell label="sheet" wide>{sections().length} sht · scale nts</TitleBlockCell>
    </div>
  )
}

// the bill of materials: the base's nav slot, listing every issued view
function BillOfMaterials(props: NavProps) {
  return (
    <div class="w-60 border border-border-weak-base bg-background-base">
      <div class="flex items-center justify-between gap-3 px-3 py-1 border-b border-border-weak-base bg-background-stronger">
        <span class="text-12-mono text-text-weaker">bill of materials</span>
        <span class="text-12-mono text-text-weaker">{props.sections.length}</span>
      </div>
      <div class="grid grid-cols-[2.75rem_1fr_3rem] gap-2 px-3 py-0.5 border-b border-border-weak-base text-12-mono text-text-weaker">
        <span>no.</span>
        <span>description</span>
        <span class="text-right">det</span>
      </div>
      <For each={props.sections}>
        {(s, i) => (
          <button
            class="grid grid-cols-[2.75rem_1fr_3rem] items-baseline gap-2 w-full px-3 py-1 text-left bg-transparent border-t border-border-weak-base first:border-t-0 cursor-pointer transition-colors duration-150"
            classList={{
              "bg-surface-base": props.active === i(),
              "hover:bg-surface-base-hover": props.active !== i(),
            }}
            onClick={() => props.onSelect(i())}
          >
            <span class="text-12-mono text-text-strong">{pad(s.index)}</span>
            <span class="text-12-regular text-text-base truncate">{firstLine(s)}</span>
            <span class="text-12-mono text-text-weaker text-right">
              {s.tools.length > 0 ? `D:${s.tools.length}` : "-"}
            </span>
          </button>
        )}
      </For>
    </div>
  )
}

// one issued view: a construction rail with datum diamond and V-NN tag;
// between views, a dimensioned sheet break (SHT NN) centered in the gap
function Sheet(props: TurnProps) {
  return (
    <article class="relative sm:pl-9 scroll-mt-16">
      <Show when={props.index > 0}>
        <div class="absolute -top-6 left-0 right-0 flex items-center gap-3" aria-hidden="true">
          <span class="bp-dim-l flex-1" />
          <span class="shrink-0 text-12-mono text-text-weaker">
            sht {pad(props.index)}
          </span>
          <span class="bp-dim-r flex-1" />
        </div>
      </Show>
      <span class="hidden sm:block absolute left-0 top-0 bottom-0 w-px bg-border-weak-base" aria-hidden="true" />
      <span
        class="hidden sm:block absolute -left-1 top-2 size-2 rotate-45 border border-border-strong-base bg-background-base"
        aria-hidden="true"
      />
      {props.children}
    </article>
  )
}

// D-numbered detail box: chamfered frame around the vendored tool part;
// the bar carries the detail number, the tool name, and a REF-style label
function DetailBox(props: ToolProps) {
  return (
    <div class="relative my-1">
      <Elbow solid top="15px" />
      <div class="bp-cut bg-border-weak-base p-px">
        <div class="bp-cut-in bg-background-base px-2 py-0.5 flex items-start gap-2">
          <span class="shrink-0 w-9 pt-[3px] text-12-mono text-text-weaker">D-{pad(props.index)}</span>
          <div class="bp-tool min-w-0 flex-1">{props.children}</div>
        </div>
      </div>
    </div>
  )
}

export const blueprintSkin: Skin = {
  id: "blueprint",
  mode: "composed",
  columnClass:
    "bp-sheet bp-grid relative w-full max-w-[56rem] mx-auto px-4 sm:px-8 py-8 flex flex-col gap-8 border border-border-base",
  wrappers: {
    Header: DraftingHeader,
    Footer: TitleBlockFooter,
    Nav: BillOfMaterials,
    TurnWrap: Sheet,
    PromptWrap: (p) => (
      <div class="bp-req relative">
        <div class="flex items-center gap-2.5 mb-1.5">
          <span class="shrink-0 text-12-mono text-text-strong border border-border-base px-1.5 py-0.5">
            V-{pad(p.section.index)}
          </span>
          <span class="bp-dim flex-1" aria-hidden="true" />
          <span class="shrink-0 text-12-mono uppercase tracking-widest text-text-weaker">issued</span>
        </div>
        {p.children}
      </div>
    ),
    ToolWrap: DetailBox,
    ReasoningWrap: (p) => (
      <div class="relative my-1.5">
        <Elbow top="9px" />
        {p.children}
      </div>
    ),
    ResponseWrap: (p) => (
      <Show when={p.text.trim()}>
        <div class="relative mt-4">
          <Elbow top="9px" />
          <div class="flex items-center gap-3 mb-2">
            <span class="flex items-center gap-1.5 shrink-0 text-12-mono uppercase tracking-widest text-text-weaker">
              <span class="size-1.5 bg-border-strong-base" aria-hidden="true" />
              notes
            </span>
            <span class="flex-1 h-px bg-border-weak-base" />
          </div>
          {p.children}
        </div>
      </Show>
    ),
  },
}

export const blueprint: ViewEntry = {
  id: "blueprint",
  label: "blueprint",
  component: (p) => <BaseSessionView {...p} skin={blueprintSkin} />,
}
