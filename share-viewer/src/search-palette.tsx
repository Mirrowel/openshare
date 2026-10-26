// The header search palette: a command-bar over the loaded session -
// prompts, responses, thinking and tool text, with scope chips. It
// renders the button AND the palette; classic chrome and every
// SkinHeader mount it left of the copy-markdown trigger.
//
// Query/scope/hit state lives in search-state.ts and PERSISTS after
// close - marks stay in the page, collapsed rows with hits keep
// expanding as they scroll in, and only emptying the query (Esc or the
// clear button) ends the search. The palette publishes its hit part
// ids; the expansion engine is data-driven because Kobalte unmounts
// closed collapsible content (DOM text can never reveal a body-only
// hit). Task/subagent tools are excluded from the index: the search
// covers the current view only.
//
// Centering rides a flex WRAPPER - the kit's tailwind emits translate:
// as a CSS property, so animating transform on a class-centered element
// applies both offsets and lands one width left mid-animation.
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import type { SessionSection } from "./views/session-data"
import {
  SEARCH_SCOPES,
  activeHit,
  clearSearch,
  ensureSearchEngine,
  jumpToHit,
  searchQuery,
  searchScopes,
  setActiveHit,
  setHitPartIds,
  setSearchQuery,
  setSearchScopes,
  type SearchHit,
  type SearchScope,
} from "./search-state"

/** subagent task tools stay out of the index: their bodies live on the
 *  child page and their triggers are links (clicking navigates) */
const EXCLUDED_TOOLS = new Set(["task", "subagent"])

/** the searchable text of one section per scope; part ids ride along so
 *  jumps and the expansion engine can target the matched part */
function scopeHits(s: SessionSection, query: string, active: Set<SearchScope>): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: SearchHit[] = []
  const push = (scope: SearchScope, text: string | undefined, partId?: string) => {
    if (!active.has(scope) || !text) return
    // offsets must be computed on the SAME string the snippet slices:
    // raw-text indices drifted off the whitespace-collapsed line
    const line = text.replace(/\s+/g, " ")
    const at = line.toLowerCase().indexOf(q)
    if (at >= 0) out.push({ sectionId: s.id, turn: s.index + 1, scope, partId, line, at })
  }
  // prompts/responses are always rendered when their section is: no
  // part id is published, so the expansion engine never treats them as
  // collapsed bodies and jumps resolve through the section instead
  push("prompts", s.prompt)
  push("responses", s.response)
  if (active.has("thinking")) for (const r of s.reasoning) {
    // the kit synthesizes `${messageID}:reasoning:${ordinal}` for
    // non-tool part ids (projection contentEntries) - match the scheme
    const rid = r.messageID != null && r.ordinal != null ? `${r.messageID}:reasoning:${r.ordinal}` : (r.part as any)?.id
    push("thinking", r.text, rid)
  }
  if (active.has("tools")) for (const t of s.tools) {
    if (EXCLUDED_TOOLS.has(t.tool)) continue
    const id = (t.part as any)?.id
    // body text (title + output) is what a match can highlight and
    // expand; a match on the RAW tool name alone (e.g. "bash", rendered
    // as "Shell") stays a result but publishes no part id - expanding it
    // opened rows with nothing to show and jumped to a body without the
    // match
    const body = `${t.title} ${t.output ?? ""}`
    if (body.toLowerCase().includes(q)) push("tools", body, id)
    else if (t.tool.toLowerCase().includes(q)) push("tools", `${t.tool} ${body}`)
  }
  return out
}


