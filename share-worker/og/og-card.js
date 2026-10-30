// Per-share OG card renderer: the pass-1 card family, hand-laid SVG
// rasterized to PNG with resvg-wasm (text layout by resvg's embedded
// shaper — no satori, whose yoga loader requires self.location and
// crashes in workerd). Runs in workerd (wrangler bundles the .wasm
// natively) and Bun (the wasm import resolves to the asset path,
// compiled here).
//
// Styles (deployment picks one via OG_STYLE; aurora is the default):
//   aurora    gradient glass panel — the default
//   minimap   session shape as a turn strip
//   poster    light paper poster with an ink stamp
//   blueprint engineering grid with a spec table
//   terminal  editor window with syntax bars
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

const W = 1200
const H = 630

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

// wrap into up to `lines` lines of ~max chars, ellipsized at the boundary
function wrap(t, max = 40, lines = 2) {
  const s = String(t ?? "").replace(/\s+/g, " ").trim()
  if (s.length <= max) return [s]
  const words = s.split(" ")
  const out = []
  let cur = ""
  for (const w of words) {
    const next = cur ? cur + " " + w : w
    if (next.length <= max) cur = next
    else {
      if (cur) out.push(cur)
      cur = w
      if (out.length === lines) break
    }
  }
  if (out.length < lines && cur) out.push(cur)
  if (out.length > lines) out.length = lines
  if (out.length === lines && out.join(" ").length < s.length) {
    let l = out[lines - 1]
    if (l.length > max - 3) l = l.slice(0, max - 3)
    out[lines - 1] = l.replace(/\s+\S*$/, "") + "..."
  }
  return out.filter(Boolean)
}

const statBits = (stats) => [
  `${stats.turns} turn${stats.turns === 1 ? "" : "s"}`,
  ...(stats.tools ? [`${stats.tools} tool${stats.tools === 1 ? "" : "s"}`] : []),
  ...(stats.durationMs ? [fmtDuration(stats.durationMs)] : []),
  ...(stats.model ? [stats.model] : []),
]
const statsText = (stats, join = "  ·  ") => statBits(stats).join(join)

// deterministic pseudo-random in [0,1) from an integer seed
function rng(seed) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

function pill(x, y, st, status, { filled = false, fs = 26 } = {}) {
  const label = st.label
  const dot = status === "live" ? 1 : 0
  const w = 36 + dot * 26 + label.length * fs * 0.58
  const h = fs + 20
  const out = []
  out.push(`<rect x="${x}" y="${y}" rx="${h / 2}" width="${w}" height="${h}" fill="${st.color}" fill-opacity="${filled ? 0.16 : 0.1}" stroke="${st.color}" stroke-opacity="0.55" stroke-width="1.5"/>`)
  let tx = x + 18
  if (dot) {
    out.push(`<circle cx="${tx + 7}" cy="${y + h / 2}" r="6" fill="${st.color}"/>`)
    tx += 26
  }
  out.push(`<text x="${tx}" y="${y + h / 2 + fs * 0.36}" font-family="Inter" font-weight="600" font-size="${fs}" fill="${st.color}">${esc(label)}</text>`)
  return { svg: out.join(""), w }
}

function lockGlyph(cx, cy, s, color, sw = 3) {
  const bw = s * 1.5
  const bh = s * 1.15
  return `<g stroke="${color}" stroke-width="${sw}" fill="none">
    <rect x="${cx - bw / 2}" y="${cy - bh / 2 + s * 0.3}" width="${bw}" height="${bh}" rx="${s * 0.25}"/>
    <path d="M ${cx - s * 0.55} ${cy - bh / 2 + s * 0.3} v ${-s * 0.55} a ${s * 0.55} ${s * 0.55} 0 0 1 ${s * 1.1} 0 v ${s * 0.55}"/>
    <circle cx="${cx}" cy="${cy - bh / 2 + s * 0.3 + bh * 0.45}" r="${s * 0.14}" fill="${color}" stroke="none"/>
  </g>`
}

