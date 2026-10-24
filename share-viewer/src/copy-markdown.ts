// Copy the session as markdown (owner round 2026-10-25, views-SDK phase 4:
// moved out of app.tsx so the ViewContext and every skin header can offer
// it - classic used to be the only surface with the affordance).
import type { ShareData } from "./fold"
import { visibleMessages } from "./fold"

export async function copySessionMarkdown(data: ShareData, sessionID: string) {
  const info = data.session.find((s: any) => s.id === sessionID) as any
  const modelLabel = data.model[sessionID]?.[0]?.name ?? data.model[sessionID]?.[0]?.id ?? ""
  const parts: string[] = [
    `# ${info?.title ?? sessionID}`,
    "",
    `_model: ${modelLabel || "?"} · v${info?.version ?? "?"} · ${info?.directory ?? ""}_`,
    "",
  ]
  const toolOutputText = (state: any): string => {
    // our v1 normalization emits content[]; v2 hosts may emit output
    for (const key of ["content", "output"]) {
      const v = state?.[key]
      if (typeof v === "string") return v
      if (Array.isArray(v)) {
        const text = v.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("")
        if (text) return text
      }
    }
    return ""
  }
  for (const m of visibleMessages(data, sessionID)) {
    const msg = m as any
    if (msg?.type === "user") {
      if (msg.text) parts.push("## user", "", msg.text, "")
      continue
    }
    if (msg?.type === "compaction") {
      parts.push("> _compaction — session summarized_", "", String(msg.summary ?? ""), "")
      continue
    }
    if (msg?.type !== "assistant") continue
    parts.push("## assistant", "")
    for (const c of msg.content ?? []) {
      if (c?.type === "text" && c.text) parts.push(c.text, "")
      else if (c?.type === "reasoning" && c.text) parts.push("<details><summary>thinking</summary>", "", c.text, "", "</details>", "")
      else if (c?.type === "tool") {
        const st = c.state ?? {}
        const input = st.input ?? {}
        const inv =
          [input.query, input.command, input.prompt, input.pattern, input.path, input.description]
            .find((v: unknown) => typeof v === "string" && v.trim()) ??
          (c.name === "subagent" && Array.isArray(input.prompts) ? String(input.prompts[0] ?? "") : "")
        let out = toolOutputText(st)
        if (c.name === "subagent") out = ""
        if (out.length > 600) out = out.slice(0, 600) + "—"
        parts.push(`> _tool: ${c.name ?? "tool"}${inv ? ` — ${String(inv).slice(0, 120)}` : ""}_`, "")
        if (out) parts.push("> ```", out.split("\n").map((l: string) => "> " + l).join("\n"), "> ```", "")
      }
    }
  }
  await navigator.clipboard.writeText(parts.join("\n"))
}
