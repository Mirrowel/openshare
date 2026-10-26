// Viewer settings: JSON cookie (osh_settings, 1yr), read pre-paint by
// entry.tsx to set html[data-osh-theme] / text size without a flash.
import { createSignal } from "solid-js"

export type OshSettings = {
  view: string
  theme: "system" | "light" | "dark" | "mirrobot" | "midnight" | "sepia" | "nord"
  continuous: boolean
  /** legacy storage (continuous-by-view) - read for migration only,
   *  stripped on the next write */
  continuousByView?: Record<string, boolean>
   /** per-view PAGED choice, keyed by view id ("classic", "terminal",
    *  ...). Absent key = continuous (default). */
   pagedByView?: Record<string, boolean>
   /** prompt navigation state: the floating pill (default) or the sidebar
    *  column; one of the two is ALWAYS present with >1 prompt - the pill
    *  is never fully removable (owner round 2026-10-25) */
   promptNav: "pill" | "sidebar"
  /** sidebar width in px (drag-resized; clamped 160-400) */
  turnNavWidth?: number
  /** hover-preview clamps: prompt/response line counts (sidebar gear) */
  previewPromptLines?: number
  previewResponseLines?: number
   followLive: boolean
  /** interface scale, percent of the default type ladder (75-150) -
   *  scales every font-size token at the root; rem paddings follow */
  textScale: number
  /** reading text base size in px (12-24), scoped to the content column */
  readTextPx: number
  /** diff rendering: auto (split when it fits), or forced (forced split
   * still requires the space; too-narrow falls back to unified) */
  diffMode: "auto" | "split" | "unified"
  backgroundOn: boolean
  reasoningOpen: boolean
  centerContent: boolean
  toolInfo: boolean
  /** tools whose bodies auto-expand on render (checkbox list, cookie-
   * persisted so every share picks it up). Default: none. */
  autoExpand: string[]
  /** tool-call grouping: off = every call its own row; custom = only the
   *  tools in groupTools collapse into summary rows; all = every call */
  toolGrouping: "off" | "custom" | "all"
  /** which tools the "custom" grouping collapses (same checklist UI as
   *  autoExpand; prefilled with the original reads & searches scope) */
  groupTools: string[]
  /** grove only: keep reasoning on the left (with tools) or move it right */
  groveThinking: "left" | "right"
  /** how tool OUTPUTS overflow long lines: wrap them, or scroll the output
   * horizontally (hidden scrollbar, VSCode-style). The width is hard-capped
   * either way - this only picks the overflow behavior. Governs non-file
   * outputs (shell, grep, glob, list); the file tools carry their own
   * per-tool choice in fileOverflow. */
  outputOverflow: "wrap" | "scroll"
  /** per-tool overflow for the FILE tools (read/write/edit+patch), each
   * wrap or scroll independently - e.g. diffs can pan while reads wrap
   * (owner round 2026-10-26). Defaults wrap; a cookie with an explicit
   * outputOverflow: "scroll" migrates all three to scroll. */
  fileOverflow: { read: "wrap" | "scroll"; write: "wrap" | "scroll"; edit: "wrap" | "scroll" }
  /** how user prompts render everywhere: right-aligned bubble (default)
   * or flat text like the reader skin */
  promptStyle: "bubble" | "flat"
  /** smooth-scroll prompt jumps (rail, j/k, [ ]); off = instant jumps.
   * Long jumps are instant either way (mid-flight measurement
   * corrections stutter across thousands of pixels). */
  /** jump animation: instant everywhere, smooth for short jumps only
   *  (near), or smooth always (long jumps included) */
  smoothScroll: "instant" | "near" | "always"
  /** [design-trial: subagent hint] how the "open subagent" hover hint
   *  appears on a task card. Everything but "flap" is vertically stable:
   *  only opacity and horizontal transforms animate */
  subagentHint: "chip" | "fade" | "corner" | "underline" | "flap"
  /** ghost mode: the pill rests invisible (0 opacity); the proximity
   * strip wakes it and a one-time pulse carries discoverability */
  pillGhost: boolean
  /** show the search/filter field in the prompt views (pill pop-open and
   * sidebar list) */
  navSearchBar: boolean
  /** row content in the prompt views: prompt lines 1-5 (default 1 =
   * today's single-line label) and response lines 0-5 (default 0 =
   * hidden) - the multi-line rows adopted from the menu trials */
  rowPromptLines: number
  rowResponseLines: number
  /** file-tool card width in rem (text cards; split diffs render at 2x,
   *  viewport-capped) - applied live as --osh-card on <html> */
  cardWidth: number
}

