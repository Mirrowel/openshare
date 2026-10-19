// OpenShare command registration. ONE user-facing /share command shadows
// the deprecated built-in (opncd.ai) by registering the same command name
// on a plugin keymap layer; running it on a shared session opens the
// share manager (copy link / stop sharing) instead — you can't share
// twice, so /share is a toggle. /openshare opens settings.
//
// LAYER SHAPE (live-caught 2026-10-19): the v1 host keymap gates layers
// that declare `mode` on the mode stack (resting mode is "base"), so a
// plugin layer MUST NOT pass mode ("global" made the whole layer
// unreachable — no palette entries, no slash commands, no shadow) and
// must not carry undefined-valued command fields. The registration shape
// is exactly what the proven family plugins use: {commands, bindings},
// commands with only defined fields, category "OpenShare" (own group,
// deliberately NOT joined into the shared family palette category).

import { CONSENT_KV_KEY, confirmShare, currentConfig, isConfigured, readBinding, resolveRoot, runShareFlow, runUnshareFlow } from "./share-flow.js"
import { onboardingDialog, settingsDialog } from "./settings.js"
import type { ShareHostApi, ShareHostLayerCommand } from "./tui-host.js"

export const PALETTE_CATEGORY = "OpenShare"

function finish(host: ShareHostApi, result: { ok: boolean; message: string; url?: string; unconfigured?: boolean }) {
  host.ui.toast({
    variant: result.ok ? "success" : result.unconfigured ? "warning" : "error",
    title: "OpenShare",
    message: result.message,
    duration: result.ok ? 8000 : 15000,
  })
}

/** The already-shared state: manage the existing share. */
function showShareManager(host: ShareHostApi, url: string, sessionID: () => string | undefined) {
  host.ui.dialog.replace(
    () =>
      host.ui.DialogSelect({
        title: "Session is shared",
        placeholder: "Share link is below — copy it or stop sharing",
        options: [
          { title: "Copy share link", value: "copy", description: url },
          { title: "Stop sharing", value: "stop", description: "Delete the share page — the link stops working for everyone" },
          { title: "Cancel", value: "cancel" },
        ],
        flat: true,
        onSelect: (option) => {
          host.ui.dialog.clear()
          if (option.value === "copy") {
            void host.clipboard.write(url).then((ok) =>
              finish(host, ok ? { ok: true, message: `Share URL copied to clipboard: ${url}`, url } : { ok: false, message: `Could not write the clipboard — link: ${url}`, url }),
            )
            return
          }
          if (option.value === "stop") {
            host.ui.dialog.replace(
              () =>
                host.ui.DialogConfirm({
                  title: "Stop sharing",
                  message: "Delete the share page for this session? The link stops working for everyone.",
                  confirmLabel: "Stop sharing",
                  onConfirm: () => {
                    host.ui.dialog.clear()
                    void runUnshareFlow(host, sessionID()).then((result) => finish(host, result))
                  },
                  onCancel: () => host.ui.dialog.clear(),
                }),
              () => host.ui.dialog.clear(),
            )
          }
        },
      }),
    () => host.ui.dialog.clear(),
  )
}

export function buildShareCommand(host: ShareHostApi, sessionID: () => string | undefined): ShareHostLayerCommand {
  return {
    name: "session.share",
    title: "Share session (re:share)",
    desc: "Share this session via openshare; on a shared session: copy the link or stop sharing",
    slashName: "share",
    category: PALETTE_CATEGORY,
    group: PALETTE_CATEGORY,
    run: async () => {
      host.ui.dialog.clear()
      const cfg = currentConfig()
      if (!isConfigured(cfg)) {
        void onboardingDialog(host)
        return
      }
      const sid = sessionID()
      if (!sid) {
        finish(host, { ok: false, message: "No active session to share." })
        return
      }
      const root = await resolveRoot(host.client, sid)
      const binding = await readBinding(host.client, root)
      if (binding?.url && binding.enabled) {
        showShareManager(host, binding.url, sessionID)
        return
      }
      // not shared (or dormant): the normal flow — consent once, then share
      const result = await runShareFlow(host, sid)
      if (result.message === "consent required") {
        host.ui.dialog.replace(
          () =>
            host.ui.DialogConfirm({
              title: "Share Session",
              message: "Publish this session (and its subagent sessions) to your openshare worker?\nThe link lets anyone with it read the conversation.",
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

export function buildSettingsCommand(host: ShareHostApi, sessionID: () => string | undefined): ShareHostLayerCommand {
  return {
    name: "openshare.settings",
    title: "OpenShare: Settings",
    desc: "Worker connection, sharing defaults, read auth, this session",
    slashName: "openshare",
    category: PALETTE_CATEGORY,
    group: PALETTE_CATEGORY,
    run: async () => {
      host.ui.dialog.clear()
      await settingsDialog(host, sessionID())
    },
  }
}

/** Registers the /share toggle + /openshare settings on one keymap layer.
 * Returns the unregister function. */
export function registerCommands(host: ShareHostApi, sessionID: () => string | undefined): () => void {
  return host.keymap.registerLayer({
    commands: [buildShareCommand(host, sessionID), buildSettingsCommand(host, sessionID)],
    bindings: [],
  })
}
