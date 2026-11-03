// Viewer-side copy of the task-call -> child-prompt pairing ladder, for
// OLD shares whose data predates the plugin's promptID/toolCallID stamps.
// New shares read the stamps; unstamped ones run this fallback at fold
// time (we were not there live, so text coverage is the only signal that
// can be trusted - see task-pairing.ts in share-plugin for the live
// version and the reasoning. Keep the two in step.)

export type PairCall = { created: number; prompt?: string }
export type PairMsg = { id: string; created: number; text: string }

export const COVERAGE_MIN = 0.75

const norm = (s: string) => s.replace(/\r\n/g, "\n").trim()
const normTokens = (s: string) =>
  s.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim().split(" ").filter(Boolean)

/** longest common contiguous run of tokens inside [alo,ahi) x [blo,bhi),
 *  as [aStart, bStart, length] or undefined */
function longestRun(a: string[], b: string[], alo: number, ahi: number, blo: number, bhi: number): [number, number, number] | undefined {
  const byLine = new Map<string, number[]>()
  for (let j = blo; j < bhi; j++) {
    const list = byLine.get(b[j])
    if (list) list.push(j)
    else byLine.set(b[j], [j])
  }
  let best: [number, number, number] | undefined
  let bestLen = 0
  const run = new Int32Array(bhi - blo + 1)
  for (let i = ahi - 1; i >= alo; i--) {
    const js = byLine.get(a[i])
    if (!js) continue
    for (const j of js) {
      const len = 1 + (run[j + 1 - blo] ?? 0)
      run[j - blo] = len
      if (len > bestLen) {
        bestLen = len
        best = [i, j, len]
      }
    }
  }
  return best
}

/** difflib-style matching blocks (monotonic in both sides): the longest
 *  run, then the regions to its left and right, recursively. Tolerates
 *  minor internal edits (renamed files) between long matched stretches
 *  while keeping order - a shuffled child matches almost nothing. */
function matchingBlocks(a: string[], b: string[]): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = []
  const queue: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]]
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!
    const m = longestRun(a, b, alo, ahi, blo, bhi)
    if (!m || m[2] === 0) continue
    out.push(m)
    queue.push([alo, m[0], blo, m[1]])
    queue.push([m[0] + m[2], ahi, m[1] + m[2], bhi])
  }
  return out.sort((x, y) => x[0] - y[0])
}

/** fraction of the CALL's prompt text found in the child message, in
 *  order: length-weighted prompt-side coverage over token-aligned
 *  blocks. Host additions around or inside the prompt (preambles,
 *  inlined @files, pasted output) are unmatched tokens on the CHILD side
 *  and cost nothing; edits inside the prompt (renamed filenames) cost
 *  only the changed tokens. */
export function promptCoverage(childText: string, prompt: string): number {
  const b = norm(prompt)
  if (!b) return 0
  if (norm(childText).includes(b)) return 1
  const child = normTokens(childText)
  const want = normTokens(prompt)
  const total = want.reduce((s, t) => s + t.length + 1, 0)
  if (!total) return 0
  const matched = matchingBlocks(want, child).reduce((s, [wi, , n]) => {
    let add = 0
    for (let k = wi; k < wi + n; k++) add += want[k].length + 1
    return s + add
  }, 0)
  return Math.min(1, matched / total)
}

/** The child prompt the call created, or undefined. `candidates` must be
 *  sorted by creation; ids in `claimed` belong to earlier calls. */
export function pairPromptID(call: PairCall, candidates: PairMsg[], claimed: Set<string>): string | undefined {
  const open = candidates.filter((c) => !claimed.has(c.id))
  if (open.length === 0) return undefined
  let best = 0
  let pick: PairMsg | undefined
  for (const c of open) {
    const cov = promptCoverage(c.text, call.prompt ?? "")
    if (cov > best) {
      best = cov
      pick = c
    }
  }
  return pick && best >= COVERAGE_MIN ? pick.id : undefined
}
