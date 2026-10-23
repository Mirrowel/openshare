// Viewer settings: JSON cookie (osh_settings, 1yr), read pre-paint by
// entry.tsx to set html[data-osh-theme] / text size without a flash.
import { createSignal } from "solid-js"

export type OshSettings = {
  view: string
  theme: "system" | "light" | "dark" | "mirrobot" | "midnight" | "sepia" | "nord"
  continuous: boolean
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
  toolOutput: boolean
  toolGrouping: boolean
  /** what grouping covers: v1 scope (reads/searches only) or every tool */
  toolGroupingScope: "context" | "all"
  /** grove only: keep reasoning on the left (with tools) or move it right */
  groveThinking: "left" | "right"
  /** how tool OUTPUTS overflow long lines: wrap them, or scroll the output
   * horizontally (hidden scrollbar, VSCode-style). The width is hard-capped
   * either way - this only picks the overflow behavior */
  outputOverflow: "wrap" | "scroll"
}

export const SETTINGS_DEFAULTS: OshSettings = {
  view: "classic",
  theme: "system",
  continuous: false,
  followLive: true,
  textSize: "normal",
  readText: "normal",
  diffMode: "auto",
  backgroundOn: true,
  reasoningOpen: false,
  centerContent: false,
  toolInfo: true,
  toolOutput: false,
  toolGrouping: true,
  toolGroupingScope: "context",
  groveThinking: "left",
  outputOverflow: "scroll",
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
  // tool invocation info + extra output expansion (the vendored per-tool
  // rule still governs what shows naturally - see toolDefaultOpen)
  html.dataset.oshToolInfo = s.toolInfo ? "on" : "off"
  html.dataset.oshToolOutput = s.toolOutput ? "on" : "off"
  // tool-call grouping (summary rows). Default ON; off = every call its
  // own row through the v2 timeline detail placements
  html.dataset.oshToolGrouping = s.toolGrouping === false ? "off" : "on"
  // tool output overflow: wrap vs hidden-scrollbar horizontal scroll
  html.dataset.oshOverflow = s.outputOverflow === "wrap" ? "wrap" : "scroll"
}

export const TEXT_SIZES: Record<string, string> = {
  compact: "95%",
  normal: "100%",
  roomy: "110%",
}
