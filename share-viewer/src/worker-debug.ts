// Dev-only worker-channel tracer. Wraps window.Worker before the app boots so
// every pool message (initialize payloads with their theme, render tasks,
// initialize acks, worker errors) lands in window.__oshWorkerLog with a
// timestamp and a worker instance id. Diagnoses worker state mismatches such
// as a task running with the worker module's default theme. Absent from
// production builds (import.meta.env.DEV).
if (import.meta.env.DEV) {
  const log: Record<string, unknown>[] = []
  ;(window as unknown as { __oshWorkerLog: Record<string, unknown>[] }).__oshWorkerLog = log
  const Orig = window.Worker
  let nextId = 0
  const at = () => Math.round(performance.now())

  const Wrapped = function (this: unknown, url: string | URL, opts?: WorkerOptions) {
    const w = new Orig(url, opts) as Worker & { __oshId?: number }
    const id = ++nextId
    w.__oshId = id
    log.push({ ev: "new", id, url: String(url).slice(-70), at: at() })
    const post = w.postMessage.bind(w)
    w.postMessage = ((msg: unknown, ...rest: unknown[]) => {
      const m = msg as { type?: string; request?: Record<string, unknown> } | undefined
      const req = (m?.request ?? m) as Record<string, unknown> | undefined
      const ro = req?.renderOptions as { theme?: unknown } | undefined
      log.push({ ev: "post", id, kind: m?.type, req: req?.type, theme: ro?.theme, reqTheme: req?.theme, at: at() })
      return (post as (m: unknown, ...r: unknown[]) => void)(msg, ...rest)
    }) as Worker["postMessage"]
    w.addEventListener("message", (e: MessageEvent) => {
      const d = e.data as { type?: string; requestType?: string; error?: unknown } | undefined
      if (d?.type === "error") log.push({ ev: "err", id, req: d.requestType, error: String(d.error).slice(0, 100), at: at() })
      else if (d?.requestType === "initialize") log.push({ ev: "init-ok", id, at: at() })
    })
    return w
  } as unknown as typeof Worker
  Wrapped.prototype = Orig.prototype
  ;(window as unknown as { Worker: typeof Worker }).Worker = Wrapped
}
