// The view registry. A view is a full-page reading instrument for the
// same session data: it owns its header chrome, content, footer and
// settings presentation. Views register here; the settings panel's view
// section lists them.
import type { JSX } from "solid-js"
import type { ShareData } from "../fold"
import { children } from "../fold"
import type { useShareSource } from "../data-source"
import type { OshSettings } from "../settings"

// the settings panel lists classic + reader + every registered view
export const VIEW_OPTIONS: { id: string; label: string }[] = [
  { id: "classic", label: "classic" },
  { id: "reader", label: "reader" },
]

export type ViewProps = {
  data: ShareData
  sessionID: string
  source: ReturnType<typeof useShareSource>
  settings: OshSettings
  updateSettings: (patch: Partial<OshSettings>) => void
  search: string
  onSearch: (v: string) => void
}

export type ViewEntry = {
  id: string
  label: string
  component: (props: ViewProps) => JSX.Element
  /** false = this view is continuous-only (a stream metaphor with no
   *  meaningful "one prompt at a time" page): the settings panel hides the
   *  paged/continuous toggle for it and it never renders the prompt rail
   *  (owner directive 2026-10-24: some views are always continuous, and
   *  the option to enable paging should not even be shown) */
  paged?: boolean
}

// full-page views (classic and reader live in the standard chrome)
export const VIEWS: ViewEntry[] = []

export function registerView(entry: ViewEntry) {
  if (VIEWS.some((v) => v.id === entry.id)) return
  VIEWS.push(entry)
  const opt = VIEW_OPTIONS.find((o) => o.id === entry.id)
  if (!opt) VIEW_OPTIONS.push({ id: entry.id, label: entry.label })
}

export function findView(id: string): ViewEntry | undefined {
  return VIEWS.find((v) => v.id === id)
}

/** view-scoped extras for the global Session info panel (owner round
 *  2026-10-24 night: atlas's legend + coordinates merge INTO the info
 *  popup instead of living in a separate surface). A skin module
 *  registers a component at import time; InfoPanel renders it after the
 *  stock groups. */
let infoExtra: (() => JSX.Element) | undefined
export function setInfoExtra(component: (() => JSX.Element) | undefined) {
  infoExtra = component
}
export function getInfoExtra() {
  return infoExtra
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

import { terminal } from "./terminal"
import { casefile } from "./casefile"
registerView(terminal)
registerView(casefile)

import { blueprint } from "./blueprint"
import { cinema } from "./cinema"
import { timeline } from "./timeline"
import { letterpress } from "./letterpress"
import { atlas } from "./atlas"
import { teletype } from "./teletype"
import { grove } from "./grove"
registerView(blueprint)
registerView(cinema)
registerView(timeline)
registerView(letterpress)
registerView(atlas)
registerView(teletype)
registerView(grove)
