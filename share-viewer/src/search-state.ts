// The persistent search state + the live highlight/expand engine
// (owner round 2026-10-26). The palette writes here; the engine reads it
// and keeps the PAGE in sync for as long as a query is active - marks
// stay after the palette closes, and any collapsed row that scrolls
// into view with a hit inside expands so the hit can be found.
//
// Marking uses the CSS Custom Highlight API: ranges are painted by the
// browser with ::highlight, so nothing in the DOM is rewritten, layout
// never shifts (no padding/mark elements feeding the virtualizer's
// measurements), renderer-owned text (Solid <pre>, SVG/markdown blocks)
// is never detached, and a common-word query cannot create thousands of
// elements. A DOM <mark> fallback remains for browsers without it.
//
// Expansion is data-driven: collapsed rows unmount their content, so
// DOM text can never reveal a body-only hit. The palette publishes the
// matched PART ids (never prompt ids - prompt text is always visible).
import { createStore } from "solid-js/store"

export type SearchScope = "prompts" | "responses" | "thinking" | "tools"
export const SEARCH_SCOPES: SearchScope[] = ["prompts", "responses", "thinking", "tools"]

export type SearchHit = {
  sectionId: string
  turn: number
  scope: SearchScope
  /** the matched part (tool/reasoning part id); absent for prompt and
   *  response hits - those are resolved through the section instead */
  partId?: string
  line: string
  at: number
}

type SearchState = {
  query: string
  scopes: SearchScope[]
  active: SearchHit | null
  /** part ids whose DATA text matched (published by the palette) */
  hitPartIds: string[]
}

const [state, setState] = createStore<SearchState>({ query: "", scopes: [...SEARCH_SCOPES], active: null, hitPartIds: [] })

export const searchState = { get: () => state }
export const searchQuery = () => state.query
export const searchScopes = () => state.scopes
export const activeHit = () => state.active
export function setSearchQuery(query: string) {
  setState({ query, active: null })
  marksDirty = true
  if (!query.trim()) clearEngine()
  else requestQueryPass()
}
export function setSearchScopes(scopes: SearchScope[]) {
  setState("scopes", scopes)
  marksDirty = true
  requestQueryPass()
}
export function setActiveHit(hit: SearchHit) {
  setState("active", hit)
}
export function setHitPartIds(ids: string[]) {
  setState("hitPartIds", ids)
  stats.hitIds = ids
  marksDirty = true
  // expansion follows the hit set when it changes on a settled query
  // (live data updates), but never before typing settles
  if (querySettled && state.query.trim()) requestContentPass()
}

// ---------------------------------------------------------------------------
// disclosure ownership: rows the ENGINE opened are tracked by their
// disclosure key, so clearing the search closes them reactively and a
// remount cannot resurrect a search expansion. A user toggle always wins
// and drops the ownership claim.
// ---------------------------------------------------------------------------

const [ownedDisclosure, setOwnedDisclosure] = createStore<Record<string, boolean | undefined>>({})
export function disclosureOwned(key: string) {
  return ownedDisclosure[key] === true
}
/** true while the engine is the one clicking a trigger */
export function engineClicking() {
  return engineMutating
}
/** record engine ownership for a disclosure key */
export function claimDisclosure(key: string, open: boolean) {
  setOwnedDisclosure(key, open ? true : undefined)
}
export function releaseDisclosure(key: string) {
  setOwnedDisclosure(key, undefined)
}
function clearDisclosureOwnership() {
  for (const k of Object.keys(ownedDisclosure)) setOwnedDisclosure(k, undefined)
}

// ---------------------------------------------------------------------------
// the engine
// ---------------------------------------------------------------------------

let engineStarted = false
let observer: MutationObserver | undefined
let scrollObs: MutationObserver | undefined
let scrollerEl: HTMLElement | undefined
let running = false
let settleTimer: ReturnType<typeof setTimeout> | undefined
let contentTimer: ReturnType<typeof setTimeout> | undefined
let fastPending = false
/** true while the engine itself writes DOM (clicks): the observer must
 *  ignore those mutations or every pass schedules the next one forever */
let engineMutating = false
/** engine writes flush to the observer asynchronously; ignore batches
 *  briefly after a pass so our own churn cannot self-schedule */
