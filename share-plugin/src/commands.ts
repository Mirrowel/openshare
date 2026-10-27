// OpenShare command registration. ONE user-facing /share command shadows
// the deprecated built-in (opncd.ai) by registering the same command name
// on a plugin keymap layer. Running it on a shared session opens the SAME
// session menu as /openshare → This session (copy / stop / TTL / read
// auth — one surface, no duplicated manager); on an unshared session it
// asks consent and creates the share. /openshare opens settings.
//
// LAYER SHAPE (live-caught 2026-10-19): the v1 host keymap gates layers
// that declare `mode` on the mode stack (resting mode is "base"), so a
// plugin layer MUST NOT pass mode ("global" made the whole layer
// unreachable — no palette entries, no slash commands, no shadow) and
// must not carry undefined-valued command fields. The registration shape
// is exactly what the proven family plugins use: {commands, bindings},
// commands with only defined fields, category "OpenShare" (own group,
// deliberately NOT joined into the shared family palette category).

import {
  clearGoneBindingEntries,
  currentConfig,
  hostOf,
  isConfigured,
  patchSessionBinding,
  readBindings,
  resolveRoot,
  runUnshareFlow,
  shareWithConsent,
  verifyShare,
} from "./share-flow.js"
import { onboardingDialog, settingsDialog } from "./settings.js"
import { engineTargetUrls } from "./core.js"
import { dbgLog } from "./sidebar.js"
import type { ShareHostApi, ShareHostLayerCommand } from "./tui-host.js"

export const PALETTE_CATEGORY = "OpenShare"

function finish(host: ShareHostApi, result: { ok: boolean; message: string; url?: string; unconfigured?: boolean }) {
  // terminal point of a flow: the dialog chain is over — clear the host
  // stack explicitly (done() no longer clears; replace-without-clear was
  // the flicker fix, so chain ENDS own the clear)
  try {
    host.ui.dialog.clear()
  } catch {}
  host.ui.toast({
    variant: result.ok ? "success" : result.unconfigured ? "warning" : "error",
    title: "OpenShare",
    message: result.message,
    duration: result.ok ? 8000 : 15000,
  })
}

/** Shared pre-menu pass: collision check + liveness sweep. Bindings whose
 * page died server-side (purge/TTL/delete) are auto-cleared and surfaced
 * in a gone modal offering a re-share. Returns null when a dialog flow
 * took over (collision / re-share) and already finished; otherwise the
 * surviving bindings and whether any gone modal was shown. */
async function sweepBindings(host: ShareHostApi, sid: string, root: string) {
  let all = await readBindings(host.client, root)
  let goneShown = false

  // collision first: the engine marked a server's credentials as rejected
  const collided = all.find((b) => b.collided)
  if (collided) {
    await showCollisionDialog(host, root, collided.server, collided.id, collided.collided ?? "")
    return null
  }

  const live = all.filter((b) => b.url && b.enabled !== false && b.id)
  if (live.length) {
    const verdicts = await Promise.all(live.map((b) => verifyShare(b.server, b.id)))
    const gone = live.filter((b, i) => verdicts[i] === "gone")
    if (gone.length) {
      goneShown = true
      await clearGoneBindingEntries(host, root, gone.map((b) => b.server))
      all = all.filter((b) => !gone.some((g) => g.server === b.server))
      const list = gone.map((b) => `• ${hostOf(b.url || b.server)} — ${b.url}`).join("\n")
      const choice = await host.ui.showMenu<string>({
        title: "Share is gone",
        hint: "The page was removed, expired, or purged on the server — sharing disabled for it.",
        options: [
          { title: "Share again", value: "again", description: "create a fresh page with the full history", help: `The stale binding was already cleared. Sharing again creates a brand-new page on the ACTIVE server with this session's full history backfilled.\n\nGone:\n${list}` },
          { title: "Close", value: "close", description: "leave the session unshared", help: `The stale binding entries were cleared automatically; the session is not shared anymore. Run /share any time to share it fresh.\n\nGone:\n${list}` },
        ],
      })
      if (choice === "again") {
        finish(host, await shareWithConsent(host, sid))
        return null
      }
      if (all.length === 0) return { all, goneShown }
    }
  }
  return { all, goneShown }
}

