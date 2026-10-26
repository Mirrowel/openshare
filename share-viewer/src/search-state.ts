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
  else scheduleRun(SETTLE_MS)
}
export function setSearchScopes(scopes: SearchScope[]) {
  setState("scopes", scopes)
  scheduleRun(SETTLE_MS)
}
export function setActiveHit(hit: SearchHit) {
  setState("active", hit)
}
export function setHitPartIds(ids: string[]) {
  setState("hitPartIds", ids)
  scheduleRun(SETTLE_MS)
}

// ---------------------------------------------------------------------------
// the engine: marks + scroll-driven expansion inside the transcript
// ---------------------------------------------------------------------------

let engineStarted = false
let observer: MutationObserver | undefined
let scrollerEl: HTMLElement | undefined
let running = false
let settleTimer: ReturnType<typeof setTimeout> | undefined
/** true while the engine itself writes DOM (marks, clicks): the
 *  observer must ignore those mutations or every pass schedules the
 *  next one forever */
let engineMutating = false
/** mark rewrites flush to the observer asynchronously (after the
 *  engineMutating flag is already false); ignore batches briefly after
 *  a pass so our own churn cannot self-schedule */
let suppressObserverUntil = 0
/** collapsibles WE expanded, to re-collapse when the search clears */
const expandedBySearch = new Set<HTMLElement>()
/** collapsibles already evaluated under the CURRENT settled query -
 *  rebuilt on every query change, so a row the user touched earlier is
 *  reconsidered by the next search (owner-caught: a sticky set made
 *  rows stop expanding permanently) */
let handledCollapsibles = new WeakSet<HTMLElement>()
/** the query the handled set belongs to */
let handledQuery = ""

function transcriptScroller(): HTMLElement | undefined {
  return (document.querySelector("[data-transcript-scroll]") as HTMLElement | null) ?? undefined
}

// typing settle: the engine waits this long after the last change
// before marking/expanding, so no prefix of a typed word triggers a pass
const SETTLE_MS = 900
// scroll-driven passes (virtualization mounts rows) use a short delay
const SCROLL_MS = 250

/** debounce a pass. Query changes wait for typing to settle (owner
 *  round 2026-10-26: per-keystroke passes mass-expanded the transcript
 *  on every prefix); scroll-driven mutations use a shorter delay */
function scheduleRun(delay = SCROLL_MS) {
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = setTimeout(() => {
    settleTimer = undefined
    runPass()
  }, delay)
}
function cancelScheduled() {
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = undefined
}

