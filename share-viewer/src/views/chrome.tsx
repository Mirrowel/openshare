// Chrome primitives (views-SDK phase 2): the header/footer scaffolding
// every skin duplicated by hand - written ONCE here, styled by the skin.
// A skin header is now: <SkinHeader class="..." settingsTrigger={...}/>
// plus whatever decoration the skin adds around it. Same for SkinFooter.
//
// Deliberate unification (owner-approved direction: skins are reskins of
// classic, not full rebuilds): the status presentation converges on one
// token-mapped tone instead of 9 divergent color maps.
import { Show, type JSX } from "solid-js"
import { useView } from "./view-context"
import { Icon } from "@opencode/ui/icon"
import { Mark } from "@opencode/ui/logo"

export const OPENSHARE_REPO = "https://github.com/Mirrowel/OpenShare"

/** one tone map for share status (token classes, theme-following) */
export function statusTone(status: string): string {
  if (status === "live") return "text-icon-success-base"
  if (status === "error" || status === "interrupted") return "text-icon-danger-base"
  if (status === "waiting") return "text-icon-accent-base"
  return "text-icon-weaker-base"
}

/** a dot + label status readout (the majority pattern) */
export function StatusReadout(props: { status: string }) {
  return (
    <span class={`flex items-center gap-1.5 ${statusTone(props.status)}`}>
      <span class="inline-block size-1.5 rounded-full bg-current" classList={{ "animate-pulse": props.status === "live" }} />
      {props.status}
    </span>
  )
}

/** the shared header core: back, title, version, model, status, GitHub,
 *  settings trigger. Structure + logic live here; classes come from the
 *  skin. Slots replace pieces when a skin needs its own flavor. */
export function SkinHeader(props: {
  /** root element classes (height, borders, background, font) */
  class?: string
  /** left cluster classes */
  leadClass?: string
  /** title text classes */
  titleClass?: string
  /** meta cluster classes (version, model, status) */
  metaClass?: string
  /** the skin's settings trigger (popover button / drawer button);
   *  skins that render nothing get no trigger */
  settingsTrigger?: JSX.Element
  /** extra content after the title (skin flavor) */
  afterTitle?: JSX.Element
  /** extra content at the far right, before GitHub */
  trailing?: JSX.Element
  /** hide the GitHub repo link (rare) */
  noGithub?: boolean
  /** custom status presentation (default: StatusReadout) */
  statusRender?: (status: string) => JSX.Element
  /** custom title text (default: session title) */
  title?: string
}) {
  const view = useView()
  return (
    <header class={props.class ?? "h-9 px-4 flex items-center justify-between self-stretch bg-background-base border-b border-border-weak-base relative z-30"}>
      <div class={props.leadClass ?? "flex items-center gap-2 min-w-0"}>
        <Show when={view.isSub()}>
          <button
            class="flex items-center gap-1 text-12-regular text-text-weaker hover:text-text-base bg-transparent border-none cursor-pointer shrink-0"
            onClick={() => view.back()}
          >
            <Icon name="arrow-left" size="small" />
            main
          </button>
        </Show>
        <span class={props.titleClass ?? "text-13-medium text-text-strong truncate"}>{props.title ?? view.info()?.title ?? "session"}</span>
        {props.afterTitle}
      </div>
      <div class={props.metaClass ?? "flex items-center gap-3"}>
        <span class="flex items-center gap-1.5 text-12-mono text-text-weaker">
          <Mark class="w-3" />
          <span>v{view.version() ?? "?"}</span>
        </span>
        <Show when={view.model()}>
          <span class="text-12-mono text-text-weaker truncate max-w-48">{view.model()}</span>
        </Show>
        {props.statusRender ? props.statusRender(view.status()) : <StatusReadout status={view.status()} />}
        {props.trailing}
        <Show when={!props.noGithub}>
          <a href={OPENSHARE_REPO} target="_blank" rel="noreferrer" class="text-icon-weaker-base hover:text-icon-strong-base cursor-pointer" title="Open(code)Share">
            <Icon name="github" size="small" />
          </a>
        </Show>
        {props.settingsTrigger}
      </div>
    </header>
  )
}

/** the shared footer core: branding/wordmark, view label, GitHub */
export function SkinFooter(props: {
  class?: string
  /** small right-side label (usually the view id) */
  label?: string
  /** hide the GitHub link */
  noGithub?: boolean
}) {
  const view = useView()
  const b = () => view.source.branding()
  return (
    <div class={props.class ?? "px-6 py-6 flex items-center justify-between text-12-mono text-text-weaker select-none"}>
      <div class="flex items-center gap-2 min-w-0">
        <Show when={b().logoUrl}>
          <img src={b().logoUrl} alt="" class="h-3 rounded-sm" />
        </Show>
        <span class="truncate">
          {b().wordmarkUrl ? "" : `${b().name ? b().name + " · " : ""}Open(code)Share`}
        </span>
        <Show when={b().wordmarkUrl}>
          <img src={b().wordmarkUrl} alt="" class="h-3.5" />
        </Show>
      </div>
      <div class="flex items-center gap-3 shrink-0">
        <Show when={props.label}>
          <span>{props.label}</span>
        </Show>
        <Show when={!props.noGithub}>
          <a href={OPENSHARE_REPO} target="_blank" rel="noreferrer" class="text-icon-weaker-base hover:text-icon-strong-base cursor-pointer" title="Open(code)Share">
            <Icon name="github" size="small" />
          </a>
        </Show>
      </div>
    </div>
  )
}

// ---- shared derived helpers (the per-skin re-implementations, once) ----

/** the 8-char session code (casefile/teletype/blueprint sliced it 3 ways) */
export function sessionCode(sessionID: string): string {
  return sessionID.replace(/-/g, "").slice(-8)
}

/** zero-pad to 2 digits */
export function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** first line of a prompt, trimmed - the rail/nav/title pattern */
export function promptTitle(prompt: string, max = 60): string {
  return prompt.trim().split("\n")[0].slice(0, max) || "(no prompt)"
}
