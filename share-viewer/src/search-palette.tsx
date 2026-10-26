// The header search palette (owner round 2026-10-26): a floating,
// animated search over the loaded session - prompts, responses,
// thinking and tool text, with toggleable scope chips. It renders the
// button AND the palette; both classic chrome and SkinHeader mount it
// left of the copy-markdown trigger. Data comes from the shared
// SessionSection model (useSessionSections), so classic and every skin
// search the same index. The nav lists' filter stays the simple
// prompts-only hide-non-matching mechanism.
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import type { SessionSection } from "./views/session-data"

type Scope = "prompts" | "responses" | "thinking" | "tools"
const SCOPES: Scope[] = ["prompts", "responses", "thinking", "tools"]

type Hit = { sectionId: string; turn: number; scope: Scope; line: string; at: number }

/** the searchable text of one section per scope */
function scopeTexts(s: SessionSection): Partial<Record<Scope, string>> {
  const toolText = s.tools
    .map((t) => `${t.tool} ${t.title} ${t.output ?? ""} ${safeJson(t.input)}`)
    .join("\n")
  return {
    prompts: s.prompt,
    responses: s.response,
    thinking: s.reasoning.map((r) => r.text).join("\n"),
    tools: toolText,
  }
}
const safeJson = (v: unknown) => {
  if (!v) return ""
  try {
    return typeof v === "string" ? v : JSON.stringify(v)
  } catch {
    return ""
  }
}

