// CINEMA: the shooting-script skin over the shared base. The header is
// the production strip and title card, prompts open scenes under caps
// mono sluglines, tool calls are stage directions with the tool name as
// the parenthetical, reasoning is the writer's notes margin, responses
// are dialogue blocks credited to the cast. Continuous mode trades
// numbered sluglines for "cut to:" transitions. The base owns scroll,
// search, follow-live and the vendored tool pipeline; this file only
// arranges and decorates.
import { Show, createComputed, createSignal } from "solid-js"
import { Title } from "@solidjs/meta"
import { BaseSessionView, type Skin, type SkinWrappers } from "./base-view"
import { useView } from "./view-context"
import { SkinHeader, SkinFooter } from "./chrome"
import { useSessionSections, type SessionSection } from "./session-data"
import { SkinSettingsPopover } from "../settings-panel"
import { pagedFor } from "../settings"

type HeaderProps = Parameters<NonNullable<SkinWrappers["Header"]>>[0]
type FooterProps = Parameters<NonNullable<SkinWrappers["Footer"]>>[0]
type TurnProps = Parameters<NonNullable<SkinWrappers["TurnWrap"]>>[0]
type ToolProps = Parameters<NonNullable<SkinWrappers["ToolWrap"]>>[0]
type ResponseProps = Parameters<NonNullable<SkinWrappers["ResponseWrap"]>>[0]

// the script's presentation mode, tracked from the header (the only
// wrapper that sees settings) so the turns can restyle around it
const [flowing, setFlowing] = createSignal(false)
// the speaking part of the current scene, tracked from its turn
const [cast, setCast] = createSignal<SessionSection["model"]>(undefined)
// the title card, computed in the header (which sees data) and typeset
// above the first scene (presentation-only plumbing)
type Card = { title?: string; byline?: string; date?: string; scenes?: number }
const [card, setCard] = createSignal<Card>({})