function runPass() {
  if (running) return
  const q = state.query.trim().toLowerCase()
  const sc = transcriptScroller()
  if (!sc) return
  // a new settled query: re-evaluate every row from scratch
  if (q !== handledQuery) {
    handledCollapsibles = new WeakSet<HTMLElement>()
    handledQuery = q
  }
  running = true
  engineMutating = true
  let expandedAny = false
  try {
    clearMarksIn(sc)
    if (q) {
      // expand BEFORE marking: expanding mounts body text that the mark
      // walk must see in the same pass
      expandedAny = expandHitRows(sc)
      markMatches(sc, q)
    }
  } finally {
    engineMutating = false
    running = false
    suppressObserverUntil = typeof performance !== "undefined" ? performance.now() + 120 : 0
  }
  // newly mounted bodies may paint after the pass: one fix-up pass so
  // their marks land without waiting for the next scroll
  if (expandedAny) scheduleRun(180)
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
 *  the subagent page (owner-caught).
 *
 *  Bounded three ways (a whole-transcript sweep mass-expanded rows on
 *  every keystroke and broke virtualization - owner-caught):
 *  - only rows near the reading position are considered; scrolling
 *    mounts more rows and the next pass expands those;
 *  - rows WE opened that no longer match the current query collapse
 *    back, so expansions track the current query, not the union of
 *    typed prefixes;
 *  - each row is evaluated once per settled query (manual re-collapses
 *    stick within that search). */
function expandHitRows(root: HTMLElement): boolean {
  const idSet = new Set(state.hitPartIds)
  let expandedAny = false
  const rows = Array.from(
    root.querySelectorAll("[data-timeline-part-id], [data-timeline-part-ids]"),
  ) as HTMLElement[]
  // the near-reading window: rows around the current scroll position
  // (a touch ahead so content is prepared before it is read)
  const vh = typeof window !== "undefined" ? window.innerHeight : 900
  const top = root.getBoundingClientRect().top
  const near = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    return r.bottom > top - vh * 0.75 && r.top < top + vh * 1.25
  }
  for (const row of rows) {
    const ids = row.getAttribute("data-timeline-part-ids")?.split(",").map((s) => s.trim()) ?? []
    const own = row.getAttribute("data-timeline-part-id")
    if (own) ids.push(own)
    const matches = ids.some((id) => idSet.has(id))
    // the collapsible to expand: tool rows carry it as an ANCESTOR
    // (tool-part-wrapper inside the collapsible); reasoning rows carry
    // it as a DESCENDANT (the reasoning-part wrapper around its own
    // BasicTool collapsible)
    const collapsible =
      (row.closest('[data-component="collapsible"]') as HTMLElement | null) ??
      (row.matches('[data-component="collapsible"]') ? row : ((row.querySelector(':scope [data-component="collapsible"]') as HTMLElement | null) ?? null))
    if (!collapsible) continue
    if (!matches) {
      // stale expansion from an earlier (prefix) query: collapse it
      if (expandedBySearch.has(collapsible) && near(row)) {
        const trigger = collapsible.querySelector('[data-slot="collapsible-trigger"]') as HTMLElement | null
        if (trigger && trigger.tagName !== "A" && !trigger.closest("a")) trigger.click()
        expandedBySearch.delete(collapsible)
      }
      continue
    }
    if (!near(row)) continue
    if (handledCollapsibles.has(collapsible) || expandedBySearch.has(collapsible)) continue
    if (collapsible.getAttribute("data-closed") === null) {
      // already open by the user: never fight it
      handledCollapsibles.add(collapsible)
      continue
    }
    const trigger = collapsible.querySelector('[data-slot="collapsible-trigger"]') as HTMLElement | null
    // a link trigger navigates (task cards) - skip, never click
    if (!trigger || trigger.tagName === "A" || trigger.closest("a")) continue
    expandedBySearch.add(collapsible)
    handledCollapsibles.add(collapsible)
    trigger.click()
    expandedAny = true
  }
  return expandedAny
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
  cancelScheduled()
  handledQuery = ""
  handledCollapsibles = new WeakSet<HTMLElement>()
  const sc = transcriptScroller()
  if (sc) {
    engineMutating = true
    try {
      clearMarksIn(sc)
    } finally {
      engineMutating = false
    }
  }
  // restore what we expanded (elements still alive re-collapse; dead
  // ones drop out of the set)
  engineMutating = true
  try {
    for (const el of Array.from(expandedBySearch)) {
      if (!el.isConnected) {
        expandedBySearch.delete(el)
        continue
      }
      const trigger = (el.querySelector('[data-slot="collapsible-trigger"]') ?? el.querySelector("button, a")) as HTMLElement | null
      trigger?.click()
      expandedBySearch.delete(el)
    }
  } finally {
    engineMutating = false
  }
}

export function ensureSearchEngine() {
  if (engineStarted || typeof window === "undefined") return
  engineStarted = true
  let scrollEl: HTMLElement | undefined
  const onScroll = () => {
    if (running || engineMutating) return
    scheduleRun()
  }
  const attach = () => {
    const sc = transcriptScroller()
    if (sc === scrollerEl) return
    scrollerEl = sc
    observer?.disconnect()
    scrollEl?.removeEventListener("scroll", onScroll)
    scrollEl = sc ?? undefined
    if (!sc) return
    observer = new MutationObserver((muts) => {
      if (running || engineMutating) return
      if (typeof performance !== "undefined" && performance.now() < suppressObserverUntil) return
      // ignore pure attribute churn (animations, aria updates)
      if (muts.every((m) => m.type === "attributes")) return
      scheduleRun()
    })
    observer.observe(sc, { childList: true, subtree: true, characterData: false })
    // virtualized scrolling repositions rows with style/transform updates
    // only (attribute churn, filtered above) - without this listener no
    // pass ever ran while scrolling, so hits never expanded as they came
    // into view (owner-caught)
    sc.addEventListener("scroll", onScroll, { passive: true })
  }
  const boot = () => {
    attach()
    if (state.query.trim()) scheduleRun(SETTLE_MS)
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
