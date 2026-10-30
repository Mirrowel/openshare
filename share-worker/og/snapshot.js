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
  // no caching: workerd gives a 128MB isolate and every text is used once
  const readOnce = (name) => readAsset(name)

  const base = html.replace(/[ \t]*<link[^>]*rel="modulepreload"[^>]*>\r?\n?/g, "")
  const entryRe = /<script[^>]*src="\/assets\/([^"]+\.js)"[^>]*>\s*<\/script>/g
  const cssRe = /<link[^>]*href="\/assets\/([^"]+\.css)"[^>]*>/g
  const entryNames = [...base.matchAll(entryRe)].map((m) => m[1])
  const cssNames = [...base.matchAll(cssRe)].map((m) => m[1])

  // --- what the share actually needs ------------------------------------
  // Icons: the entry's file-icon map names one chunk per icon. Only icons a
  // path in this share can ask for are inlined (plus the generic fallbacks);
  // anything else resolves through the vendored fallback to the generic file
  // icon instead of a blank.
  const ICON_ALIAS = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    py: "python", rb: "ruby", md: "markdown", mdx: "markdown", yml: "yaml", yaml: "yaml", json: "json", jsonc: "json",
    sh: "shell", bash: "shell", zsh: "shell", ps1: "powershell", h: "c", cpp: "cpp", "c++": "cpp", hpp: "cpp",
    cs: "csharp", "c#": "csharp", rs: "rust", kt: "kotlin", kts: "kotlin", go: "go", java: "java", php: "php",
    swift: "swift", lua: "lua", sql: "sql", toml: "toml", xml: "xml", html: "html", htm: "html", css: "css",
    scss: "scss", sass: "sass", less: "less", vue: "vue", svelte: "svelte", png: "image", jpg: "image", jpeg: "image",
    gif: "image", webp: "image", svg: "svg", ico: "image", lock: "lock", txt: "text", log: "text", env: "env",
    dockerfile: "docker", gitignore: "git", license: "license", readme: "readme",
  }
  const iconChunk = new Map()
  const iconNameOf = new Map()
  const entryText = (await readOnce(entryNames[0])) ?? ""
  // the glob compiles to `"<name>.svg":()=>PRELOAD(()=>import("./<name>-<hash>.js"),[...])`
  // with a Vite-version-specific preload wrapper; match the import, not the wrapper
  for (const m of entryText.matchAll(/"\.\.\/assets\/icons\/file-types\/([^"]+)\.svg":\(\)=>[^;]{0,200}?import\("\.\/([A-Za-z0-9_.+-]+-[A-Za-z0-9_-]{8}\.js)"/g)) {
    iconChunk.set(m[2], m[1])
    iconNameOf.set(m[1], m[2])
  }
  // the kit's generic icons are named Document / Folder / FolderOpen
  const neededIcons = new Set(["document", "folder", "folder-open"])
  // every filename-ish string in the share can ask for an icon: tool paths,
  // patch headers, display paths. Take the extension + basename of each.
  const islandPaths = [...String(island).matchAll(/"([^"]*[\\/][^"]*|[^"\s]+\.\w{1,8})"/g)].map((m) => m[1].replace(/\\\\/g, "/"))
  for (const p of islandPaths) {
    const base = p.split("/").pop() ?? ""
    const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : ""
    const name = base.toLowerCase()
    if (ext && ICON_ALIAS[ext]) neededIcons.add(ICON_ALIAS[ext])
    if (ICON_ALIAS[name]) neededIcons.add(ICON_ALIAS[name])
    if (iconNameOf.has(name)) neededIcons.add(name)
    if (iconNameOf.has(ext)) neededIcons.add(ext)
  }
  // the kit's own defaults plus the common languages, so a share never
  // renders a blank slot for an ordinary file
  for (const name of ["markdown", "json", "python", "typescript", "javascript", "shell", "text", "yaml", "toml", "xml", "html", "css", "readme", "config", "lock", "license", "git", "docker", "image", "svg", "diff"]) {
    if (iconNameOf.has(name)) neededIcons.add(name)
  }

  // Grammars: each langs-*.js manifest lists every language pack. Read the
  // manifest, keep only the languages this share uses, and inline the
  // REWRITTEN manifest so a missing language falls back to plain text.
  const wanted = snapshotLanguages(island)
  const GRAMMAR_ENTRY = /\{id:"([^"]+)",name:"[^"]*"(?:,aliases:\[([^\]]*)\])?,import:\(\(\)=>import\("\.\/([A-Za-z0-9_.+-]+-[A-Za-z0-9_-]{8}\.js)"\)\)\}/g
  const grammarWanted = (id, aliases) => {
    if (wanted.has(id)) return true
    for (const a of aliases ?? []) if (wanted.has(a.trim().replace(/^"|"$/g, ""))) return true
    return false
  }
  const overrides = new Map()

  // the REAL worker bundles never run offline (main-thread copies do); the
  // shim and the diffs-main copies must stay
  // NOTE: `markdown.worker-main-*` IS the main-thread copy the shim imports -
  // only the real `markdown.worker-<hash>` worker is dead weight
  const isWorkerBundle = (name) =>
    /^worker-[A-Za-z0-9_-]{8}\.js$/.test(name) ||
    (/^markdown\.worker-[A-Za-z0-9_-]{8}\.js$/.test(name) && !name.startsWith("markdown.worker-main-"))
  // shiki's wasm engine never loads offline (the main-thread renderer uses
  // the pure-JS `highlights` engine) and the viewer registers its own theme;
  // the bundled shiki themes are dead weight in a snapshot
  const isDeadWeight = (name) =>
    /^wasm-[A-Za-z0-9_-]{8}\.js$/.test(name) ||
    /^(everforest|catppuccin|tokyo-night|pierre-(light|dark)-vibrant|one-dark|github-(light|dark)|nord|dracula|solarized|material|vitesse|min-light|min-dark|snazzy|monokai|ayu|kanagawa|rose-pine|gruvbox)-[A-Za-z0-9_-]{8}\.js$/.test(name)
  const includeIcon = (name) => {
    const icon = iconChunk.get(name)
    return icon === undefined || neededIcons.has(icon)
  }

  // --- walk the module graph -------------------------------------------
  // Static imports (`from"./x.js"`) and real dynamic imports
  // (`import("./x.js")`) pull chunks in. Bare "assets/x.js" strings are
  // Vite's preload dependency arrays - an optimization list that also names
  // every lazy chunk, so they never count as inclusion by themselves.
  const STATIC_RE = /from\s*["'](?:\.\/|\/assets\/)([A-Za-z0-9_\-.]+\.js)["']/g
  const DYNAMIC_RE = /import\(["'](?:\.\/|\/assets\/)([A-Za-z0-9_\-.]+\.js)["']\)/g
  const ASSET_STR_RE =
    /["'](?:\.\/|\/assets\/|assets\/)([A-Za-z0-9_\-.]+-[A-Za-z0-9_-]{8}\.(?:png|svg|jpe?g|webp|gif|woff2))["']/g

  const included = new Set()
  const assetNames = new Set()
  const enqueue = (name, next) => {
    if (included.has(name)) return
    if (isWorkerBundle(name) || isDeadWeight(name)) return
    if (!includeIcon(name)) return
    included.add(name)
    next.push(name)
  }
  let wave = []
  for (const name of entryNames) enqueue(name, wave)
  while (wave.length) {
    const next = []
    await Promise.all(
      wave.map(async (name) => {
        const text = await readOnce(name)
        if (text == null) return
        if (/^langs-/.test(name)) {
          // keep only the languages this share uses
          const kept = []
          const rewritten = text.replace(GRAMMAR_ENTRY, (whole, id, aliases, file) => {
            if (!grammarWanted(id, aliases ? aliases.split(",") : [])) return ""
            kept.push(file)
            return whole
          })
          overrides.set(name, rewritten.replace(/,\s*,/g, ",").replace(/\[,/, "[").replace(/,\s*\]/, "]"))
          for (const file of kept) enqueue(file, next)
          return
        }
        for (const re of [STATIC_RE, DYNAMIC_RE]) {
          for (const m of text.matchAll(re)) enqueue(m[1], next)
        }
        for (const m of text.matchAll(ASSET_STR_RE)) assetNames.add(m[1])
      }),
    )
    wave = next
  }
  // --- read CSS, collecting the fonts/images it references --------------
  let cssOut = ""
  // math fonts only when the share actually renders math: a `$` in shell
  const hasMath = /\$\$|\\\(|\\\[/.test(String(island))
  for (const name of cssNames) {
    const css = (await readOnce(name)) ?? ""
    for (const m of css.matchAll(/url\(\/assets\/([^)]+)\)/g)) {
      if (!hasMath && /^KaTeX_/.test(m[1])) continue
      assetNames.add(m[1])
    }
    cssOut += css + "\n"
  }

  // --- non-JS assets as data: URLs --------------------------------------
  // the provider sprite is special: <use href="data:...#icon"> does not
  // resolve reliably, so its symbols are injected into the document and the
  // module's sprite URL becomes "" (href="#icon" then hits the document)
  const assetUrls = {}
  let spriteMarkup = ""
  await Promise.all(
    [...assetNames].map(async (file) => {
      const text = await readOnce(file)
      if (text == null) return
      if (/^sprite-[A-Za-z0-9_-]{8}\.svg$/.test(file)) {
        spriteMarkup = text.replace(/^<\?xml[^>]*\?>\s*/, "")
        return
      }
      assetUrls[file] = dataUrl(file, text)
    }),
  )
  cssOut = cssOut.replace(/url\(\/assets\/([^)]+)\)/g, (m, file) => assetUrls[file] ?? m)

  // --- modules: bare keys + inline asset URLs ---------------------------
  const imports = {}
  const referenced = new Set()
  await Promise.all(
    [...included].map(async (name) => {
      const text = overrides.get(name) ?? (await readOnce(name))
      if (text == null) return
      let code = text
        // CSS is already inlined as <style>; Vite's preload helper would
        // still inject <link> tags for the mapped CSS - point them at an
        // empty data: URL so the fetch never leaves the document
        .replace(/(["'`])(?:assets\/|\/assets\/)([A-Za-z0-9_\-.]+\-[A-Za-z0-9_-]{8}\.css)\1/g, "$1data:text/css,$1")
        // `?worker&url` becomes a plain asset URL string; offline it must not
        // be resolved as a module specifier (new Worker("@osh/...") threw)
        .replace(/(["'`])(?:assets\/|\/assets\/)(worker-[A-Za-z0-9_-]{8}\.js)\1/g, "$1data:text/javascript,$1")
        .replace(/(["'`])\.\/([A-Za-z0-9_\-.]+\.js)\1/g, "$1@osh/$2$1")
        .replace(/(["'`])\/assets\/([A-Za-z0-9_\-.]+\.js)\1/g, "$1@osh/$2$1")
        .replace(/(["'])assets\/([A-Za-z0-9_\-.]+\.js)\1/g, "$1@osh/$2$1")
      code = code
        .replace(/(["'`])(?:assets\/|\/assets\/)sprite-[A-Za-z0-9_-]{8}\.svg\1/g, "$1$1")
        .replace(
          /(["'`])(?:assets\/|\/assets\/)([A-Za-z0-9_\-.]+-[A-Za-z0-9_-]{8}\.(?:png|svg|jpe?g|webp|gif|woff2))\1/g,
          (m, q, file) => (assetUrls[file] ? q + assetUrls[file] + q : m),
        )
      for (const m of code.matchAll(/@osh\/([A-Za-z0-9_.+-]+)/g)) referenced.add(m[1])
      imports[`@osh/${name}`] = dataUrl(name, code)
    }),
  )
  // any specifier we deliberately left out (the real worker bundles) must
  // still RESOLVE: point it at an empty module instead of a missing key
  for (const name of referenced) {
    if (!imports[`@osh/${name}`]) imports[`@osh/${name}`] = "data:text/javascript,export{}"
  }

  // --- assemble ---------------------------------------------------------
  // Chunks ship as base64 in a JSON island; a classic boot script turns each
  // into a Blob URL and installs the import map before the entry loads.
  // data: modules were pathological here: `import.meta.url` inside one is
  // the whole (multi-MB) data URL, and the app's URL math blew the tab to
  // 4.5 GB RSS. Blob URLs are short and behave like normal module URLs.
  // entry: replaced by the boot script's module tag (see BOOT_SHIM)
  let out = base.replace(entryRe, () => '<!--osh-entry-->')
  out = out.replace(cssRe, () => `<style>\n${cssOut}\n</style>`)
  const chunks = {}
  for (const [key, url] of Object.entries(imports)) {
    const name = key.slice('@osh/'.length)
    chunks[name] = url
  }
  const head = [
    // charset FIRST: the island carries UTF-8 (em dashes, quotes) and the
    // document must decode as UTF-8 before any of it is parsed
    `<meta charset="utf-8">`,
    "",
    `<script id="osh-chunks" type="application/json">${JSON.stringify(chunks).replace(/</g, "\\u003c")}</script>`,
    `<script>window.__MIRROBOT_SNAPSHOT__=${island};</script>`,
    BOOT_SHIM.replace("__OSH_ENTRY__", entryNames[0] ?? ""),
  ].join("\n    ")
  out = out.replace(/<head>/i, "<head>\n    " + head)
  // the sprite lives at the END of the body: an <svg> inside <head> is
  // invalid HTML and the parser relocates it, which breaks the render root
  if (spriteMarkup) out = out.replace(/<\/body>/i, `<div hidden>${spriteMarkup}</div>` + "</body>")
  return out
}

const BOOT_SHIM = `<script>(function(){
  // a snapshot file runs from file:// - its PATH cannot be rewritten
  // (pushState across file paths throws SecurityError), so /s/<id>[/<n>][#h]
  // URLs translate to same-path hashes: subagent page n becomes #n<n>,
  // message anchors keep their hash.
  if (!window.__MIRROBOT_SNAPSHOT__) return
  // chunks: base64 -> Blob URLs -> import map -> entry module. Blob URLs
  // keep import.meta.url short; data: module URLs made the app's own URL
  // math allocate gigabytes.
  try {
    var data = JSON.parse(document.getElementById("osh-chunks").textContent)
    var imports = {}
    for (var k in data) {
      var v = data[k]
      var cut = v.indexOf(";base64,")
      if (cut < 0) {
        imports["@osh/" + k] = v
        continue
      }
      var bin = atob(v.slice(cut + 8))
      var bytes = new Uint8Array(bin.length)
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      imports["@osh/" + k] = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }))
    }
    var map = document.createElement("script")
    map.type = "importmap"
    map.textContent = JSON.stringify({ imports: imports })
    document.head.appendChild(map)
    var entry = document.createElement("script")
    entry.type = "module"
    entry.src = imports["@osh/__OSH_ENTRY__"]
    document.head.appendChild(entry)
  } catch (e) {
    console.error("[openshare] snapshot boot failed", e)
  }
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