export const SETTINGS_DEFAULTS: OshSettings = {
  view: "classic",
  theme: "system",
  continuous: false,
  pagedByView: {},
  promptNav: "sidebar",
  previewPromptLines: 3,
  previewResponseLines: 4,
  followLive: true,
  textScale: 100,
  readTextPx: 14,
  diffMode: "auto",
  backgroundOn: true,
  reasoningOpen: false,
  centerContent: false,
  toolInfo: true,
  autoExpand: [],
  toolGrouping: "off",
  groupTools: ["read", "glob", "grep", "list"],
  groveThinking: "left",
  // wrap is the default (owner round 2026-10-25); saved cookies keep
  // their explicit choice
  outputOverflow: "wrap",
  fileOverflow: { read: "wrap", write: "wrap", edit: "wrap" },
  promptStyle: "bubble",
  smoothScroll: "near",
  subagentHint: "chip",
  pillGhost: false,
  navSearchBar: false,
  rowPromptLines: 1,
  rowResponseLines: 0,
  cardWidth: 40,
}

const COOKIE = "osh_settings"

// preset -> continuous migration values (old 3-step cookies). Lives
// above readSettings: it runs at import time (signal seeds), so a
// module-bottom const would be a TDZ crash.
export const TEXT_SCALE_MIGRATE: Record<string, number> = { compact: 95, normal: 100, roomy: 110 }
export const READ_TEXT_MIGRATE: Record<string, number> = { compact: 13, normal: 14, large: 16 }

export function readSettings(): OshSettings {
  try {
    for (const part of document.cookie.split(";")) {
      const [k, ...v] = part.trim().split("=")
      if (k === COOKIE) {
        const parsed = JSON.parse(decodeURIComponent(v.join("=")))
        // migrate the old diffStyle setting (unified|split) to diffMode
        // (auto|split|unified): an explicit old value stays forced
        if (parsed.diffStyle && !parsed.diffMode) {
          parsed.diffMode = parsed.diffStyle === "split" ? "split" : "unified"
        }
        // migrate the old toolOutput boolean to the autoExpand list (its
        // old semantics: shell tools expanded)
        if (typeof parsed.toolOutput === "boolean" && !Array.isArray(parsed.autoExpand)) {
          parsed.autoExpand = parsed.toolOutput ? ["shell"] : []
        }
        delete parsed.diffStyle
        delete parsed.toolOutput
        // showRail is gone: the pill/sidebar pair replaced it and the pill
        // is no longer removable
        delete parsed.showRail
        if (!Array.isArray(parsed.autoExpand)) parsed.autoExpand = []
        // fileOverflow migration: an explicit global scroll choice (from
        // before the per-tool split) seeds all three file tools; otherwise
        // the per-tool defaults (wrap) stand
        if (!parsed.fileOverflow && parsed.outputOverflow === "scroll") {
          parsed.fileOverflow = { read: "scroll", write: "scroll", edit: "scroll" }
        }
        // preset -> continuous migrations (old 3-step text sizes, the
        // boolean smooth scroll)
        if (typeof parsed.textSize === "string") {
          parsed.textScale = TEXT_SCALE_MIGRATE[parsed.textSize] ?? 100
          delete parsed.textSize
        }
        if (typeof parsed.readText === "string") {
          parsed.readTextPx = READ_TEXT_MIGRATE[parsed.readText] ?? 14
          delete parsed.readText
        }
        if (typeof parsed.smoothScroll === "boolean") {
          parsed.smoothScroll = parsed.smoothScroll ? "near" : "instant"
        }
        // grouping: {bool + context|all scope} -> off | custom | all
        if (typeof parsed.toolGrouping === "boolean" || typeof parsed.toolGroupingScope === "string") {
          const on = parsed.toolGrouping !== false
          const all = parsed.toolGroupingScope === "all"
          parsed.toolGrouping = on ? (all ? "all" : "custom") : "off"
          delete parsed.toolGroupingScope
        }
        if (!Array.isArray(parsed.groupTools)) parsed.groupTools = ["read", "glob", "grep", "list"]
        return { ...SETTINGS_DEFAULTS, ...parsed }
      }
    }
  } catch {}
  return { ...SETTINGS_DEFAULTS }
}