// compress a prompt into a slugline: first meaningful line, markdown
// stripped, trimmed to one breath. Uppercase is applied by CSS.
function slugline(prompt: string): string {
  const line = (prompt.split("\n").find((l) => l.trim().length > 0) ?? "")
    .replace(/[`*_#>~[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!line) return "(silent)"
  if (line.length <= 58) return line
  const cut = line.slice(0, 58)
  const space = cut.lastIndexOf(" ")
  return (space > 24 ? cut.slice(0, space) : cut).trimEnd() + "..."
}

// the speaking part credited to the model: first segment of the model
// id (claude-sonnet-4-5 -> CLAUDE), ASSISTANT when unusable
function castName(model?: { providerID?: string; modelID?: string }): string {
  const head = (model?.modelID ?? "").split(/[-._]/)[0] ?? ""
  if (head && head.length <= 10 && !/^\d+$/.test(head)) return head.toUpperCase()
  return "ASSISTANT"
}

// production strip and title card: SkinHeader carries the structure
// (back, version, model, status, GitHub, settings trigger); cinema
// supplies the flavor (the "shooting script" caption, the slug status)
function CinemaHeader(props: HeaderProps) {
  const sections = useSessionSections(props.data, props.sessionID)
  createComputed(() => setFlowing(!pagedFor(props.settings, "cinema")))
  const view = useView()
  const info = view.info
  const b = () => props.source.branding()
  createComputed(() => {
    const i = info()
    setCard({
      title: i?.title,
      byline: props.model || undefined,
      date: i?.time?.created
        ? new Date(i.time.created).toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" })
        : undefined,
      scenes: sections().length,
    })
  })
  const slugClass = () =>
    props.status === "live"
      ? "text-icon-strong-base border-icon-strong-base"
      : props.status === "error"
        ? "text-icon-critical-base border-icon-critical-base"
        : "text-text-weaker border-border-strong-base"
  return (
    <>
      <Title>{info()?.title ?? "session"} | {b().name || "openshare"}</Title>
      <SkinHeader
        searchControl={props.searchControl}
        class="shrink-0 px-4 py-2 flex items-center justify-between gap-3 bg-background-stronger border-b border-border-weak-base relative z-30"
        leadClass="flex items-center gap-2.5 min-w-0"
        titleClass="text-12-mono uppercase tracking-widest text-text-weaker"
        metaClass="flex items-center gap-3 shrink-0"
        title="shooting script"
        afterBack={
          <Show when={b().logoUrl}>
            <a href={b().linkUrl ?? "#"} target="_blank" rel="noreferrer" class="shrink-0">
              <img src={b().logoUrl} alt="" class="h-4 rounded-sm" />
            </a>
          </Show>
        }
        statusRender={(status) => (
          <span
            class="text-12-mono uppercase tracking-widest border rounded px-1.5 py-0.5"
            classList={{ [slugClass()]: true }}
          >
            {status}
          </span>
        )}
        settingsTrigger={
          <SkinSettingsPopover
            settings={props.settings}
            update={props.updateSettings}
            branding={b() as any}
            search={props.search}
            onSearch={props.onSearch}
            gearClass="flex items-center gap-1.5 bg-transparent border border-border-weak-base rounded px-2 py-1 text-12-regular text-text-weaker hover:text-text-base hover:border-border-strong-base cursor-pointer transition-colors duration-150"
            gearLabel="settings"
          />
        }
      />
    </>
  )
}

// script footer: the fade line, then the shared brand row
function ScriptFooter(props: FooterProps) {
  const sections = useSessionSections(props.data, props.sessionID)
  return (
    <footer class="shrink-0 bg-background-stronger border-t border-border-weak-base">
      <Show when={sections().length > 0}>
        <div class="pt-3 text-center text-12-mono uppercase tracking-widest text-text-weaker">
          {props.source.status() === "live" ? "continued..." : "fade out."}
        </div>
      </Show>
      <SkinFooter class="h-7 px-4 flex items-center justify-between gap-3 text-12-mono text-text-weaker" label={`${sections().length} scenes · cinema`} />
    </footer>
  )
}

// one scene: the title card and fade in above the first, cut to:
// transitions in flowing mode
const cardMeta = () => {
  const c = card()
  const parts: string[] = []
  if (c.byline) parts.push(`written by ${c.byline}`)
  if (c.date) parts.push(c.date)
  if (c.scenes != null) parts.push(`${c.scenes} scenes`)
  return parts.join(" · ")
}
function Scene(props: TurnProps) {
  createComputed(() => setCast(props.section.model))
  return (
    <section classList={{ "pt-3": flowing(), "pt-10": !flowing() }}>
      <Show when={props.index === 0}>
        <div class="pb-10 text-center">
          <div class="text-12-mono uppercase tracking-widest text-text-weaker">a session, typeset</div>
          <h1 class="mt-3 text-20-medium uppercase tracking-widest text-text-strong break-words">
            {card().title ?? "untitled session"}
          </h1>
          <Show when={cardMeta()}>
            <div class="mt-3 text-12-mono text-text-weaker">{cardMeta()}</div>
          </Show>
        </div>
        <div class="pb-4 text-center text-14-mono uppercase text-text-weaker">fade in:</div>
      </Show>
      <Show when={flowing()}>
        <div class="pb-3 text-center text-12-mono uppercase tracking-widest text-text-weaker">cut to:</div>
      </Show>
      {props.children}
    </section>
  )
}

export const cinemaSkin: Skin = {
  id: "cinema",
  columnClass: "osh-content max-w-[48rem] mx-auto px-6 pt-10 pb-8",
  wrappers: {
    Header: CinemaHeader,
    Footer: ScriptFooter,
    TurnWrap: Scene,
    PromptWrap: (p) => (
      <div class="cinema-action">
        {/* SCENE label only - the FULL prompt renders as the body below
            (owner: the truncated slugline was kept instead of the full
            text - wrong half removed in the previous round) */}
        <h2 class="text-14-mono uppercase tracking-wide text-text-strong">
          <span class="text-text-weaker">Scene {p.section.index + 1}.</span>
        </h2>
        <div class="mt-3 pl-1 sm:pl-3">{p.children}</div>
      </div>
    ),
    ToolWrap: (p) => (
      <div class="my-1.5 pl-3 sm:pl-8">
        <div class="cinema-paren text-12-mono italic text-text-weaker">({p.entry.tool})</div>
        {p.children}
      </div>
    ),
    ReasoningWrap: (p) => <div class="my-1 pl-3 sm:pl-8 cinema-notes">{p.children}</div>,
    ResponseWrap: (p: ResponseProps) => (
      <div class="cinema-dialogue mt-4 pl-5 sm:pl-10">
        <div class="text-12-mono uppercase tracking-widest text-text-weaker">{castName(cast())}</div>
        <div class="mt-1.5 max-w-[40rem]">{p.children}</div>
      </div>
    ),
  },
}

