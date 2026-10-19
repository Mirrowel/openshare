/** @jsxImportSource @opentui/solid */

// OpenShare TUI plugin entry (OpenCode v1).
//
// Registers the /share, /unshare (shadowing the deprecated opncd.ai
// built-ins via a priority keymap layer) and /openshare commands, plus the
// sidebar_title slot chip. The flows run against the ShareHostApi facade
// (tui-host.ts); v2 hosts run the same flows through the v2-tui adapter.

import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { ClientApi } from "./core.js"
import { registerCommands } from "./commands.js"
import { createSidebarSlot, dbgLog, dbg } from "./sidebar.js"
import { showAlertMenu, showConfirmMenu, showMenuOnce, showPromptOnce, toMenuOptions } from "./dialogs.js"
import type { ShareHostApi } from "./tui-host.js"
import { createV2TuiSetup } from "./v2-tui.js"

/** Builds the host facade over the v1 TuiPluginApi. */
export function buildV1HostApi(api: TuiPluginApi): ShareHostApi {
  return {
    hostVersion: 1,
    app: { version: api.app?.version },
    // 1.19.x hands plugins the v2 SDK client — a LAZY PROXY (methods
    // materialize on property access; spreading it destroys them, which
    // broke session.update: live-caught "no client.session.update" after
    // the adapter was added). Wrap with passthrough Proxies instead:
    //  - path args are translated id -> sessionID (the v2 SDK's URL
    //    builder left "{sessionID}" literally in the URL for {path:{id}}
    //    calls — server log: "Expected a string starting with ses, got
    //    %7BsessionID%7D" — so every session.get/update failed silently),
    //  - session.get fills metadata from the state store when the v2
    //    response lacks it,
    //  - everything else reaches the original proxy untouched.
    client: (() => {
      const raw = api.client as unknown as Record<string, unknown> & { session?: Record<string, unknown> }
      const rawSession = raw?.session
      if (!rawSession) return raw as unknown as ClientApi
      const translateArgs = (args: unknown): unknown => {
        if (!args || typeof args !== "object") return args
        const a = args as { path?: Record<string, unknown>; body?: Record<string, unknown> }
        if (a.path && "id" in a.path && !("sessionID" in a.path)) {
          const { id, ...rest } = a.path
          return { ...a, path: { ...rest, sessionID: id } }
        }
        return args
      }
      // v2 arg-shape probing: hey-api left "{sessionID}" literally in the
      // URL for {path:{id}} calls (server: "Expected a string starting
      // with ses, got %7BsessionID%7D"), and {path:{sessionID}} fared no
      // better — the v2 convention is FLAT args ({sessionID, ...body},
      // matching the beta client's SessionUpdateInput). Failed calls are
      // side-effect-free (URL 500s), so probe: path-shape first, then
      // flat. The winning shape is cached and logged once.
      let argShape: "path" | "flat" | undefined
      const callV2 = async (method: string, args: unknown): Promise<Record<string, unknown> | undefined> => {
        const orig = rawSession[method] as ((a: unknown) => Promise<unknown>) | undefined
        if (!orig) return undefined
        const a = args as { path?: Record<string, unknown>; body?: Record<string, unknown> }
        const flat = { sessionID: a.path?.id ?? a.path?.sessionID, ...(a.body ?? {}) }
        const attempts: Array<["path" | "flat", unknown]> =
          argShape === "flat"
            ? [["flat", flat]]
            : argShape === "path"
              ? [["path", translateArgs(args)]]
              : [
                  ["path", translateArgs(args)],
                  ["flat", flat],
                ]
        let last: Record<string, unknown> | undefined
        for (const [shape, callArgs] of attempts) {
          try {
            last = (await orig.call(rawSession, callArgs)) as Record<string, unknown> | undefined
          } catch (e) {
            last = { error: e } as Record<string, unknown>
          }
          const failed = !last || (typeof last === "object" && "error" in last && (last as { error?: unknown }).error)
          if (!failed) {
            if (!argShape) {
              argShape = shape
              dbgLog(`client.${method} arg shape = ${shape}`)
            }
            return last
          }
        }
        return last
      }
      const adaptedGet = async (args: { path: { id: string } }) => {
        const res = (await callV2("get", args)) as Record<string, unknown> | undefined
        const info = (res && typeof res === "object" && "data" in (res as object) ? (res as { data?: Record<string, unknown> }).data : (res as Record<string, unknown> | undefined)) ?? undefined
        if (info && typeof info === "object" && !info.metadata) {
          const stateInfo = api.state.session.get(args.path.id) as { metadata?: Record<string, unknown> } | undefined
          if (stateInfo?.metadata) {
            dbgLog(`client.get metadata fallback: client keys=${Object.keys(info).slice(0, 12).join("|")} -> state metadata used`)
            if (res && typeof res === "object" && "data" in res) return { ...res, data: { ...info, metadata: stateInfo.metadata } }
            return { ...info, metadata: stateInfo.metadata }
          }
        }
        return res
      }
      const adaptedSession = new Proxy(rawSession, {
        get(target, key: string) {
          if (key === "get") return adaptedGet
          if (key === "update") return (args: unknown) => callV2("update", args)
          const value = Reflect.get(target, key, target)
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value
        },
      })
      return new Proxy(raw, {
        get(target, key: string) {
          if (key === "session") return adaptedSession
          const value = Reflect.get(target, key, target)
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value
        },
      }) as unknown as ClientApi
    })(),
    kv: api.kv,
    lifecycle: api.lifecycle,
    theme: api.theme,
    ui: {
      toast: (input) => api.ui.toast(input),
      // dialog.clear() THROWS on an already-empty stack on 1.19.x — and
      // flows legitimately clear after my components already settled+cleared
      // (the throw killed confirmShare before it started, live-caught via
      // the debug log). Idempotent wrapper for every call site.
      dialog: new Proxy({} as ShareHostApi["ui"]["dialog"], {
        get: (_t, key: string) => {
          if (key === "clear")
            return () => {
              try {
                api.ui.dialog.clear()
              } catch {}
            }
          if (key === "replace")
            return (render: () => unknown, onClose?: () => void) => {
              try {
                api.ui.dialog.replace(render as never, onClose)
              } catch (e) {
                dbgLog(`dialog.replace THREW: ${(e as Error)?.message ?? e}`)
              }
            }
          const value = (api.ui.dialog as unknown as Record<string, unknown>)[key]
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(api.ui.dialog) : value
        },
      }),
      // Promise menus — the family showMenuOnce pattern, ported verbatim.
      showMenu: (props) => showMenuOnce(api, { ...props, options: toMenuOptions(props.options) }),
      showConfirm: (props) => showConfirmMenu(api, props),
      showAlert: (props) => showAlertMenu(api, props),
      showPrompt: (props) => showPromptOnce(api, props),
      // CUSTOM interactive dialogs (family MenuDialog pattern: own
      // priority-10000 key layer + mode push + input shield). The host's
      // ui.DialogX components under plugin dialog.replace render but
      // receive no keys on opencode 1.19.x (live-caught + pty-reproduced).
      // These are component functions: flows invoke them inside their own
      // dialog.replace(() => ...) render thunk (the host renders the thunk
      // in a proper Solid root, so the hooks inside run with an owner).
      // DialogX bridge shims (v2 adapter / legacy call sites): route to the
      // ported promise menus. Nothing on v1 renders these through
      // dialog.replace anymore — flows use showMenu/showConfirm directly.
      DialogSelect: (props) => {
        void showMenuOnce(api, { title: props.title, options: toMenuOptions(props.options), current: props.current, hint: props.placeholder }).then((value) => {
          if (value === undefined) (props as { onCancel?: () => void }).onCancel?.()
          else {
            const option = props.options.find((o) => o.value === value)
            if (option) (props as { onSelect: (o: unknown) => void }).onSelect(option)
          }
        })
        return undefined as never
      },
      DialogPrompt: (props) => {
        void showPromptOnce(api, { title: props.title, placeholder: props.placeholder, value: props.value }).then((value) => {
          if (value === undefined) (props as { onCancel?: () => void }).onCancel?.()
          else (props as { onConfirm: (v: string) => void }).onConfirm(value)
        })
        return undefined as never
      },
      DialogConfirm: (props) => {
        void showConfirmMenu(api, { title: props.title, message: props.message, confirmLabel: props.confirmLabel }).then((yes) => (yes ? props.onConfirm() : (props as { onCancel?: () => void }).onCancel?.()))
        return undefined as never
      },
      DialogAlert: (props) => {
        void showAlertMenu(api, { title: props.title, message: props.message }).then(() => (props as { onConfirm?: () => void }).onConfirm?.())
        return undefined as never
      },
    },
    keymap: {
      registerLayer(layer) {
        // Host layer shape = exactly what the proven family plugins pass:
        // {commands, bindings}. NO mode (a declared mode gates the layer on
        // the mode stack; resting mode is "base" — the layer would never be
        // reachable), no priority, and command objects carry ONLY defined
        // fields (undefined-valued keys are not part of the working shape).
        const commands = layer.commands.map((command) => {
          const host: Record<string, unknown> = {
            namespace: "palette",
            name: command.name,
            title: command.title,
            run: (ctx: unknown) => command.run((ctx ?? {}) as never),
          }
          if (command.desc !== undefined) host.desc = command.desc
          if (command.category !== undefined) host.category = command.category
          if (command.slashName !== undefined) host.slashName = command.slashName
          if (command.slashAliases?.length) host.slashAliases = command.slashAliases
          if (command.suggested !== undefined) host.suggested = command.suggested
          if (command.hidden !== undefined) host.hidden = command.hidden
          if (command.enabled !== undefined) host.enabled = command.enabled
          return host
        })
        return api.keymap.registerLayer({ commands, bindings: layer.bindings as never[] })
      },
    },
    sessionInfo: (sid) => api.state.session.get(sid) as never,
    currentSessionID: () => {
      const route = api.route.current
      return route.name === "session" ? (route.params?.sessionID as string | undefined) : undefined
    },
    clipboard: {
      // navigator.clipboard.writeText resolves as a silent no-op in the
      // TUI runtime (live-caught: the menu copy said "copied" but nothing
      // landed; the sidebar chip worked because it falls back to OSC52).
      // Belt-and-braces: try navigator, then ALWAYS emit the OSC52 escape
      // — harmless when the terminal ignores it, correct when it honors it.
      async write(text) {
        let ok = false
        try {
          const clip = (navigator as unknown as { clipboard?: { writeText?: (t: string) => Promise<void> } }).clipboard
          if (typeof clip?.writeText === "function") {
            await clip.writeText(text).then(
              () => {
                ok = true
              },
              () => {},
            )
          }
        } catch {}
        try {
          process.stdout.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`)
          ok = true
        } catch {}
        return ok
      },
    },
  }
}

const tui: TuiPlugin = async (api) => {
  dbgLog(`tui entry running; host v=${dbg(api.app?.version)} slots=${!!api.slots} keymap=${!!api.keymap} state=${!!api.state}`)
  const host = buildV1HostApi(api)

  const sessionID = () => host.currentSessionID?.() ?? undefined
  const unregister = registerCommands(host, sessionID)

  // sidebar chip (v1 slots; the v2 context has no slot registry). The
  // slots registry has no unregister API — registration lives for the
  // process lifetime. (crash-hunt: registration errors are logged, not
  // swallowed — see sidebar.tsx for the temporary debug logger)
  try {
    const slot = createSidebarSlot(api)
    dbgLog(`registering sidebar slot: ${Object.keys(slot?.slots ?? {}).join(",") || "NO SLOTS"}`)
    const reg = api.slots.register(slot as never)
    dbgLog(`sidebar slot registered -> ${dbg(reg)}`)
  } catch (error) {
    dbgLog(`sidebar slot REGISTRATION THREW ${(error as Error)?.stack ?? String(error)}`)
  }

  api.lifecycle.onDispose(() => {
    try {
      unregister()
    } catch {}
  })
}

/**
 * Dual-target TUI entry.
 *
 * - OpenCode v1 (strict loader) requires `default.tui` to be a function;
 *   excess keys are ignored.
 * - OpenCode v2 requires `default` to be `{ id, setup }`.
 */
export default { id: "openshare", tui, setup: createV2TuiSetup() }
