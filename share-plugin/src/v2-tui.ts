/**
 * OpenCode v2 TUI plugin implementation: builds a ShareHostApi adapter
 * over the v2 TUI plugin context so the unchanged share flows and settings
 * dialog run on both hosts, and registers the same commands (one reactive
 * keymap layer).
 *
 * Dialog bridging (family pattern): the v1 api exposes dialog components
 * that RETURN JSX rendered inside an enclosing `dialog.replace(render)`
 * entry; the v2 api only offers promise-based dialogs that open their own
 * host entry. The bridge reconciles the two — `replace()` invokes the
 * render thunk synchronously; if it returned nothing (a DialogX bridge
 * already opened the host's own dialog), the caller's onClose is parked
 * and invoked when that nested dialog is dismissed without a result.
 */

import { createSignal } from "solid-js"
import { registerCommands } from "./commands.js"
import type { ClientApi } from "./core.js"
import type { ShareHostApi, ShareHostKeymapLayer } from "./tui-host.js"
import type { V2KeymapCommand, V2KeymapLayer, V2TuiContext, V2TuiSetup } from "./v2-types.js"

function pickThemeToken(source: unknown, ...path: Array<string | number>): unknown {
  let current: unknown = source
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function buildV2Theme(context: V2TuiContext) {
  // Read theme/mode live inside the getter so mid-session theme switches
  // reach the flows.
  return {
    get current() {
      const theme = context.theme
      const dark = context.themeMode === "dark"
      const text = pickThemeToken(theme, "text", "default")
      return {
        text,
        textMuted: pickThemeToken(theme, "text", "subdued") ?? text,
        background: pickThemeToken(theme, "background", "default"),
        backgroundPanel: pickThemeToken(theme, "background", "surface", "offset") ?? pickThemeToken(theme, "background", "default"),
        primary: pickThemeToken(theme, "text", "action", "primary", "selected") ?? text,
        secondary: pickThemeToken(theme, "hue", dark ? "interactive" : "neutral", dark ? 300 : 700) ?? text,
        accent: pickThemeToken(theme, "hue", "accent", dark ? 200 : 800) ?? text,
        success: pickThemeToken(theme, "text", "feedback", "success", "default") ?? text,
        warning: pickThemeToken(theme, "text", "feedback", "warning", "default") ?? text,
        error: pickThemeToken(theme, "text", "feedback", "error", "default") ?? text,
        info: pickThemeToken(theme, "text", "feedback", "info", "default") ?? text,
      }
    },
  }
}

function convertKeymapLayer(layer: ShareHostKeymapLayer): V2KeymapLayer {
  const bindingsByName = new Map<string, string[]>()
  for (const binding of layer.bindings ?? []) {
    if (!binding?.cmd) continue
    const keys = bindingsByName.get(binding.cmd) ?? []
    keys.push(binding.key)
    bindingsByName.set(binding.cmd, keys)
  }
  const commands: V2KeymapCommand[] = (layer.commands ?? []).map((command) => ({
    id: command.name,
    title: command.title ?? command.name,
    description: command.desc,
    group: command.group ?? command.category,
    palette: true as const,
    ...(command.slashName ? { slash: { name: command.slashName, ...(command.slashAliases?.length ? { aliases: command.slashAliases } : {}) } } : {}),
    ...(command.suggested !== undefined ? { suggested: command.suggested } : {}),
    ...(command.enabled !== undefined ? { enabled: command.enabled } : {}),
    ...(bindingsByName.get(command.name)?.length ? { bind: bindingsByName.get(command.name)!.join(",") } : {}),
    run: (_input?: string, event?: { preventDefault?: () => void; stopPropagation?: () => void }) =>
      command.run({
        event: event
          ? {
              preventDefault: () => event.preventDefault?.(),
              stopPropagation: () => event.stopPropagation?.(),
            }
          : undefined,
      }),
  }))
  return { mode: layer.mode ?? "global", priority: layer.priority, commands }
}

/** Builds the v1-shaped ShareHostApi facade over a v2 TUI plugin context. */
export function buildV2HostApi(context: V2TuiContext): ShareHostApi {
  const disposeFns: Array<() => void> = []

  // --- kv: synchronous read-your-writes mirror over the persistent store ---
  const [kvStore, kvMutate] = context.storage.store("kv", { initial: {} as Record<string, unknown> })
  const kvMirror: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(kvStore as Record<string, unknown>)) kvMirror[key] = value
  const kv = {
    get<Value = unknown>(key: string, fallback?: Value): Value {
      const value = key in kvMirror ? kvMirror[key] : (kvStore as Record<string, unknown>)[key]
      return (value === undefined ? fallback : value) as Value
    },
    set(key: string, value: unknown) {
      kvMirror[key] = value
      void kvMutate((draft) => {
        draft[key] = value
      }).catch(() => undefined)
    },
  }

  // --- dialog bridging (see module doc comment) ---
  const dialog = context.ui.dialog
  let nestedOnClose: (() => void) | undefined
  const settleNested = (dismissed: boolean) => {
    const onClose = nestedOnClose
    nestedOnClose = undefined
    if (dismissed) onClose?.()
  }

  return {
    hostVersion: 2,
    app: { version: context.app?.version },
    client: context.client as unknown as ClientApi,
    kv,
    lifecycle: {
      onDispose(fn: () => void) {
        disposeFns.push(fn)
      },
    },
    theme: buildV2Theme(context),
    ui: {
      toast: (input) => {
        try {
          context.ui.toast.show({ title: input.title, message: input.message, variant: input.variant, duration: input.duration })
        } catch {
          /* toasts must never crash the flows */
        }
      },
      dialog: {
        replace(renderer: unknown, onClose?: () => void) {
          nestedOnClose = undefined
          let content: unknown
          try {
            content = typeof renderer === "function" ? (renderer as () => unknown)() : renderer
          } catch {
            content = undefined
          }
          if (content === undefined || content === null) {
            nestedOnClose = onClose
            return
          }
          dialog.show(() => content, onClose)
        },
        clear() {
          nestedOnClose = undefined
          dialog.clear()
        },
        setSize(size: string) {
          try {
            dialog.set({ size })
          } catch {
            /* size hints are best-effort */
          }
        },
      },
      DialogSelect(props) {
        void dialog
          .select({
            title: props.title,
            placeholder: props.placeholder,
            current: props.current,
            options: props.options.map((option) => ({
              title: option.title,
              value: option.value,
              description: option.description,
              category: option.category,
              disabled: option.disabled,
            })),
          })
          .then((value) => {
            if (value === undefined) {
              settleNested(true)
              return
            }
            settleNested(false)
            const option = props.options.find((item) => item.value === value)
            if (option) props.onSelect(option)
          })
          .catch(() => settleNested(true))
      },
      DialogPrompt(props) {
        void dialog
          .prompt({ title: props.title, placeholder: props.placeholder, value: props.value })
          .then((value) => {
            settleNested(value === undefined)
            if (value === undefined) props.onCancel?.()
            else props.onConfirm(value)
          })
          .catch(() => {
            settleNested(true)
            props.onCancel?.()
          })
      },
      DialogConfirm(props) {
        void dialog
          .confirm({ title: props.title, message: props.message, label: { confirm: props.confirmLabel } })
          .then((result) => {
            settleNested(result !== true)
            if (result === true) props.onConfirm()
            else props.onCancel?.()
          })
          .catch(() => {
            settleNested(true)
            props.onCancel?.()
          })
      },
      DialogAlert(props) {
        void dialog
          .alert({ title: props.title, message: props.message })
          .then(() => {
            settleNested(false)
            props.onConfirm?.()
          })
          .catch(() => {
            settleNested(true)
            props.onConfirm?.()
          })
      },
    },
    keymap: {
      registerLayer(layer: ShareHostKeymapLayer) {
        // v2 layers are reactive: the input function re-evaluates when the
        // signal flips, so "unregistering" disables the layer.
        const [active, setActive] = createSignal(true)
        try {
          context.keymap.layer(() =>
            active()
              ? convertKeymapLayer(layer)
              : { mode: "global", enabled: false, commands: [], bindings: [] },
          )
        } catch {
          return () => undefined
        }
        return () => {
          setActive(false)
        }
      },
    },
    sessionInfo: () => undefined,
    currentSessionID: undefined,
    clipboard: {
      async write(text) {
        try {
          const clip = (navigator as unknown as { clipboard?: { writeText?: (t: string) => Promise<void> } }).clipboard
          if (typeof clip?.writeText === "function") {
            await clip.writeText(text)
            return true
          }
        } catch {}
        return false
      },
    },
  }
}

/**
 * v2 TUI plugin setup: registers the share commands (one reactive keymap
 * layer). Session-context wiring (currentSessionID) finalizes in phase 4
 * once the beta's session/route surface is verified.
 */
export function createV2TuiSetup(): V2TuiSetup {
  return async (context: V2TuiContext) => {
    const host = buildV2HostApi(context)
    const sessionID = () => host.currentSessionID?.() ?? undefined
    const unregister = registerCommands(host, sessionID)
    return () => {
      try {
        unregister()
      } catch {}
    }
  }
}
