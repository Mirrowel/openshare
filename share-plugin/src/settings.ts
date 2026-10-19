// OpenShare settings dialog (/openshare): select -> edit flows over the
// host facade's dialog stack. No custom JSX — every screen is a
// DialogSelect/DialogPrompt/DialogConfirm composition, so the same flows
// run on the v1 TUI and the v2 dialog bridge.
//
// Sections: Connection, Sharing, Read auth, Advanced, This session.

import { configSourceMap, moduleDir, writeCandidates, type ShareConfig, type WriteCandidate } from "./config.js"
import {
  adminClient,
  adminTokenFor,
  clearShareFlag,
  confirmShare,
  currentConfig,
  deleteServerEntry,
  disconnectAtServer,
  enrollAtServer,
  isConfigured,
  normServerUrl,
  probeAuthMode,
  probeWorker,
  readBinding,
  resolveRoot,
  rotateAtServer,
  saveConfig,
  saveServerEntry,
  serverEntries,
  setShareFlag,
  type AdminShare,
  type AdminUser,
} from "./share-flow.js"
import type { SessionOpts } from "./core.js"
import type { ShareDialogSelectOption, ShareHostApi } from "./tui-host.js"

/** description suffix: `[from <source>]` when a key is overridden by a
 * file/env higher in the chain than the write target. */
function withSource(display: string, source: string | undefined): string {
  return source ? `${display} [${source}]` : display
}

function summarizeSources(sources: Record<string, string>): string {
  const labels = [...new Set(Object.values(sources))]
  return labels.length ? labels.slice(0, 2).join(" + ") + (labels.length > 2 ? "…" : "") : "all defaults"
}

function sourcesMessage(sources: Record<string, string>): string {
  const lines = Object.entries(sources).map(([key, source]) => `${key}: ${source}`)
  return lines.length ? lines.join("\n") : "All values are defaults — no config file or env var sets anything yet."
}

type UI = ShareHostApi["ui"]

function showSelect<Value>(
  ui: UI,
  props: {
    title: string
    options: ShareDialogSelectOption<Value>[]
    placeholder?: string
    current?: Value
  },
): Promise<Value | undefined> {
  return ui.showMenu<Value>({ title: props.title, options: props.options, current: props.current, hint: props.placeholder })
}

function showPrompt(ui: UI, props: { title: string; placeholder?: string; value?: string }): Promise<string | undefined> {
  return ui.showPrompt(props)
}

function showConfirm(ui: UI, props: { title: string; message: string; confirmLabel?: string }): Promise<boolean> {
  return ui.showConfirm(props)
}

function showInfo(ui: UI, props: { title: string; message: string }): Promise<void> {
  return ui.showAlert(props)
}

function mask(value: string | undefined): string {
  if (!value) return "(not set)"
  if (value.length <= 6) return "****"
  return `${value.slice(0, 3)}${"*".repeat(Math.min(10, value.length - 5))}${value.slice(-2)}`
}

type EditKind = "text" | "number" | "password"

const LABELS: Record<string, { label: string; help: string; kind: EditKind; section: string }> = {
  workerUrl: { label: "Worker URL", help: "Your openshare-worker deployment (https://…). Empty disables the plugin.", kind: "text", section: "Connection" },
  createToken: { label: "Create token", help: "The worker's CREATE_TOKEN. Required to create shares.", kind: "password", section: "Connection" },
  debounceMs: { label: "Sync interval (ms)", help: "Max time between syncs while streaming; anything batched rides the next one. Turn-end batches flush immediately. Default 10000; clamped into the server policy window.", kind: "number", section: "Sharing" },
  completedDelayMs: { label: "Completed delay (ms)", help: "Idle this long before the share says completed (default 5000, 0 = immediate). Busy cancels; opencode exit flushes. Clamped by the server.", kind: "number", section: "Sharing" },
  modelLabel: { label: "Model label template", help: "$Provider/$Model placeholders; literal text as-is; empty hides the model.", kind: "text", section: "Sharing" },
  ttlDays: { label: "TTL (days)", help: "Share lifetime; the worker caps it at its MAX_TTL_DAYS.", kind: "number", section: "Sharing" },
  openTasksInNewTab: { label: "Open tasks in new tab", help: "Viewer: task rows open subagent pages in a new tab.", kind: "text", section: "Sharing" },
  authLogin: { label: "Read auth: login", help: "Optional read gate for share pages. Empty removes protection on the next attach.", kind: "text", section: "Read auth" },
  authPassword: { label: "Read auth: password", help: "Optional read gate for share pages.", kind: "password", section: "Read auth" },
  spoolDir: { label: "Spool directory", help: "Temporary unacked-frame buffer (default: XDG data home).", kind: "text", section: "Advanced" },
  urlFile: { label: "URL file", help: 'File each share URL is appended to (all-mode). Empty = default openshare.urls.txt in the session directory; "none" = no URL file.', kind: "text", section: "Advanced" },
  announceStderr: { label: "Announce on stderr", help: '"true"/"false": the [openshare] live: and url file: log lines. false silences them; the share itself is unaffected.', kind: "text", section: "Advanced" },
  shareMode: { label: "Share mode", help: '"all" shares every session; "manual" needs /share. Default: TUI presence.', kind: "text", section: "Sharing" },
}