async function showCollisionDialog(host: ShareHostApi, root: string, server: string, shareId: string, error: string) {
  const debugInfo = JSON.stringify({ server, shareId, error, sessionID: root, plugin: "openshare", time: new Date().toISOString() }, null, 2)
  const choice = await host.ui.showMenu<string>({
    title: `Share conflict — ${hostOf(server)}`,
    hint: `saved credentials for ${shareId.slice(0, 12)}… were rejected (${error})`,
    options: [
      {
        title: "Copy debug info",
        value: "debug",
        description: "server, share id, error — for the hoster or an issue report",
        help: `Copies a JSON blob with the server, share id, exact error, and session id — attach it when reporting to the hoster or filing an issue.\n\n${debugInfo}`,
      },
      {
        title: "Share on a new share",
        value: "new",
        description: "abandon the old binding; create a fresh share with full history",
        help: `Drops the rejected binding and lets the engine create a brand-new share on ${hostOf(server)} with the session's full history. The old page (whoever owns it now) is left untouched.`,
      },
      {
        title: "Don't share here",
        value: "no",
        description: "leave the old page; this server stops receiving this session",
        help: `Opts this session out on ${hostOf(server)}: the engine stops trying to attach. The rejected page stays as-is. Re-share here anytime via "Share to another server".`,
      },
      { title: "Cancel", value: "cancel" },
    ],
  })
  if (!choice || choice === "cancel") return
  if (choice === "debug") {
    const ok = await host.clipboard.write(debugInfo)
    finish(host, ok ? { ok: true, message: "Debug info copied to clipboard." } : { ok: false, message: `Clipboard failed:\n${debugInfo}` })
    return
  }
  if (choice === "new") {
    await patchSessionBinding(host.client, root, (servers) => {
      delete servers[server]
    })
    finish(host, { ok: true, message: `Re-sharing on ${hostOf(server)} — a new share appears within seconds.` })
    return
  }
  if (choice === "no") {
    await patchSessionBinding(host.client, root, (servers) => {
      delete servers[server]
      servers[server] = { optedOut: true }
    })
    finish(host, { ok: true, message: `${hostOf(server)} opted out for this session.` })
  }
}

export function buildShareCommand(host: ShareHostApi, sessionID: () => string | undefined): ShareHostLayerCommand {
  return {
    name: "session.share",
    title: "Share session (re:share)",
    desc: "Share this session via openshare; on a shared session: copy the link or stop sharing",
    slashName: "share",
    slashAliases: ["reshare"],
    category: PALETTE_CATEGORY,
    group: PALETTE_CATEGORY,
    run: async () => {
      dbgLog(`/share run: entered (sid=${sessionID() ?? "none"})`)
      host.ui.dialog.clear()
      const cfg = currentConfig()
      // engine-aware gate: project-level plugin options can configure
      // targets the TUI's file chain cannot see - trust the live engine
      if (!isConfigured(cfg) && !engineTargetUrls().length) {
        void onboardingDialog(host)
        return
      }
      const sid = sessionID()
      if (!sid) {
        finish(host, { ok: false, message: "No active session to share." })
        return
      }
      const root = await resolveRoot(host.client, sid)
      // collision + gone sweep, then the gate. null = a dialog flow took
      // over (collision / gone re-share) and already finished.
      const swept = await sweepBindings(host, sid, root)
      if (swept === null) return
      const { all, goneShown } = swept
      // live ⇔ url && enabled !== false (all-mode bindings carry
      // enabled:true; legacy all-mode bindings without the field are live
      // too — only an explicit false is dormant)
      if (all.some((b) => b.url && b.enabled !== false)) {
        // THE session menu - identical to /openshare  This session by
        // construction (one surface, no duplicated manager), opened
        // DIRECTLY (owner: "/share is supposed to be the same menu, not
        // the settings root one hop away"). No dialog.clear() after:
        // settings owns its chain end-to-end.
        await settingsDialog(host, sid, "session")
        return
      }
      // everything was just cleared by the gone modal and the user chose
      // Close — leaving it unshared is the answer, do not offer a share
      if (goneShown && all.length === 0) return
      // not shared (or dormant): explicit consent, every time
      finish(host, await shareWithConsent(host, sid))
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