let suppressObserverUntil = 0
/** query typing settle state - nothing expands or paints until it flips */
let querySettled = false
/** part ids already evaluated under the CURRENT settled query */
let handledIds = new Set<string>()
let resolvedQuery = ""
/** part ids the engine opened -> their collapsible at click time. Kept
 *  after unmount (element gone but the id stays) so a remount cannot
 *  resurrect the expansion; stale passes close whatever is mounted. */
const ownedPartIds = new Map<string, HTMLElement | undefined>()
/** containers (grouped wrappers) the engine opened, closed when none of
 *  their parts match any more or on clear */
const ownedContainers = new Map<HTMLElement, string[]>()
/** the query painted right now + whether new content needs painting */
let lastMarkedQuery = ""
let marksDirty = false
/** jump generation: a newer jump (or a clear) cancels pending ones */
let jumpGen = 0
let jumpTimer: ReturnType<typeof setTimeout> | undefined

/** engine counters for probes/diagnostics (window.__oshSearchStats) */
const stats = { passes: 0, expands: 0, matches: 0, lastPassMs: 0, hitIds: [] as string[], settled: false }
if (typeof window !== "undefined") (window as any).__oshSearchStats = stats

const SETTLE_MS = 900
const CONTENT_MS = 200

/** the ACTIVE transcript scroller: focus mode keeps the main timeline
 *  mounted but hidden while an overlay timeline is the visible surface,
 *  and the responsive branches leave the other one display:none. Picking
 *  the first match attached the engine to a hidden transcript (search
 *  then expanded and jumped where the user could not see it). */
function transcriptScroller(): HTMLElement | undefined {
  const all = Array.from(document.querySelectorAll<HTMLElement>("[data-transcript-scroll]"))
  let visible: HTMLElement | undefined
  for (const el of all) {
    if (!el.isConnected || el.clientHeight === 0) continue
    let seen = false
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n)
      if (cs.display === "none" || cs.visibility === "hidden") {
        seen = true
        break
      }
    }
    if (!seen) visible = el
  }
  return visible ?? all.find((el) => el.isConnected)
}

/** debounce a pass that may expand. Query changes wait for typing to
 *  settle (per-keystroke passes mass-expanded every prefix); content
 *  changes use a short backstop - the mount fast path does the real
 *  "expand beforehand" work. */
function requestQueryPass() {
  querySettled = false
  stats.settled = false
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = setTimeout(() => {
    settleTimer = undefined
    querySettled = true
    stats.settled = true
    runPass()
  }, SETTLE_MS)
}
function requestContentPass() {
  if (!querySettled) return
  if (contentTimer) clearTimeout(contentTimer)
  contentTimer = setTimeout(() => {
    contentTimer = undefined
    runPass()
  }, CONTENT_MS)
}
function cancelTimers() {
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = undefined
  if (contentTimer) clearTimeout(contentTimer)
  contentTimer = undefined
  if (jumpTimer) clearTimeout(jumpTimer)
  jumpTimer = undefined
}

function runPass() {
  if (running) return
  const q = state.query.trim()
  const sc = transcriptScroller()
  if (!sc) return
  attach()
  if (q.toLowerCase() !== resolvedQuery) {
    handledIds = new Set<string>()
    resolvedQuery = q.toLowerCase()
    marksDirty = true
  }
  running = true
  engineMutating = true
  const started = typeof performance !== "undefined" ? performance.now() : 0
  let expandedAny = false
  try {
    if (q && querySettled) expandedAny = expandHitRows(sc)
    if (marksDirty || lastMarkedQuery !== q) {
      paint(sc, q)
      lastMarkedQuery = q
      marksDirty = false
    }
  } finally {
    engineMutating = false
    running = false
    suppressObserverUntil = typeof performance !== "undefined" ? performance.now() + 120 : 0
    stats.passes++
    stats.lastPassMs = Math.round(((typeof performance !== "undefined" ? performance.now() : 0) - started) * 100) / 100
  }
  if (expandedAny) {
    marksDirty = true
    requestContentPass()
  }
}

/** fast path: expand and paint rows the virtualizer JUST mounted, before
 *  they paint, so a hit is already open when it scrolls in (the 250ms
 *  debounce alone made scrolling feel laggy - the row expanded as the
 *  reader arrived). Coalesced to one rAF, and never runs before the
 *  typing settle. */