export function SearchControl(props: {
  sections: () => SessionSection[]
  onJump: (sectionId: string) => void
  class?: string
}) {
  const [open, setOpen] = createSignal(false)
  const [q, setQ] = createSignal("")
  const [scopes, setScopes] = createSignal<Set<Scope>>(new Set(SCOPES))
  const [sel, setSel] = createSignal(0)
  let inputEl: HTMLInputElement | undefined

  const hits = createMemo<Hit[]>(() => {
    const query = q().trim().toLowerCase()
    if (!query) return []
    const active = scopes()
    const out: Hit[] = []
    for (const s of props.sections()) {
      const texts = scopeTexts(s)
      for (const scope of SCOPES) {
        if (!active.has(scope)) continue
        const text = texts[scope]
        if (!text) continue
        const at = text.toLowerCase().indexOf(query)
        if (at >= 0) out.push({ sectionId: s.id, turn: s.index + 1, scope, line: text, at })
      }
    }
    return out.slice(0, 60)
  })
  createEffect(() => {
    hits()
    setSel(0)
  })

  const toggle = (s: Scope) => {
    setScopes((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }

  const jump = (h: Hit) => {
    props.onJump(h.sectionId)
    setOpen(false)
  }

  const onKey = (e: KeyboardEvent) => {
    if (!open()) {
      // "/" opens (when not already typing somewhere)
      if (e.key === "/" && !(e.target as HTMLElement)?.closest?.("input, textarea, [contenteditable]")) {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    if (e.key === "Escape") {
      setOpen(false)
      return
    }
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault()
      setSel((i) => Math.min(i + 1, hits().length - 1))
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault()
      setSel((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      const h = hits()[sel()]
      if (h) {
        e.preventDefault()
        jump(h)
      }
    }
  }
  onMount(() => window.addEventListener("keydown", onKey))
  onCleanup(() => window.removeEventListener("keydown", onKey))
  createEffect(() => {
    if (open()) queueMicrotask(() => inputEl?.focus())
    else setQ("")
  })
  onCleanup(() => setOpen(false))

  // snippet: window around the match, match wrapped in <mark>
  const Snippet = (h: Hit) => {
    const text = h.line.replace(/\s+/g, " ")
    const start = Math.max(0, h.at - 48)
    const line = text.slice(start, start + 140)
    const rel = h.at - start
    const head = line.slice(0, rel)
    const needle = q().trim()
    const match = line.slice(rel, rel + needle.length)
    const tail = line.slice(rel + needle.length)
    return (
      <span class="text-12-regular text-text-weak truncate">
        {start > 0 ? "…" : ""}
        {head}
        <mark class="bg-transparent text-text-strong font-medium">{match}</mark>
        {tail}
      </span>
    )
  }

  return (
    <>
      <button
        type="button"
        class={`flex items-center justify-center size-6 rounded text-text-weaker hover:text-text-base hover:bg-surface-base bg-transparent border-none cursor-pointer ${props.class ?? ""}`}
        onClick={() => setOpen(true)}
        title="search the session (/)"
        aria-label="search session"
      >
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5" />
          <line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>
      <Show when={open()}>
        <Portal mount={document.body}>
          <div class="fixed inset-0 z-[80]" onClick={() => setOpen(false)}>
            <div
              class="osh-search-palette absolute left-1/2 top-14 -translate-x-1/2 w-[min(36rem,calc(100vw-2rem))] rounded-xl border border-border-weak-base bg-background-base shadow-2xl overflow-hidden"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-label="search session"
            >
              <div class="flex items-center gap-2 px-3 h-11 border-b border-border-weak-base/60">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" class="shrink-0 text-text-weaker" aria-hidden="true">
                  <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5" />
                  <line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                </svg>
                <input
                  ref={inputEl}
                  type="text"
                  value={q()}
                  onInput={(e) => setQ(e.currentTarget.value)}
                  placeholder="search prompts, responses, thinking, tools…"
                  class="flex-1 bg-transparent border-none outline-none text-14-regular text-text-base placeholder:text-text-weaker"
                  aria-label="search query"
                />
                <Show when={q()}>
                  <span class="text-10-mono text-text-weaker shrink-0">{hits().length} hits</span>
                </Show>
              </div>
              <div class="flex items-center gap-1.5 px-3 py-2 border-b border-border-weak-base/60">
                <For each={SCOPES}>
                  {(s) => (
                    <button
                      type="button"
                      class="px-2 py-0.5 rounded-full border text-11-regular cursor-pointer transition-colors duration-150"
                      classList={{
                        "border-icon-strong-base/60 text-text-strong bg-surface-base": scopes().has(s),
                        "border-border-weak-base text-text-weaker bg-transparent hover:text-text-base": !scopes().has(s),
                      }}
                      onClick={() => toggle(s)}
                      aria-pressed={scopes().has(s)}
                    >
                      {s}
                    </button>
                  )}
                </For>
              </div>
              <div class="max-h-[46vh] overflow-y-auto osh-thin-scroll p-1.5" role="listbox" aria-label="search results">
                <Show
                  when={q().trim()}
                  fallback={
                    <div class="px-2 py-3 text-12-regular text-text-weaker text-center">
                      type to search - <span class="text-text-weak">↑↓</span> walk results, <span class="text-text-weak">↵</span> jump, <span class="text-text-weak">esc</span> close
                    </div>
                  }
                >
                  <Show
                    when={hits().length}
                    fallback={<div class="px-2 py-3 text-12-regular text-text-weaker text-center">no matches</div>}
                  >
                    <For each={hits()}>
                      {(h, i) => (
                        <button
                          type="button"
                          role="option"
                          aria-selected={sel() === i()}
                          class="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md border-none cursor-pointer text-left bg-transparent hover:bg-surface-base"
                          classList={{ "bg-surface-raised-base": sel() === i() }}
                          onClick={() => jump(h)}
                          onMouseEnter={() => setSel(i())}
                        >
                          <span class="text-11-mono text-text-weaker w-[2ch] shrink-0 tabular-nums text-right">{h.turn}</span>
                          <span class="min-w-0 flex-1 truncate">
                            <Snippet {...h} />
                          </span>
                          <span class="text-10-mono text-text-weaker shrink-0">{h.scope}</span>
                        </button>
                      )}
                    </For>
                  </Show>
                </Show>
              </div>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  )
}
