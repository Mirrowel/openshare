// Open(code)Share — OpenCode v2 server setup.
//
// The v2 host validates `default` as `{ id, setup }` and calls setup with
// the v2 plugin context (packages/plugin/src/promise). The v2 world is
// shaped differently from v1 in three places this adapter bridges:
//
//  1. Events: v2 publishes fine-grained domain events
//     (session.metadata.updated, session.text.started, session.tool.*,
//     session.step.*) — not v1's coarse session/message/part updates.
//     Mapping strategy: structural events (created/deleted/metadata/
//     status) pass into the engine directly; content events trigger a
//     debounced re-sync that pulls the fresh message list through the
//     client. The engine's keyed queue makes re-syncs idempotent, and
//     correctness never depends on decoding every fine-grained shape.
//
//  2. Client: the v2 client speaks /api/session with {sessionID} inputs,
//     unwrapped outputs and cursor pagination. The adapter below presents
//     the v1-shaped ClientApi the engine already speaks, including the
//     v2-message -> v1 message+parts conversion (the worker/viewer
//     contract is the v1 Data[] format).
//
//  3. Share mode: v2 auto-discovers the package's ./tui entrypoint, so
//     presence detection cannot scan tui.json. The adapter applies the
//     v2-native rule instead: when the plugin's own package declares the
//     tui entrypoint (oc-plugin), a human drives sharing -> manual; the
//     single-file build (no package) stays all-mode. Explicit shareMode
//     config still wins.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { METADATA_KEY, moduleDir, packageRoot } from "./config.js"
import { createEngine, type ClientApi, type Engine, type MessageInfo, type PartInfo } from "./core.js"

type V2Event = {
  type: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

type V2Message = {
  id: string
  type: string
  time?: { created?: number; completed?: number; streamed?: number }
  text?: string
  agent?: string
  model?: { providerID: string; id?: string; modelID?: string }
  content?: Array<Record<string, unknown>>
  error?: { message?: string } | null
  metadata?: Record<string, unknown>
}

type V2SessionClient = {
  get(input: { sessionID: string }): Promise<unknown>
  update(input: { sessionID: string; title?: string; metadata?: Record<string, unknown> }): Promise<unknown>
  list(input?: { directory?: string; parentID?: string; cursor?: string; limit?: number }): Promise<unknown>
  diff(input: { sessionID: string }): Promise<unknown>
  remove?(input: { sessionID: string }): Promise<unknown>
}

type V2MessageClient = {
  list(input: { sessionID: string; limit?: number; cursor?: string }): Promise<unknown>
}

type V2Context = {
  event?: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<V2Event>
  }
  client?: {
    session?: V2SessionClient
    message?: V2MessageClient
  }
  options?: Record<string, unknown>
  app?: { name?: string; version?: string; channel?: string }
  signal?: AbortSignal
}

// --- v2 client -> engine ClientApi ---------------------------------------------
// Contract v2: messages pass through VERBATIM as v2 session messages (the
// engine's ingestion detects v2-native shapes and enqueues them directly —
// no v1 conversion, no dropped compaction, no dropped user text).