function expandMountedNow() {
  fastPending = false
  if (running || engineMutating) return
  if (!querySettled) return
  const q = state.query.trim()
  if (!q) return
  const sc = transcriptScroller()
  if (!sc) return
  attach()
  running = true
  engineMutating = true
  let changed = false
  try {
    changed = expandHitRows(sc, 2.5)
    if (marksDirty || lastMarkedQuery !== q) {
      paint(sc, q)
      lastMarkedQuery = q
      marksDirty = false
    }
  } finally {
    engineMutating = false
    running = false
    suppressObserverUntil = typeof performance !== "undefined" ? performance.now() + 120 : 0
  }
  if (changed) {
    marksDirty = true
    requestContentPass()
  }
}

const idList = (row: HTMLElement): string[] => {
  const ids = (row.getAttribute("data-timeline-part-ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  const own = row.getAttribute("data-timeline-part-id")
  if (own) ids.push(own)
  return ids
}

const isCollapsible = (el: Element | null): el is HTMLElement =>
  !!el && el.getAttribute("data-component") === "collapsible"

/** the disclosure-bearing collapsibles a hit row belongs to, outermost
 *  first: ancestor groups (grouping wraps parts) and, for a part row,
 *  its own descendant collapsible (the reasoning/tool body). Clicking
 *  the outer group first is required - its children only exist once it
 *  is open. */
function collapsibleChain(row: HTMLElement, sc: HTMLElement): HTMLElement[] {
  const chain: HTMLElement[] = []
  let n: HTMLElement | null = row.parentElement
  while (n && n !== sc) {
    if (isCollapsible(n)) chain.push(n)
    n = n.parentElement
  }
  chain.reverse()
  // a part row owns the innermost collapsible inside it (reasoning rows
  // wrap their BasicTool collapsible)
  if (row.hasAttribute("data-timeline-part-id") && !row.hasAttribute("data-timeline-part-ids")) {
    const own = row.querySelector<HTMLElement>('[data-component="collapsible"]')
    if (own) chain.push(own)
  }
  if (isCollapsible(row)) chain.push(row)
  return chain
}

/** click a collapsible's trigger unless it is a link (task cards render
 *  their trigger as <a href>; clicking navigates - owner-caught). */
function toggleOpen(col: HTMLElement): boolean {
  const trigger = col.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')
  if (!trigger || trigger.tagName === "A" || trigger.closest("a")) return false
  trigger.click()
  return col.getAttribute("data-closed") === null
}
function toggleClose(col: HTMLElement): boolean {
  const trigger = col.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')
  if (!trigger || trigger.tagName === "A" || trigger.closest("a")) return false
  if (col.getAttribute("data-closed") !== null) return true
  trigger.click()
  return col.getAttribute("data-closed") !== null
}

/** expanded window: viewport plus a margin ahead (scaled by the caller)
 *  so rows are open before they are read, without sweeping the
 *  virtualizer's offscreen cache (500 rows) in one pass. */
function inWindow(row: HTMLElement, sc: HTMLElement, reach: number): boolean {
  const vh = typeof window !== "undefined" ? window.innerHeight : 900
  const box = sc.getBoundingClientRect()
  const r = row.getBoundingClientRect()
  return r.bottom > box.top - vh * 0.6 * reach && r.top < box.bottom + vh * 1.4 * reach
}

/** collapsibles/details the engine opened, closed again on clear */
const openedDetails = new Set<HTMLDetailsElement>()

/** open <details> disclosures (composed skins render reasoning as a
 *  native details, not a kit collapsible) around/inside a hit row */
function openDetails(row: HTMLElement, sc: HTMLElement): boolean {
  const cands: HTMLDetailsElement[] = []
  if (row instanceof HTMLDetailsElement) cands.push(row)
  cands.push(...Array.from(row.querySelectorAll("details")))
  for (let n: HTMLElement | null = row.parentElement; n && n !== sc; n = n.parentElement) {
    if (n instanceof HTMLDetailsElement) cands.push(n)
  }
  let any = false
  for (const d of cands) {
    if (d.open) continue
    d.open = true
    openedDetails.add(d)
    any = true
    stats.expands++
  }
  return any
}

/** rows opened per pass: a dense one-character query matches nearly
 *  every mounted row, and expanding all of them at once is the "it
 *  expanded everything" report; nearest-first means the rows you are
 *  actually reading always make the cut */
const MAX_EXPAND_PER_PASS = 12

function expandHitRows(sc: HTMLElement, reach = 1): boolean {
  const idSet = new Set(state.hitPartIds)
  if (!idSet.size) return false
  let expandedAny = false
  let openedCount = 0
  const box = sc.getBoundingClientRect()
  const mid = box.top + box.height / 2
  const rows = Array.from(
    sc.querySelectorAll<HTMLElement>("[data-timeline-part-id], [data-timeline-part-ids]"),
  )
  // nearest to the reading position first
  const dist = new Map<HTMLElement, number>()
  for (const r of rows) dist.set(r, Math.abs(r.getBoundingClientRect().top - mid))
  rows.sort((x, y) => (dist.get(x) ?? 0) - (dist.get(y) ?? 0))
  for (const row of rows) {
    if (!row.isConnected) continue
    const ids = idList(row)
    if (!ids.length) continue
    const matched = ids.filter((id) => idSet.has(id))
    const isContainer = row.hasAttribute("data-timeline-part-ids")
    if (isContainer) {
      // a container row (grouped turn/message wrapper): open the
      // collapsibles on the way to its members, then let each member row
      // handle itself. Consuming the ids here suppressed every member
      // expansion under grouping.
      if (!matched.length) {
        const owned = ownedContainers.get(row)
        if (owned) {
          const el = row.isConnected ? (row.querySelector<HTMLElement>('[data-component="collapsible"]') ?? row.closest<HTMLElement>('[data-component="collapsible"]')) : null
          if (el) toggleClose(el)
          ownedContainers.delete(row)
        }
        continue
      }
      if (!inWindow(row, sc, reach)) continue
      const chain = collapsibleChain(row, sc)
      for (const col of chain) {
        if (col.getAttribute("data-closed") !== null && toggleOpen(col)) {
          expandedAny = true
          stats.expands++
          ownedContainers.set(row, matched)
        }
      }
      if (openDetails(row, sc)) expandedAny = true
      continue
    }
    if (!matched.length) {
      // stale expansion from an earlier query for a row that no longer
      // matches: close it (it is ours - the disclosure claim is set).
      // Ownership survives unmounts by part id, so a row that remounts
      // open after its expansion went stale is closed here too.
      if (ids.some((id) => ownedPartIds.has(id))) {
        const chain = collapsibleChain(row, sc)
        for (const id of ids) {
          if (!ownedPartIds.has(id)) continue
          const known = ownedPartIds.get(id)
          const el = known && known.isConnected ? known : chain[chain.length - 1]
          if (el) toggleClose(el)
          ownedPartIds.delete(id)
        }
      }
      continue
    }
    if (!inWindow(row, sc, reach)) continue
    // a row already evaluated under this query is skipped - this is what
    // makes a manual collapse STICK for the rest of the search
    if (matched.every((id) => handledIds.has(id))) continue
    if (openedCount >= MAX_EXPAND_PER_PASS) break
    const chain = collapsibleChain(row, sc)
    let opened = false
    for (const col of chain) {
      if (col.getAttribute("data-closed") === null) continue
      if (toggleOpen(col)) {
        opened = true
        expandedAny = true
        stats.expands++
      }
    }
    if (openDetails(row, sc)) expandedAny = true
    // only record ownership/registration when the row actually opened:
    // pending or locked triggers refuse the click and are retried by a
    // later pass or the mount fast path
    if (!chain.length) {
      matched.forEach((id) => handledIds.add(id))
    } else if (opened || chain.some((c) => c.getAttribute("data-closed") === null)) {
      for (const id of matched) {
        handledIds.add(id)
        ownedPartIds.set(id, chain[chain.length - 1])
      }
      openedCount++
    }
  }
  return expandedAny
}

// painting: CSS Custom Highlight API (no DOM writes) with a <mark> fallback
// ---------------------------------------------------------------------------

const HL = "osh-search"
const HL_FLASH = "osh-search-flash"

type HighlightsApi = { set: (name: string, hl: unknown) => void; get: (name: string) => any; delete: (name: string) => void }
const highlightsApi = (): HighlightsApi | undefined =>
  typeof CSS !== "undefined" ? ((CSS as any).highlights as HighlightsApi | undefined) : undefined
const canHighlight = () => !!highlightsApi() && typeof (window as any).Highlight === "function"

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** ranges of every case-insensitive match in the scroller's mounted text */
function collectRanges(scope: HTMLElement, q: string, cap = 4000): Range[] {
  const re = new RegExp(escapeRe(q), "gi")
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = (node as Text).parentElement
      if (!p) return NodeFilter.FILTER_REJECT
      const tag = p.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SCRIPT" || tag === "STYLE" || tag === "MARK") return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const out: Range[] = []
  let cur = walker.nextNode()
  while (cur && out.length < cap) {
    const t = cur as Text
    const raw = t.nodeValue ?? ""
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(raw)) && out.length < cap) {
      const r = document.createRange()
      r.setStart(t, m.index)
      r.setEnd(t, m.index + m[0].length)
      out.push(r)
      if (m[0].length === 0) re.lastIndex++
    }
    cur = walker.nextNode()
  }
  return out
}

