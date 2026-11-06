#!/usr/bin/env node
// Open(code)Share session interchange.
//
// Converts between the three shapes a session can live in:
//   - share envelope   the OpenShare contract v2 items served by a share
//                      (`{items:[{type,sessionID,data}]}`; also `data`)
//   - opencode export  what `opencode export` prints and `opencode import`
//                      reads: `{info, messages:[{info, parts}]}` (v1 host)
//   - local viewer     (view-export.py) — not handled here
//
// Commands
//   export <share-url|file...> [-o DIR] [--share]
//       share / export  ->  one `opencode import`-ready JSON per session
//       (--share also writes each session's envelope slice)
//   pack <export...> [-o FILE]
//       opencode export(s)  ->  one share envelope (for publishing/viewing)
//   import <file...> [--dry]
//       run `opencode import` for every session in the file(s)
//
// Usage examples
//   node tools/osh-session.mjs export https://host/s/<id> -o ./out
//   node tools/osh-session.mjs pack ./main.json ./child.json -o ./session.share.json
//   node tools/osh-session.mjs import ./out/ses_abc.json
//
// No dependencies: plain Node 18+ (fetch, fs/promises).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, resolve, basename, dirname } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

// ---- shared maps: the viewer speaks "shell"/"subagent"/"path"/"agent",
// ---- the v1 host speaks "bash"/"task"/"filePath"/"subagent_type".
// ---- Input keys are PER TOOL: read/write/edit take `filePath` in v1 while
// ---- glob/grep/list take a directory `path` — a global map silently
// ---- rewrote grep's real `path` into `filePath` (roundtrip test caught it).
const TO_V2_NAME = { bash: "shell", task: "subagent" }
const TO_V1_NAME = { shell: "bash", subagent: "task" }

// Range language: a snippet or diff hunk from inside an html file's
// script/style block tokenizes as untyped soup under the html grammar when
// it carries no tag context. The stamp carries the language of the RANGE
// (viewer forwards it to pierre as an explicit language override). Sniffs
// clean source text only: for reads the preview/display content, never the
// raw v1 output whose <path> header reads as an html tag; for edits the
// hunk body with its diff markers stripped.
function refineRangeLanguage(meta, ext, clean) {
  if (!clean || (meta.language && meta.language !== "html")) return false
  if (ext !== "html" && ext !== "htm") return false
  const head = String(clean).slice(0, 4000)
  if (/<[a-zA-Z][^>\n]*>/.test(head)) return false
  if (/^[ \t]*[.#][A-Za-z][\w-]*[^\n{]*\{/m.test(head) && !/\b(function|=>|return)\b/.test(head)) {
    meta.language = "css"
  } else if (/\b(function|const|let|var|return|if|for|while|=>|addEventListener|document\.|window\.)\b/.test(head) || /[;{}]\s*$/m.test(head)) {
    meta.language = "javascript"
  } else {
    return false
  }
  return true
}

function extOf(p) {
  const s = String(p ?? "")
  return s.includes(".") ? s.split(".").pop().toLowerCase() : ""
}

function readCleanText(meta, output) {
  return (typeof meta.preview === "string" && meta.preview) || (typeof meta.display?.text === "string" && meta.display.text) || String(output ?? "").replace(/^<path>[^]*?<\/path>\s*/i, "")
}

function patchBody(patchText) {
  const at = String(patchText ?? "").indexOf("@@")
  if (at < 0) return ""
  return String(patchText)
    .slice(at)
    .split("\n")
    .map((l) => (/^[ +\\]/.test(l) ? l.slice(1) : l.startsWith("-") ? l.slice(1) : ""))
    .join("\n")
}
const FILEPATH_TOOLS = new Set(["read", "write", "edit", "multiedit", "patch"])
const inputV1toV2 = (tool, input) => {
  if (!input || typeof input !== "object") return input
  if (tool === "task" && "subagent_type" in input) return { ...(input.subagent_type !== undefined ? { agent: input.subagent_type } : {}), ...Object.fromEntries(Object.entries(input).filter(([k]) => k !== "subagent_type")) }
  if (FILEPATH_TOOLS.has(tool) && "filePath" in input) return { ...Object.fromEntries(Object.entries(input).filter(([k]) => k !== "filePath")), path: input.filePath }
  return input
}
const inputV2toV1 = (tool, input) => {
  if (!input || typeof input !== "object") return input
  if ((tool === "task" || tool === "subagent") && "agent" in input && !("subagent_type" in input)) {
    return { ...Object.fromEntries(Object.entries(input).filter(([k]) => k !== "agent")), subagent_type: input.agent }
  }
  if (FILEPATH_TOOLS.has(tool) && "path" in input && !("filePath" in input)) {
    return { ...Object.fromEntries(Object.entries(input).filter(([k]) => k !== "path")), filePath: input.path }
  }
  return input
}

const sortKey = (m) => [Number(m?.time?.created ?? 0), String(m?.id ?? "")]

/** Normalize any accepted input into an array of contract items. */
export function itemsFromValue(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.items)) return value.items
  if (Array.isArray(value?.data)) return value.data
  if (value?.info && Array.isArray(value?.messages)) return envelopeFromExports([value])
  throw new Error("unrecognized session data: expected a share envelope or an `opencode export` JSON")
}

