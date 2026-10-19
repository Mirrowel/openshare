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

import {
  CONSENT_KV_KEY,
  clearGoneBindingEntries,
  confirmShare,
  currentConfig,
  isConfigured,
  hostOf,
  patchSessionBinding,
  readBinding,
  readBindings,
  resolveRoot,
  runShareFlow,
  runUnshareFlow,
  serverEntries,
  verifyShare,
  workerDeleteShare,
} from "./share-flow.js"
import { onboardingDialog, settingsDialog } from "./settings.js"
import { dbgLog } from "./sidebar.js"
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

/** The already-shared state: per-server management for the fan-out era.
 * Single binding keeps the compact classic menu; multiple bindings get a
 * per-server submenu (copy / stop here / leave as-is) plus all-stop.
 * Opens with a liveness sweep: bindings whose page died server-side
 * (purge/TTL/delete) are auto-cleared and surfaced in a gone modal. */
async function showShareManager(host: ShareHostApi, sessionID: () => string | undefined) {
  const sid = sessionID()
  if (!sid) return
  const root = await resolveRoot(host.client, sid)
  let all = await readBindings(host.client, root)

  // collision first: the engine marked a server's credentials as rejected
  const collided = all.find((b) => b.collided)
  if (collided) return showCollisionDialog(host, root, collided.server, collided.id, collided.collided ?? "")

  // liveness sweep: probe every live-bound server (credential-free /data
  // check). GONE entries are removed from the binding automatically; the
  // modal says what happened and offers to re-share. Network errors are
  // "unknown" and never treated as gone.
  const live = all.filter((b) => b.url && b.enabled !== false && b.id)
  if (live.length) {
    const verdicts = await Promise.all(live.map((b) => verifyShare(b.server, b.id)))
    const gone = live.filter((b, i) => verdicts[i] === "gone")
    if (gone.length) {
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
        finish(host, await runShareFlow(host, sid))
        return
      }
      if (all.length === 0) return
    }
  }

  if (all.length === 0) return

  const otherServers = serverEntries().filter((s) => !all.some((b) => b.server === s.url))

  if (all.length === 1 && otherServers.length === 0) {
    // the classic single-server menu
    const b = all[0]
    void host.ui
      .showMenu<string>({
        title: "Session is shared",
        hint: b.url,
        options: [
          {
            title: "Copy share link",
            value: "copy",
            description: "copy the share URL to the clipboard",
            help: `Copies the share URL to the clipboard (navigator + OSC52 fallback).\n\nURL: ${b.url}\nServer: ${b.server}\nShare id: ${b.id}\n\nAnyone with the link can read the page (plus the login, if read auth is set).`,
          },
          {
            title: "Stop sharing",
            value: "stop",
            description: "Delete the share page — the link stops working for everyone",
            help: `Deletes the page on ${hostOf(b.url || b.server)} server-side and clears this session's share flag. Viewers with the link see a final "gone" state. This cannot be undone — sharing again creates a NEW page with a new URL.`,
          },
          { title: "Cancel", value: "cancel" },
        ],
      })
      .then(async (choice) => {
        if (choice === "copy") {
          const ok = await host.clipboard.write(b.url)
          finish(host, ok ? { ok: true, message: `Share URL copied to clipboard: ${b.url}`, url: b.url } : { ok: false, message: `Could not write the clipboard — link: ${b.url}`, url: b.url })
          return
        }
        if (choice === "stop") {
          const yes = await host.ui.showConfirm({
            title: "Stop sharing",
            message: "Delete the share page for this session? The link stops working for everyone.",
            confirmLabel: "Stop sharing",
          })
          if (!yes) return
          finish(host, await runUnshareFlow(host, sessionID()))
        }
      })
    return
  }

  // fan-out menu
  const options: Array<{ title: string; value: string; description?: string; help?: string }> = all.map((b) => ({
    title: `Copy link — ${hostOf(b.url || b.server)}`,
    value: `copy:${b.server}`,
    description: b.url,
    help: `Copies this server's share URL to the clipboard.\n\nURL: ${b.url}\nServer: ${b.server}\nShare id: ${b.id}\n\nEach server carries an independent page of the same session.`,
  }))
  options.push({
    title: "Manage per server…",
    value: "manage",
    description: `${all.length} servers — stop one, leave a snapshot`,
    help: `Per-server actions: copy the link, stop sharing there (page deleted), or leave it as a read-only snapshot (updates stop, the page lives out its TTL). Other servers are unaffected.\n\nBound servers:\n${all.map((b) => `• ${b.server} — ${b.url}`).join("\n")}`,
  })
  if (otherServers.length) {
    options.push({
      title: "Share to another server…",
      value: "more",
      description: otherServers.map((s) => hostOf(s.url)).join(", "),
      help: `Adds one of your other configured servers as a destination for THIS session: it becomes the active server and the full history is mirrored there within seconds.\n\nAvailable:\n${otherServers.map((s) => `• ${s.url}`).join("\n")}`,
    })
  }
  options.push({
    title: "Stop sharing (all)",
    value: "stop-all",
    description: "delete every server's page",
    help: `Deletes the page on all ${all.length} servers and clears the share flag. Every link stops working; sharing again creates fresh pages.`,
  })
  options.push({ title: "Cancel", value: "cancel" })
  const choice = await host.ui.showMenu<string>({ title: `Session is shared · ${all.length} servers`, options })
  if (!choice || choice === "cancel") return
  if (choice.startsWith("copy:")) {
    const b = all.find((x) => `copy:${x.server}` === choice)
    if (b) {
      const ok = await host.clipboard.write(b.url)
      finish(host, ok ? { ok: true, message: `Share URL copied: ${b.url}`, url: b.url } : { ok: false, message: `Clipboard failed — ${b.url}`, url: b.url })
    }
    return
  }
  if (choice === "stop-all") {
    const yes = await host.ui.showConfirm({
      title: "Stop sharing",
      message: `Delete the share pages on all ${all.length} servers? The links stop working for everyone.`,
      confirmLabel: "Stop all",
    })
    if (!yes) return
    finish(host, await runUnshareFlow(host, sessionID()))
    return
  }
  if (choice === "more") {
    const pick = await host.ui.showMenu<string>({
      title: "Share to another server",
      options: [...otherServers.map((s) => ({ title: hostOf(s.url), value: s.url, description: s.entry.label })), { title: "Cancel", value: "__cancel" }],
    })
    if (!pick || pick === "__cancel") return
    const { saveServerEntry } = await import("./share-flow.js")
    for (const s of serverEntries()) if (s.url !== pick) saveServerEntry(s.url, { active: undefined })
    saveServerEntry(pick, { active: true })
    finish(host, { ok: true, message: `${hostOf(pick)} activated — this session mirrors there within seconds (new sessions share to it too).` })
    return
  }
  if (choice === "manage") {
    const pick = await host.ui.showMenu<string>({
      title: "Manage server",
      options: [...all.map((b) => ({ title: hostOf(b.url || b.server), value: b.server, description: b.url })), { title: "Cancel", value: "__cancel" }],
    })
    if (!pick || pick === "__cancel") return
    const b = all.find((x) => x.server === pick)
    if (!b) return
    const action = await host.ui.showMenu<string>({
      title: `${hostOf(b.url || b.server)}`,
      hint: b.url,
      options: [
        {
          title: "Copy link",
          value: "copy",
          description: "copy the share URL",
          help: `Copies this server's share URL to the clipboard.\n\nURL: ${b.url}\nShare id: ${b.id}`,
        },
        {
          title: "Stop sharing here",
          value: "stop",
          description: "delete THIS server's page; other servers unaffected",
          help: `Deletes the page on ${hostOf(b.url || b.server)} and retires this server for the session (the engine stops mirroring here). Other servers keep streaming. Sharing here again later creates a new page.`,
        },
        {
          title: "Leave as-is (snapshot)",
          value: "leave",
          description: "stop updating it; the page stays until its TTL",
          help: `Stops mirroring to ${hostOf(b.url || b.server)} WITHOUT deleting anything — viewers keep reading the snapshot until the share's TTL expires. Useful for handing someone a frozen copy while you keep working.`,
        },
        { title: "Cancel", value: "cancel" },
      ],
    })
    if (!action || action === "cancel") return
    if (action === "copy") {
      const ok = await host.clipboard.write(b.url)
      finish(host, ok ? { ok: true, message: `Share URL copied: ${b.url}`, url: b.url } : { ok: false, message: `Clipboard failed — ${b.url}`, url: b.url })
      return
    }
    if (action === "stop") {
      const deleted = await workerDeleteShare(b.server || b.url.slice(0, b.url.indexOf("/s/")), b.id, b.secret)
      await patchSessionBinding(host.client, root, (servers) => {
        delete servers[b.server]
        servers[b.server] = { optedOut: true }
      })
      finish(host, { ok: true, message: deleted ? `Stopped sharing on ${hostOf(b.url || b.server)} — page deleted.` : `Stopped sharing on ${hostOf(b.url || b.server)} (page deletion follows via the sweeper).` })
      return
    }
    if (action === "leave") {
      await patchSessionBinding(host.client, root, (servers) => {
        delete servers[b.server]
        servers[b.server] = { optedOut: true }
      })
      finish(host, { ok: true, message: `${hostOf(b.url || b.server)} left as-is — a snapshot until its TTL.` })
      return
    }
  }
}