function paint(sc: HTMLElement, q: string) {
  if (canHighlight()) {
    // drop any fallback marks left from a previous build
    clearDomMarks(sc)
    const ranges = q ? collectRanges(sc, q) : []
    const hl = new (window as any).Highlight()
    for (const r of ranges) hl.add(r)
    highlightsApi()!.set(HL, hl)
    stats.matches = ranges.length
    return
  }
  clearDomMarks(sc)
  if (q) markMatchesDom(sc, q)
}

function clearPaint() {
  if (canHighlight()) highlightsApi()!.delete(HL)
  const sc = transcriptScroller()
  if (sc) clearDomMarks(sc)
  stats.matches = 0
}

/** fallback for browsers without the Custom Highlight API */
function markMatchesDom(root: HTMLElement, q: string) {
  const needle = q.toLowerCase()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = (node as Text).parentElement
      if (!p) return NodeFilter.FILTER_REJECT
      const tag = p.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SCRIPT" || tag === "STYLE" || tag === "MARK") return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const targets: Text[] = []
  let cur = walker.nextNode()
  while (cur) {
    targets.push(cur as Text)
    cur = walker.nextNode()
  }
  const parents = new Set<Node>()
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
    const parent = t.parentNode
    if (parent) {
      parent.replaceChild(frag, t)
      parents.add(parent)
    }
  }
  // one normalize per parent (normalizing per mark was quadratic)
  for (const p of parents) (p as Element).normalize()
}

