// Post-build theme emitter: reads the built CSS, extracts the light :root
// token block and the dark @media token block, and emits attribute-scoped
// copies so the settings panel can force a theme (html[data-osh-theme]):
//   :root                      — light (system)
//   @media dark :root          — dark (system)
//   :root[data-osh-theme=light] — forced light
//   :root[data-osh-theme=dark]  — forced dark
//   :root[data-osh-theme=<premade>] — full base copy + overrides
// Attribute blocks out-specify :root (0,2,0 vs 0,1,0), so a forced theme
// beats the media query; premades are appended AFTER so their overrides
// win over their base copy. Appends everything to the built CSS.
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// fileURLToPath decodes %20 etc. — the repo path contains a space, and a
// raw .pathname keeps the encoding (live-caught: build died on scandir)
const dist = fileURLToPath(new URL("../dist", import.meta.url))
const assets = join(dist, "assets")
const cssFile = readdirSync(assets).find((f) => f.endsWith(".css"))
if (!cssFile) {
  console.error("build-themes: no css asset found")
  process.exit(1)
}
const css = readFileSync(join(assets, cssFile), "utf8")

function extractBalanced(source, startIdx) {
  // startIdx points at the '{' — return the block content + end index
  let depth = 0
  for (let i = startIdx; i < source.length; i++) {
    if (source[i] === "{") depth++
    else if (source[i] === "}") {
      depth--
      if (depth === 0) return source.slice(startIdx + 1, i)
    }
  }
  return null
}

// light tokens: the FIRST `:root{` that defines --background-base
let light = null
const rootIdx = css.indexOf(":root{--")
if (rootIdx >= 0) light = extractBalanced(css, css.indexOf("{", rootIdx))

// dark tokens: inside the prefers-color-scheme media block
let dark = null
const mediaIdx = css.indexOf("@media(prefers-color-scheme:dark)")
if (mediaIdx >= 0) {
  const brace = css.indexOf("{", mediaIdx)
  const inner = extractBalanced(css, brace)
  const rootStart = inner.indexOf(":root{")
  dark = extractBalanced(inner, inner.indexOf("{", rootStart))
}
if (!light || !dark) {
  console.error("build-themes: could not extract token blocks", { light: !!light, dark: !!dark })
  process.exit(1)
}

// light-mode readability floor (owner-caught): the kit's light tier ships
// --text-weak #8f8f8f (3.5:1) and --text-weaker #c7c7c7 (1.6:1 - meta text
// nearly invisible on white). Darken both in the EXTRACTED copy so the
// forced-light block and light-based premades inherit the fix; premades
// with explicit overrides keep theirs. Throw when upstream changes the
// values so this never silently stops applying.
const patchLight = (s, prop, from, to) => {
  const re = new RegExp(`${prop}:\\s*${from}`)
  if (!re.test(s)) throw new Error(`build-themes: light token drift - ${prop} is no longer ${from}`)
  return s.replace(re, `${prop}:${to}`)
}
light = patchLight(light, "--text-weak", "#8f8f8f", "#767676")
light = patchLight(light, "--text-weaker", "#c7c7c7", "#9e9e9e")

// premade themes: base ("dark"|"light") + property overrides
// (font-family overrides are legitimate theme content; the chrome pins its
// own line-heights so fixed-height elements don't shift when fonts swap)
//
// Each premade overrides BOTH token families: our chrome tokens
// (--background-*/--text-*) and the v2 kit tokens (--v2-*), so session
// content recolors with the theme, not just the chrome.
const v2Overrides = (bg, bgLayer, textBase, textMuted, textFaint, border) => ({
  "--v2-background-bg-base": bg,
  "--v2-background-bg-deep": bgLayer,
  "--v2-background-bg-layer-01": bgLayer,
  "--v2-background-bg-layer-02": bgLayer,
  "--v2-background-bg-layer-03": bgLayer,
  "--v2-background-bg-layer-04": bgLayer,
  "--v2-text-text-base": textBase,
  "--v2-text-text-muted": textMuted,
  "--v2-text-text-faint": textFaint,
  "--v2-icon-icon-base": textBase,
  "--v2-icon-icon-muted": textMuted,
  "--v2-icon-icon-faint": textFaint,
  "--v2-border-border-muted": border,
  "--v2-border-border-base": border,
})
const PREMADES = {
  mirrobot: {
    base: "dark",
    overrides: {
      "--background-base": "#16130f",
      "--background-weak": "#1d1913",
      "--background-strong": "#16130f",
      "--background-stronger": "#1d1913",
      "--text-strong": "#f2ead8",
      "--text-base": "#e8dfc9",
      "--text-weak": "#a89c86",
      "--text-weaker": "#6f6656",
      "--font-family-sans": "Fraunces, Georgia, 'Times New Roman', serif",
      "--font-family-mono": "'IBM Plex Mono', ui-monospace, Consolas, monospace",
      ...v2Overrides("#16130f", "#1d1913", "#e8dfc9", "#a89c86", "#6f6656", "#332c22"),
    },
  },
  midnight: {
    base: "dark",
    overrides: {
      "--background-base": "#0b0e14",
      "--background-weak": "#10141c",
      "--background-strong": "#0d1017",
      "--background-stronger": "#10141c",
      "--text-base": "#c8d0e0",
      ...v2Overrides("#0b0e14", "#10141c", "#c8d0e0", "#7d8aa0", "#5a6478", "#232b3a"),
    },
  },
  sepia: {
    base: "light",
    overrides: {
      "--background-base": "#f4ecd8",
      "--background-weak": "#ece1c8",
      "--background-strong": "#efe5cd",
      "--background-stronger": "#f4ecd8",
      "--text-strong": "#2c2418",
      "--text-base": "#4a4034",
      "--text-weak": "#7a6c56",
      "--text-weaker": "#a3947a",
      ...v2Overrides("#f4ecd8", "#ece1c8", "#4a4034", "#7a6c56", "#a3947a", "#d8caae"),
    },
  },
  nord: {
    base: "dark",
    overrides: {
      "--background-base": "#2e3440",
      "--background-weak": "#3b4252",
      "--background-strong": "#333a47",
      "--background-stronger": "#3b4252",
      "--text-strong": "#eceff4",
      "--text-base": "#d8dee9",
      ...v2Overrides("#2e3440", "#3b4252", "#d8dee9", "#a7b1c2", "#7e8898", "#434c5e"),
    },
  },
}

let out = "\n/* === openshare themes (generated by scripts/build-themes.mjs) === */\n"
// forced blocks must also pin color-scheme: the v2 kit themes through
// light-dark() + [data-color-scheme] tokens — without it, forced dark on
// a light OS renders every kit surface in its light variant
out += `:root[data-osh-theme="light"]{color-scheme:light;${light}}\n`
out += `:root[data-osh-theme="dark"]{color-scheme:dark;${dark}}\n`
for (const [name, def] of Object.entries(PREMADES)) {
  const base = def.base === "dark" ? dark : light
  const scheme = def.base === "dark" ? "dark" : "light"
  const overrides = Object.entries(def.overrides).map(([k, v]) => `${k}:${v}`).join(";")
  out += `:root[data-osh-theme="${name}"]{color-scheme:${scheme};${base};${overrides}}\n`
}

writeFileSync(join(assets, cssFile), css + out)
console.log(`build-themes: emitted ${Object.keys(PREMADES).length + 2} forced themes into ${cssFile}`)
