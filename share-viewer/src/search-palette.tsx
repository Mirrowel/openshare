// The header search palette (owner round 2026-10-26): a floating,
// animated search over the loaded session - prompts, responses,
// thinking and tool text, with scope chips. It renders the button AND
// the palette; both classic chrome and SkinHeader mount it left of the
// copy-markdown trigger. Query/scope/active state lives in
// search-state.ts and PERSISTS after close - marks stay in the page,
// collapsed rows with hits keep expanding as they scroll in, and only
// emptying the query (Esc or the clear button) ends the search.
//
// Centering: the palette sits in a flex-centered wrapper and the entry
// animation only touches opacity/translateY/scale on the inner element
// - the kit's tailwind emits `translate:` (the CSS property) for
// translate utilities, so animating `transform` on a class-centered
// element applied BOTH offsets and the palette landed one width left
// mid-animation (owner-caught).
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import type { SessionSection } from "./views/session-data"
import {
  SEARCH_SCOPES,
  activeHit,
  ensureSearchEngine,
  jumpToHit,
  searchQuery,
  searchScopes,
  setActiveHit,
  setSearchQuery,
  setSearchScopes,
  type SearchHit,
  type SearchScope,
} from "./search-state"

/** the searchable text of one section per scope; part ids ride along so
 *  jumps can target the matched tool/reasoning part, not just the
 *  section */
