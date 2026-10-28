// Per-share OG card renderer: hand-laid SVG rasterized to PNG with
// resvg-wasm (text layout by resvg's embedded shaper — no satori, whose
// yoga loader requires self.location and crashes in workerd).
// Runs in workerd (wrangler bundles the .wasm natively) and Bun (the
// wasm import resolves to the asset path, compiled here).
import { initWasm, Resvg } from "@resvg/resvg-wasm"
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm"
import { decode } from "./fonts-decode.js"
import { INTER_REGULAR, INTER_SEMIBOLD } from "./fonts.js"

let wasmReady = null
const ensureWasm = () => {
  wasmReady ??= (async () => {
    // workerd's bundler hands a WebAssembly.Module; Bun's direct run hands
    // the asset URL/path — compile it ourselves there
    let mod = resvgWasm
    if (!(mod instanceof WebAssembly.Module)) {
      const url = String(mod)
      const bytes = url.startsWith("file:") || /^[a-z]:[\\/]/i.test(url) ? new Uint8Array(await (await import("node:fs/promises")).readFile(url)) : new Uint8Array(await (await fetch(url)).arrayBuffer())
      mod = await WebAssembly.compile(bytes)
    }
    await initWasm(mod)
  })().catch((e) => {
    wasmReady = null
    throw e
  })
  return wasmReady
}

let fontsCache = null
function resvgFonts() {
  fontsCache ??= [{ data: decode(INTER_REGULAR) }, { data: decode(INTER_SEMIBOLD) }]
  return fontsCache
}

const STATUS = {
  completed: { label: "Completed", color: "#3fb950" },
  live: { label: "Live", color: "#58a6ff" },
  interrupted: { label: "Interrupted", color: "#d29922" },
  error: { label: "Error", color: "#f85149" },
  cached: { label: "Snapshot", color: "#8b949e" },
}

function fmtDuration(ms) {
  const min = Math.max(0, Math.round(ms / 60000))
  if (min < 1) return "under a minute"
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  return min % 60 ? `${h}h ${min % 60}m` : `${h}h`
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])

/** Title wrap: up to two lines of ~40 chars (46px Inter at 1020px), word
 * boundaries, ellipsis when it cannot fit. */
function wrapTitle(t) {
  const s = String(t ?? "").replace(/\s+/g, " ").trim()
  if (s.length <= 40) return [s]
  const words = s.split(" ")
  const lines = []
  let cur = ""
  for (const w of words) {
    const next = cur ? cur + " " + w : w
    if (next.length <= 40) cur = next
    else {
      if (cur) lines.push(cur)
      cur = w
      if (lines.length === 2) break
    }
  }
  if (lines.length < 2 && cur) lines.push(cur)
  if (lines.length > 2) lines.length = 2
  // still overflowing after two lines: ellipsize the second
  if (lines.length === 2 && (lines[0].length + lines[1].length) < s.length) {
    let l = lines[1]
    if (l.length > 37) l = l.slice(0, 37)
    lines[1] = l.replace(/\s+\S*$/, "") + "…"
  } else if (lines.length === 1 && lines[0].length > 40) {
    let l = lines[0].slice(0, 37)
    lines[0] = l.replace(/\s+\S*$/, "") + "…"
  }
  return lines.filter(Boolean)
}

export async function renderOgPng({ title, status, stats, branding }) {
  await ensureWasm()
  const accent = branding?.accent || "#7aa2f7"
  const name = branding?.name || "openshare"
  const st = STATUS[status] ?? STATUS.completed
  const gated = !title
  const statBits = gated
    ? []
    : [
        `${stats.turns} turn${stats.turns === 1 ? "" : "s"}`,
        ...(stats.tools ? [`${stats.tools} tool${stats.tools === 1 ? "" : "s"}`] : []),
        ...(stats.durationMs ? [fmtDuration(stats.durationMs)] : []),
        ...(stats.model ? [stats.model] : []),
      ]

  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">`]
  parts.push(`<rect width="1200" height="630" fill="#0d1117"/>`)
  parts.push(`<rect x="0" y="0" width="12" height="630" fill="${esc(accent)}"/>`)
  // wordmark
  parts.push(`<text x="72" y="105" font-family="Inter" font-weight="600" font-size="30" fill="${esc(accent)}">${esc(name)}</text>`)
  parts.push(`<text x="${72 + name.length * 17 + 18}" y="105" font-family="Inter" font-size="26" fill="#6e7681">· Open(code)Share</text>`)
  if (gated) {
    parts.push(`<text x="72" y="230" font-family="Inter" font-weight="600" font-size="52" fill="#e6edf3">Private share</text>`)
    parts.push(`<text x="72" y="290" font-family="Inter" font-size="30" fill="#8b949e">Log in to view this session</text>`)
  } else {
    const lines = wrapTitle(title)
    const y0 = 225
    for (let i = 0; i < lines.length; i++) {
      parts.push(`<text x="72" y="${y0 + i * 62}" font-family="Inter" font-weight="600" font-size="46" fill="#e6edf3">${esc(lines[i])}</text>`)
    }
    // status pill
    const pillY = lines.length > 1 ? y0 + 62 + 52 : y0 + 52
    const label = st.label
    const pillW = 44 + label.length * 15 + (status === "live" ? 22 : 0)
    parts.push(`<rect x="72" y="${pillY}" rx="23" ry="23" width="${pillW}" height="46" fill="none" stroke="${st.color}" stroke-width="2"/>`)
    if (status === "live") {
      parts.push(`<circle cx="${72 + 24}" cy="${pillY + 23}" r="6" fill="${st.color}"/>`)
      parts.push(`<text x="${72 + 40}" y="${pillY + 32}" font-family="Inter" font-weight="600" font-size="26" fill="${st.color}">${esc(label)}</text>`)
    } else {
      parts.push(`<text x="${72 + 24}" y="${pillY + 32}" font-family="Inter" font-weight="600" font-size="26" fill="${st.color}">${esc(label)}</text>`)
    }
    if (statBits.length) {
      parts.push(`<text x="${72 + pillW + 24}" y="${pillY + 32}" font-family="Inter" font-size="27" fill="#8b949e">${esc(statBits.join("  ·  "))}</text>`)
    }
  }
  parts.push(`<text x="1128" y="576" text-anchor="end" font-family="Inter" font-size="24" fill="#484f58">shared agent sessions</text>`)
  parts.push(`</svg>`)

  const resvg = new Resvg(parts.join(""), {
    fitTo: { mode: "width", value: 1200 },
    font: { fontBuffers: resvgFonts().map((f) => f.data), loadSystemFonts: false, defaultFontFamily: "Inter" },
  })
  return resvg.render().asPng()
}
