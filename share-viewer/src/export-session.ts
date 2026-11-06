// Export the session being viewed as an `opencode import`-ready JSON file.
// This is the client-side half of the interchange tools (tools/osh-session.mjs):
// same shape, so a downloaded file imports straight into a local opencode.
//
// The v1 import schema is strict (typed ids, per-variant tool states, every
// token counter present), so every field below is shaped deliberately:
// `ses_`/`msg_`/`prt_` ids, completed/error/running/pending tool states, and
// a zero-filled token record when the share carries none.

type AnyRecord = Record<string, any>

const TO_V1_NAME: Record<string, string> = { shell: "bash", subagent: "task" }
// per-tool input keys: read/write/edit take `filePath` in v1 while
// glob/grep/list take a directory `path` — a global map rewrote grep's
// real `path` into `filePath` (caught by the interchange roundtrip test)
const FILEPATH_TOOLS = new Set(["read", "write", "edit", "multiedit", "patch"])

/**
 * Translate viewer-canonical tool input keys back to v1 names.
 *
 * @param tool  v1 tool name (bash/task/read/...)
 * @param input tool input record as stored in the share
 */
const inputV2toV1 = (tool: string, input: unknown): AnyRecord => {
  if (!input || typeof input !== "object") return {}
  const rec = input as AnyRecord
  if ((tool === "task" || tool === "subagent") && "agent" in rec && !("subagent_type" in rec)) {
    const { agent, ...rest } = rec
    return { ...rest, subagent_type: agent }
  }
  if (FILEPATH_TOOLS.has(tool) && "path" in rec && !("filePath" in rec)) {
    const { path, ...rest } = rec
    return { ...rest, filePath: path }
  }
  return rec
}

/**
 * Build the `{info, messages}` document for one session.
 *
 * @param items   contract items as served by `/data` (session/message/model/...)
 * @param sessionID  which session to export
 * @returns an object accepted by `opencode import <file>`
 */
export function exportSessionDocument(items: AnyRecord[], sessionID: string): { info: AnyRecord; messages: AnyRecord[] } {
  const session = items.find((it) => it.type === "session" && (it.sessionID === sessionID || it.data?.id === sessionID))
  if (!session) throw new Error(`session ${sessionID} is not in this share`)
  const messages = items
    .filter((it) => it.type === "message" && !it.del && (it.sessionID === sessionID || it.data?.sessionID === sessionID))
    .map((it) => it.data as AnyRecord)
  return convertSession(String(session.data?.id ?? sessionID), session.data as AnyRecord, messages)
}

/**
 * Build the document from the viewer's folded data (what the page renders).
 *
 * @param data      the folded share data (`session` list + per-session `message`)
 * @param sessionID which session to export
 */
export function exportSessionFromShare(data: { session: AnyRecord[]; message: Record<string, AnyRecord[]> }, sessionID: string): { info: AnyRecord; messages: AnyRecord[] } {
  const info = data.session.find((s) => String(s?.id) === sessionID)
  if (!info) throw new Error(`session ${sessionID} is not in this share`)
  return convertSession(sessionID, info, data.message[sessionID] ?? [])
}