function wordmark(x, y, name, accent, fs = 28, dim = "#6e7681") {
  return `<text x="${x}" y="${y}" font-family="Inter" font-weight="600" font-size="${fs}" fill="${accent}">${esc(name)}</text>` +
    `<text x="${x + name.length * fs * 0.58 + 16}" y="${y}" font-family="Inter" font-size="${fs - 3}" fill="${dim}">· Open(code)Share</text>`
}

const terminal = (d) => {
  const st = STATUS[d.status] ?? STATUS.completed
  const gated = !d.title
  const p = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`]
  p.push(`<defs><radialGradient id="g" cx="0.15" cy="0" r="1"><stop offset="0" stop-color="${d.branding.accent}" stop-opacity="0.13"/><stop offset="0.55" stop-color="${d.branding.accent}" stop-opacity="0"/></radialGradient></defs>`)
  p.push(`<rect width="${W}" height="${H}" fill="#0b0e14"/><rect width="${W}" height="${H}" fill="url(#g)"/>`)
  p.push(wordmark(72, 66, d.branding.name, d.branding.accent, 26))
  if (gated) {
    p.push(`<text x="${W / 2}" y="196" text-anchor="middle" font-family="Inter" font-weight="600" font-size="54" fill="#e6edf3">Private share</text>`)
    p.push(`<text x="${W / 2}" y="242" text-anchor="middle" font-family="Inter" font-size="28" fill="#8b949e">Log in to view this session</text>`)
  } else {
    const lines = wrap(d.title, 42)
    lines.forEach((l, i) => p.push(`<text x="72" y="${150 + i * 60}" font-family="Inter" font-weight="600" font-size="46" fill="#e6edf3">${esc(l)}</text>`))
    const pl = pill(72, lines.length > 1 ? 268 : 208, st, d.status)
    p.push(pl.svg)
    p.push(`<text x="${72 + pl.w + 22}" y="${(lines.length > 1 ? 268 : 208) + 33}" font-family="Inter" font-size="25" fill="#8b949e">${esc(statsText(d.stats))}</text>`)
  }
  const wx = gated ? 290 : 640, wy = gated ? 320 : 352, ww = gated ? 620 : 488, wh = 218
  p.push(`<rect x="${wx}" y="${wy}" width="${ww}" height="${wh}" rx="12" fill="#0d1117" stroke="#30363d"/>`)
  p.push(`<rect x="${wx}" y="${wy}" width="${ww}" height="36" rx="12" fill="#161b22"/><rect x="${wx}" y="${wy + 24}" width="${ww}" height="12" fill="#161b22"/>`)
  ;["#ff5f57", "#febc2e", "#28c840"].forEach((c, i) => p.push(`<circle cx="${wx + 22 + i * 22}" cy="${wy + 18}" r="6.5" fill="${c}"/>`))
  p.push(`<text x="${wx + ww - 16}" y="${wy + 24}" text-anchor="end" font-family="Inter" font-size="15" fill="#6e7681">agent session</text>`)
  const rows = gated
    ? Array.from({ length: 4 }, (_, i) => `<rect x="${wx + 24}" y="${wy + 58 + i * 30}" width="${90 + rng(i + 3)() * 180}" height="10" rx="5" fill="#8b949e" fill-opacity="0.28"/>`)
    : [
        [150, "#7ee787"], [230, "#79c0ff"], [110, "#d2a8ff"], [270, "#8b949e"], [190, "#ffa657"],
      ].map(([w2, c], i) => `<rect x="${wx + 24}" y="${wy + 58 + i * 26}" width="${w2}" height="10" rx="5" fill="${c}" fill-opacity="0.85"/>`)
  p.push(rows.join(""))
  if (!gated) {
    const lastY = wy + 58 + 4 * 26 + 26
    p.push(`<rect x="${wx + 24}" y="${lastY}" width="10" height="18" fill="${d.status === "error" ? "#f85149" : d.branding.accent}"/>`)
  } else {
    p.push(lockGlyph(wx + ww - 66, wy + 118, 22, "#6e7681", 3))
  }
  p.push(`<text x="72" y="${H - 26}" font-family="Inter" font-size="19" fill="#484f58">shared agent sessions</text>`)
  p.push(`</svg>`)
  return p.join("")
}