function scopeHits(s: SessionSection, query: string, active: Set<SearchScope>): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: SearchHit[] = []
  const push = (scope: SearchScope, text: string | undefined, partId?: string) => {
    if (!active.has(scope) || !text) return
    const at = text.toLowerCase().indexOf(q)
    if (at >= 0) out.push({ sectionId: s.id, turn: s.index + 1, scope, partId, line: text.replace(/\s+/g, " "), at })
  }
  push("prompts", s.prompt)
  push("responses", s.response)
  for (const r of s.reasoning) push("thinking", r.text, (r.part as any)?.id)
  for (const t of s.tools) push("tools", `${t.tool} ${t.title} ${t.output ?? ""} ${safeJson(t.input)}`, (t.part as any)?.id)
  return out
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
  smooth?: boolean
  class?: string
}) {
  ensureSearchEngine()
  const [open, setOpen] = createSignal(false)
  const [sel, setSel] = createSignal(0)
  let inputEl: HTMLInputElement | undefined

  const hits = createMemo<SearchHit[]>(() => {
    const q = searchQuery()
    if (!q.trim()) return []
    const active = new Set(searchScopes())
    const out: SearchHit[] = []
    for (const s of props.sections()) out.push(...scopeHits(s, q, active))
    return out.slice(0, 60)
  })
  createEffect(() => {
    hits()
    setSel(0)
  })

  const jump = (h: SearchHit) => {
    setActiveHit(h)
    // jumpToHit is the mechanism (part-targeted, expands, flashes); the
    // section-level onJump runs only when no transcript scroller exists
    if (!jumpToHit(h, props.smooth !== false)) props.onJump(h.sectionId)
  }

  const onKey = (e: KeyboardEvent) => {
    if (!open()) {
      if (e.key === "/" && !(e.target as HTMLElement)?.closest?.("input, textarea, [contenteditable]")) {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    if (e.key === "Escape") {
      // Esc ENDS the search: empties the query (marks clear) and closes
      e.preventDefault()
      setSearchQuery("")
      setOpen(false)
      return
    }
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSel((i) => Math.min(i + 1, hits().length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setSel((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      const h = hits()[sel()]
      if (h) {
        e.preventDefault()
        jump(h)
        setOpen(false)
      }
    }
  }
  onMount(() => window.addEventListener("keydown", onKey))
  onCleanup(() => window.removeEventListener("keydown", onKey))
  createEffect(() => {
    if (open()) queueMicrotask(() => inputEl?.focus())
  })

  // snippet: window around the match, match emphasized
  const Snippet = (h: SearchHit) => {
    const text = h.line
    const start = Math.max(0, h.at - 48)
    const line = text.slice(start, start + 140)
    const rel = h.at - start
    const head = line.slice(0, rel)
    const needle = searchQuery().trim()
    const match = line.slice(rel, rel + needle.length)
    const tail = line.slice(rel + needle.length)
    return (
      <span class="text-12-regular text-text-weak truncate">
        {start > 0 ? "…" : ""}
        {head}
        <span class="text-text-strong font-medium">{match}</span>
        {tail}
      </span>
    )
  }

  const activeMark = () => activeHit()
  void activeMark

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
          {/* outside click CLOSES WITHOUT EMPTYING: marks + query stay */}
          <div class="fixed inset-0 z-[80]" onClick={() => setOpen(false)}>
            {/* centering wrapper: the flex container centers, the inner
                element animates - no translate composition anywhere */}
            <div class="absolute left-0 right-0 top-14 flex justify-center pointer-events-none px-4">
              <div
                class="osh-search-palette pointer-events-auto w-[min(36rem,100%)] rounded-xl border border-border-weak-base bg-background-base shadow-2xl overflow-hidden"
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
                    value={searchQuery()}
                    onInput={(e) => setSearchQuery(e.currentTarget.value)}
                    placeholder="search prompts, responses, thinking, tools…"
                    class="flex-1 bg-transparent border-none outline-none text-14-regular text-text-base placeholder:text-text-weaker"
                    aria-label="search query"
                  />
                  <Show when={searchQuery()}>
                    {/* the clear button: ends the search, keeps the palette */}
                    <button
                      type="button"
                      class="flex items-center justify-center size-5 rounded-full bg-surface-base text-text-weaker hover:text-text-base border-none cursor-pointer shrink-0"
                      title="clear search"
                      aria-label="clear search"
                      onClick={() => {
                        setSearchQuery("")
                        inputEl?.focus()
                      }}
                    >
                      <svg viewBox="0 0 12 12" width="9" height="9" fill="none" aria-hidden="true">
                        <line x1="2.5" y1="2.5" x2="9.5" y2="9.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                        <line x1="9.5" y1="2.5" x2="2.5" y2="9.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                      </svg>
                    </button>
                    <span class="text-10-mono text-text-weaker shrink-0">{hits().length}</span>
                  </Show>
                </div>
                {/* scopes: one segmented container - the settings panel's
                    language, not floating pills */}
                <div class="flex p-0.5 mx-3 my-2 rounded-lg border border-border-weak-base bg-background-stronger">
                  <For each={SEARCH_SCOPES}>
                    {(s) => (
                      <button
                        type="button"
                        class="flex-1 py-1 text-12-regular rounded-md border-none cursor-pointer transition-colors duration-150"
                        classList={{
                          "bg-surface-base-interactive-active text-text-strong": searchScopes().includes(s),
                          "bg-transparent text-text-weaker hover:text-text-base": !searchScopes().includes(s),
                        }}
                        onClick={() => {
                          const cur = new Set(searchScopes())
                          if (cur.has(s)) cur.delete(s)
                          else cur.add(s)
                          setSearchScopes([...cur])
                        }}
                        aria-pressed={searchScopes().includes(s)}
                      >
                        {s}
                      </button>
                    )}
                  </For>
                </div>
                <div class="max-h-[46vh] overflow-y-auto osh-thin-scroll p-1.5" role="listbox" aria-label="search results">
                  <Show
                    when={searchQuery().trim()}
                    fallback={
                      <div class="px-2 py-3 text-12-regular text-text-weaker text-center">
                        type to search - <span class="text-text-weak">↑↓</span> results, <span class="text-text-weak">↵</span> jump, <span class="text-text-weak">esc</span> clear + close
                      </div>
                    }
                  >
                    <Show when={hits().length} fallback={<div class="px-2 py-3 text-12-regular text-text-weaker text-center">no matches</div>}>
                      <For each={hits()}>
                        {(h, i) => (
                          <button
                            type="button"
                            role="option"
                            aria-selected={sel() === i()}
                            class="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md border-none cursor-pointer text-left bg-transparent hover:bg-surface-base"
                            classList={{ "bg-surface-raised-base": sel() === i() }}
                            onClick={() => {
                              jump(h)
                              setOpen(false)
                            }}
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
          </div>
        </Portal>
      </Show>
    </>
  )
}
