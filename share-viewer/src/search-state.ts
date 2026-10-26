// The persistent search state + the live highlight/expand engine
// (owner round 2026-10-26). The palette writes here; the engine reads it
// and keeps the PAGE in sync for as long as a query is active - marks
// stay after the palette closes, and any collapsed row that scrolls
// into view with a hit inside expands so the hit can be found.
import { createStore } from "solid-js/store"

export type SearchScope = "prompts" | "responses" | "thinking" | "tools"
export const SEARCH_SCOPES: SearchScope[] = ["prompts", "responses", "thinking", "tools"]

export type SearchHit = {
  sectionId: string
  turn: number
  scope: SearchScope
  /** the matched part (tool/reasoning part id) or the section's user
   *  message id for prompt/response hits */
  partId?: string
  line: string
  at: number
}

type SearchState = {
  query: string
  scopes: SearchScope[]
  active: SearchHit | null
  /** part ids whose DATA text matched (published by the palette) - the
   *  expansion engine is data-driven: collapsed rows unmount their
   *  content, so DOM text can never reveal a body-only hit */
  hitPartIds: string[]
}

const [state, setState] = createStore<SearchState>({ query: "", scopes: [...SEARCH_SCOPES], active: null, hitPartIds: [] })

export const searchState = { get: () => state }
export const searchQuery = () => state.query
export const searchScopes = () => state.scopes
export const activeHit = () => state.active
export function setSearchQuery(query: string) {
  setState({ query, active: null })
  if (!query.trim()) clearEngine()
  else scheduleRun()
}
export function setSearchScopes(scopes: SearchScope[]) {
  setState("scopes", scopes)
  scheduleRun()
}
export function setActiveHit(hit: SearchHit) {
  setState("active", hit)
}
export function setHitPartIds(ids: string[]) {
  setState("hitPartIds", ids)
  if (ids.length) scheduleRun()
}

// ---------------------------------------------------------------------------
// the engine: marks + scroll-driven expansion inside the transcript
// ---------------------------------------------------------------------------

let engineStarted = false
let observer: MutationObserver | undefined
let scrollerEl: HTMLElement | undefined
let running = false
let runQueued = false
/** collapsibles WE expanded, to re-collapse when the search clears */
const expandedBySearch = new Set<HTMLElement>()
/** collapsibles already handled (expanded or found hitless) - manual
 * re-collapses during an active search stick */
const handledCollapsibles = new WeakSet<HTMLElement>()

function transcriptScroller(): HTMLElement | undefined {
  return (document.querySelector("[data-transcript-scroll]") as HTMLElement | null) ?? undefined
}

function scheduleRun() {
  if (runQueued) return
  runQueued = true
  requestAnimationFrame(() => {
    runQueued = false
    runPass()
  })
}

function runPass() {
  if (running) return
  const q = state.query.trim().toLowerCase()
  const sc = transcriptScroller()
  if (!sc) return
  running = true
  try {
    clearMarksIn(sc)
    if (q) {
      markMatches(sc, q)
      expandHitRows(sc)
    }
  } finally {
    running = false
  }
}

/** wrap case-insensitive query matches in <mark> across the scroller's
 *  text nodes (skip inputs, scripts, existing marks) */
function markMatches(root: HTMLElement, q: string) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = (node as Text).parentElement
      if (!p) return NodeFilter.FILTER_REJECT
      const tag = p.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SCRIPT" || tag === "STYLE" || tag === "MARK") return NodeFilter.FILTER_REJECT
      if (!p.closest("[data-transcript-scroll]")) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const targets: Text[] = []
  let cur = walker.nextNode()
  while (cur) {
    targets.push(cur as Text)
    cur = walker.nextNode()
  }
  const needle = q
  for (const t of targets) {
    const raw = t.nodeValue ?? ""
    const lower = raw.toLowerCase()
    let i = lower.indexOf(needle)
    if (i < 0) continue
    const frag = document.createDocumentFragment()
    let last = 0
    while (i >= 0) {
      if (i > last) frag.appendChild(document.createTextNode(raw.slice(last, i)))
      const m = document.createElement("mark")
      m.className = "osh-search-hit"
      m.textContent = raw.slice(i, i + needle.length)
      frag.appendChild(m)
      last = i + needle.length
      i = lower.indexOf(needle, last)
    }
    if (last < raw.length) frag.appendChild(document.createTextNode(raw.slice(last)))
    t.parentNode?.replaceChild(frag, t)
  }
}

/** expand the rows whose PARTS carry hits - decided by DATA (the
 *  palette publishes hit part ids), never by DOM text: Kobalte unmounts
 *  closed collapsible content, so a collapsed row's body text is not in
 *  the DOM and DOM inspection can never see a body-only hit. Triggers
 *  that are links (subagent task cards render their trigger as an <a
 *  href> - triggerAsLink) are NEVER clicked: clicking one navigates to
 *  the subagent page (owner-caught). */