function displayValue(key: string, cfg: ShareConfig): string {
  if (key === "createToken" || key === "authPassword") return mask(String(cfg[key] ?? ""))
  if (key === "openTasksInNewTab") return String(cfg.openTasksInNewTab !== false)
  if (key === "announceStderr") return String(cfg.announceStderr !== false)
  const value = (cfg as unknown as Record<string, unknown>)[key]
  return value === undefined || value === "" ? "(not set)" : String(value)
}

async function editKey(host: ShareHostApi, cfg: ShareConfig, key: string): Promise<ShareConfig | undefined> {
  const meta = LABELS[key]
  if (!meta) return undefined
  const raw = await showPrompt(host.ui, {
    title: `${meta.label} — ${displayValue(key, cfg)}`,
    placeholder: meta.kind === "number" ? "number" : meta.kind === "password" ? "paste token" : "value",
    value: meta.kind === "password" ? "" : String((cfg as unknown as Record<string, unknown>)[key] ?? ""),
  })
  if (raw === undefined) return undefined
  const next = { ...cfg } as unknown as Record<string, unknown>
  if (meta.kind === "number") {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      host.ui.toast({ variant: "error", title: "OpenShare", message: `${meta.label}: "${raw}" is not a positive number.` })
      return undefined
    }
    next[key] = Math.floor(parsed)
  } else if (key === "openTasksInNewTab" || key === "announceStderr") {
    next[key] = raw === "true" || raw === "yes" || raw === "1"
  } else if (key === "urlFile") {
    // "" = default path, "none" = disabled, anything else = explicit path
    next[key] = raw.trim().toLowerCase() === "none" ? "none" : raw
  } else if (key === "shareMode") {
    if (raw !== "all" && raw !== "manual" && raw !== "") {
      host.ui.toast({ variant: "error", title: "OpenShare", message: 'Share mode must be "all", "manual", or empty (auto).' })
      return undefined
    }
    next[key] = raw === "" ? undefined : raw
  } else {
    next[key] = raw
  }
  return next as ShareConfig
}

/** Connect (add + enroll) a server — the /share first-run flow and the
 * settings "Connect to a server" row share it. Prompts the URL, probes
 * the auth mode, prompts a code for private servers, enrolls, persists
 * the token and makes it the active server. */