function adaptSessionClient(session: V2SessionClient | undefined, message: V2MessageClient | undefined, directory: string | undefined): ClientApi | undefined {
  if (!session) return undefined
  const loc = () => (directory ? { directory } : undefined)

  const listAll = async () => {
    const out: unknown[] = []
    let cursor: string | undefined
    for (let page = 0; page < 50; page++) {
      const res = (await session.list({ ...loc(), cursor, limit: 100 })) as { data?: unknown[]; cursor?: { next?: string | null } } | undefined
      const data = res?.data
      if (Array.isArray(data)) out.push(...data)
      const next = res?.cursor?.next ?? undefined
      if (!next || !Array.isArray(data) || data.length === 0) break
      cursor = next
    }
    return out
  }

  const listMessages = async (sessionID: string) => {
    if (!message) return []
    const out: Array<{ info: unknown; parts: unknown[] }> = []
    let cursor: string | undefined
    for (let page = 0; page < 50; page++) {
      const res = (await message.list({ sessionID, limit: 100, cursor })) as
        | { data?: V2Message[]; cursor?: { next?: string | null } }
        | undefined
      const data = res?.data
      if (!Array.isArray(data)) break
      for (const raw of data) {
        if (raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string") {
          out.push({ info: raw, parts: [] })
        }
      }
      const next = res?.cursor?.next ?? undefined
      if (!next || data.length === 0) break
      cursor = next
    }
    return out
  }

  return {
    session: {
      async get(input) {
        const res = await session.get({ sessionID: input.path.id })
        return { data: res }
      },
      async update(input) {
        const body = input.body as { title?: string; metadata?: Record<string, unknown> }
        const res = await session.update({ sessionID: input.path.id, title: body.title, metadata: body.metadata })
        return { data: res }
      },
      async list() {
        return { data: await listAll() }
      },
      async messages(input) {
        return { data: await listMessages(input.path.id) }
      },
      async diff(input) {
        const res = await session.diff({ sessionID: input.path.id })
        return { data: res }
      },
    },
  }
}

// --- event classification --------------------------------------------------------

const SESSION_ITEM_EVENTS = new Set([
  "session.created",
  "session.renamed",
  "session.metadata.updated",
  "session.agent.selected",
  "session.model.selected",
  "session.moved",
  "session.permissions",
  "session.compaction.started",
  "session.compaction.ended",
])

const CONTENT_EVENTS_PREFIXES = [
  "session.text.",
  "session.reasoning.",
  "session.tool.",
  "session.message.",
  "session.step.streamed",
]

const BUSY_EVENTS = new Set(["session.step.started", "session.execution.started"])
const IDLE_EVENTS = new Set(["session.step.ended", "session.execution.succeeded", "session.execution.interrupted"])
const ERROR_EVENTS = new Set(["session.step.failed", "session.tool.failed", "session.retry.scheduled"])

function eventSessionID(event: V2Event): string | undefined {
  const data = event.data
  if (data && typeof data === "object" && typeof (data as { sessionID?: unknown }).sessionID === "string") {
    return (data as { sessionID: string }).sessionID
  }
  return undefined
}

// --- the setup ---------------------------------------------------------------------

function resolveV2ShareMode(options: Record<string, unknown> | undefined): "all" | "manual" | undefined {
  const explicit = options?.["shareMode"] ?? process.env.OPENSHARE_SHARE_MODE
  if (explicit === "all" || explicit === "manual") return explicit
  // v2-native presence: the v2 host auto-loads ./tui for packages that
  // declare it. The single-file build ships no package.json next to it.
  try {
    const root = packageRoot(moduleDir())
    const pkgPath = join(root, "package.json")
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
      const declared = pkg["oc-plugin"]
      if (Array.isArray(declared) && declared.includes("tui")) return "manual"
    }
  } catch {}
  return undefined
}