function expandHitRows(root: HTMLElement) {
  if (!state.hitPartIds.length) return
  const idSet = new Set(state.hitPartIds)
  const rows = Array.from(
    root.querySelectorAll("[data-timeline-part-id], [data-timeline-part-ids]"),
  ) as HTMLElement[]
  for (const row of rows) {
    const ids = row.getAttribute("data-timeline-part-ids")?.split(",").map((s) => s.trim()) ?? []
    const own = row.getAttribute("data-timeline-part-id")
    if (own) ids.push(own)
    if (!ids.some((id) => idSet.has(id))) continue
    // the collapsible to expand: tool rows carry it as an ANCESTOR
    // (tool-part-wrapper inside the collapsible); reasoning rows carry
    // it as a DESCENDANT (the reasoning-part wrapper around its own
    // BasicTool collapsible)
    const collapsible =
      (row.closest('[data-component="collapsible"]') as HTMLElement | null) ??
      (row.matches('[data-component="collapsible"]') ? row : ((row.querySelector(':scope [data-component="collapsible"]') as HTMLElement | null) ?? null))
    if (!collapsible) continue
    if (handledCollapsibles.has(collapsible) || expandedBySearch.has(collapsible)) continue
    if (collapsible.getAttribute("data-closed") === null) {
      handledCollapsibles.add(collapsible)
      continue
    }
    const trigger = collapsible.querySelector('[data-slot="collapsible-trigger"]') as HTMLElement | null
    // a link trigger navigates (task cards) - skip, never click
    if (!trigger || trigger.tagName === "A" || trigger.closest("a")) continue
    expandedBySearch.add(collapsible)
    handledCollapsibles.add(collapsible)
    trigger.click()
  }
}

function clearMarksIn(root: HTMLElement) {
  for (const m of Array.from(root.querySelectorAll("mark.osh-search-hit"))) {
    const parent = m.parentNode
    if (!parent) continue
    parent.replaceChild(document.createTextNode(m.textContent ?? ""), m)
    parent.normalize()
  }
}

function clearEngine() {
  const sc = transcriptScroller()
  if (sc) clearMarksIn(sc)
  // restore what we expanded (elements still alive re-collapse; dead
  // ones drop out of the set)
  for (const el of Array.from(expandedBySearch)) {
    if (!el.isConnected) {
      expandedBySearch.delete(el)
      continue
    }
    const trigger = (el.querySelector('[data-slot="collapsible-trigger"]') ?? el.querySelector("button, a")) as HTMLElement | null
    trigger?.click()
    expandedBySearch.delete(el)
  }
}

export function ensureSearchEngine() {
  if (engineStarted || typeof window === "undefined") return
  engineStarted = true
  const attach = () => {
    const sc = transcriptScroller()
    if (sc === scrollerEl) return
    scrollerEl = sc
    observer?.disconnect()
    if (!sc) return
    observer = new MutationObserver((muts) => {
      if (running) return
      // ignore pure attribute churn (animations, aria updates)
      if (muts.every((m) => m.type === "attributes")) return
      scheduleRun()
    })
    observer.observe(sc, { childList: true, subtree: true, characterData: false })
  }
  const boot = () => {
    attach()
    if (state.query.trim()) scheduleRun()
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true })
  else boot()
  // the scroller element is replaced across views/modes: re-attach on
  // any body-level structural change (cheap; guarded by sc === scrollerEl)
  const bodyObs = new MutationObserver(() => attach())
  bodyObs.observe(document.body, { childList: true, subtree: false })
}

/** scroll to a hit's part: the part element if we have its id, else the
 *  section; expanded rows settle first, then the first mark inside the
 *  target gets a brief active flash. Returns false when no transcript
 *  scroller exists (the caller falls back to its own navigation). */
export function jumpToHit(hit: SearchHit, smooth: boolean): boolean {
  const sc = transcriptScroller()
  if (!sc) return false
  // section keys are `${cachePrefix}:${id}`; match by suffix
  const target: HTMLElement | null = hit.partId
    ? (sc.querySelector(`[data-timeline-part-id="${CSS.escape(hit.partId)}"]`) as HTMLElement | null)
    : null
  const el = target ?? (sc.querySelector(`[data-section-key$=":${CSS.escape(hit.sectionId)}"]`) as HTMLElement | null)
  const settle = () => {
    const dest = el ?? sc
    dest.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" })
    // after expansion + marks land, flash the first mark at/after dest
    setTimeout(() => {
      const scope = target ?? sc
      const first = target
        ? (scope.querySelector("mark.osh-search-hit") as HTMLElement | null)
        : marksNear(scope, dest)
      first?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" })
      first?.classList.add("osh-search-hit-active")
      setTimeout(() => first?.classList.remove("osh-search-hit-active"), 1600)
    }, 260)
  }
  // rows may need a pass to expand before their part elements exist
  runPass()
  setTimeout(settle, 60)
  return true
}

function marksNear(scope: HTMLElement, anchor: HTMLElement): HTMLElement | null {
  const marks = Array.from(scope.querySelectorAll("mark.osh-search-hit")) as HTMLElement[]
  if (!marks.length) return null
  const top = anchor.getBoundingClientRect().top
  let best: HTMLElement | undefined
  let bestD = Infinity
  for (const m of marks) {
    const d = Math.abs(m.getBoundingClientRect().top - top)
    if (d < bestD) {
      bestD = d
      best = m
    }
  }
  return best ?? null
}