export function SearchControl(props: {
  sections: () => SessionSection[]
  onJump: (sectionId: string) => void
  smooth?: boolean
  class?: string
}) {
  ensureSearchEngine()
  const [open, setOpen] = createSignal(false)
  // a different session (subagent open/back) must not inherit this
  // session's query, hits or expansions; live data updates keep the
  // same first section id so they never clear
  let firstSectionId = ""
  createEffect(() => {
    const s = props.sections()
    const first = s[0]?.id ?? ""
    if (!first) return
    if (firstSectionId && first !== firstSectionId) clearSearch()
    firstSectionId = first
  })
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
  // publish the hit part ids: the expansion engine is data-driven
  createEffect(() => {
    setHitPartIds(hits().map((h) => h.partId).filter((x): x is string => !!x))
  })

  const jump = (h: SearchHit) => {
    setActiveHit(h)
    if (jumpToHit(h, props.smooth !== false)) return
    // the part is not mounted (far turn / collapsed body): navigate by
    // section first - the mount fast path expands it - then retry the
    // part jump so the flash lands on the match, not the turn top
    props.onJump(h.sectionId)
    let tries = 0
    const retry = () => {
      if (++tries > 8) return
      if (!jumpToHit(h, false, true)) setTimeout(retry, 120)
    }
    setTimeout(retry, 220)
  }

  const onKey = (e: KeyboardEvent) => {
    if (!open()) {
      if (e.key === "/" && !(e.target as HTMLElement)?.closest?.("input, textarea, [contenteditable]")) {
        e.preventDefault()
        setOpen(true)
      } else if (e.key === "Escape" && searchQuery().trim() && !(e.target as HTMLElement)?.closest?.("input, textarea, [contenteditable]")) {
        // marks persist after clicking away or jumping; Esc is the
        // documented way to end the search - it must work then too
        setSearchQuery("")
        setHitPartIds([])
      }
      return
    }
    if (e.key === "Escape") {
      // Esc ENDS the search: empties the query (marks clear) and closes
      e.preventDefault()
      setSearchQuery("")
      setHitPartIds([])
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
  const multiScope = () => searchScopes().length > 1
  void activeHit

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
        <span class="text-text-strong font-semibold">{match}</span>
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
          {/* outside click CLOSES WITHOUT EMPTYING: marks + query stay */}
          <div class="fixed inset-0 z-[80]" onClick={() => setOpen(false)}>
            <div class="osh-search-scrim absolute inset-0" />
            <div class="absolute left-0 right-0 top-12 flex justify-center pointer-events-none px-4">
              <div
                class="osh-search-palette pointer-events-auto w-[min(34rem,100%)] rounded-2xl border border-border-weak-base bg-background-base shadow-2xl overflow-hidden"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-label="search session"
              >
                {/* query row */}
                <div class="flex items-center gap-2.5 px-4 h-12 border-b border-border-weak-base/50">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" class="shrink-0 text-text-weaker" aria-hidden="true">
                    <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5" />
                    <line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                  </svg>
                  <input
                    ref={inputEl}
                    type="text"
                    value={searchQuery()}
                    onInput={(e) => setSearchQuery(e.currentTarget.value)}
                    placeholder="search this session…"
                    class="flex-1 bg-transparent border-none outline-none text-15-regular text-text-base placeholder:text-text-weaker"
                    aria-label="search query"
                  />
                  <Show when={searchQuery()}>
                    <span class="shrink-0 min-w-6 h-5 px-1.5 flex items-center justify-center rounded-full bg-surface-base text-10-mono text-text-weak tabular-nums">
                      {hits().length}
                    </span>
                    <button
                      type="button"
                      class="flex items-center justify-center size-5 rounded-full bg-surface-base text-text-weaker hover:text-text-base border-none cursor-pointer shrink-0"
                      title="clear search"
                      aria-label="clear search"
                      onClick={() => {
                        setSearchQuery("")
                        setHitPartIds([])
                        inputEl?.focus()
                      }}
                    >
                      <svg viewBox="0 0 12 12" width="9" height="9" fill="none" aria-hidden="true">
                        <line x1="2.5" y1="2.5" x2="9.5" y2="9.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                        <line x1="9.5" y1="2.5" x2="2.5" y2="9.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                      </svg>
                    </button>
                  </Show>
                </div>
                {/* scope chips: compact pill toggles - a filter, not tabs */}
                <div class="flex items-center gap-1.5 px-4 py-2">
                  <span class="text-10-mono text-text-weaker shrink-0 pr-0.5">in</span>
                  <For each={SEARCH_SCOPES}>
                    {(s) => {
                      const on = () => searchScopes().includes(s)
                      return (
                        <button
                          type="button"
                          class="osh-search-chip"
                          classList={{ "osh-search-chip-on": on() }}
                          onClick={() => {
                            const cur = new Set(searchScopes())
                            if (cur.has(s)) cur.delete(s)
                            else cur.add(s)
                            setSearchScopes([...cur])
                          }}
                          aria-pressed={on()}
                        >
                          {s}
                        </button>
                      )
                    }}
                  </For>
                </div>
                {/* results */}
                <div class="max-h-[46vh] overflow-y-auto osh-thin-scroll py-1" role="listbox" aria-label="search results">
                  <Show
                    when={searchQuery().trim()}
                    fallback={
                      <div class="px-4 py-4 text-12-regular text-text-weaker text-center">
                        find anything in this session
                      </div>
                    }
                  >
                    <Show when={hits().length} fallback={<div class="px-4 py-4 text-12-regular text-text-weaker text-center">nothing matches</div>}>
                      <For each={hits()}>
                        {(h, i) => (
                          <button
                            type="button"
                            role="option"
                            aria-selected={sel() === i()}
                            class="osh-search-row"
                            classList={{ "osh-search-row-sel": sel() === i() }}
                            onClick={() => {
                              jump(h)
                              setOpen(false)
                            }}
                            onMouseEnter={() => setSel(i())}
                          >
                            <span class="text-10-mono text-text-weaker w-[2ch] shrink-0 text-right tabular-nums pt-px">{h.turn}</span>
                            <span class="min-w-0 flex-1 truncate">
                              <Snippet {...h} />
                            </span>
                            <Show when={multiScope()}>
                              <span class="text-10-mono text-text-weaker/80 shrink-0">{h.scope}</span>
                            </Show>
                          </button>
                        )}
                      </For>
                    </Show>
                  </Show>
                </div>
                {/* hint bar */}
                <div class="flex items-center gap-3 h-7 px-4 border-t border-border-weak-base/50 text-10-mono text-text-weaker">
                  <span class="flex items-center gap-1"><span class="text-text-weak">↑↓</span>results</span>
                  <span class="flex items-center gap-1"><span class="text-text-weak">↵</span>jump</span>
                  <span class="flex items-center gap-1"><span class="text-text-weak">esc</span>clear</span>
                  <span class="ml-auto">stay open: click away</span>
                </div>
              </div>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  )
}
