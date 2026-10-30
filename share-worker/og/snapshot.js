// Self-contained snapshot builder (shared by the CF worker and the Bun
// server). Takes the built viewer's index.html plus a reader for dist
// assets and returns ONE offline HTML file:
//
// - the entry module and every chunk the page actually pulls in are
//   inlined; specifiers become bare "@osh/<file>" keys so an import map can
//   point them at data: URLs (relative specifiers cannot resolve inside a
//   data: module)
// - shiki grammar packs are pulled in only for the languages the share uses
//   (24 MB of grammars otherwise)
// - CSS url() references (webfonts) and asset URL strings inside JS
//   (provider icons, images) become data: URLs (woff2 only - the woff/ttf
//   fallbacks are dead weight offline)
//
// The result opens from file:// with zero network and no workers: pierre
// and the markdown parser fall back to in-page main-thread copies there
// (vendor forks).

// languages keyed by alias -> the shiki language id
const LANG_ALIAS = {
  sh: "shellscript",
  shell: "shellscript",
  zsh: "shellscript",
  bash: "shellscript",
  ts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  md: "markdown",
  yml: "yaml",
  h: "c",
  hpp: "cpp",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  rs: "rust",
  ps1: "powershell",
  kt: "kotlin",
  htm: "html",
  jsonc: "json",
  dockerfile: "docker",
  patch: "diff",
}

/** languages the share data actually uses: plugin-stamped file languages
 * plus code fences in message text */
