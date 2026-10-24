// The view registry (views-SDK phase 3: single-source registration).
// A view is a full-page reading instrument for the same session data.
// Views register here ONCE: the entry carries the id (from the skin), the
// label, the visual mark, the paged capability, and any view-scoped
// settings - no VIEW_MARKS table, no triple id, no shared-file edits when
// a view adds a setting.
import type { JSX } from "solid-js"
import type { ShareData } from "../fold"
import type { useShareSource } from "../data-source"
import type { OshSettings } from "../settings"
import type { Skin } from "./base-view"
import { BaseSessionView } from "./base-view"

// classic + reader live in the standard chrome (not BaseSessionView
// skins in the registry sense) but still need entries for the selector,
// the paged capability and their view-scoped settings
export type ViewProps = {
  data: ShareData
  sessionID: string
  source: ReturnType<typeof useShareSource>
  settings: OshSettings
  updateSettings: (patch: Partial<OshSettings>) => void
  search: string
  onSearch: (v: string) => void
}

/** a view-scoped setting, rendered automatically by the settings panel
 *  when this view is active. `key` is an OshSettings field the view owns;
 *  `showWhen` gates visibility on another boolean key being true. */
export type ViewSettingDef =
  | { kind: "switch"; key: string; label: string; hint?: string }
  | { kind: "segmented"; key: string; label: string; hint?: string; showWhen?: string; options: { id: string; label: string }[] }

export type ViewEntry = {
  id: string
  label: string
  component: (props: ViewProps) => JSX.Element
  /** the selector-grid glyph (was the VIEW_MARKS table) */
  mark?: string
  /** false = this view is continuous-only (a stream metaphor with no
   *  meaningful "one prompt at a time" page): the settings panel hides the
   *  paged/continuous toggle for it and it never renders the prompt rail
   *  (owner directive 2026-10-24: some views are always continuous, and
   *  the option to enable paging should not even be shown) */
  paged?: boolean
  /** view-scoped settings (rendered in the settings panel when active) */
  settings?: ViewSettingDef[]
}

// the settings panel lists classic + reader + every registered view
export const VIEW_OPTIONS: { id: string; label: string }[] = [
  { id: "classic", label: "classic" },
  { id: "reader", label: "reader" },
]

// view-scoped settings for the chrome-mounted views (registered views
// carry theirs on their entries; see registerView)
export const VIEW_SETTINGS: Record<string, ViewSettingDef[]> = {
  classic: [
    { kind: "switch", key: "toolGrouping", label: "Group tool calls", hint: "collapse a response's tool calls into summary rows" },
    { kind: "segmented", key: "toolGroupingScope", label: "Group", showWhen: "toolGrouping", hint: "reads & searches matches the original scope: shell, edits and agents stay their own rows", options: [{ id: "context", label: "reads & searches" }, { id: "all", label: "all calls" }] },
  ],
}

// full-page views (classic and reader live in the standard chrome)
export const VIEWS: ViewEntry[] = []

export function registerView(entry: ViewEntry) {
  if (VIEWS.some((v) => v.id === entry.id)) return
  VIEWS.push(entry)
  VIEW_SETTINGS[entry.id] = entry.settings ?? []
  const opt = VIEW_OPTIONS.find((o) => o.id === entry.id)
  if (!opt) VIEW_OPTIONS.push({ id: entry.id, label: entry.label })
}

/** register a SKIN as a view: the entry derives its id from the skin and
 *  the component is the standard BaseSessionView mount - one declaration
 *  per view, no wrapper boilerplate */
export function registerSkin(skin: Skin, extra: { label: string; mark?: string; paged?: boolean; settings?: ViewSettingDef[] }) {
  registerView({
    id: skin.id,
    label: extra.label,
    mark: extra.mark,
    paged: extra.paged,
    settings: extra.settings,
    component: (props) => <BaseSessionView {...props} skin={skin} />,
  })
}

export function findView(id: string): ViewEntry | undefined {
  return VIEWS.find((v) => v.id === id)
}

/** the selector glyph for a view (entries carry theirs; classic/reader
 *  keep their literal marks here) */
const CHROME_MARKS: Record<string, string> = { classic: "▣", reader: "≡" }
export function viewMark(id: string): string {
  return findView(id)?.mark ?? CHROME_MARKS[id] ?? (findView(id)?.label ?? id)[0]
}


/** does this view support paged mode? (classic/reader do; registered views
 *  declare it via ViewEntry.paged, default true) */
export function viewSupportsPaged(id: string): boolean {
  if (id === "classic" || id === "reader") return true
  const v = VIEWS.find((x) => x.id === id)
  return v?.paged !== false
}

// which session a route renders (main or subagent /N) - shared with the
// classic chrome so every view lands on the same session
export function resolveSessionID(data: ShareData, sub: number | undefined): string {
  if (sub == null) return data.sessionID
  const hit = children(data).find((s) => s.index === sub)
  return hit ? hit.sessionID : data.sessionID
}

import { children } from "../fold"
import { terminalSkin } from "./terminal"
import { casefileSkin } from "./casefile"
import { blueprintSkin } from "./blueprint"
import { cinemaSkin } from "./cinema"
import { timelineSkin } from "./timeline"
import { letterpressSkin } from "./letterpress"
import { atlasSkin } from "./atlas"
import { teletypeSkin } from "./teletype"
import { groveSkin } from "./grove"

registerSkin(terminalSkin, { label: "terminal", mark: "❯" })
registerSkin(casefileSkin, { label: "casefile", mark: "◫" })
registerSkin(blueprintSkin, { label: "blueprint", mark: "⊞" })
registerSkin(cinemaSkin, { label: "cinema", mark: "⬒" })
registerSkin(timelineSkin, { label: "timeline", mark: "⋮" })
registerSkin(letterpressSkin, { label: "letterpress", mark: "A" })
registerSkin(atlasSkin, { label: "atlas", mark: "△" })
registerSkin(teletypeSkin, { label: "teletype", mark: "≣" })
registerSkin(groveSkin, {
  label: "grove",
  mark: "❧",
  settings: [
    { kind: "segmented", key: "groveThinking", label: "Thinking", hint: "thinking sits with the tools on the left; flip it to the reading column", options: [{ id: "left", label: "left, with tools" }, { id: "right", label: "right, with prompts" }] },
  ],
})