const blueprint = (d) => {
  const st = STATUS[d.status] ?? STATUS.completed
  const gated = !d.title
  const grid = []
  for (let x = 40; x < W; x += 40) grid.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="#14243d" stroke-width="1"/>`)
  for (let y = 40; y < H; y += 40) grid.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#14243d" stroke-width="1"/>`)
  const p = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`]
  p.push(`<rect width="${W}" height="${H}" fill="#0a1526"/>`)
  p.push(grid.join(""))
  const cm = 26, m = 26
  for (const [cx, cy, dx, dy] of [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]]) {
    p.push(`<path d="M ${cx + dx * cm} ${cy} h ${-dx * cm} v ${dy * cm}" fill="none" stroke="${d.branding.accent}" stroke-opacity="0.7" stroke-width="2"/>`)
  }
  p.push(wordmark(72, 70, d.branding.name, d.branding.accent, 26, "#4f6d96"))
  p.push(`<text x="${W - 72}" y="66" text-anchor="end" font-family="Inter" font-size="18" letter-spacing="6" fill="#4f6d96">OS · SESSION RECORD</text>`)
  if (gated) {
    for (let i = -6; i < 30; i++) p.push(`<rect x="${i * 46}" y="300" width="18" height="80" fill="#1c2c45" transform="rotate(24 ${i * 46} 340)"/>`)
    p.push(`<text x="${W / 2}" y="262" text-anchor="middle" font-family="Inter" font-weight="600" font-size="48" letter-spacing="4" fill="${d.branding.accent}">ACCESS RESTRICTED</text>`)
    p.push(`<text x="${W / 2}" y="424" text-anchor="middle" font-family="Inter" font-size="24" fill="#7d93b5">log in to view this session</text>`)
    p.push(lockGlyph(W / 2, 502, 24, "#7d93b5", 3))
  } else {
    const lines = wrap(d.title, 40)
    const y0 = 190
    lines.forEach((l, i) => p.push(`<text x="72" y="${y0 + i * 64}" font-family="Inter" font-weight="600" font-size="54" fill="#dbe7f5">${esc(l)}</text>`))
    p.push(`<rect x="72" y="${y0 + lines.length * 64 - 18}" width="180" height="5" fill="${d.branding.accent}"/>`)
    const cols = [["TURNS", `${d.stats.turns}`], ["TOOLS", `${d.stats.tools ?? "-"}`], ["DURATION", fmtDuration(d.stats.durationMs ?? 0)], ["MODEL", d.stats.model ?? "-"]]
    const cw = (W - 144) / cols.length
    cols.forEach(([k, v], i) => {
      const x = 72 + i * cw
      p.push(`<text x="${x}" y="452" font-family="Inter" font-size="16" letter-spacing="3" fill="#4f6d96">${esc(k)}</text>`)
      p.push(`<text x="${x}" y="490" font-family="Inter" font-weight="600" font-size="28" fill="#dbe7f5">${esc(v)}</text>`)
      if (i) p.push(`<line x1="${x - 18}" y1="432" x2="${x - 18}" y2="498" stroke="#1c2c45" stroke-width="1.5"/>`)
    })
  }
  const label = gated ? "PROTECTED" : st.label.toUpperCase()
  const sw2 = 40 + label.length * 14
  p.push(`<rect x="${W - 72 - sw2}" y="98" width="${sw2}" height="44" fill="none" stroke="${gated ? d.branding.accent : st.color}" stroke-dasharray="6 5" stroke-width="1.8"/>`)
  p.push(`<text x="${W - 72 - sw2 / 2}" y="127" text-anchor="middle" font-family="Inter" font-weight="600" font-size="21" letter-spacing="2" fill="${gated ? d.branding.accent : st.color}">${esc(label)}</text>`)
  p.push(`<text x="${W - 72}" y="${H - 30}" text-anchor="end" font-family="Inter" font-size="17" letter-spacing="2" fill="#31435f">SHARED AGENT SESSIONS</text>`)
  p.push(`</svg>`)
  return p.join("")
}

const aurora = (d) => {
  const st = STATUS[d.status] ?? STATUS.completed
  const gated = !d.title
  const p = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`]
  p.push(`<defs>
    <radialGradient id="a" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${d.branding.accent}" stop-opacity="0.5"/><stop offset="1" stop-color="${d.branding.accent}" stop-opacity="0"/></radialGradient>
    <radialGradient id="b" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#a371f7" stop-opacity="0.42"/><stop offset="1" stop-color="#a371f7" stop-opacity="0"/></radialGradient>
    <radialGradient id="c" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#39d2c0" stop-opacity="0.3"/><stop offset="1" stop-color="#39d2c0" stop-opacity="0"/></radialGradient>
  </defs>`)
  p.push(`<rect width="${W}" height="${H}" fill="#0b0d12"/>`)
  p.push(`<circle cx="1020" cy="80" r="360" fill="url(#a)"/><circle cx="120" cy="560" r="380" fill="url(#b)"/><circle cx="1150" cy="560" r="300" fill="url(#c)"/>`)
  p.push(`<rect x="56" y="56" width="${W - 112}" height="${H - 112}" rx="26" fill="#ffffff" fill-opacity="0.045" stroke="#ffffff" stroke-opacity="0.14"/>`)
  p.push(wordmark(104, 116, d.branding.name, d.branding.accent, 25, "#8b95a8"))
  if (!gated) {
    const pl = pill(W - 104 - (36 + (d.status === "live" ? 26 : 0) + st.label.length * 15) - 8, 88, st, d.status, { fs: 24 })
    p.push(pl.svg)
  }
  if (gated) {
    p.push(lockGlyph(W / 2, 268, 34, d.branding.accent, 4))
    p.push(`<text x="${W / 2}" y="382" text-anchor="middle" font-family="Inter" font-weight="600" font-size="54" fill="#eef1f6">Private share</text>`)
    p.push(`<text x="${W / 2}" y="428" text-anchor="middle" font-family="Inter" font-size="27" fill="#9aa7b8">Log in to view this session</text>`)
  } else {
    const lines = wrap(d.title, 34)
    const y0 = 268
    lines.forEach((l, i) => p.push(`<text x="112" y="${y0 + i * 70}" font-family="Inter" font-weight="600" font-size="56" fill="#eef1f6">${esc(l)}</text>`))
    if (d.status === "live") p.push(`<rect x="112" y="${y0 + lines.length * 70 - 34}" width="300" height="4" rx="2" fill="${d.branding.accent}" fill-opacity="0.8"/><circle cx="424" cy="${y0 + lines.length * 70 - 32}" r="7" fill="${d.branding.accent}"/>`)
    p.push(`<line x1="112" y1="470" x2="${W - 112}" y2="470" stroke="#ffffff" stroke-opacity="0.1"/>`)
    p.push(`<text x="112" y="514" font-family="Inter" font-size="25" fill="#9aa7b8">${esc(statsText(d.stats))}</text>`)
  }
  p.push(`<text x="${W - 112}" y="${H - 84}" text-anchor="end" font-family="Inter" font-size="18" fill="#7b8598">shared agent sessions</text>`)
  p.push(`</svg>`)
  return p.join("")
}