export function snapshotLanguages(islandJson) {
  const langs = new Set()
  const add = (l) => {
    if (!l || typeof l !== "string") return
    const id = l.trim().toLowerCase()
    if (id.length < 1 || id.length > 32) return
    langs.add(LANG_ALIAS[id] ?? id)
  }
  const visit = (node, depth) => {
    if (depth > 14 || node == null) return
    if (typeof node === "string") {
      const re = /```([A-Za-z0-9_+#.-]{1,32})/g
      let m
      while ((m = re.exec(node))) add(m[1])
      return
    }
    if (Array.isArray(node)) {
      for (const v of node) visit(v, depth + 1)
      return
    }
    if (typeof node === "object") {
      const lang = node.metadata?.language
      if (typeof lang === "string") add(lang)
      for (const k in node) visit(node[k], depth + 1)
    }
  }
  try {
    visit(JSON.parse(islandJson), 0)
  } catch {}
  return langs
}

const MIME = [
  [".js", "text/javascript"],
  [".css", "text/css"],
  [".json", "application/json"],
  [".woff2", "font/woff2"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]
const mimeOf = (file) => MIME.find(([ext]) => file.endsWith(ext))?.[1] ?? "application/octet-stream"

/** UTF-8 safe base64 (btoa alone mangles non-latin1 source) */
function base64(text) {
  const bytes = new TextEncoder().encode(text)
  let bin = ""
  const chunk = 0x2000 // workerd throws "too many arguments" far below 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

const dataUrl = (file, text) => `data:${mimeOf(file)};base64,${base64(text)}`

/**
 * @param {{ html: string, island: string, readAsset: (name: string) => Promise<string|null> }} opts
 * @returns {Promise<string>} the complete offline HTML
 */
export async function buildSnapshotHtml({ html, island, readAsset }) {
  const wanted = snapshotLanguages(island)
  // no caching: workerd gives a 128MB isolate and every text is used once
  const readOnce = (name) => readAsset(name)

  const base = html.replace(/[ \t]*<link[^>]*rel="modulepreload"[^>]*>\r?\n?/g, "")
  const entryRe = /<script[^>]*src="\/assets\/([^"]+\.js)"[^>]*>\s*<\/script>/g
  const cssRe = /<link[^>]*href="\/assets\/([^"]+\.css)"[^>]*>/g
  const entryNames = [...base.matchAll(entryRe)].map((m) => m[1])
  const cssNames = [...base.matchAll(cssRe)].map((m) => m[1])

  // --- walk the module graph -------------------------------------------
  // Static imports (`from"./x.js"`) and real dynamic imports
  // (`import("./x.js")`) pull chunks in. Bare "assets/x.js" strings are
  // Vite's preload dependency arrays - an optimization list that also names
  // every lazy chunk, so they never count as inclusion by themselves.
  // Discovery runs in concurrent waves: a snapshot reaches ~1300 files and
  // sequential round trips took literal minutes.
  const STATIC_RE = /from\s*["'](?:\.\/|\/assets\/)([A-Za-z0-9_\-.]+\.js)["']/g
  const DYNAMIC_RE = /import\(["'](?:\.\/|\/assets\/)([A-Za-z0-9_\-.]+\.js)["']\)/g
  const ASSET_STR_RE =
    /["'](?:\.\/|\/assets\/|assets\/)([A-Za-z0-9_\-.]+-[A-Za-z0-9_-]{8}\.(?:png|svg|jpe?g|webp|gif|woff2))["']/g

  const included = new Set()
  const assetNames = new Set()
  let wave = entryNames.slice()
  for (const name of wave) included.add(name)
  while (wave.length) {
    const next = []
    await Promise.all(
      wave.map(async (name) => {
        const text = await readOnce(name)
        if (text == null) return
        for (const re of [STATIC_RE, DYNAMIC_RE]) {
          for (const m of text.matchAll(re)) {
            if (included.has(m[1])) continue
            included.add(m[1])
            next.push(m[1])
          }
        }
        for (const m of text.matchAll(ASSET_STR_RE)) assetNames.add(m[1])
      }),
    )
    wave = next
  }

  // --- read CSS, collecting the fonts/images it references --------------
  let cssOut = ""
  for (const name of cssNames) {
    const css = (await readOnce(name)) ?? ""
    for (const m of css.matchAll(/url\(\/assets\/([^)]+)\)/g)) assetNames.add(m[1])
    cssOut += css + "\n"
  }

  // --- non-JS assets as data: URLs --------------------------------------
  const assetUrls = {}
  await Promise.all(
    [...assetNames].map(async (file) => {
      const text = await readOnce(file)
      if (text != null) assetUrls[file] = dataUrl(file, text)
    }),
  )
  cssOut = cssOut.replace(/url\(\/assets\/([^)]+)\)/g, (m, file) => assetUrls[file] ?? m)

  // --- modules: bare keys + inline asset URLs ---------------------------
  const imports = {}
  await Promise.all(
    [...included].map(async (name) => {
      const text = await readOnce(name)
      if (text == null) return
      let code = text
        // CSS is already inlined as <style>; Vite's preload helper would
        // still inject <link> tags for the mapped CSS - point them at an
        // empty data: URL so the fetch never leaves the document
        .replace(/(["'`])(?:assets\/|\/assets\/)([A-Za-z0-9_\-.]+\-[A-Za-z0-9_-]{8}\.css)\1/g, "$1data:text/css,$1")
        .replace(/(["'`])\.\/([A-Za-z0-9_\-.]+\.js)\1/g, "$1@osh/$2$1")
        .replace(/(["'`])\/assets\/([A-Za-z0-9_\-.]+\.js)\1/g, "$1@osh/$2$1")
        .replace(/(["'])assets\/([A-Za-z0-9_\-.]+\.js)\1/g, "$1@osh/$2$1")
      code = code.replace(
        /(["'`])(?:assets\/|\/assets\/)([A-Za-z0-9_\-.]+-[A-Za-z0-9_-]{8}\.(?:png|svg|jpe?g|webp|gif|woff2))\1/g,
        (m, q, file) => (assetUrls[file] ? q + assetUrls[file] + q : m),
      )
      imports[`@osh/${name}`] = dataUrl(name, code)
    }),
  )
  // --- assemble ---------------------------------------------------------
  let out = base.replace(entryRe, (whole, src) =>
    imports[`@osh/${src}`] ? `<script type="module" src="${imports[`@osh/${src}`]}"></script>` : whole,
  )
  out = out.replace(cssRe, () => `<style>\n${cssOut}\n</style>`)
  const head = [
    `<script type="importmap">${JSON.stringify({ imports }).replace(/</g, "\\u003c")}</script>`,
    `<script>window.__MIRROBOT_SNAPSHOT__=${island};</script>`,
    BOOT_SHIM,
  ].join("\n    ")
  out = out.replace(/<head>/i, "<head>\n    " + head)
  return out
}

const BOOT_SHIM = `<script>(function(){
  // a snapshot file runs from file:// - its PATH cannot be rewritten
  // (pushState across file paths throws SecurityError), so /s/<id>[/<n>][#h]
  // URLs translate to same-path hashes: subagent page n becomes #n<n>,
  // message anchors keep their hash.
  if (!window.__MIRROBOT_SNAPSHOT__) return
  var orig = history.pushState.bind(history)
  history.pushState = function(st, title, url) {
    if (typeof url === "string" && url.charAt(0) === "/") {
      var m = /^\\/s\\/[^/]+(?:\\/(\\d+))?/.exec(url)
      var hi = url.indexOf("#")
      var hash = hi >= 0 ? url.slice(hi) : ""
      var sub = m && m[1] ? "#n" + m[1] : ""
      var next = sub || hash
      if (next) return orig(st, title, location.pathname + location.search + next)
      return
    }
    return orig(st, title, url)
  }
})()</script>`