export function writeSettings(s: OshSettings) {
  // not HttpOnly by design: the viewer reads its own settings cookie
  document.cookie = `${COOKIE}=${encodeURIComponent(JSON.stringify(s))}; Path=/; Max-Age=31536000; SameSite=Lax`
}

/** the paged/continuous choice FOR A VIEW, in PAGED terms (owner round
 *  2026-10-24: the toggle is now "Paged mode", ON = paged; default OFF =
 *  continuous). Migrates the old continuousByView storage; views that do
 *  not support paging (ViewEntry.paged === false) are always continuous
 *  regardless of any stored choice. */
export function pagedFor(s: OshSettings, view: string, supportsPaged = true): boolean {
  if (!supportsPaged) return false
  const paged = s.pagedByView?.[view]
  if (typeof paged === "boolean") return paged
  // migration: the old flag was continuous-by-view (true = continuous)
  const legacy = s.continuousByView?.[view]
  if (typeof legacy === "boolean") return !legacy
  return false
}

/** write a view's paged choice (per-view map; keeps other views' choices) */
export function setPagedFor(prev: OshSettings, view: string, value: boolean): OshSettings {
  const { continuousByView, ...rest } = prev as OshSettings & { continuousByView?: Record<string, boolean> }
  void continuousByView
  return {
    ...rest,
    pagedByView: { ...(prev.pagedByView ?? {}), [view]: value },
  }
}

// Apply to <html>: theme attribute + scale attributes. Called pre-paint.
//
// Theming rides TWO attributes:
//   data-color-scheme  — the v2 kit's own switch (all --v2-* tokens,
//                        light-dark() colors, app-icon variants)
//   data-osh-theme     — our chrome + premade overrides (build-themes
//                        emits :root[data-osh-theme=…] blocks)
// system resolves through matchMedia and re-resolves on OS change.
const PREMADE_BASE: Record<string, "light" | "dark"> = {
  light: "light",
  dark: "dark",
  mirrobot: "dark",
  midnight: "dark",
  sepia: "light",
  nord: "light",
}
let systemHooked = false
// diffMode as a standalone reactive signal: tool renderers (outside the
// app's settings store tree) read it live, and the per-card toggle writes
// it through setDiffMode (cookie + apply, then the signal).
const [diffModeSignal, setDiffModeSignal] = createSignal<OshSettings["diffMode"]>(readSettings().diffMode)
export { diffModeSignal, setDiffModeSignal }
export function setDiffMode(mode: OshSettings["diffMode"]) {
  const next = readSettings()
  next.diffMode = mode
  delete (next as any).diffStyle
  writeSettings(next)
  setDiffModeSignal(mode)
}

// output overflow (scroll | wrap) as a signal too: the per-card toggle on
// EXPANDED output bodies writes it live (same cookie + html attr path)
const [overflowSignal, setOverflowSignal] = createSignal<OshSettings["outputOverflow"]>(readSettings().outputOverflow)
export { overflowSignal }
export function setOutputOverflow(mode: OshSettings["outputOverflow"]) {
  const next = readSettings()
  next.outputOverflow = mode
  writeSettings(next)
  setOverflowSignal(mode)
  applySettings(next)
}

// per-tool file overflow as signals too: the per-card toggle on a FILE
// card writes its own tool's entry (read/write/edit; patch rides edit)
export type FileTool = "read" | "write" | "edit"
const [fileOverflowSignal, setFileOverflowSignal] = createSignal<OshSettings["fileOverflow"]>(readSettings().fileOverflow)
export { fileOverflowSignal }
export function setFileOverflow(tool: FileTool, mode: "wrap" | "scroll") {
  const next = readSettings()
  next.fileOverflow = { ...(next.fileOverflow ?? { read: "wrap", write: "wrap", edit: "wrap" }), [tool]: mode }
  writeSettings(next)
  setFileOverflowSignal(next.fileOverflow)
}

