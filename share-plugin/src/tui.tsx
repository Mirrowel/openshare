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
import { createSidebarSlot } from "./sidebar.js"
import type { ShareHostApi } from "./tui-host.js"
import { createV2TuiSetup } from "./v2-tui.js"

/** Builds the host facade over the v1 TuiPluginApi. */
export function buildV1HostApi(api: TuiPluginApi): ShareHostApi {
  return {
    hostVersion: 1,
    app: { version: api.app?.version },
    client: api.client as unknown as ClientApi,
    kv: api.kv,
    lifecycle: api.lifecycle,
    theme: api.theme,
    ui: {
      toast: (input) => api.ui.toast(input),
      dialog: api.ui.dialog,
      DialogSelect: (props) => api.ui.DialogSelect(props as never) as never,
      DialogPrompt: (props) => api.ui.DialogPrompt(props as never) as never,
      DialogConfirm: (props) => api.ui.DialogConfirm(props as never) as never,
      DialogAlert: (props) => api.ui.DialogAlert(props as never) as never,
    },
    keymap: {
      registerLayer(layer) {
        return api.keymap.registerLayer({
          mode: layer.mode,
          priority: layer.priority,
          commands: layer.commands.map((command) => ({
            namespace: "palette",
            name: command.name,
            title: command.title,
            desc: command.desc,
            category: command.category,
            slashName: command.slashName,
            slashAliases: command.slashAliases,
            suggested: command.suggested,
            hidden: command.hidden,
            enabled: command.enabled,
            run: (ctx: unknown) => command.run((ctx ?? {}) as never),
          })),
          bindings: layer.bindings as never[],
        })
      },
    },
    sessionInfo: (sid) => api.state.session.get(sid) as never,
    currentSessionID: () => {
      const route = api.route.current
      return route.name === "session" ? (route.params?.sessionID as string | undefined) : undefined
    },
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

const tui: TuiPlugin = async (api) => {
  const host = buildV1HostApi(api)

  const sessionID = () => host.currentSessionID?.() ?? undefined
  const unregister = registerCommands(host, sessionID)

  // sidebar chip (v1 slots; the v2 context has no slot registry). The
  // slots registry has no unregister API — registration lives for the
  // process lifetime.
  try {
    api.slots.register(createSidebarSlot(api) as never)
  } catch {
    /* the chip is decorative — registration failure must not break sharing */
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
