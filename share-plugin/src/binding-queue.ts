/** Serialize session-metadata binding writes.
 *
 * Two writers read-modify-write `metadata.openshare` on the same session:
 * the engine (`writeMetadata` in core.ts — preserves foreign keys, sets
 * the servers map) and the TUI (`patchSessionBinding` in share-flow.ts —
 * opt-outs, collision resolution). Their PATCHes interleave at the host:
 * writer A reads at T0, writer B reads at T1, A PATCHes at T2, B PATCHes
 * at T3 — A's change is silently lost (live-caught class: a TUI opt-out
 * erased by the engine's binding refresh).
 *
 * Both route their whole read-modify-write through this per-session FIFO.
 * The queue never breaks on errors; entries drop when the process exits.
 */
const queues = new Map<string, Promise<unknown>>()

export function queueBindingWrite<T>(sid: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(sid) ?? Promise.resolve()
  // run regardless of the previous slot's outcome — one failed write must
  // not wedge the session's binding updates forever
  const run = prev.then(fn, fn)
  queues.set(
    sid,
    run.catch(() => {}),
  )
  return run
}