/** Credential collision: the engine refused to auto-recreate. The user
 * chooses: copy debug info (for the hoster/issue), share on a new share,
 * or don't share. */
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
      const bindings = await readBindings(host.client, root)
      const binding = bindings[0]
      dbgLog(`/share gate: sid=${sid} root=${root} bindings=${bindings.length}`)
      // live ⇔ url && enabled !== false (all-mode bindings carry
      // enabled:true since the fix; legacy all-mode bindings without the
      // field are live too — only an explicit false is dormant)
      if (bindings.some((b) => b.url && b.enabled !== false)) {
        await showShareManager(host, sessionID)
        return
      }
      // not shared (or dormant): the normal flow — consent once, then share
      const result = await runShareFlow(host, sid)
      if (result.message === "consent required") {
        const yes = await host.ui.showConfirm({
          title: "Share Session",
          message: "Publish this session (and its subagent sessions) to your openshare worker?\nThe link lets anyone with it read the conversation.",
          confirmLabel: "Share",
        })
        if (!yes) return
        try {
          host.kv.set(CONSENT_KV_KEY, true)
          dbgLog("consent kv.set ok")
        } catch (e) {
          dbgLog(`consent kv.set THREW: ${(e as Error)?.message ?? e}`)
        }
        try {
          finish(host, await confirmShare(host, root))
        } catch (e) {
          dbgLog(`confirmShare rejected: ${(e as Error)?.stack ?? e}`)
          finish(host, { ok: false, message: "Share failed (see debug log)." })
        }
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