export async function connectServerFlow(host: ShareHostApi): Promise<{ ok: boolean; message: string; url?: string }> {
  const raw = await showPrompt(host.ui, { title: "Share server URL", placeholder: "https://your-openshare-host" })
  if (raw === undefined || raw === "") return { ok: false, message: "Cancelled." }
  const url = normServerUrl(raw)
  if (!/^https?:\/\//.test(url)) return { ok: false, message: "URL must start with http:// or https://" }
  host.ui.toast({ variant: "info", title: "OpenShare", message: `Probing ${url}…` })
  const probe = await probeAuthMode(url)
  if (!probe.ok) return { ok: false, message: `${url}: ${probe.detail}` }
  let code = ""
  if (probe.mode === "private") {
    const typed = await showPrompt(host.ui, { title: `${url} needs an access code`, placeholder: "osc_… (from the hoster)" })
    if (typed === undefined) return { ok: false, message: "Cancelled — private servers need a code." }
    code = typed.trim()
  }
  const res = await enrollAtServer(url, code)
  if (!res.ok) return { ok: false, message: `Enrollment refused: ${res.error}` }
  // single active server: deactivate the others in the settings home,
  // then persist the new membership as active
  for (const other of serverEntries()) {
    if (other.url !== url) saveServerEntry(other.url, { active: undefined })
  }
  saveServerEntry(url, { token: res.token, label: res.label, code: code || undefined, active: true })
  return { ok: true, message: `Connected to ${url} as "${res.label}" — sharing goes there now.`, url }
}

/** Per-server submenu: identity status + membership actions. */
async function serverMenu(host: ShareHostApi, url: string): Promise<void> {
  while (true) {
    const entries = serverEntries()
    const mine = entries.find((s) => s.url === url)
    if (!mine) return
    const cred = mine.entry.token
      ? `token ${mask(mine.entry.token)}`
      : mine.entry.code
        ? "no token (code saved, enrolls on demand)"
        : "no token (public server, enrolls on demand)"
    const options: ShareDialogSelectOption<string>[] = [
      { title: url, value: "info", description: `${mine.entry.label ?? "(no label)"} · ${cred}${mine.active ? " · ACTIVE" : ""}`, disabled: true },
    ]
    if (!mine.active) options.push({ title: "Set active", value: "active", description: "new sessions share here" })
    if (!mine.entry.token) options.push({ title: "Enroll now", value: "enroll", description: "get a user token immediately" })
    if (mine.entry.token) options.push({ title: "Rotate token", value: "rotate", description: "new token, old one revoked" })
    if (mine.entry.token) options.push({ title: "Disconnect", value: "disconnect", description: "revoke the token server-side and forget it" })
    options.push({ title: "Test this server", value: "test", description: "probe /health" })
    options.push({ title: "Remove from config", value: "remove", description: "drop the saved membership (server-side state untouched)" })
    options.push({ title: "Back", value: "back" })

    const choice = await showSelect(host.ui, { title: "Share server", options })
    if (choice === undefined || choice === "back") return

    if (choice === "active") {
      for (const other of entries) {
        if (other.url !== url) saveServerEntry(other.url, { active: undefined })
      }
      saveServerEntry(url, { active: true })
      host.ui.toast({ variant: "success", title: "OpenShare", message: `${url} is now the active server.` })
      return
    }
    if (choice === "enroll") {
      const probe = await probeAuthMode(url)
      if (!probe.ok) {
        await showInfo(host.ui, { title: "Unreachable", message: `${url}: ${probe.detail}` })
        continue
      }
      let code = mine.entry.code ?? ""
      if (probe.mode === "private" && !code) {
        const typed = await showPrompt(host.ui, { title: `${url} needs an access code`, placeholder: "osc_… (from the hoster)" })
        if (typed === undefined) continue
        code = typed.trim()
        if (code) saveServerEntry(url, { code })
      }
      const res = await enrollAtServer(url, code)
      if (res.ok) {
        saveServerEntry(url, { token: res.token, label: res.label })
        host.ui.toast({ variant: "success", title: "OpenShare", message: `Enrolled as "${res.label}".` })
      } else {
        await showInfo(host.ui, { title: "Enrollment refused", message: res.error ?? "unknown error" })
      }
      continue
    }
    if (choice === "rotate") {
      const res = await rotateAtServer(url, mine.entry.token ?? "")
      if (res.ok && res.token) {
        saveServerEntry(url, { token: res.token })
        host.ui.toast({ variant: "success", title: "OpenShare", message: "Token rotated; the old one is revoked." })
      } else {
        await showInfo(host.ui, { title: "Rotation failed", message: `${res.error ?? "unknown"} — if the token was revoked server-side, use Enroll now instead.` })
      }
      continue
    }
    if (choice === "disconnect") {
      const sure = await showConfirm(host.ui, { title: "Disconnect", message: `Revoke the token at ${url} and forget it?\nYour shares stay (read-only for you until TTL).`, confirmLabel: "Disconnect" })
      if (!sure) continue
      const res = await disconnectAtServer(url, mine.entry.token ?? "")
      saveServerEntry(url, { token: undefined })
      host.ui.toast({ variant: res.ok ? "success" : "error", title: "OpenShare", message: res.ok ? "Disconnected." : `Server-side revoke failed (${res.error ?? "error"}) — token forgotten locally.` })
      continue
    }
    if (choice === "test") {
      const result = await probeWorker(url)
      await showInfo(host.ui, { title: result.ok ? "Server reachable" : "Server unreachable", message: `${url} — ${result.detail}` })
      continue
    }
    if (choice === "remove") {
      const sure = await showConfirm(host.ui, { title: "Remove server", message: `Remove the saved membership for\n${url}?`, confirmLabel: "Remove" })
      if (!sure) continue
      deleteServerEntry(url)
      host.ui.toast({ variant: "success", title: "OpenShare", message: "Membership removed." })
      return
    }
  }
}

// --- admin console -------------------------------------------------------------

/** Manage a share server with its root token: users, tokens, codes,
 * shares — the /api/admin surface as promise menus. */
export async function adminConsole(host: ShareHostApi): Promise<void> {
  // 1) pick the server
  const entries = serverEntries()
  const pickOptions: ShareDialogSelectOption<string>[] = entries.map((s) => ({
    title: s.url,
    value: s.url,
    description: `${s.entry.label ? s.entry.label + " · " : ""}${s.entry.adminToken ? "admin token saved" : "no admin token saved"}`,
  }))
  pickOptions.push({ title: "Enter a server URL…", value: "__prompt" })
  const picked = await showSelect(host.ui, { title: "Admin console — server", options: pickOptions })
  if (picked === undefined) return
  let url = picked
  if (picked === "__prompt") {
    const raw = await showPrompt(host.ui, { title: "Server URL", placeholder: "https://your-openshare-host" })
    if (raw === undefined || raw === "") return
    url = normServerUrl(raw)
  }

  // 2) resolve the root token (saved adminToken / legacy createToken /
  //    prompt), verify it actually opens the admin API
  let adminToken = adminTokenFor(url)
  let prompted = false
  let client = adminClient(url, adminToken)
  while (true) {
    const probe = adminToken ? await client.users() : { ok: false, error: "no admin token" }
    if (probe.ok) break
    const raw = await showPrompt(host.ui, {
      title: `Admin (root) token for ${url}`,
      placeholder: "the worker's CREATE_TOKEN",
      value: "",
    })
    if (raw === undefined) return
    adminToken = raw.trim()
    prompted = true
    client = adminClient(url, adminToken)
    const retry = await client.users()
    if (!retry.ok) {
      await showInfo(host.ui, { title: "Not an admin token", message: `${url}: ${retry.error ?? "rejected"} — the root CREATE_TOKEN is required (user tokens cannot administer).` })
      return
    }
    break
  }
  if (prompted && adminToken) {
    const saved = saveServerEntry(url, { adminToken })
    if (saved) host.ui.toast({ variant: "info", title: "OpenShare", message: `Admin token saved for ${url} (servers entry).` })
  }

  // 3) the console loop
  while (true) {
    const [usersR, tokensR, codesR, sharesR] = await Promise.all([client.users(), client.tokens(), client.codes(), client.shares()])
    const users = usersR.data?.users ?? []
    const tokens = tokensR.data?.tokens ?? []
    const codes = codesR.data?.codes ?? []
    const shares = sharesR.data?.shares ?? []

    const choice = await showSelect(host.ui, {
      title: `Admin — ${url}`,
      options: [
        { title: "Server info", value: "info", description: "health, policy, auth mode" },
        { title: `Users (${users.length})`, value: "users", description: `${users.filter((u) => u.frozen).length} frozen` },
        { title: `Tokens (${tokens.length})`, value: "tokens", description: `${tokens.filter((t) => !t.revoked).length} active` },
        { title: `Access codes (${codes.length})`, value: "codes", description: "invite codes with activation budgets" },
        { title: `Shares (${shares.length})`, value: "shares", description: "every share on this server" },
        { title: "Purge ALL shares", value: "purge", description: "delete every share — maintenance" },
        { title: "Back", value: "back" },
      ],
    })
    if (choice === undefined || choice === "back") return

    if (choice === "info") {
      const h = await client.health()
      await showInfo(host.ui, {
        title: h.ok ? "Server info" : "Unreachable",
        message: h.ok
          ? `${url}\nservice: ${h.data?.service ?? "?"}\nauth: ${h.data?.auth?.mode ?? "?"}\npolicy: ${JSON.stringify(h.data?.policy ?? {})}`
          : `${url}: ${h.error ?? "unreachable"}`,
      })
      continue
    }

    if (choice === "users") {
      await adminUsersMenu(host, client, url, users)
      continue
    }
    if (choice === "tokens") {
      await adminTokensMenu(host, client, tokens)
      continue
    }
    if (choice === "codes") {
      await adminCodesMenu(host, client, codes)
      continue
    }
    if (choice === "shares") {
      await adminSharesMenu(host, client, url, shares, users)
      continue
    }
    if (choice === "purge") {
      const sure = await showConfirm(host.ui, {
        title: "Purge every share",
        message: `Delete ALL ${shares.length} shares on\n${url}?\nViewers get a final "gone" frame. Users, tokens and codes are untouched.`,
        confirmLabel: "Purge",
      })
      if (!sure) continue
      const res = await client.purge()
      host.ui.toast({ variant: res.ok ? "success" : "error", title: "OpenShare", message: res.ok ? `Removed ${res.data?.removed ?? "?"} shares.` : `Purge failed: ${res.error}` })
      continue
    }
  }
}

async function adminUsersMenu(host: ShareHostApi, client: ReturnType<typeof adminClient>, url: string, users: AdminUser[]): Promise<void> {
  const options: ShareDialogSelectOption<string>[] = users.map((u) => ({
    title: u.label,
    value: u.id,
    description: `${u.shares} shares · ${u.tokensActive}/${u.tokens} tokens${u.frozen ? " · FROZEN" : ""}`,
  }))
  options.push({ title: "Create user", value: "__create", description: "empty user record; mint a token next" })
  options.push({ title: "Back", value: "__back" })
  while (true) {
    const picked = await showSelect(host.ui, { title: `Users — ${url}`, options })
    if (picked === undefined || picked === "__back") return
    if (picked === "__create") {
      const label = await showPrompt(host.ui, { title: "New user label", placeholder: "name (optional)" })
      if (label === undefined) continue
      const res = await client.createUser(label.trim())
      host.ui.toast({ variant: res.ok ? "success" : "error", title: "OpenShare", message: res.ok ? `User created: ${res.data?.label}` : `Failed: ${res.error}` })
      continue
    }
    const user = users.find((u) => u.id === picked)
    if (!user) return
    const action = await showSelect(host.ui, {
      title: `${user.label}${user.frozen ? " (FROZEN)" : ""}`,
      options: [
        { title: user.frozen ? "Unfreeze" : "Freeze", value: "freeze", description: user.frozen ? "restore edit rights on their shares" : "sever ALL edit paths on their shares (view unaffected)" },
        { title: "Mint token", value: "mint", description: "issue a new osk_ token (shown once)" },
        { title: "Delete user", value: "delete", description: "default freezes; delete mode also removes shares + tokens" },
        { title: "Back", value: "back" },
      ],
    })
    if (action === undefined || action === "back") continue
    if (action === "freeze") {
      const res = user.frozen ? await client.unfreeze(user.id) : await client.freeze(user.id)
      host.ui.toast({ variant: res.ok ? "success" : "error", title: "OpenShare", message: res.ok ? (user.frozen ? "Unfrozen." : `Frozen (${res.data?.shares ?? "?"} shares locked).`) : `Failed: ${res.error}` })
      return
    }
    if (action === "mint") {
      const res = await client.mintToken(user.id)
      if (res.ok && res.data?.token) {
        await host.clipboard.write(res.data.token)
        await showInfo(host.ui, { title: "Token minted", message: `For ${user.label}:\n${res.data.token}\n\n(copied to clipboard — shown once)` })
      } else {
        await showInfo(host.ui, { title: "Mint failed", message: res.error ?? "unknown error" })
      }
      continue
    }
    if (action === "delete") {
      const mode = await showSelect(host.ui, {
        title: `Delete ${user.label}?`,
        options: [
          { title: "Freeze instead (default)", value: "freeze", description: "reversible — shares stay, edits blocked" },
          { title: "Delete everything", value: "delete", description: "remove their shares + tokens + user" },
          { title: "Cancel", value: "cancel" },
        ],
      })
      if (mode === undefined || mode === "cancel") continue
      const res = await client.deleteUser(user.id, mode === "delete" ? "delete" : "freeze")
      host.ui.toast({ variant: res.ok ? "success" : "error", title: "OpenShare", message: res.ok ? (mode === "delete" ? `Deleted (${res.data?.shares ?? "?"} shares removed).` : "Frozen.") : `Failed: ${res.error}` })
      return
    }
  }
}

async function adminTokensMenu(host: ShareHostApi, client: ReturnType<typeof adminClient>, tokens: Array<{ id: string; userId: string; label: string; createdAt: number; lastUsedAt: number; revoked: boolean }>): Promise<void> {
  while (true) {
    const fresh = (await client.tokens()).data?.tokens ?? []
    const options: ShareDialogSelectOption<string>[] = fresh
      .filter((t) => !t.revoked)
      .map((t) => ({
        title: `${t.label || "(unlabeled)"} ${t.id}`,
        value: t.id,
        description: `last used ${t.lastUsedAt ? new Date(t.lastUsedAt).toISOString().slice(0, 16).replace("T", " ") : "never"}`,
      }))
    options.push({ title: "Back", value: "__back" })
    const picked = await showSelect(host.ui, { title: `Active tokens (${options.length - 1}) — revoke`, options })
    if (picked === undefined || picked === "__back") return
    const sure = await showConfirm(host.ui, { title: "Revoke token", message: `Revoke ${picked}?\nThe holder can no longer write (existing shares keep their secrets unless the user is frozen).`, confirmLabel: "Revoke" })
    if (!sure) continue
    const res = await client.revokeToken(picked)
    host.ui.toast({ variant: res.ok ? "success" : "error", title: "OpenShare", message: res.ok ? "Token revoked." : `Failed: ${res.error}` })
  }
}

async function adminCodesMenu(host: ShareHostApi, client: ReturnType<typeof adminClient>, codes: Array<{ id: string; label: string; activationsLeft: number; used: number; disabled: boolean }>): Promise<void> {
  while (true) {
    const fresh = (await client.codes()).data?.codes ?? []
    const options: ShareDialogSelectOption<string>[] = fresh.map((c) => ({
      title: `${c.label}${c.disabled ? " (disabled)" : ""}`,
      value: c.id,
      description: c.activationsLeft === -1 ? "unlimited activations" : `${c.activationsLeft} left · ${c.used} used`,
    }))
    options.push({ title: "Create code", value: "__create", description: "invite: label + activation budget" })
    options.push({ title: "Back", value: "__back" })
    const picked = await showSelect(host.ui, { title: "Access codes", options })
    if (picked === undefined || picked === "__back") return
    if (picked === "__create") {
      const label = await showPrompt(host.ui, { title: "Code label", placeholder: "e.g. friends, team" })
      if (label === undefined) continue
      const raw = await showPrompt(host.ui, { title: "Activations", placeholder: "1 (personal invite) · number · -1 = unlimited" })
      if (raw === undefined) continue
      const n = Number(raw.trim() === "" ? "1" : raw.trim())
      const activations = Number.isFinite(n) && n >= 1 ? Math.floor(n) : -1
      const res = await client.createCode(label.trim() || "invite", activations)
      if (res.ok && res.data?.code) {
        await host.clipboard.write(res.data.code)
        await showInfo(host.ui, { title: "Code created", message: `${label.trim() || "invite"}: ${res.data.code}\n(${activations === -1 ? "unlimited" : activations} activation${activations === 1 ? "" : "s"})\n\n(copied to clipboard — shown once)` })
      } else {
        await showInfo(host.ui, { title: "Create failed", message: res.error ?? "unknown error" })
      }
      continue
    }
    const code = fresh.find((c) => c.id === picked)
    if (!code || code.disabled) continue
    const sure = await showConfirm(host.ui, { title: "Disable code", message: `Disable "${code.label}"?\nHolders can no longer enroll with it (existing tokens unaffected).`, confirmLabel: "Disable" })
    if (!sure) continue
    const res = await client.disableCode(picked)
    host.ui.toast({ variant: res.ok ? "success" : "error", title: "OpenShare", message: res.ok ? "Code disabled." : `Failed: ${res.error}` })
  }
}

async function adminSharesMenu(host: ShareHostApi, client: ReturnType<typeof adminClient>, url: string, shares: AdminShare[], users: AdminUser[]): Promise<void> {
  const labelOf = (id: string | null | undefined) => users.find((u) => u.id === id)?.label ?? id ?? "(ownerless)"
  while (true) {
    const fresh = (await client.shares()).data?.shares ?? []
    const options: ShareDialogSelectOption<string>[] = fresh.map((s) => ({
      title: `${s.id.slice(0, 10)}…`,
      value: s.id,
      description: `${labelOf(s.ownerId)} · ${new Date(s.createdAt).toISOString().slice(0, 16).replace("T", " ")}`,
    }))
    options.push({ title: "Back", value: "__back" })
    const picked = await showSelect(host.ui, { title: `Shares — ${url}`, options })
    if (picked === undefined || picked === "__back") return
    const share = fresh.find((s) => s.id === picked)
    if (!share) continue
    const action = await showSelect(host.ui, {
      title: `Share ${picked.slice(0, 12)}…`,
      options: [
        { title: "Reassign owner", value: "reassign", description: `currently ${labelOf(share.ownerId)} — the rescue path` },
        { title: "Delete share", value: "delete", description: "viewers get a final gone frame" },
        { title: "Back", value: "back" },
      ],
    })
    if (action === undefined || action === "back") continue
    if (action === "reassign") {
      const usersNow = (await client.users()).data?.users ?? []
      const target = await showSelect(host.ui, {
        title: "Reassign to user",
        options: [...usersNow.map((u) => ({ title: u.label, value: u.id, description: u.frozen ? "FROZEN — unfreeze after" : `${u.shares} shares` })), { title: "Cancel", value: "__cancel" }],
      })
      if (target === undefined || target === "__cancel") continue
      const res = await client.reassign(picked, target)
      host.ui.toast({ variant: res.ok ? "success" : "error", title: "OpenShare", message: res.ok ? "Reassigned (freeze cleared on this share)." : `Failed: ${res.error}` })
      continue
    }
    if (action === "delete") {
      const sure = await showConfirm(host.ui, { title: "Delete share", message: `Delete ${picked} permanently?`, confirmLabel: "Delete" })
      if (!sure) continue
      const res = await client.deleteShare(picked)
      host.ui.toast({ variant: res.ok ? "success" : "error", title: "OpenShare", message: res.ok ? "Share deleted." : `Failed: ${res.error}` })
      continue
    }
  }
}

/** The settings dialog. Returns when the user exits. */
export async function settingsDialog(host: ShareHostApi, startAtSession?: string): Promise<void> {
  let cfg = currentConfig()
  let dirty = false
  // Write target (owner rule): global settings home by default; any other
  // existing file in the read chain may be chosen explicitly. The TUI
  // never creates deploy-time override files.
  const candidates = writeCandidates(moduleDir())
  let writeTarget: WriteCandidate = candidates[0]
  const sources = configSourceMap(moduleDir())

  while (true) {
    const binding = startAtSession ? await readBinding(host.client, await resolveRoot(host.client, startAtSession)) : undefined
    const shared = binding?.url ? (binding.enabled === false ? "attached (dormant)" : "live") : "not shared"

    const options: ShareDialogSelectOption<string>[] = []
    options.push({ title: "Write target", value: "action:target", description: writeTarget.label, disabled: candidates.length <= 1 })
    options.push({ title: "Where values come from", value: "action:sources", description: summarizeSources(sources) })
    for (const [key, meta] of Object.entries(LABELS)) {
      if (meta.section === "Connection") options.push({ title: meta.label, value: `key:${key}`, description: withSource(displayValue(key, cfg), sources[key]) })
    }
    const servers = serverEntries(cfg)
    options.push({ title: "— Servers —", value: "servers:none", description: servers.length ? `${servers.length} saved · active receives new sessions` : "no membership yet", disabled: true })
    for (const s of servers) {
      const cred = s.entry.token ? "token saved" : s.entry.code ? "code saved" : "enrolls on demand"
      options.push({ title: s.url, value: `server:${s.url}`, description: `${s.entry.label ? s.entry.label + " · " : ""}${cred}${s.active ? " · ACTIVE" : ""}` })
    }
    options.push({ title: "Connect to a server", value: "server:add", description: "URL (+ access code) — enrolls and saves the token" })
    options.push({ title: "Admin console", value: "action:admin", description: "manage a server with its root token (users, codes, tokens, shares)" })
    options.push({ title: "Test connection", value: "action:test", description: "Probe the active server's /health" })
    for (const [key, meta] of Object.entries(LABELS)) {
      if (meta.section === "Sharing") options.push({ title: meta.label, value: `key:${key}`, description: withSource(displayValue(key, cfg), sources[key]) })
    }
    for (const [key, meta] of Object.entries(LABELS)) {
      if (meta.section === "Read auth") options.push({ title: meta.label, value: `key:${key}`, description: withSource(displayValue(key, cfg), sources[key]) })
    }
    for (const [key, meta] of Object.entries(LABELS)) {
      if (meta.section === "Advanced") options.push({ title: meta.label, value: `key:${key}`, description: withSource(displayValue(key, cfg), sources[key]) })
    }
    if (startAtSession) {
      options.push({ title: `— This session (${shared}) —`, value: "session:none", description: "Per-session actions and overrides", disabled: true })
      options.push({ title: binding?.url ? "Copy share link" : "Share this session", value: "session:share", description: binding?.url ? "copy the share URL to the clipboard" : "Set the share flag; the server plugin creates the page" })
      if (binding?.url) options.push({ title: "Stop sharing", value: "session:unshare", description: "Delete the share page and clear the flag" })
      options.push({ title: "Session TTL override (days)", value: "session:ttl", description: binding?.opts?.ttlDays !== undefined ? String(binding.opts.ttlDays) : "(worker default)" })
      options.push({ title: "Session read auth", value: "session:auth", description: binding?.opts?.authLogin ? `${binding.opts.authLogin} / ****` : "(config default)" })
    }
    options.push({ title: dirty ? "Save & exit" : "Exit", value: "action:exit", description: dirty ? `Write ${writeTarget.path}` : "No changes" })

    const choice = await showSelect(host.ui, { title: "OpenShare settings", options })
    if (choice === undefined || choice === "action:exit") {
      if (dirty) {
        const saved = saveConfig(cfg, writeTarget.path)
        if (saved) host.ui.toast({ variant: "success", title: "OpenShare", message: `Saved ${saved.path}` })
        else host.ui.toast({ variant: "error", title: "OpenShare", message: `Could not write ${writeTarget.path}.` })
      }
      host.ui.dialog.clear()
      return
    }

    if (choice === "action:target") {
      const picked = await showSelect(
        host.ui,
        {
          title: "Write target",
          placeholder: "Files that already exist; the global home is always available",
          options: candidates.map((candidate) => ({ title: candidate.label, value: candidate.path, description: candidate.path })),
          current: writeTarget.path,
        },
      )
      if (picked) writeTarget = candidates.find((candidate) => candidate.path === picked) ?? writeTarget
      continue
    }

    if (choice === "action:sources") {
      await showInfo(host.ui, { title: "Where values come from", message: sourcesMessage(sources) })
      continue
    }

    if (choice === "action:test") {
      const serverUrl = serverEntries(cfg).find((s) => s.active)?.url ?? cfg.workerUrl
      host.ui.toast({ variant: "info", title: "OpenShare", message: "Testing server connection..." })
      const result = await probeWorker(serverUrl)
      await showInfo(host.ui, {
        title: result.ok ? "Server reachable" : "Server unreachable",
        message: `${serverUrl || "(no server set)"} — ${result.detail}${result.ok && !serverEntries(cfg).some((s) => s.entry.token) ? "\nNote: no token held — the plugin enrolls on first contact (public) or needs a code (private)." : ""}`,
      })
      continue
    }

    if (choice === "server:add") {
      const res = await connectServerFlow(host)
      host.ui.toast({ variant: res.ok ? "success" : "error", title: "OpenShare", message: res.message, duration: 10000 })
      if (res.ok) cfg = currentConfig()
      continue
    }

    if (choice === "action:admin") {
      await adminConsole(host)
      cfg = currentConfig()
      continue
    }

    if (choice.startsWith("server:")) {
      await serverMenu(host, choice.slice(7))
      cfg = currentConfig()
      continue
    }

    if (choice.startsWith("key:")) {
      const key = choice.slice(4)
      const next = await editKey(host, cfg, key)
      if (next) {
        cfg = next
        dirty = true
      }
      continue
    }

    if (choice.startsWith("session:") && startAtSession) {
      const root = await resolveRoot(host.client, startAtSession)
      const current = await readBinding(host.client, root)
      if (choice === "session:share") {
        if (!isConfigured(cfg)) {
          await showInfo(host.ui, { title: "Not configured", message: "Set workerUrl and createToken (Connection) first, then share." })
          continue
        }
        const result = await confirmShare(host, root)
        host.ui.toast({ variant: result.ok ? "success" : "error", title: "OpenShare", message: result.message, duration: result.ok ? 8000 : 15000 })
        continue
      }
      if (choice === "session:unshare") {
        const okClear = await clearShareFlag(host.client, root)
        host.ui.toast({ variant: okClear ? "success" : "error", title: "OpenShare", message: okClear ? "Share flag cleared; the page is deleted via the sweeper path." : "Could not clear the flag." })
        continue
      }
      if (choice === "session:ttl") {
        const raw = await showPrompt(host.ui, { title: "Session TTL (days)", placeholder: "days", value: current?.opts?.ttlDays !== undefined ? String(current.opts.ttlDays) : "" })
        if (raw === undefined) continue
        const opts: SessionOpts = { ...(current?.opts ?? {}) }
        if (raw === "") delete opts.ttlDays
        else {
          const days = Number(raw)
          if (!Number.isFinite(days) || days <= 0) {
            host.ui.toast({ variant: "error", title: "OpenShare", message: "TTL must be a positive number of days." })
            continue
          }
          opts.ttlDays = Math.floor(days)
        }
        await setShareFlag(host.client, root, opts)
        host.ui.toast({ variant: "success", title: "OpenShare", message: opts.ttlDays !== undefined ? `Session TTL: ${opts.ttlDays}d (applies at the next attach/create)` : "Session TTL override cleared" })
        continue
      }
      if (choice === "session:auth") {
        const login = await showPrompt(host.ui, { title: "Session read auth: login", placeholder: "empty = use config default", value: current?.opts?.authLogin ?? "" })
        if (login === undefined) continue
        const password = await showPrompt(host.ui, { title: "Session read auth: password", placeholder: "empty = no password" })
        if (password === undefined) continue
        const opts: SessionOpts = { ...(current?.opts ?? {}) }
        if (login === "") {
          delete opts.authLogin
          delete opts.authPassword
        } else {
          opts.authLogin = login
          if (password !== "") opts.authPassword = password
          else delete opts.authPassword
        }
        await setShareFlag(host.client, root, opts)
        host.ui.toast({ variant: "success", title: "OpenShare", message: "Session read auth saved (applies at the next attach/create)." })
        continue
      }
    }
  }
}

/** Onboarding shown by /share when no server is connected: connect flow
 * first (URL + optional code = enrolled + active), full settings as the
 * fallback for manual configuration. */
export async function onboardingDialog(host: ShareHostApi): Promise<void> {
  const ok = await showConfirm(host.ui, {
    title: "Welcome to Open(code)Share",
    message: "Sharing needs a share server.\nConnect now (URL + access code if the hoster gave you one), or open the full settings?",
    confirmLabel: "Connect to a server",
  })
  if (ok) {
    const res = await connectServerFlow(host)
    host.ui.dialog.clear()
    host.ui.toast({ variant: res.ok ? "success" : "error", title: "OpenShare", message: res.message, duration: 10000 })
    if (!res.ok) await settingsDialog(host)
  } else {
    await settingsDialog(host)
  }
}