function clearDomMarks(root: HTMLElement) {
  const parents = new Set<Node>()
  for (const m of Array.from(root.querySelectorAll("mark.osh-search-hit"))) {
    const parent = m.parentNode
    if (!parent) continue
    parent.replaceChild(document.createTextNode(m.textContent ?? ""), m)
    parents.add(parent)
  }
  for (const p of parents) (p as Element).normalize()
}

/** flash the first match inside el (or the element itself when the match
 *  is inside a renderer we cannot range, e.g. no visible text) */
function flashMatch(el: HTMLElement, q: string) {
  if (!q) return
  if (canHighlight()) {
    const range = collectRanges(el, q, 1)[0]
    if (range) {
      const hl = new (window as any).Highlight()
      hl.add(range)
      highlightsApi()!.set(HL_FLASH, hl)
      setTimeout(() => highlightsApi()?.delete(HL_FLASH), 1600)
      return
    }
  } else {
    const first = el.querySelector<HTMLElement>("mark.osh-search-hit")
    if (first) {
      first.classList.add("osh-search-hit-active")
      setTimeout(() => first.classList.remove("osh-search-hit-active"), 1600)
      return
    }
  }
  el.classList.add("osh-search-flash-row")
  setTimeout(() => el.classList.remove("osh-search-flash-row"), 1600)
}

function clearEngine() {
  cancelTimers()
  jumpGen++
  running = false
  engineMutating = false
  querySettled = false
  stats.settled = false
  handledIds = new Set<string>()
  resolvedQuery = ""
  marksDirty = false
  lastMarkedQuery = ""
  clearPaint()
  // close what we opened, then drop ownership so a remount cannot
  // resurrect the expansion
  engineMutating = true
  try {
    for (const [id, el] of Array.from(ownedPartIds)) {
      if (el && el.isConnected) toggleClose(el)
      ownedPartIds.delete(id)
    }
    for (const [row] of Array.from(ownedContainers)) {
      if (row.isConnected) {
        const el = row.querySelector<HTMLElement>('[data-component="collapsible"]') ?? row.closest<HTMLElement>('[data-component="collapsible"]')
        if (el) toggleClose(el)
      }
    }
    ownedContainers.clear()
  } finally {
    engineMutating = false
  }
  for (const d of Array.from(openedDetails)) {
    if (d.isConnected) d.open = false
    openedDetails.delete(d)
  }
  clearDisclosureOwnership()
  suppressObserverUntil = typeof performance !== "undefined" ? performance.now() + 120 : 0
}

