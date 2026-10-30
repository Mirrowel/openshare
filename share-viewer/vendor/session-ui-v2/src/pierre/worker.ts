// @ts-nocheck — upstream beta type bug: preferredHighlighter "highlights" not in @pierre/diffs 1.6.1 HighlighterTypes
import { WorkerPoolManager } from "@pierre/diffs/worker"
import DiffsWorkerUrl from "@pierre/diffs/worker/worker.js?worker&url"
import { highlightOptions } from "./index"

// openshare fork: main-thread pierre pool. Offline snapshot files run from
// file://, where Worker construction throws SecurityError; instead of
// degrading rendering to plain text, the same worker module code runs
// in-page (./worker-shim, lazy-loaded so http pages never ship it):
// identical output, no parallelism.
let oshMainThreadPool: boolean | undefined
function pierreMainThreadPool(): boolean {
  if (oshMainThreadPool === undefined) {
    // offline snapshot files and data: module pages cannot run workers
    if (location.protocol === "file:" || !!(window as any).__MIRROBOT_SNAPSHOT__) return (oshMainThreadPool = true)
    oshMainThreadPool = false
  }
  return oshMainThreadPool
}
function lazyMainThreadWorker(lineDiffType: "none" | "word-line"): Worker {
  const listeners: Array<[string, unknown]> = []
  const queue: unknown[] = []
  let real: Worker | undefined
  let dead = false
  void import("./worker-shim").then((m) => {
    if (dead) return
    real = m.createMainThreadWorker(lineDiffType)
    for (const [t, cb] of listeners) real.addEventListener(t, cb as never)
    for (const req of queue) real.postMessage(req)
    listeners.length = 0
    queue.length = 0
  }).catch((e) => console.error("[openshare] main-thread pierre shim failed to load", e))
  return {
    addEventListener: (t: string, cb: unknown) => {
      if (real) real.addEventListener(t, cb as never)
      else listeners.push([t, cb])
    },
    removeEventListener: (t: string, cb: unknown) => {
      real?.removeEventListener(t, cb as never)
      const i = listeners.findIndex(([t2, cb2]) => t2 === t && cb2 === cb)
      if (i >= 0) listeners.splice(i, 1)
    },
    postMessage: (req: unknown) => {
      if (real) real.postMessage(req)
      else queue.push(req)
    },
    terminate: () => {
      dead = true
      real?.terminate()
    },
    onmessage: null,
    onerror: null,
    dispatchEvent: () => false,
  } as unknown as Worker
}
function pierreWorkerFactory(lineDiffType: "none" | "word-line"): Worker {
  if (!pierreMainThreadPool()) {
    try {
      return new Worker(DiffsWorkerUrl, { type: "module" })
    } catch {
      oshMainThreadPool = true
      console.warn("[openshare] workers unavailable; pierre renders on the main thread")
    }
  }
  return lazyMainThreadWorker(lineDiffType)
}

function createPool(lineDiffType: "none" | "word-line") {
  const pool = new WorkerPoolManager(
    {
      workerFactory: () => pierreWorkerFactory(lineDiffType),
      // poolSize defaults to 8. More workers = more parallelism but
      // also more memory. Too many can actually slow things down.
      // NOTE: 2 is probably better for OpenCode, as I think 8 might be
      // a bit overkill, especially because Safari has a significantly slower
      // boot up time for workers
      poolSize: pierreMainThreadPool() ? 1 : 2,
    },
    {
      ...highlightOptions,
      lineDiffType,
      // Pierre renders with the pool's options, not the viewer's, whenever the pool works. The "none" pool only
      // serves diffs above the large-file threshold, so it carries the plain-text fallback the viewer requests.
      ...(lineDiffType === "none" && { maxLineDiffLength: 0, tokenizeMaxLineLength: 1 }),
    },
  )

  void pool.initialize().catch((e) => console.warn("[openshare] pierre pool init failed", e))

  return pool
}

let plain: WorkerPoolManager | undefined

let diff: WorkerPoolManager | undefined

export function getWorkerPool(lineDiffType: "none" | "word-line" = "word-line"): WorkerPoolManager | undefined {
  if (typeof window === "undefined") return

  if (lineDiffType === "none") {
    if (!plain) plain = createPool("none")

    return plain
  }

  if (!diff) diff = createPool("word-line")

  return diff
}