/** opencode export shape -> contract items (one envelope per export family). */
export function envelopeFromExports(exports) {
  const items = []
  for (const exp of exports) {
    const info = exp.info ?? {}
    const sessionID = String(info.id ?? "")
    if (!sessionID) continue
    items.push({ type: "session", sessionID, data: info })
    let modelItem
    for (const msg of exp.messages ?? []) {
      const minfo = msg?.info ?? {}
      const id = String(minfo.id ?? "")
      if (!id) continue
      const time = { created: Number(minfo?.time?.created ?? 0) }
      if (minfo.role === "user") {
        const text = (msg.parts ?? [])
          .filter((p) => p?.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join("\n")
        const metadata = {}
        if (minfo.agent !== undefined) metadata.agent = String(minfo.agent)
        if (minfo.model) metadata.model = { id: String(minfo.model.modelID ?? ""), providerID: String(minfo.model.providerID ?? "") }
        items.push({ type: "message", sessionID, data: { id, type: "user", time, text, metadata } })
        continue
      }
      if (minfo.role !== "assistant") continue
      const content = []
      let cost = Number(minfo.cost ?? 0)
      let tokens
      for (const p of msg.parts ?? []) {
        if (p?.type === "text") {
          content.push({ type: "text", text: String(p.text ?? "") })
        } else if (p?.type === "reasoning") {
          const rt = p.time ?? {}
          content.push({ type: "reasoning", text: String(p.text ?? ""), time: { created: rt.start, completed: rt.end } })
        } else if (p?.type === "tool") {
          const st = p.state ?? {}
          const tt = st.time ?? {}
          // range language stamps (see refineRangeLanguage above); applied to
          // the metadata object that the normalized state carries below
          const meta = { ...(st.metadata ?? {}) }
          {
            const rawPath = String(st.input?.filePath ?? st.input?.path ?? "")
            if (String(p.tool ?? "") === "read" && st.status === "completed") {
              refineRangeLanguage(meta, extOf(rawPath), readCleanText(meta, st.output))
            } else if ((String(p.tool ?? "") === "edit" || String(p.tool ?? "") === "patch")) {
              const pt = typeof meta.diff === "string" ? meta.diff : typeof meta.filediff?.patch === "string" ? meta.filediff.patch : ""
              refineRangeLanguage(meta, extOf(rawPath), patchBody(pt))
            }
          }
          // v2 state shape, mirroring the plugin's normalizeToolState
          // (share-plugin/src/contract.ts): the kit reads state.content, not
          // the v1 state.output string, and state.error as {type,message}
          const status = String(st.status ?? "pending")
          const input = inputV1toV2(String(p.tool ?? ""), st.input) ?? {}
          let stOut
          if (status === "completed") {
            const out = typeof st.output === "string" && st.output ? st.output : " "
            stOut = { status: "completed", input, content: [{ type: "text", text: out }], metadata: meta, ...(Array.isArray(st.attachments) && st.attachments.length ? { attachments: st.attachments } : {}) }
          } else if (status === "error") {
            stOut = { status: "error", input, error: { type: "unknown", message: typeof st.error === "string" ? st.error : String(st.error?.message ?? "tool failed") }, metadata: meta }
          } else if (status === "running") {
            stOut = { status: "running", input, metadata: meta }
          } else {
            stOut = { status: "streaming", input: typeof st.raw === "string" ? st.raw : JSON.stringify(input) }
          }
          content.push({
            type: "tool",
            id: String(p.id ?? ""),
            name: TO_V2_NAME[String(p.tool ?? "")] ?? String(p.tool ?? "unknown"),
            state: stOut,
            time: { created: tt.start, completed: tt.end },
          })
        } else if (p?.type === "step-finish") {
          if (typeof p.cost === "number") cost += p.cost
          if (p.tokens && typeof p.tokens === "object") tokens = p.tokens
        }
      }
      const model = { id: String(minfo.modelID ?? ""), providerID: String(minfo.providerID ?? "") }
      if (!modelItem && model.id) modelItem = { id: model.id, providerID: model.providerID, name: minfo.modelID }
      const message = {
        id,
        type: "assistant",
        agent: String(minfo.agent ?? "build"),
        model,
        parentID: minfo.parentID,
        time: {
          created: Number(minfo?.time?.created ?? 0),
          streamed: minfo?.time?.started,
          completed: minfo?.time?.completed,
        },
        content,
        cost,
        ...(tokens ? { tokens } : {}),
        ...(minfo.finish ? { finish: String(minfo.finish) } : {}),
        ...(minfo.error
          ? { error: { type: String(minfo.error.name ?? "UnknownError"), message: String(minfo.error.message ?? "turn failed") } }
          : {}),
      }
      items.push({ type: "message", sessionID, data: message })
    }
    if (modelItem) items.push({ type: "model", sessionID, data: [modelItem] })
  }
  return items
}

/** contract items -> opencode export for ONE session (import-ready). */
export function exportFromItems(items, sessionID) {
  const session = items.find((it) => it.type === "session" && (it.sessionID === sessionID || it.data?.id === sessionID))
  if (!session) throw new Error(`session ${sessionID} not present in the data`)
  const messages = items
    .filter((it) => it.type === "message" && !it.del && (it.sessionID === sessionID || it.data?.sessionID === sessionID))
    .map((it) => it.data)
    .sort((a, b) => {
      const [ta, ia] = sortKey(a)
      const [tb, ib] = sortKey(b)
      return ta - tb || (ia < ib ? -1 : ia > ib ? 1 : 0)
    })
  const out = []
  let lastUser = ""
  // the v1 User schema requires a model; fall back to the session's first
  // assistant model when the prompt metadata carries none
  const fallbackModel = messages.find((m) => m.type === "assistant" && m.model?.id)?.model ?? { id: "", providerID: "" }
  const modelOf = (model) => ({ providerID: String(model?.providerID ?? fallbackModel.providerID ?? ""), modelID: String(model?.id ?? model?.modelID ?? fallbackModel.id ?? "") })
  for (const m of messages) {
    const id = String(m.id ?? "")
    const created = Number(m?.time?.created ?? 0)
    if (m.type === "user") lastUser = id
    // opencode ids are typed: sessions `ses_`, messages `msg_`, parts `prt_`
    const pid = (suffix) => `prt_${id.replace(/^msg_/, "")}_${suffix}`
    if (m.type === "user") {
      const parts = [{ id: pid("text"), sessionID, messageID: id, type: "text", text: String(m.text ?? ""), time: { start: created, end: created } }]
      for (const [i, f] of (m.files ?? []).entries()) {
        parts.push({ id: pid(`f${i}`), sessionID, messageID: id, type: "file", filename: String(f?.name ?? f?.filename ?? "file"), url: String(f?.url ?? "") })
      }
      const info = {
        id,
        sessionID,
        role: "user",
        time: { created },
        agent: String(m.metadata?.agent ?? "build"),
        model: modelOf(m.metadata?.model),
      }
      out.push({ info, parts })
      continue
    }
    if (m.type !== "assistant") continue
    const parts = []
    for (const [i, c] of (m.content ?? []).entries()) {
      if (c?.type === "text") {
        parts.push({ id: pid(`p${i}`), sessionID, messageID: id, type: "text", text: String(c.text ?? "") })
      } else if (c?.type === "reasoning") {
        parts.push({
          id: pid(`p${i}`),
          sessionID,
          messageID: id,
          type: "reasoning",
          text: String(c.text ?? ""),
          time: { start: c?.time?.created, end: c?.time?.completed },
        })
      } else if (c?.type === "tool") {
        const st = c.state ?? {}
        const tt = c?.time ?? st?.time ?? {}
        const start = Number(tt.created ?? st?.time?.start ?? created)
        const end = Number(tt.completed ?? st?.time?.end ?? start)
        const status = st.status === "running" || st.status === "pending" || st.status === "error" ? st.status : "completed"
        // v1 states are a strict union; each variant has its own required
        // fields (completed: output+title+metadata+time, error: error, ...)
        const outputText = typeof st.output === "string" ? st.output : st.output && typeof st.output === "object" && typeof st.output.text === "string" ? st.output.text : st.output == null ? "" : JSON.stringify(st.output)
        const toolState =
          status === "completed"
            ? { status, input: inputV2toV1(String(c.name ?? ""), st.input) ?? {}, output: outputText, title: String(st.title ?? ""), metadata: st.metadata ?? {}, time: { start, end } }
            : status === "error"
              ? { status, input: inputV2toV1(String(c.name ?? ""), st.input) ?? {}, error: String(st.error?.message ?? st.error ?? "failed"), metadata: st.metadata ?? {}, time: { start, end } }
              : status === "running"
                ? { status, input: inputV2toV1(String(c.name ?? ""), st.input) ?? {}, title: String(st.title ?? ""), metadata: st.metadata ?? {}, time: { start } }
                : { status, input: inputV2toV1(String(c.name ?? ""), st.input) ?? {}, raw: String(st.raw ?? "") }
        // range language stamps (see refineRangeLanguage above); the v1
        // export highlights meta.preview, so sniff the clean content, never
        // the raw v1-shaped output whose <path> header reads as an html tag
        {
          const meta = toolState.metadata
          const p = String(toolState.input?.filePath ?? toolState.input?.path ?? "")
          if (String(c.name ?? "") === "read" && status === "completed" && outputText) {
            refineRangeLanguage(meta, extOf(p), readCleanText(meta, outputText))
          } else if (String(c.name ?? "") === "edit" || String(c.name ?? "") === "patch") {
            const pt = typeof meta.diff === "string" ? meta.diff : typeof meta.filediff?.patch === "string" ? meta.filediff.patch : ""
            refineRangeLanguage(meta, extOf(p), patchBody(pt))
          }
        }
        parts.push({
          id: String(c.id || pid(`p${i}`)),
          sessionID,
          messageID: id,
          type: "tool",
          callID: String(c.id || pid(`p${i}`)),
          tool: TO_V1_NAME[String(c.name ?? "")] ?? String(c.name ?? "unknown"),
          state: toolState,
        })
      }
    }
    const info = {
      id,
      sessionID,
      role: "assistant",
      time: { created, completed: m?.time?.completed ?? created },
      parentID: String(m.parentID ?? lastUser ?? id),
      agent: String(m.agent ?? "build"),
      mode: String(m.mode ?? "build"),
      modelID: modelOf(m.model).modelID,
      providerID: modelOf(m.model).providerID,
      // v1 requires every token counter to be a number, cache included
      path: { cwd: "", root: "" },
      cost: Number(m.cost ?? 0),
      tokens: {
        ...(typeof m.tokens?.total === "number" ? { total: m.tokens.total } : {}),
        input: Number(m.tokens?.input ?? 0),
        output: Number(m.tokens?.output ?? 0),
        reasoning: Number(m.tokens?.reasoning ?? 0),
        cache: { read: Number(m.tokens?.cache?.read ?? 0), write: Number(m.tokens?.cache?.write ?? 0) },
      },
      ...(m.finish ? { finish: String(m.finish) } : {}),
      ...(m.error ? { error: { name: String(m.error.type ?? "UnknownError"), message: String(m.error.message ?? "") } } : {}),
    }
    out.push({ info, parts })
  }
  const updated = messages.reduce((max, m) => Math.max(max, Number(m?.time?.completed ?? m?.time?.created ?? 0)), 0)
  const info = { ...session.data, id: sessionID }
  info.time = { created: Number(info?.time?.created ?? updated ?? 0), updated: updated || Number(info?.time?.updated ?? 0) }
  return { info, messages: out }
}

export function sessionIDs(items) {
  return [...new Set(items.filter((it) => it.type === "session").map((it) => String(it.data?.id ?? it.sessionID)))].filter(Boolean)
}

// ---- CLI ------------------------------------------------------------------
const isUrl = (s) => /^https?:\/\//i.test(s)

async function loadInput(source) {
  if (isUrl(source)) {
    const u = new URL(source)
    const tail = u.pathname.split("/").filter(Boolean)
    const id = tail[0] === "s" ? tail[1] : tail[tail.length - 1] === "data" ? tail[tail.length - 2] : tail[tail.length - 1]
    const url = /\/api\/share\/[0-9a-f]+\/data$/i.test(u.pathname) ? u.href : `${u.origin}/api/share/${id}/data`
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status} ${res.statusText} (gated shares need the viewer password; download the data from an authenticated session)`)
    return JSON.parse(await res.text())
  }
  const path = resolve(source)
  if (!existsSync(path)) throw new Error(`no such file: ${source}`)
  return JSON.parse(readFileSync(path, "utf8"))
}

async function cmdExport(args) {
  const outIdx = args.indexOf("-o")
  const outdir = outIdx >= 0 ? resolve(args[outIdx + 1]) : resolve(".")
  const wantShare = args.includes("--share")
  const sources = args.filter((a, i) => !a.startsWith("-") && a !== "export" && (outIdx < 0 || i !== outIdx + 1))
  mkdirSync(outdir, { recursive: true })
  const written = []
  for (const src of sources) {
    const value = await loadInput(src)
    const items = itemsFromValue(value)
    for (const sid of sessionIDs(items)) {
      const exp = exportFromItems(items, sid)
      const file = join(outdir, `${sid}.json`)
      writeFileSync(file, JSON.stringify(exp, null, 1))
      written.push(file)
      if (wantShare) {
        const slice = items.filter((it) => it.sessionID === sid || it.data?.id === sid)
        writeFileSync(join(outdir, `${sid}.share.json`), JSON.stringify({ v: 2, items: slice }, null, 1))
      }
      console.log(`${sid}  ${exp.messages.length} messages  -> ${file}`)
    }
  }
  if (written.length === 0) throw new Error("nothing exported")
  return written
}

function cmdPack(args) {
  const outIdx = args.indexOf("-o")
  const outfile = outIdx >= 0 ? resolve(args[outIdx + 1]) : resolve("session.share.json")
  const sources = args.filter((a, i) => !a.startsWith("-") && a !== "pack" && (outIdx < 0 || i !== outIdx + 1))
  const exports = sources.map((s) => JSON.parse(readFileSync(resolve(s), "utf8")))
  const items = envelopeFromExports(exports)
  writeFileSync(outfile, JSON.stringify({ v: 2, items }, null, 1))
  console.log(`${exports.length} session(s)  ${items.length} items  -> ${outfile}`)
}

function cmdImport(args) {
  const dry = args.includes("--dry")
  const sources = args.filter((a) => !a.startsWith("-") && a !== "import")
  for (const src of sources) {
    const value = JSON.parse(readFileSync(resolve(src), "utf8"))
    const items = itemsFromValue(value)
    for (const sid of sessionIDs(items)) {
      const exp = exportFromItems(items, sid)
      const tmp = join(process.env.TEMP ?? "/tmp", `osh-import-${sid}.json`)
      writeFileSync(tmp, JSON.stringify(exp))
      if (dry) {
        console.log(`would import ${sid} (${exp.messages.length} messages) from ${tmp}`)
        continue
      }
      const r = spawnSync("opencode", ["import", tmp], { encoding: "utf8", shell: process.platform === "win32" })
      const ok = r.status === 0
      console.log(`${ok ? "imported" : "FAILED "} ${sid}  ${(r.stdout ?? "").trim().split("\n").pop() ?? ""}${r.stderr ? ` ${r.stderr.trim().split("\n").pop()}` : ""}`)
      if (!ok) process.exitCode = 1
    }
  }
}

// run the CLI only when executed directly (tests import the functions)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2)
  try {
    if (cmd === "export") await cmdExport(rest)
    else if (cmd === "pack") cmdPack(rest)
    else if (cmd === "import") cmdImport(rest)
    else {
      console.log(`usage: osh-session <export|pack|import> ...  (see the header of ${basename(process.argv[1])})`)
      process.exitCode = 1
    }
  } catch (e) {
    console.error(`error: ${e?.message ?? e}`)
    process.exitCode = 1
  }
}