/** Shared converter: session info + ordered messages -> import document. */
function convertSession(sessionID: string, sessionInfo: AnyRecord, input: AnyRecord[]) {
  const messages = [...input].sort((a, b) => {
    const ta = Number(a?.time?.created ?? 0)
    const tb = Number(b?.time?.created ?? 0)
    return ta - tb || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)
  })
  const session = { data: sessionInfo, sessionID }

  const fallbackModel = messages.find((m) => m.type === "assistant" && m.model?.id)?.model ?? { id: "", providerID: "" }
  const modelOf = (model: AnyRecord | undefined) => ({
    providerID: String(model?.providerID ?? fallbackModel.providerID ?? ""),
    modelID: String(model?.id ?? model?.modelID ?? fallbackModel.id ?? ""),
  })

  const out: AnyRecord[] = []
  let lastUser = ""
  for (const m of messages) {
    const id = String(m.id ?? "")
    const created = Number(m?.time?.created ?? 0)
    const pid = (suffix: string) => `prt_${id.replace(/^msg_/, "")}_${suffix}`
    if (m.type === "user") {
      lastUser = id
      const parts: AnyRecord[] = [
        { id: pid("text"), sessionID, messageID: id, type: "text", text: String(m.text ?? ""), time: { start: created, end: created } },
      ]
      for (const [i, f] of (m.files ?? []).entries()) {
        parts.push({ id: pid(`f${i}`), sessionID, messageID: id, type: "file", filename: String(f?.name ?? f?.filename ?? "file"), url: String(f?.url ?? "") })
      }
      out.push({
        info: { id, sessionID, role: "user", time: { created }, agent: String(m.metadata?.agent ?? "build"), model: modelOf(m.metadata?.model) },
        parts,
      })
      continue
    }
    if (m.type !== "assistant") continue
    const parts: AnyRecord[] = []
    for (const [i, c] of (m.content ?? []).entries()) {
      if (c?.type === "text") {
        parts.push({ id: pid(`p${i}`), sessionID, messageID: id, type: "text", text: String(c.text ?? "") })
      } else if (c?.type === "reasoning") {
        parts.push({ id: pid(`p${i}`), sessionID, messageID: id, type: "reasoning", text: String(c.text ?? ""), time: { start: c?.time?.created, end: c?.time?.completed } })
      } else if (c?.type === "tool") {
        const st: AnyRecord = c.state ?? {}
        const tt: AnyRecord = c?.time ?? st?.time ?? {}
        const start = Number(tt.created ?? st?.time?.start ?? created)
        const end = Number(tt.completed ?? st?.time?.end ?? start)
        const status = st.status === "running" || st.status === "pending" || st.status === "error" ? st.status : "completed"
        const output =
          typeof st.output === "string" ? st.output : st.output && typeof st.output === "object" && typeof st.output.text === "string" ? st.output.text : st.output == null ? "" : JSON.stringify(st.output)
        const toolName = TO_V1_NAME[String(c.name ?? "")] ?? String(c.name ?? "unknown")
        const input = inputV2toV1(toolName, st.input)
        const state =
          status === "completed"
            ? { status, input, output, title: String(st.title ?? ""), metadata: st.metadata ?? {}, time: { start, end } }
            : status === "error"
              ? { status, input, error: String(st.error?.message ?? st.error ?? "failed"), metadata: st.metadata ?? {}, time: { start, end } }
              : status === "running"
                ? { status, input, title: String(st.title ?? ""), metadata: st.metadata ?? {}, time: { start } }
                : { status, input, raw: String(st.raw ?? "") }
        parts.push({ id: String(c.id || pid(`p${i}`)), sessionID, messageID: id, type: "tool", callID: String(c.id || pid(`p${i}`)), tool: toolName, state })
      }
    }
    const model = modelOf(m.model)
    out.push({
      info: {
        id,
        sessionID,
        role: "assistant",
        time: { created, completed: m?.time?.completed ?? created },
        parentID: String(m.parentID ?? lastUser ?? id),
        agent: String(m.agent ?? "build"),
        mode: String(m.mode ?? "build"),
        modelID: model.modelID,
        providerID: model.providerID,
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
      },
      parts,
    })
  }
  const updated = messages.reduce((max, m) => Math.max(max, Number(m?.time?.completed ?? m?.time?.created ?? 0)), 0)
  const info: AnyRecord = { ...session.data, id: sessionID }
  info.time = { created: Number(info?.time?.created ?? updated ?? 0), updated: updated || Number(info?.time?.updated ?? 0) }
  return { info, messages: out }
}

/** Browser download of the export document, named after the session title. */
export function downloadSessionExport(data: { session: AnyRecord[]; message: Record<string, AnyRecord[]> }, sessionID: string, title: string | undefined) {
  const doc = exportSessionFromShare(data, sessionID)
  const safe = String(title ?? sessionID).replace(/[^\w.\- ]+/g, "").trim().slice(0, 60) || sessionID
  const blob = new Blob([JSON.stringify(doc, null, 1)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `${safe}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
