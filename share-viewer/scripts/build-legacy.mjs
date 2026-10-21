// Build the LEGACY (v1) viewer and publish it under dist/v1 so the worker can
// serve both generations from one deployment:
//
//   /s/<id>      -> the current (v2) viewer   (dist/index.html)
//   /v1/s/<id>   -> the legacy (v1) viewer    (dist/v1/index.html)
//
// The legacy tree is exported from git (no worktree, no git metadata) into
// .legacy-src/, patched for the /v1 base path, built with the same vite
// pipeline it always used, and copied into dist/v1. Re-running is safe: the
// source dir and the output dir are replaced.
//
//   npm run build:legacy
//   OPENSHARE_LEGACY_REF=<ref> npm run build:legacy   (default: origin/master)
import { execFileSync, execSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO = dirname(ROOT)
const REF = process.env.OPENSHARE_LEGACY_REF ?? "origin/master"
const SRC = join(ROOT, ".legacy-src")
const OUT = join(ROOT, "dist", "v1")

const fail = (message) => {
  console.error(`[build-legacy] ${message}`)
  process.exit(1)
}

const patch = (file, replacements, label) => {
  if (!existsSync(file)) fail(`${label}: missing ${file}`)
  let text = readFileSync(file, "utf8")
  for (const [from, to] of replacements) {
    const next = text.replace(from, to)
    if (next === text) fail(`${label}: anchor not found - ${from}`)
    text = next
  }
  writeFileSync(file, text)
}

console.log(`[build-legacy] exporting ${REF}`)
rmSync(SRC, { recursive: true, force: true })
mkdirSync(SRC, { recursive: true })
// no shell pipe: cmd.exe + bsdtar lose the stdin stream (live-caught), so
// export to a file first and extract it explicitly
const archive = join(ROOT, ".legacy-src.tar")
rmSync(archive, { force: true })
execSync(`git archive --format=tar -o "${archive}" ${REF}`, { cwd: REPO, stdio: "inherit" })
execSync(`tar -xf "${archive}" -C "${SRC}"`, { cwd: REPO, stdio: "inherit" })
rmSync(archive, { force: true })

const viewer = join(SRC, "share-viewer")
if (!existsSync(join(viewer, "package.json"))) fail(`${REF} has no share-viewer/ - is this the v1 branch?`)

// Serve every legacy asset from /v1/ (vite rewrites index.html + CSS urls).
patch(
  join(viewer, "vite.config.ts"),
  [
    [/export default defineConfig\(\{/, 'export default defineConfig({\n  base: "/v1/",'],
    [
      /worker: \{ format: "es" \},/,
      'worker: {\n    format: "es",\n    // inline the worker chunks: a blob/module worker cannot resolve the\n    // relative wasm import (live-caught: shiki worker died, which took the\n    // assistant turn down with it)\n    rollupOptions: { output: { inlineDynamicImports: true } },\n  },',
    ],
  ],
  "vite base + worker inlining",
)

// The legacy viewer is mounted at /v1/ and uses HASH routes (/v1/#/s/<id>)
// so its assets are served straight by the assets layer - no rewrite rules,
// no SPA fallback, and module workers load exactly like they do for v2.
patch(
  join(viewer, "src", "app.tsx"),
  [
    [
      /^(import [^\r\n]*\r?\n)/m,
      (match) =>
        `${match}\n// the legacy build is served under /v1 with hash routes\nconst SHARE_BASE = location.pathname.startsWith("/v1/") ? "/v1/#" : ""\n`,
    ],
    [
      /(function subHref\(source: [^)]*\)[^{]*\{)/,
      '$1\n  // keep the legacy prefix on links\n',
    ],
    [/`\/s\/\$\{source\.shareID\}/g, "`${SHARE_BASE}/s/${source.shareID}"],
    [
      /`\/s\/\$\{props\.source\.shareID\}`/g,
      "`${SHARE_BASE}/s/${props.source.shareID}`",
    ],
    // route parsing: hash when present, pathname otherwise
    [
      /const parts = location\.pathname\.split\("\/"\)\.filter\(Boolean\)/g,
      'const parts = (location.hash.length > 1 ? location.hash.slice(1) : location.pathname).split("/").filter(Boolean)',
    ],
  ],
  "app hrefs + hash routes",
)

// parsePath lives in the data source; apply the same hash rule there
patch(
  join(viewer, "src", "data-source.ts"),
  [
    [
      /const parts = location\.pathname\.split\("\/"\)\.filter\(Boolean\)/g,
      'const parts = (location.hash.length > 1 ? location.hash.slice(1) : location.pathname).split("/").filter(Boolean)',
    ],
  ],
  "data-source hash route",
)

// The share contract is v2 (messages carry their content embedded), while
// this viewer renders the old v1 model (message + separate parts). Without
// an adapter the legacy page shows turns but no content at all, so the
// export gets one injected before the fold.
const adapter = `// Injected by share-viewer/scripts/build-legacy.mjs - do not edit in the
// exported tree. Adapts the OpenShare v2 envelope (message content embedded)
// to the v1 model this viewer renders (message + part items).
type AnyItem = { type: string; data?: any; sessionID?: string; del?: boolean }

const textOf = (content: any): string => {
  if (!Array.isArray(content)) return ""
  return content
    .filter((block: any) => block && block.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\\n")
}

const V1_TOOL: Record<string, string> = { subagent: "task" }

// v2 inputs name the file "path"; every v1 file renderer reads "filePath"
function v1Input(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input ?? {})) out[key === "path" ? "filePath" : key] = value
  return out
}

// v1 renderers read a few metadata fields under their own names: the task
// row links its child session through sessionId, file tools through
// filediff, and read renders preview instead of parsing <content>.
function v1Metadata(name: string, metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(metadata ?? {}) }
  if (out.sessionId === undefined && typeof out.sessionID === "string") out.sessionId = out.sessionID
  if (out.filediff === undefined && Array.isArray(out.files)) out.filediff = out.files[0]
  return out
}

// what a v1 host stored for the read tool: <content> with numbered lines
function readBlock(text: string): string {
  const numbered = text.split("\\n").map((line, index) => (index + 1) + ": " + line)
  return "<content>\\n" + numbered.join("\\n") + "\\n</content>"
}

export function adaptItems(input: AnyItem[]): AnyItem[] {
  const out: AnyItem[] = []
  // items arrive in storage-key order (an assistant message can precede its
  // user message), but v1's turn model needs chronological messages; user
  // messages are pre-scanned so an assistant always finds its parent.
  const users = input
    .filter((i) => i.type === "message" && i.data?.type === "user")
    .map((i) => ({ id: i.data.id as string, at: i.data.time?.created ?? 0 }))
    .sort((a, b) => a.at - b.at)
  const parentFor = (created: number) => {
    let found: string | undefined
    for (const user of users) if (user.at <= created) found = user.id
    return found
  }
  const items = [
    ...input.filter((i) => i.type !== "message"),
    ...input
      .filter((i) => i.type === "message" && i.data && !i.data.role && i.data.type === "user")
      .sort((a, b) => (a.data.time?.created ?? 0) - (b.data.time?.created ?? 0)),
    ...input
      .filter((i) => i.type === "message" && i.data && !i.data.role && i.data.type !== "user")
      .sort((a, b) => (a.data.time?.created ?? 0) - (b.data.time?.created ?? 0)),
    ...input.filter((i) => i.type === "message" && i.data?.role),
  ]
  for (const item of items) {
    if (item.type !== "message" || !item.data || typeof item.data !== "object") {
      out.push(item)
      continue
    }
    const message = item.data
    // already v1-shaped (role present) - pass through
    if (message.role) {
      out.push(item)
      continue
    }
    const sessionID = item.sessionID ?? message.sessionID ?? ""
    if (message.type === "user") {
      out.push({
        type: "message",
        sessionID,
        data: {
          id: message.id,
          sessionID,
          role: "user",
          time: { created: message.time?.created ?? 0 },
          agent: message.metadata?.agent ?? message.agents?.[0]?.name,
          model: message.metadata?.model,
        },
      })
      if (typeof message.text === "string" && message.text.trim())
        out.push({
          type: "part",
          data: { id: message.id + "_text", sessionID, messageID: message.id, type: "text", text: message.text },
        })
      for (const [index, file] of (message.files ?? []).entries())
        out.push({
          type: "part",
          data: {
            id: message.id + "_file_" + index,
            sessionID,
            messageID: message.id,
            type: "file",
            mime: file?.mime ?? "application/octet-stream",
            filename: file?.name,
            url: file?.source?.type === "uri" ? file.source.uri : undefined,
          },
        })
      continue
    }
    if (message.type === "assistant") {
      out.push({
        type: "message",
        sessionID,
        data: {
          id: message.id,
          sessionID,
          role: "assistant",
          // v1 associates assistant messages to their user turn by parentID
          parentID: message.parentID ?? parentFor(message.time?.created ?? 0),
          time: { created: message.time?.created ?? 0, completed: message.time?.completed },
          agent: message.agent,
          model: message.model ? { providerID: message.model.providerID, modelID: message.model.id } : undefined,
          error: message.error,
          cost: message.cost,
          tokens: message.tokens,
        },
      })
      for (const [index, content] of (message.content ?? []).entries()) {
        const partID = message.id + "_c" + index
        if (!content || typeof content !== "object") continue
        if (content.type === "text")
          out.push({ type: "part", data: { id: partID, sessionID, messageID: message.id, type: "text", text: content.text ?? "" } })
        else if (content.type === "reasoning")
          out.push({ type: "part", data: { id: partID, sessionID, messageID: message.id, type: "reasoning", text: content.text ?? "" } })
        else if (content.type === "tool") {
          const text = textOf(content.state?.content)
          const failed = content.state?.status === "error"
          const failure = failed ? content.state?.error?.message ?? "error" : undefined
          out.push({
            type: "part",
            data: {
              id: partID,
              sessionID,
              messageID: message.id,
              type: "tool",
              tool: V1_TOOL[content.name] ?? content.name,
              callID: content.id,
              state: {
                status: content.state?.status === "streaming" ? "running" : (content.state?.status ?? "completed"),
                input: v1Input(content.state?.input ?? {}),
                // read is parsed from the v1 <content> block (numbered lines);
                // every other tool takes the text as-is
                output: failure ?? (content.name === "read" ? readBlock(text) : text),
                error: failure,
                metadata: v1Metadata(content.name, content.state?.metadata),
                title: content.state?.title,
                time: { start: content.time?.created ?? 0, end: content.time?.completed ?? 0 },
              },
            },
          })
        }
      }
      continue
    }
    if (message.type === "compaction") {
      out.push({
        type: "message",
        sessionID,
        data: {
          id: message.id,
          sessionID,
          role: "assistant",
          time: { created: message.time?.created ?? 0, completed: message.time?.created },
          agent: "compaction",
          parentID: message.parentID ?? parentFor(message.time?.created ?? 0),
        },
      })
      out.push({ type: "part", data: { id: message.id + "_compaction", sessionID, messageID: message.id, type: "compaction", auto: message.reason === "auto" } })
      if (message.summary)
        out.push({ type: "part", data: { id: message.id + "_summary", sessionID, messageID: message.id, type: "text", text: message.summary } })
      continue
    }
    // unknown message type: keep it so the fold can decide
    out.push(item)
  }
  return out
}
`
writeFileSync(join(viewer, "src", "legacy-adapter.ts"), adapter)
patch(
  join(viewer, "src", "fold.ts"),
  [
    [
      /^(import [^\r\n]*\r?\n)/m,
      (match) =>
        `${match}import { adaptItems } from "./legacy-adapter"\n\n`,
    ],
    [
      /(export function fold\(items: \{ type: string; data\?: any; sessionID\?: string \}\[\], sessionID: string, shareID: string\): ShareData \{\r?\n)/,
      (match) => `${match}  // the share contract is v2 - normalize it to this viewer's v1 model\n  items = adaptItems(items)\n`,
    ],
  ],
  "fold adapter",
)

console.log("[build-legacy] installing legacy deps")
execSync("bun install", { cwd: viewer, stdio: "inherit" })
console.log("[build-legacy] building legacy viewer")
execSync("bunx vite build && node scripts/build-themes.mjs", { cwd: viewer, stdio: "inherit" })

rmSync(OUT, { recursive: true, force: true })
cpSync(join(viewer, "dist"), OUT, { recursive: true })
// Worker chunks are instantiated as blobs on some paths, where a relative
// "./wasm-..." import cannot resolve (live-caught: the markdown worker died
// with "Failed to fetch dynamically imported module"). Absolute /v1/asset
// URLs work from both a module and a blob worker.
for (const file of readdirSync(join(OUT, "assets"))) {
  if (!/worker/i.test(file) || !file.endsWith(".js")) continue
  const path = join(OUT, "assets", file)
  let code = readFileSync(path, "utf8")
  const patched = code.replace(/import\("\.\//g, 'import("/v1/assets/').replace(/from"\.\//g, 'from"/v1/assets/')
  if (patched !== code) writeFileSync(path, patched)
}
console.log(`[build-legacy] wrote ${OUT}`)