const poster = (d) => {
  const st = STATUS[d.status] ?? STATUS.completed
  const gated = !d.title
  const p = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`]
  p.push(`<rect width="${W}" height="${H}" fill="#f4f1ea"/>`)
  p.push(`<rect x="24" y="24" width="${W - 48}" height="${H - 48}" fill="none" stroke="#d8d2c4"/>`)
  p.push(`<rect x="34" y="34" width="${W - 68}" height="${H - 68}" fill="none" stroke="#d8d2c4"/>`)
  p.push(`<text x="${W / 2}" y="102" text-anchor="middle" font-family="Inter" font-size="19" letter-spacing="7" fill="#6b6455">${esc(d.branding.name.toUpperCase())} · OPENCODESHARE</text>`)
  p.push(`<rect x="${W / 2 - 30}" y="136" width="60" height="9" fill="${d.branding.accent}"/>`)
  if (gated) {
    p.push(`<text x="${W / 2}" y="330" text-anchor="middle" font-family="Inter" font-weight="600" font-size="76" letter-spacing="6" fill="#191613">PRIVATE</text>`)
    p.push(`<line x1="${W / 2 - 130}" y1="366" x2="${W / 2 + 130}" y2="366" stroke="#191613" stroke-width="1.5"/>`)
    p.push(`<text x="${W / 2}" y="406" text-anchor="middle" font-family="Inter" font-size="24" fill="#6b6455">log in to view this session</text>`)
  } else {
    const lines = wrap(d.title, 28)
    const y0 = 272
    lines.forEach((l, i) => p.push(`<text x="${W / 2}" y="${y0 + i * 86}" text-anchor="middle" font-family="Inter" font-weight="600" font-size="66" fill="#191613">${esc(l)}</text>`))
    p.push(`<text x="${W / 2}" y="470" text-anchor="middle" font-family="Inter" font-size="20" letter-spacing="3" fill="#6b6455">${esc(statsText(d.stats, "  ·  ").toUpperCase())}</text>`)
  }
  const label = gated ? "PROTECTED" : st.label.toUpperCase()
  const sw2 = 46 + label.length * 17
  const sy = gated ? 188 : 128
  p.push(`<g transform="rotate(-7 ${W - 190} ${sy + 31})">`)
  p.push(`<rect x="${W - 190 - sw2 / 2}" y="${sy}" width="${sw2}" height="62" fill="none" stroke="${gated ? "#8a8375" : st.color}" stroke-width="3"/>`)
  p.push(`<text x="${W - 190}" y="${sy + 41}" text-anchor="middle" font-family="Inter" font-weight="600" font-size="26" letter-spacing="3" fill="${gated ? "#8a8375" : st.color}">${esc(label)}</text>`)
  p.push(`</g>`)
  p.push(`<text x="${W / 2}" y="${H - 58}" text-anchor="middle" font-family="Inter" font-size="16" letter-spacing="3" fill="#a09a8c">SHARED AGENT SESSIONS</text>`)
  p.push(`</svg>`)
  return p.join("")
}

