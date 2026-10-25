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
  textSize: "compact" | "normal" | "roomy"
  readText: "compact" | "normal" | "large"
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
  toolGrouping: boolean
  /** what grouping covers: v1 scope (reads/searches only) or every tool */
  toolGroupingScope: "context" | "all"
  /** grove only: keep reasoning on the left (with tools) or move it right */
  groveThinking: "left" | "right"
  /** how tool OUTPUTS overflow long lines: wrap them, or scroll the output
   * horizontally (hidden scrollbar, VSCode-style). The width is hard-capped
   * either way - this only picks the overflow behavior */
  outputOverflow: "wrap" | "scroll"
  /** how user prompts render everywhere: right-aligned bubble (default)
   * or flat text like the reader skin */
  promptStyle: "bubble" | "flat"
  /** smooth-scroll prompt jumps (rail, j/k, [ ]); off = instant jumps.
   * Long jumps are instant either way (mid-flight measurement
   * corrections stutter across thousands of pixels). */
  smoothScroll: boolean
}

export const SETTINGS_DEFAULTS: OshSettings = {
  view: "classic",
  theme: "system",
  continuous: false,
  pagedByView: {},
  promptNav: "sidebar",
  previewPromptLines: 2,
  previewResponseLines: 4,
  followLive: true,
  textSize: "normal",
  readText: "normal",
  diffMode: "auto",
  backgroundOn: true,
  reasoningOpen: false,
  centerContent: false,
  toolInfo: true,
  autoExpand: [],
  toolGrouping: true,
  toolGroupingScope: "context",
  groveThinking: "left",
  // wrap is the default (owner round 2026-10-25); saved cookies keep
  // their explicit choice
  outputOverflow: "wrap",
  promptStyle: "bubble",
  smoothScroll: true,
}

const COOKIE = "osh_settings"

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
  // interface scale (root font — rem paddings scale with it)
  html.dataset.oshText =
    s.textSize === "compact" ? "compact" : s.textSize === "roomy" ? "roomy" : "normal"
  // reading text size (markdown content only)
  html.dataset.oshReadText =
    s.readText === "compact" ? "compact" : s.readText === "large" ? "large" : "normal"
  html.dataset.oshReasoning = s.reasoningOpen ? "open" : "collapsed"
  // tool invocation info (subtitle/args while collapsed)
  html.dataset.oshToolInfo = s.toolInfo ? "on" : "off"
  // tool-call grouping (summary rows). Default ON; off = every call its
  // own row through the v2 timeline detail placements
  html.dataset.oshToolGrouping = s.toolGrouping === false ? "off" : "on"
  // tool output overflow: wrap vs hidden-scrollbar horizontal scroll
  html.dataset.oshOverflow = s.outputOverflow === "wrap" ? "wrap" : "scroll"
  html.dataset.oshPrompts = s.promptStyle === "flat" ? "flat" : "bubble"
}

export const TEXT_SIZES: Record<string, string> = {
  compact: "95%",
  normal: "100%",
  roomy: "110%",
}