export function createV2ServerSetup() {
  return async (context: V2Context): Promise<(() => void) | void> => {
    if (!context?.event?.subscribe || !context.client?.session) {
      // v1 directory loads call BOTH `server` and `setup` on the default
      // export; the v1 input arrives here and trips this guard. That is
      // expected on v1 — stay inert and quiet (debug file only).
      if (process.env.OPENSHARE_DEBUG_FILE) {
        try {
          console.error(`[${METADATA_KEY}] v2 setup not applicable on this host — sharing handled by the server entry`)
        } catch {}
      }
      return () => {}
    }

    const directory = (context as { directory?: string }).directory
    const client = adaptSessionClient(context.client.session, context.client.message, directory)
    const modeOverride = resolveV2ShareMode(context.options)
    const engine: Engine = createEngine({
      client,
      pluginDir: moduleDir(),
      directory,
      options: modeOverride ? { ...context.options, shareMode: modeOverride } : context.options,
    })

    if (!engine.hooks.event) {
      return () => {}
    }

    // debounced content re-sync per session: fetch info + messages through
    // the client adapter and feed them into the engine as the v1 events it
    // understands (session.updated / message.updated / message.part.updated).
    // The engine's keyed queue makes repeated re-syncs idempotent.
    const pendingRefresh = new Map<string, ReturnType<typeof setTimeout>>()
    const refresh = (sessionID: string) => {
      let timer = pendingRefresh.get(sessionID)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        pendingRefresh.delete(sessionID)
        void (async () => {
          try {
            const info = await (client as NonNullable<typeof client>).session.get({ path: { id: sessionID } })
            await engine.hooks.event({
              event: { type: "session.updated", properties: { sessionID, info: (info as { data?: unknown }).data ?? info } },
            })
            const messages = await (client as NonNullable<typeof client>).session.messages?.({ path: { id: sessionID } })
            const list = ((messages as { data?: unknown })?.data ?? []) as Array<{ info: MessageInfo; parts: PartInfo[] }>
            for (const message of list) {
              await engine.hooks.event({
                event: { type: "message.updated", properties: { sessionID, info: message.info } },
              })
              for (const part of message.parts ?? []) {
                await engine.hooks.event({
                  event: { type: "message.part.updated", properties: { sessionID, part } },
                })
              }
            }
          } catch {
            /* refresh is best-effort; the next event retries */
          }
        })()
      }, 400)
      pendingRefresh.set(sessionID, timer)
    }

    const unsubscribe = (() => {
      let stopped = false
      const run = async () => {
        try {
          const stream = context.event!.subscribe!({ signal: context.signal })
          for await (const event of stream) {
            if (stopped) break
            if (!event || typeof event.type !== "string") continue
            const sid = eventSessionID(event)
            if (!sid) continue
            const type = event.type

            if (type === "session.deleted") {
              await engine.hooks.event({ event: { type, properties: { sessionID: sid } } })
              continue
            }
            if (type === "message.removed" || type === "message.part.removed") {
              // undo cleanup: forwarded verbatim — the engine emits the
              // tombstones that purge the reverted items from the share
              const data = (event.data ?? {}) as { messageID?: string; partID?: string }
              await engine.hooks.event({
                event: { type, properties: { sessionID: sid, messageID: data.messageID, partID: data.partID } },
              })
              continue
            }
            if (SESSION_ITEM_EVENTS.has(type)) {
              refresh(sid)
              continue
            }
            if (BUSY_EVENTS.has(type)) {
              await engine.hooks.event({ event: { type: "session.status", properties: { sessionID: sid, status: { type: "busy" } } } })
              refresh(sid)
              continue
            }
            if (IDLE_EVENTS.has(type)) {
              await engine.hooks.event({ event: { type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } } })
              refresh(sid)
              continue
            }
            if (type === "session.error" || type === "session.execution.failed") {
              // terminal failure: the share says error at the next idle
              // (recovered retries never set it)
              await engine.hooks.event({ event: { type: "session.error", properties: { sessionID: sid } } })
              continue
            }
            if (ERROR_EVENTS.has(type)) {
              await engine.hooks.event({ event: { type: "session.status", properties: { sessionID: sid, status: { type: "retry" } } } })
              continue
            }
            if (CONTENT_EVENTS_PREFIXES.some((prefix) => type.startsWith(prefix))) {
              refresh(sid)
              continue
            }
          }
        } catch {
          /* stream ended or aborted */
        }
      }
      void run()
      return () => {
        stopped = true
      }
    })()

    return () => {
      unsubscribe()
      for (const timer of pendingRefresh.values()) clearTimeout(timer)
      pendingRefresh.clear()
      void engine.hooks.dispose()
    }
  }
}