const minimap = (d) => {
  const st = STATUS[d.status] ?? STATUS.completed
  const gated = !d.title
  const p = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`]
  p.push(`<rect width="${W}" height="${H}" fill="#0d1117"/>`)
  p.push(`<rect x="0" y="0" width="10" height="${H}" fill="${d.branding.accent}"/>`)
  p.push(wordmark(72, 70, d.branding.name, d.branding.accent, 26))
  if (!gated) {
    const pl = pill(W - 72 - (36 + (d.status === "live" ? 26 : 0) + st.label.length * 15) - 8, 42, st, d.status, { fs: 24 })
    p.push(pl.svg)
  }
  if (gated) {
    p.push(`<text x="72" y="200" font-family="Inter" font-weight="600" font-size="52" fill="#e6edf3">Private share</text>`)
    p.push(`<text x="72" y="248" font-family="Inter" font-size="27" fill="#8b949e">Log in to view this session</text>`)
    const rr = rng(42)
    for (let i = 0; i < 12; i++) {
      const x = 72 + i * 72
      p.push(`<rect x="${x}" y="388" width="15" height="15" rx="3" fill="#30363d"/>`)
      p.push(`<rect x="${x}" y="414" width="${34 + Math.round(rr() * 22)}" height="12" rx="6" fill="#161b22"/>`)
      p.push(`<rect x="${x + 4 + Math.round(rr()) * 8}" y="432" width="4" height="9" rx="1.5" fill="#21262d"/>`)
      if (i < 11) p.push(`<line x1="${x + 15}" y1="395" x2="${x + 72}" y2="395" stroke="#161b22" stroke-width="1.5"/>`)
    }
    p.push(lockGlyph(72 + 12 * 72 + 26, 412, 26, "#6e7681", 3.5))
  } else {
    const lines = wrap(d.title, 44)
    lines.forEach((l, i) => p.push(`<text x="72" y="${152 + i * 58}" font-family="Inter" font-weight="600" font-size="44" fill="#e6edf3">${esc(l)}</text>`))
    p.push(`<text x="72" y="350" font-family="Inter" font-size="16" letter-spacing="4" fill="#484f58">SESSION SHAPE · ${d.stats.turns} PROMPTS</text>`)
    const show = Math.min(d.stats.turns, 15)
    const r = rng(d.stats.turns * 7 + d.stats.tools)
    for (let i = 0; i < show; i++) {
      const x = 72 + i * 72
      const last = i === show - 1
      const isErr = last && d.status === "error"
      p.push(`<rect x="${x}" y="388" width="15" height="15" rx="3" fill="${d.branding.accent}" fill-opacity="0.85"/>`)
      if (last && d.status === "live") p.push(`<rect x="${x - 4}" y="384" width="23" height="23" rx="6" fill="none" stroke="${d.branding.accent}" stroke-width="2"/>`)
      const bw = 34 + Math.round(r() * 22)
      p.push(`<rect x="${x}" y="414" width="${bw}" height="12" rx="6" fill="${isErr ? "#f85149" : "#30363d"}"/>`)
      if (last && d.status === "live") p.push(`<rect x="${x + 2}" y="417" width="14" height="6" rx="3" fill="${d.branding.accent}"/>`)
      const ticks = Math.round(r() * 3)
      for (let t = 0; t < ticks; t++) p.push(`<rect x="${x + 4 + t * 8}" y="432" width="4" height="9" rx="1.5" fill="#6e7681"/>`)
      if (i < show - 1) p.push(`<line x1="${x + 15}" y1="395" x2="${x + 72}" y2="395" stroke="#21262d" stroke-width="1.5"/>`)
    }
    if (d.stats.turns > show) p.push(`<text x="${72 + show * 72 + 6}" y="408" font-family="Inter" font-size="22" fill="#6e7681">+${d.stats.turns - show}</text>`)
    p.push(`<text x="72" y="498" font-family="Inter" font-size="24" fill="#8b949e">${esc(statsText(d.stats))}</text>`)
  }
  p.push(`<text x="72" y="${H - 28}" font-family="Inter" font-size="18" fill="#484f58">shared agent sessions</text>`)
  p.push(`</svg>`)
  return p.join("")
}

const STYLES = { aurora, minimap, poster, blueprint, terminal }

/** Render the per-share OG card PNG. style picks a card family
 * (aurora | minimap | poster | blueprint | terminal); unknown values and
 * the default resolve to aurora. */
export async function renderOgPng({ title, status, stats, branding, style }) {
  await ensureWasm()
  const d = {
    title,
    status,
    stats: stats ?? {},
    branding: {
      name: branding?.name || "openshare",
      accent: branding?.accent || "#7aa2f7",
    },
  }
  const fn = STYLES[style] ?? aurora
  const resvg = new Resvg(fn(d), {
    fitTo: { mode: "width", value: W },
    font: { fontBuffers: resvgFonts().map((f) => f.data), loadSystemFonts: false, defaultFontFamily: "Inter" },
  })
  return resvg.render().asPng()
}
