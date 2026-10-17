// OpenShare command registration. The v1 layer shadows the deprecated
// built-in /share (opncd.ai) by registering the same command names with a
// higher layer priority; /openshare opens settings. Registration goes
// through the host facade so the v2 adapter feeds the same commands into
// its keymap layer.

import { currentPaletteCategory, declarePaletteCategory, schedulePaletteReconcile } from "./palette-category.js"
import { CONSENT_KV_KEY, confirmShare, currentConfig, isConfigured, resolveRoot, runShareFlow, runUnshareFlow } from "./share-flow.js"
import { onboardingDialog, settingsDialog } from "./settings.js"
import type { ShareHostApi, ShareHostLayerCommand } from "./tui-host.js"

function finish(host: ShareHostApi, result: { ok: boolean; message: string; url?: string; unconfigured?: boolean }) {
  host.ui.toast({
    variant: result.ok ? "success" : result.unconfigured ? "warning" : "error",
    title: "OpenShare",
    message: result.message,
    duration: result.ok ? 8000 : 15000,
  })
}

export function buildShareCommand(host: ShareHostApi, sessionID: () => string | undefined): ShareHostLayerCommand {
  return {
    name: "session.share",
    title: "Share session (re:share)",
    desc: "Share this session via openshare; copies the link when already shared",
    slashName: "share",
    run: async () => {
      host.ui.dialog.clear()
      const cfg = currentConfig()
      if (!isConfigured(cfg)) {
        void onboardingDialog(host)
        return
      }
      const result = await runShareFlow(host, sessionID())
      if (result.message === "consent required") {
        const root = await resolveRoot(host.client, sessionID() ?? "")
        host.ui.dialog.replace(
          () =>
            host.ui.DialogConfirm({
              title: "Share Session",
              message:
                "Publish this session (and its subagent sessions) to your openshare worker?\nThe link lets anyone with it read the conversation.",
              confirmLabel: "Share",
              onConfirm: () => {
                host.ui.dialog.clear()
                host.kv.set(CONSENT_KV_KEY, true)
                void confirmShare(host, root).then((res) => finish(host, res))
              },
              onCancel: () => host.ui.dialog.clear(),
            }),
          () => host.ui.dialog.clear(),
        )
        return
      }
      finish(host, result)
    },
  }
}

export function buildUnshareCommand(host: ShareHostApi, sessionID: () => string | undefined): ShareHostLayerCommand {
  return {
    name: "session.unshare",
    title: "Stop sharing (re:share)",
    desc: "Delete the share page and stop syncing this session",
    slashName: "unshare",
    run: async () => {
      host.ui.dialog.clear()
      host.ui.dialog.replace(
        () =>
          host.ui.DialogConfirm({
            title: "Stop Sharing",
            message: "Stop sharing and delete the share page? The link stops working for everyone.",
            confirmLabel: "Stop sharing",
            onConfirm: () => {
              host.ui.dialog.clear()
              void runUnshareFlow(host, sessionID()).then((result) => finish(host, result))
            },
            onCancel: () => host.ui.dialog.clear(),
          }),
        () => host.ui.dialog.clear(),
      )
    },
  }
}

export function buildSettingsCommand(host: ShareHostApi, sessionID: () => string | undefined): ShareHostLayerCommand {
  return {
    name: "openshare.settings",
    title: "OpenShare: Settings",
    desc: "Worker connection, sharing defaults, read auth, this session",
    slashName: "openshare",
    run: async () => {
      host.ui.dialog.clear()
      await settingsDialog(host, sessionID())
    },
  }
}

/** Registers all commands on one high-priority layer (shadowing the
 * deprecated built-in /share). Returns the unregister function. */
export function registerCommands(host: ShareHostApi, sessionID: () => string | undefined): () => void {
  const commands = [buildShareCommand(host, sessionID), buildUnshareCommand(host, sessionID), buildSettingsCommand(host, sessionID)]
  for (const command of commands) {
    command.category = currentPaletteCategory()
    command.group = currentPaletteCategory()
  }
  declarePaletteCategory("OpenShare", ...commands)
  schedulePaletteReconcile()
  return host.keymap.registerLayer({
    mode: "global",
    priority: 100,
    commands,
    bindings: [],
  })
}
