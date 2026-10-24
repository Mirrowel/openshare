// The diff review panel, shared by classic and every skin (owner round
// 2026-10-25: "I want the diff view to be shown ... for all views, and
// allow views to customize it same SDK way").
//
// Two exports:
//  - ReviewToggle: the header button (right of the settings gear) that
//    shows/closes the panel. Classic renders it directly; base-view
//    passes it to every skin Header as `reviewToggle`.
//  - ReviewPanel: the SessionReview wiring (file-open state seeded all
//    open, diff style seeded from the global diffMode setting and written
//    back live) so classic, skins and custom review components share one
//    implementation.
import { createSignal, Show, type Component } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { SessionReview } from "@opencode/session-ui/session-review"
import type { FileDiffInfo } from "./fold"
import type { OshSettings } from "./settings"

export type ReviewProps = {
  diffs: FileDiffInfo[]
  settings: OshSettings
  updateSettings: (patch: Partial<OshSettings>) => void
}

/** skin-customizable review surface: default = the shared panel; a Skin
 *  may pass its own Component (same props) or `false` to opt out */
export type ReviewSurface = boolean | Component<ReviewProps>

export function ReviewToggle(props: { count: number; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      class="text-icon-weaker-base hover:text-icon-strong-base cursor-pointer bg-transparent border-none p-0"
      classList={{ "text-icon-strong-base": props.open }}
      title={`${props.open ? "close" : "show"} diff review - ${props.count} ${props.count === 1 ? "file" : "files"} changed`}
      aria-pressed={props.open}
      aria-label={`diff review (${props.count} files)`}
      onClick={props.onToggle}
    >
      <Icon name="review-active" size="small" />
    </button>
  )
}

export function ReviewPanel(props: ReviewProps) {
  // file-expand state: all files open (classic's behavior)
  const [open, setOpen] = createSignal<string[]>(props.diffs.map((d: any) => String(d.file ?? "")))
  // diff style rides the global diffMode setting (auto reads as unified
  // here; the panel's own toggle writes the setting back live)
  const [diffStyle, setDiffStyle] = createSignal<"unified" | "split">(props.settings.diffMode === "split" ? "split" : "unified")
  return (
    <SessionReview
      diffs={props.diffs as any}
      open={open()}
      onOpenChange={setOpen}
      diffStyle={diffStyle()}
      onDiffStyleChange={(style: "unified" | "split") => {
        setDiffStyle(style)
        props.updateSettings({ diffMode: style })
      }}
      classes={{ root: "pb-20", header: "px-6", container: "px-6" }}
    />
  )
}

/** the default review column content (skin.customizable via Skin.review) */
export function DefaultReview(props: ReviewProps) {
  return (
    <Show when={props.diffs.length > 0}>
      <ReviewPanel diffs={props.diffs} settings={props.settings} updateSettings={props.updateSettings} />
    </Show>
  )
}
