// ViewContext: ONE source of view state for every skin surface (owner
// round 2026-10-25, views-SDK phase 1). Wrappers, headers, footers, navs
// and rails read useView() instead of hand-rolling session lookups,
// deriving mode state, or inventing module-global signal channels.
//
// The context value is created by BaseSessionView; skins never construct
// it. Everything a skin legitimately needs is here - if a skin reaches
// around it, that is a Skin API gap to fix in base-view, not in the skin.
import { createContext, useContext } from "solid-js"
import type { JSX } from "solid-js"
import type { ShareData, SessionLite } from "../fold"
import type { useShareSource } from "../data-source"
import type { OshSettings } from "../settings"
import type { Skin } from "./base-view"
import type { SessionSection } from "./session-data"

export type ViewContextValue = {
  /** the skin currently rendering */
  skin: Skin
  data: ShareData
  sessionID: string
  source: ReturnType<typeof useShareSource>
  settings: OshSettings
  updateSettings: (patch: Partial<OshSettings>) => void
  search: string
  onSearch: (v: string) => void
  /** all sections of this session, search-independent */
  sections: () => SessionSection[]
  /** search-filtered sections (the transcript + nav render these) */
  visible: () => SessionSection[]
  /** the active search query, lowercased + trimmed ("" = no filter) */
  query: () => string
  /** continuous = NOT paged (paged is the per-view opt-in) */
  continuous: () => boolean
  /** paged mode: the active section index */
  active: () => number
  setActive: (i: number) => void
  /** this session's info (the lookup every header used to duplicate) */
  info: () => SessionLite | undefined
  /** the session's version as-is for header display (undefined = absent) */
  version: () => string | number | undefined
  /** display label for the session's model */
  model: () => string
  /** share status string ("live" | "completed" | ...) */
  status: () => string
  /** navigate back to the main session page */
  back: () => void
  /** is a subagent (/N) page */
  isSub: () => boolean
  /** virtualization cache prefix for this session mount */
  cachePrefix: string
}

const ViewContext = createContext<ViewContextValue>()

export function ViewProvider(props: { value: ViewContextValue; children: any }) {
  return <ViewContext.Provider value={props.value}>{props.children}</ViewContext.Provider>
}

export function useView(): ViewContextValue {
  const v = useContext(ViewContext)
  if (!v) throw new Error("useView() outside BaseSessionView - a skin surface rendered outside its provider")
  return v
}