/** clear the search entirely (session/view navigation uses this: hits
 *  from another session must not linger) */
export function clearSearch() {
  if (state.query) setState({ query: "", active: null, hitPartIds: [] })
  stats.hitIds = []
  clearEngine()
}

// ---------------------------------------------------------------------------
// binding: keep the observer + scroll listener on the ACTIVE scroller
// ---------------------------------------------------------------------------

let boundScroll: HTMLElement | undefined
let rebindTimer: ReturnType<typeof setInterval> | undefined

const onScroll = () => {
  if (running || engineMutating) return
  if (!querySettled || !state.query.trim()) return
  marksDirty = true
  if (!fastPending) {
    fastPending = true
    requestAnimationFrame(() => expandMountedNow())
  }
  requestContentPass()
}

const onMutations = (muts: MutationRecord[]) => {
  if (running || engineMutating) return
  if (typeof performance !== "undefined" && performance.now() < suppressObserverUntil) return
  if (muts.every((m) => m.type === "attributes")) return
  if (!state.query.trim() || !querySettled) return
  const mounted = muts.some((m) => m.addedNodes.length > 0)
  marksDirty = true
  if (mounted) {
    if (!fastPending) {
      fastPending = true
      requestAnimationFrame(() => expandMountedNow())
    }
    return
  }
  requestContentPass()
}

/** bind observer + scroll listener to the active scroller; identity
 *  guarded, safe to call on every pass */
function attach() {
  const sc = transcriptScroller()
  if (sc && sc === scrollerEl && sc === boundScroll) return
  scrollerEl = sc
  observer?.disconnect()
  boundScroll?.removeEventListener("scroll", onScroll)
  boundScroll = undefined
  if (!sc) return
  observer = new MutationObserver(onMutations)
  observer.observe(sc, { childList: true, subtree: true, characterData: false })
  // virtualized scrolling repositions rows with style/transform updates
  // only (attribute churn, filtered above) - without this listener no
  // pass ever ran while scrolling
  sc.addEventListener("scroll", onScroll, { passive: true })
  boundScroll = sc
}

export function ensureSearchEngine() {
  if (engineStarted || typeof window === "undefined") return
  engineStarted = true
  attach()
  // the scroller is replaced across views/modes and the focus overlay
  // mounts a second one; a light interval re-binds while a search is
  // active (a root MutationObserver would fire on every virtualized row
  // mount and force layout reads during scrolling)
  rebindTimer = setInterval(() => {
    if (state.query.trim()) attach()
  }, 800)
}

/** scroll to a hit's part. Resolves ONLY when a target was actually
 *  found and scrolled - the caller falls back to section/message
 *  navigation otherwise (returning true unconditionally disabled the
 *  fallback, so prompt/response hits went nowhere). */
export function jumpToHit(hit: SearchHit, smooth: boolean, retryOnly = false): boolean {
  const sc = transcriptScroller()
  if (!sc) return false
  attach()
  const q = state.query.trim()
  if (!retryOnly && q && !querySettled) {
    // an explicit jump is deliberate: don't wait for the typing settle
    querySettled = true
    stats.settled = true
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = undefined
  }
  if (!retryOnly) runPass()
  const gen = ++jumpGen
  const findTarget = (): HTMLElement | null => {
    if (hit.partId) {
      const part = sc.querySelector<HTMLElement>(`[data-timeline-part-id="${CSS.escape(hit.partId)}"]`)
      if (part) return part
      const listed = Array.from(sc.querySelectorAll<HTMLElement>("[data-timeline-part-ids]")).find((el) =>
        (el.getAttribute("data-timeline-part-ids") ?? "")
          .split(",")
          .map((s) => s.trim())
          .includes(hit.partId!),
      )
      if (listed) return listed
    }
    return sc.querySelector<HTMLElement>(`[data-section-key$=":${CSS.escape(hit.sectionId)}"]`)
  }
  const target = findTarget()
  if (!target) return false
  target.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" })
  if (jumpTimer) clearTimeout(jumpTimer)
  jumpTimer = setTimeout(() => {
    if (gen === jumpGen) flashMatch(target, q)
  }, 280)
  return true
}
