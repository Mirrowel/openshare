// Durable guard for a pierre worker that renders with its module-default theme
// ("pierre-dark") instead of the pool's registered theme: the task then throws
// "Theme ... has not been resolved" and every later task on that worker repeats
// it. The pool's own handshake should make this impossible (a worker only
// receives tasks after acking initialize), so when it happens anyway we repair
// the worker in place: resolve the pool's themes on the main thread and re-send
// the initialize handshake to that worker. The failing task still degrades to
// the kit's plain-text fallback; the guard stops the error from repeating.
import { WorkerPoolManager } from "@pierre/diffs/worker"
import { getThemes, resolveThemes } from "@pierre/diffs"

let installed = false
let seq = 0

export function installPierreGuard() {
  if (installed) return
  installed = true
  const proto = WorkerPoolManager.prototype as unknown as {
    handleWorkerMessage: (managedWorker: unknown, response: { type?: string; error?: unknown }) => void
  }
  const orig = proto.handleWorkerMessage
  const healed = new WeakSet<object>()

  proto.handleWorkerMessage = function (managedWorker: unknown, response) {
    try {
      const err = typeof response?.error === "string" ? response.error : ""
      if (response?.type === "error" && err.includes("has not been resolved") && !healed.has(managedWorker as object)) {
        healed.add(managedWorker as object)
        const pool = this as unknown as {
          renderOptions?: { theme?: unknown }
          preferredHighlighter?: string
        }
        const worker = (managedWorker as { worker?: Worker }).worker
        const themes = getThemes(pool.renderOptions?.theme as never)
        void resolveThemes(themes, pool.preferredHighlighter as never)
          .then((resolved) => {
            worker?.postMessage({
              type: "initialize",
              id: `osh-heal-${++seq}`,
              renderOptions: pool.renderOptions,
              preferredHighlighter: pool.preferredHighlighter,
              resolvedThemes: resolved,
              resolvedLanguages: [],
              resultFormat: "hast-ops-v1",
            })
          })
          .catch(() => {})
        console.warn("[openshare] worker lost its theme; re-sent initialize", { theme: pool.renderOptions?.theme })
      }
    } catch {}
    return orig.call(this, managedWorker, response)
  }
}