// nav row-content + search bar as a signal: NavRow and the nav config
// popover live outside the app's settings store tree, so they read this
// live (same pattern as diffModeSignal)
export type NavRows = { searchBar: boolean; promptLines: number; responseLines: number }
const [navRowsSignal, setNavRowsSignal] = createSignal<NavRows>({
  searchBar: readSettings().navSearchBar ?? false,
  promptLines: readSettings().rowPromptLines ?? 1,
  responseLines: readSettings().rowResponseLines ?? 0,
})
export { navRowsSignal }
function writeNavRows(next: NavRows) {
  const s = readSettings()
  s.navSearchBar = next.searchBar
  s.rowPromptLines = next.promptLines
  s.rowResponseLines = next.responseLines
  writeSettings(s)
  setNavRowsSignal(next)
}
export function setNavSearchBar(searchBar: boolean) {
  const cur = navRowsSignal()
  writeNavRows({ ...cur, searchBar })
}
export function setRowLines(patch: Partial<Pick<NavRows, "promptLines" | "responseLines">>) {
  const cur = navRowsSignal()
  writeNavRows({
    ...cur,
    promptLines: Math.max(1, Math.min(5, patch.promptLines ?? cur.promptLines)),
    responseLines: Math.max(0, Math.min(5, patch.responseLines ?? cur.responseLines)),
  })
}
function resolvedScheme(theme: string): "light" | "dark" {
  if (theme === "system")
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  return PREMADE_BASE[theme] ?? "light"
}
function applyScheme(html: HTMLElement, theme: string) {
  const scheme = resolvedScheme(theme)
  html.dataset.colorScheme = scheme
  // the kit's app-icon + theme context read this dataset
  html.dataset.ln = scheme
}
export function applySettings(s: OshSettings) {
  const html = document.documentElement
  if (s.theme === "system") delete html.dataset.oshTheme
  else html.dataset.oshTheme = s.theme
  applyScheme(html, s.theme)
  if (!systemHooked) {
    systemHooked = true
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      // re-resolve only while following the system
      const cur = readSettings()
      if (cur.theme === "system") applyScheme(document.documentElement, "system")
    })
  }
  // interface scale, continuous: font-size tokens scale at the root
  const textScale = Math.max(75, Math.min(150, s.textScale ?? 100))
  html.style.setProperty("--osh-text-scale", String(textScale / 100))
  // reading text, continuous: the content column's type ladder derives
  // from one base px (ratios from the kit's default ladder)
  const readPx = Math.max(12, Math.min(24, s.readTextPx ?? 14))
  html.style.setProperty("--osh-read-px", `${readPx}px`)
  html.dataset.oshReasoning = s.reasoningOpen ? "open" : "collapsed"
  // tool invocation info (subtitle/args while collapsed)
  html.dataset.oshToolInfo = s.toolInfo ? "on" : "off"
  // tool-call grouping (summary rows). Default ON; off = every call its
  // own row through the v2 timeline detail placements
  html.dataset.oshToolGrouping = s.toolGrouping === "off" ? "off" : s.toolGrouping
  // tool output overflow: wrap vs hidden-scrollbar horizontal scroll
  html.dataset.oshOverflow = s.outputOverflow === "wrap" ? "wrap" : "scroll"
  html.dataset.oshPrompts = s.promptStyle === "flat" ? "flat" : "bubble"
  // nav state drives the content indent: the floating pill needs room at
  // the left edge; the sidebar column already displaces content, so its
  // extra indent shrinks to breathing room
  html.dataset.oshNav = s.promptNav === "sidebar" ? "sidebar" : "pill"
  html.dataset.oshHint = s.subagentHint ?? "chip"
  // file-card width, live: every file tool reads --osh-card (text cards
  // at the value, split diffs at 2x, both viewport-capped)
  const cardWidth = Math.max(20, Math.min(80, s.cardWidth ?? 40))
  html.style.setProperty("--osh-card", `${cardWidth}rem`)
}

/** wipe every saved setting and re-apply the defaults live: same as
 *  killing the cookie, minus the cookie editor. App state listens for
 *  the osh:settings-reset event and swaps to the defaults the same
 *  tick, so no reload is needed. */
export function resetAllSettings() {
  const expires = "Thu, 01 Jan 1970 00:00:00 GMT"
  document.cookie = `osh_settings=; path=/; expires=${expires}`
  applySettings(SETTINGS_DEFAULTS)
  window.dispatchEvent(new CustomEvent("osh:settings-reset", { detail: SETTINGS_DEFAULTS }))
}
