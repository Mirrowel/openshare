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
  hostOf,
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
import { DIALOG_WIDTH_COLUMNS, kvHeightPercentOf, kvWidthOf, nextDialogWidth, UI_HEIGHT_PERCENT_KV, UI_WIDTH_KV, clampHeightPercent } from "./ui-prefs.js"
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

/** Row metadata: label (column 1), help (the one-line description), kind
 * (editor), section — plus `info` (the long-form [i] pane text: what it
 * does, effects, caveats) and `def` (the default shown in the pane). */
type LabelMeta = { label: string; help: string; kind: EditKind; section: string; info?: string; def?: string }

const LABELS: Record<string, LabelMeta> = {
  workerUrl: {
    label: "Worker URL",
    help: "Your openshare-worker deployment (https://…). Empty disables the plugin.",
    kind: "text",
    section: "Connection",
    info: "The base URL of your share server — the Cloudflare Worker or the portable Bun server. Every share page is created, synced and deleted through it.\n\nLegacy single-server key: the servers group below is the canonical multi-server form; this pair still works and synthesizes into it.",
    def: "(empty — plugin disabled)",
  },
  createToken: {
    label: "Create token",
    help: "The worker's CREATE_TOKEN. Required to create shares.",
    kind: "password",
    section: "Connection",
    info: "The server's root CREATE_TOKEN — full admin rights (create, edit, delete ANY share, manage users). Kept for legacy setups and hoster machines.\n\nRegular users should NOT hold the root token: connect via an access code instead (Connect to a server) and the plugin enrolls its own limited user token. The value is masked here but stored as-is in the config file.",
    def: "(empty)",
  },
  shareMode: {
    label: "Share mode",
    help: '"all" shares every session; "manual" needs /share. Default: TUI presence.',
    kind: "text",
    section: "Sharing",
    info: 'all: every NEW session shares automatically (CI posture). Sessions that existed before the plugin started are never auto-shared — share those explicitly. manual: sessions stay private until you run /share.\n\nDefault (empty): TUI presence decides — installing the TUI part means manual, server-only means all.',
    def: "auto (TUI presence)",
  },
  debounceMs: {
    label: "Sync interval (ms)",
    help: "Max time between syncs while streaming; anything batched rides the next one. Turn-end batches flush immediately. Default 10000; clamped into the server policy window.",
    kind: "number",
    section: "Sharing",
    info: "A rate limit anchored at the previous flush, not a restart-on-every-event debounce: an update arriving AFTER the interval flushes instantly; anything earlier rides the next tick. Turn-end batches (idle) always flush immediately regardless of this value.\n\nThe server clamps it into its allowed window (DEBOUNCE_MIN_MS..DEBOUNCE_MAX_MS, default 1000..60000).",
    def: "10000",
  },
  completedDelayMs: {
    label: "Completed delay (ms)",
    help: "Idle this long before the share says completed (default 5000, 0 = immediate). Busy cancels; opencode exit flushes. Clamped by the server.",
    kind: "number",
    section: "Sharing",
    info: "opencode's idle signal is authoritative turn end (busy is held through tool runs and permission waits). This delay only smooths the gap before an automation's NEXT prompt — if a new turn starts inside the window the timer cancels and the share stays live.\n\nA graceful opencode exit flushes the pending flip, so CI runs land their final status.",
    def: "5000",
  },
  modelLabel: {
    label: "Model label template",
    help: "$Provider/$Model placeholders; literal text as-is; empty hides the model.",
    kind: "text",
    section: "Sharing",
    info: 'How the model name appears on the share page. "$Provider/$Model" renders e.g. "closedrouter/zai/glm-5.3". Any literal text is used as-is; empty string hides the model line entirely.',
    def: '"$Provider/$Model"',
  },
  ttlDays: {
    label: "TTL (days)",
    help: "Share lifetime; the worker caps it at its MAX_TTL_DAYS.",
    kind: "number",
    section: "Sharing",
    info: "How long pages live before the server's sweeper deletes them. Capped server-side: the deployment's MAX_TTL_DAYS and the token's maxTtlDays limit both apply.\n\nA per-session override lives in the This-session section; it is sent at create/attach time.",
    def: "worker cap (90 on the reference deployment)",
  },
  openTasksInNewTab: {
    label: "Open tasks in new tab",
    help: "Viewer: task rows open subagent pages in a new tab.",
    kind: "text",
    section: "Sharing",
    info: "Viewer behavior only: clicking a task (subagent) row opens its sub-page in a new browser tab instead of navigating. true/false.",
    def: "true",
  },
  authLogin: {
    label: "Read auth: login",
    help: "Optional read gate for share pages. Empty removes protection on the next attach.",
    kind: "text",
    section: "Read auth",
    info: "Optional username for a login gate on NEW shares. Viewers must enter login+password (PBKDF2-hashed server-side, 7-day cookie, lockout after failures).\n\nWrite access is a separate lock — a login never lets anyone edit. Removing both values removes the gate on the next attach.",
    def: "(empty — no gate)",
  },
  authPassword: {
    label: "Read auth: password",
    help: "Optional read gate for share pages.",
    kind: "password",
    section: "Read auth",
    info: "The password half of the optional read gate. Stored in plain text in the config file — prefer per-session auth for anything sensitive. Only the hash ever reaches the server.",
    def: "(empty)",
  },
  spoolDir: {
    label: "Spool directory",
    help: "Temporary unacked-frame buffer (default: XDG data home).",
    kind: "text",
    section: "Advanced",
    info: "Where un-acked sync frames buffer on disk (one file per session per server). They replay automatically on reconnect. The binding in session metadata is the source of truth — the spool is an optimization, safe to clear while idle.",
    def: "XDG data home",
  },
  urlFile: {
    label: "URL file",
    help: 'File each share URL is appended to (all-mode). Empty = default openshare.urls.txt in the session directory; "none" = no URL file.',
    kind: "text",
    section: "Advanced",
    info: 'All-mode CI surface: every created share URL is APPENDED to this file and announced on stderr. Empty uses openshare.urls.txt in the session\'s working directory; "none" disables the file; a path writes there.\n\nManual mode (TUI) never writes it — the link lives in the TUI.',
    def: "openshare.urls.txt (session dir)",
  },
  announceStderr: {
    label: "Announce on stderr",
    help: '"true"/"false": the [openshare] live: and url file: log lines. false silences them; the share itself is unaffected.',
    kind: "text",
    section: "Advanced",
    info: "Whether the informational [openshare] lines reach stderr in all-mode (CI logs). Error-class lines (worker down, refused, timeouts) ALWAYS reach stderr regardless. In manual mode stderr is errors-only by design.",
    def: "true",
  },
}

/** [i] pane text for a config key row: long info + live value + source + default. */
function helpForKey(key: string, cfg: ShareConfig, sources: Record<string, string>): string | undefined {
  const meta = LABELS[key]
  if (!meta) return undefined
  const lines = [meta.info ?? meta.help]
  lines.push("")
  lines.push(`Current: ${displayValue(key, cfg)}`)
  if (sources[key]) lines.push(`Source: ${sources[key]} (overrides anything written below it)`)
  if (meta.def) lines.push(`Default: ${meta.def}`)
  return lines.join("\n")
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
    options.push({
      title: "Admin panel",
      value: "admin",
      description: "root-token console: users, codes, tokens, shares",
      help: `Opens the admin console for THIS server: manage users (freeze/unfreeze/mint/delete), revoke tokens, create access codes, list/reassign/delete shares, purge.\n\nNeeds the server's root CREATE_TOKEN (saved admin token used first; prompted otherwise, and then saved). User tokens cannot administer.`,
    })
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
    if (choice === "admin") {
      await adminConsole(host, url)
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
 * shares — the /api/admin surface as promise menus. Reached from the
 * per-server submenu (Admin panel); pinnedUrl skips the server picker. */
export async function adminConsole(host: ShareHostApi, pinnedUrl?: string): Promise<void> {
  // 1) pick the server (skipped when pinned from a server submenu)
  let url = pinnedUrl
  if (!url) {
    const entries = serverEntries()
    const pickOptions: ShareDialogSelectOption<string>[] = entries.map((s) => ({
      title: s.url,
      value: s.url,
      description: `${s.entry.label ? s.entry.label + " · " : ""}${s.entry.adminToken ? "admin token saved" : "no admin token saved"}`,
    }))
    pickOptions.push({ title: "Enter a server URL…", value: "__prompt" })
    const picked = await showSelect(host.ui, { title: "Admin console — server", options: pickOptions })
    if (picked === undefined) return
    url = picked
    if (picked === "__prompt") {
      const raw = await showPrompt(host.ui, { title: "Server URL", placeholder: "https://your-openshare-host" })
      if (raw === undefined || raw === "") return
      url = normServerUrl(raw)
    }
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

/** The settings dialog: a compact ROOT of group entries (with live
 * summaries) opening focused submenus. Two-level by design — one flat
 * ~25-row dump was unreadable (owner-directed regroup 2026-10-19).
 * Save semantics unchanged: root Exit saves when dirty; submenu Back
 * just returns. */
export async function settingsDialog(host: ShareHostApi, startAtSession?: string): Promise<void> {
  let cfg = currentConfig()
  let dirty = false
  // Write target (owner rule): global settings home by default; any other
  // existing file in the read chain may be chosen explicitly. The TUI
  // never creates deploy-time override files.
  const candidates = writeCandidates(moduleDir())
  let writeTarget: WriteCandidate = candidates[0]
  const sources = configSourceMap(moduleDir())

  type GroupId = "session" | "connection" | "servers" | "sharing" | "readauth" | "interface" | "advanced" | "configfiles"
  const GROUP_LABEL: Record<GroupId, string> = {
    session: "This session",
    connection: "Connection",
    servers: "Servers",
    sharing: "Sharing",
    readauth: "Read auth",
    interface: "Interface",
    advanced: "Advanced",
    configfiles: "Config files",
  }

  // ---- row builders (one per group) ---------------------------------------

  const keyRows = (section: string): ShareDialogSelectOption<string>[] =>
    Object.entries(LABELS)
      .filter(([, meta]) => meta.section === section)
      .map(([key, meta]) => ({ title: meta.label, value: `key:${key}`, description: withSource(displayValue(key, cfg), sources[key]), help: helpForKey(key, cfg, sources) }))

  const serverRows = (): ShareDialogSelectOption<string>[] => {
    const servers = serverEntries(cfg)
    const rows: ShareDialogSelectOption<string>[] = servers.map((s) => {
      const cred = s.entry.token ? "token saved" : s.entry.code ? "code saved" : "enrolls on demand"
      return {
        title: s.url,
        value: `server:${s.url}`,
        description: `${s.entry.label ? s.entry.label + " · " : ""}${cred}${s.active ? " · ACTIVE" : ""}`,
        help: [
          `Server: ${s.url}`,
          `Label: ${s.entry.label ?? "(none)"}`,
          `Credential: ${s.entry.token ? `user token ${mask(s.entry.token)}` : s.entry.code ? "access code saved — enrolls on demand" : "none — public server, enrolls on demand"}`,
          `Receives new sessions: ${s.active ? "YES (active)" : "no"}`,
          "",
          "Every ACTIVE server receives new sessions (fan-out); one active server is the normal setup. Tokens persist in the settings home; enroll once, then it just works. The per-server submenu (enter) adds the admin panel for this server.",
        ].join("\n"),
      }
    })
    rows.push({
      title: "Connect to a server",
      value: "server:add",
      description: "URL (+ access code) — enrolls and saves the token",
      help: "Onboarding flow: paste the server URL; public servers enroll immediately, private ones ask for an access code (osc_… from the hoster). The server issues a user token that persists in the settings home — the root CREATE_TOKEN is never needed for sharing.",
    })
    rows.push({
      title: "Test connection",
      value: "action:test",
      description: "Probe the active server's /health",
      help: "Fetches /health on the active server and reports the service, auth mode, and socket policy. A quick way to verify URL and reachability before sharing.",
    })
    return rows
  }

  const interfaceRows = (): ShareDialogSelectOption<string>[] => {
    const uiWidth = kvWidthOf(host.kv)
    const uiHeight = kvHeightPercentOf(host.kv)
    return [
      {
        title: "Menu width",
        value: "ui:width",
        description: `${uiWidth} (${DIALOG_WIDTH_COLUMNS[uiWidth]} columns)`,
        help: `How wide OpenShare menus render. OpenCode exposes fixed widths only: medium = 60, large = 88, xlarge = 116 columns. Selecting cycles to the next size.\n\nCurrent: ${uiWidth} (${DIALOG_WIDTH_COLUMNS[uiWidth]} columns)\nStored per host (opencode's own preference store), not in the config file.`,
      },
      {
        title: "Menu height",
        value: "ui:height",
        description: `${uiHeight}% of terminal`,
        help: `Maximum height of OpenShare menus, as a percent of terminal rows (25-100). Short menus stay compact; long ones scroll inside this cap. Presets: compact 35, normal 50, tall 70, max 100.\n\nCurrent: ${uiHeight}%\nStored per host, not in the config file.`,
      },
    ]
  }

  const configRows = (): ShareDialogSelectOption<string>[] => [
    {
      title: "Write target",
      value: "action:target",
      description: writeTarget.label,
      disabled: candidates.length <= 1,
      help: `Which file "Save & exit" writes. The global settings home is always available; other files in the read chain only when they already exist (the TUI never creates deploy-time override files).\n\nWriting: ${writeTarget.path}`,
    },
    {
      title: "Where values come from",
      value: "action:sources",
      description: summarizeSources(sources),
      help: `Config merges per key, highest priority wins: OPENSHARE_* env > plugin options > adjacent openshare.config.json > openshare.local.json (repo walk-up) > settings home > defaults. An empty string means unset for url/token keys.\n\n${sourcesMessage(sources)}`,
    },
  ]

  const sessionRows = async (): Promise<ShareDialogSelectOption<string>[]> => {
    if (!startAtSession) return []
    const binding = await readBinding(host.client, await resolveRoot(host.client, startAtSession))
    const rows: ShareDialogSelectOption<string>[] = [
      {
        title: binding?.url ? "Copy share link" : "Share this session",
        value: "session:share",
        description: binding?.url ? "copy the share URL to the clipboard" : "Set the share flag; the server plugin creates the page",
        help: binding?.url
          ? `Copies the share URL to the clipboard.\n\nURL: ${binding.url}\nShare id: ${binding.id ?? "?"}`
          : "Publishes this session (and its subagent sessions) to the active server. The full history lands in the page — sharing mid-session is first-class, nothing is missed.",
      },
    ]
    if (binding?.url) {
      rows.push({
        title: "Stop sharing",
        value: "session:unshare",
        description: "Delete the share page and clear the flag",
        help: `Deletes the page(s) server-side and clears the share flag from this session's metadata. Every link stops working (viewers see a final "gone" state). Sharing again later creates fresh page(s) with new URLs.`,
      })
    }
    rows.push({
      title: "Session TTL override (days)",
      value: "session:ttl",
      description: binding?.opts?.ttlDays !== undefined ? String(binding.opts.ttlDays) : "(worker default)",
      help: `Per-session share lifetime. Overrides the config ttlDays for THIS session's pages; still capped by the server's MAX_TTL_DAYS and the token's maxTtlDays. Applied at the next create/attach.\n\nCurrent: ${binding?.opts?.ttlDays !== undefined ? `${binding.opts.ttlDays} days` : "(none — config default)"}`,
    })
    rows.push({
      title: "Session read auth",
      value: "session:auth",
      description: binding?.opts?.authLogin ? `${binding.opts.authLogin} / ****` : "(config default)",
      help: `Login gate for THIS session's page only — viewers must log in (7-day cookie, lockout). Overrides the config read auth. Applied at the next create/attach; removing the login removes the gate.\n\nCurrent: ${binding?.opts?.authLogin ? `${binding.opts.authLogin} / (password set)` : "(none — config default applies)"}`,
    })
    return rows
  }

  const rowsFor = async (id: GroupId): Promise<ShareDialogSelectOption<string>[]> => {
    switch (id) {
      case "session":
        return await sessionRows()
      case "connection":
        return keyRows("Connection")
      case "servers":
        return serverRows()
      case "sharing":
        return keyRows("Sharing")
      case "readauth":
        return keyRows("Read auth")
      case "interface":
        return interfaceRows()
      case "advanced":
        return keyRows("Advanced")
      case "configfiles":
        return configRows()
    }
  }

  // ---- shared dispatch: every non-root choice, same handlers as ever ------

  const dispatch = async (choice: string): Promise<void> => {
    if (choice === "action:target") {
      const picked = await showSelect(host.ui, {
        title: "Write target",
        placeholder: "Files that already exist; the global home is always available",
        options: candidates.map((candidate) => ({ title: candidate.label, value: candidate.path, description: candidate.path })),
        current: writeTarget.path,
      })
      if (picked) writeTarget = candidates.find((candidate) => candidate.path === picked) ?? writeTarget
      return
    }

    if (choice === "action:sources") {
      await showInfo(host.ui, { title: "Where values come from", message: sourcesMessage(sources) })
      return
    }

    if (choice === "ui:width") {
      host.kv.set(UI_WIDTH_KV, nextDialogWidth(kvWidthOf(host.kv)))
      host.ui.toast({ variant: "info", title: "OpenShare", message: `Menu width: ${kvWidthOf(host.kv)} (${DIALOG_WIDTH_COLUMNS[kvWidthOf(host.kv)]} columns) — applies to the next menu.` })
      return
    }

    if (choice === "ui:height") {
      let height: number | undefined
      if (host.ui.showHeightSlider) {
        height = await host.ui.showHeightSlider(kvHeightPercentOf(host.kv))
      } else {
        const raw = await showPrompt(host.ui, { title: "Menu height percent", placeholder: "25-100", value: String(kvHeightPercentOf(host.kv)) })
        if (raw !== undefined) {
          const parsed = Number(raw)
          if (!Number.isFinite(parsed)) {
            host.ui.toast({ variant: "error", title: "OpenShare", message: "Height must be a number from 25 to 100." })
            return
          }
          height = clampHeightPercent(parsed)
        }
      }
      if (height !== undefined) {
        host.kv.set(UI_HEIGHT_PERCENT_KV, height)
        host.ui.toast({ variant: "info", title: "OpenShare", message: `Menu height: ${height}% of terminal — applies to the next menu.` })
      }
      return
    }

    if (choice === "action:test") {
      const serverUrl = serverEntries(cfg).find((s) => s.active)?.url ?? cfg.workerUrl
      host.ui.toast({ variant: "info", title: "OpenShare", message: "Testing server connection..." })
      const result = await probeWorker(serverUrl)
      await showInfo(host.ui, {
        title: result.ok ? "Server reachable" : "Server unreachable",
        message: `${serverUrl || "(no server set)"} — ${result.detail}${result.ok && !serverEntries(cfg).some((s) => s.entry.token) ? "\nNote: no token held — the plugin enrolls on first contact (public) or needs a code (private)." : ""}`,
      })
      return
    }

    if (choice === "server:add") {
      const res = await connectServerFlow(host)
      host.ui.toast({ variant: res.ok ? "success" : "error", title: "OpenShare", message: res.message, duration: 10000 })
      if (res.ok) cfg = currentConfig()
      return
    }

    if (choice.startsWith("server:")) {
      await serverMenu(host, choice.slice(7))
      cfg = currentConfig()
      return
    }

    if (choice.startsWith("key:")) {
      const next = await editKey(host, cfg, choice.slice(4))
      if (next) {
        cfg = next
        dirty = true
      }
      return
    }

    if (choice.startsWith("session:") && startAtSession) {
      const root = await resolveRoot(host.client, startAtSession)
      const current = await readBinding(host.client, root)
      if (choice === "session:share") {
        if (!isConfigured(cfg)) {
          await showInfo(host.ui, { title: "Not configured", message: "Connect a server (Servers group) first, then share." })
          return
        }
        const result = await confirmShare(host, root)
        host.ui.toast({ variant: result.ok ? "success" : "error", title: "OpenShare", message: result.message, duration: result.ok ? 8000 : 15000 })
        return
      }
      if (choice === "session:unshare") {
        const okClear = await clearShareFlag(host.client, root)
        host.ui.toast({ variant: okClear ? "success" : "error", title: "OpenShare", message: okClear ? "Share flag cleared; the page is deleted via the sweeper path." : "Could not clear the flag." })
        return
      }
      if (choice === "session:ttl") {
        const raw = await showPrompt(host.ui, { title: "Session TTL (days)", placeholder: "days", value: current?.opts?.ttlDays !== undefined ? String(current.opts.ttlDays) : "" })
        if (raw === undefined) return
        const opts: SessionOpts = { ...(current?.opts ?? {}) }
        if (raw === "") delete opts.ttlDays
        else {
          const days = Number(raw)
          if (!Number.isFinite(days) || days <= 0) {
            host.ui.toast({ variant: "error", title: "OpenShare", message: "TTL must be a positive number of days." })
            return
          }
          opts.ttlDays = Math.floor(days)
        }
        await setShareFlag(host.client, root, opts)
        host.ui.toast({ variant: "success", title: "OpenShare", message: opts.ttlDays !== undefined ? `Session TTL: ${opts.ttlDays}d (applies at the next attach/create)` : "Session TTL override cleared" })
        return
      }
      if (choice === "session:auth") {
        const login = await showPrompt(host.ui, { title: "Session read auth: login", placeholder: "empty = use config default", value: current?.opts?.authLogin ?? "" })
        if (login === undefined) return
        const password = await showPrompt(host.ui, { title: "Session read auth: password", placeholder: "empty = no password" })
        if (password === undefined) return
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
        return
      }
    }
  }

  // ---- group submenu loop ---------------------------------------------------

  const groupMenu = async (id: GroupId): Promise<void> => {
    while (true) {
      const rows = await rowsFor(id)
      if (!rows.length) return
      const options = [...rows, { title: "Back", value: "__back" }]
      const choice = await showSelect(host.ui, { title: `OpenShare — ${GROUP_LABEL[id]}`, options })
      if (choice === undefined || choice === "__back") return
      await dispatch(choice)
    }
  }

  // ---- root: compact group list with live summaries --------------------------

  const seconds = (ms: number | undefined, fallback: number) => `${Math.round((ms ?? fallback) / 100) / 10}s`
  while (true) {
    const servers = serverEntries(cfg)
    const active = servers.find((s) => s.active)
    const connectionSummary = cfg.workerUrl
      ? `${hostOf(cfg.workerUrl)}${cfg.createToken ? " · root token" : ""}`
      : active
        ? `${hostOf(active.url)} · servers group`
        : "not configured"
    const uiWidth = kvWidthOf(host.kv)

    const groups: Array<{ id: GroupId; summary: string; help: string }> = []
    if (startAtSession) {
      const binding = await readBinding(host.client, await resolveRoot(host.client, startAtSession))
      const shared = binding?.url ? (binding.enabled === false ? "attached (dormant)" : "live") : "not shared"
      groups.push({
        id: "session",
        summary: shared,
        help: `Per-session state and overrides for the session this dialog was opened on.\n\nStatus: ${shared}${binding?.url ? `\nURL: ${binding.url}` : ""}\n\nInside: share/stop sharing, session TTL override, session read auth.`,
      })
    }
    groups.push({
      id: "connection",
      summary: connectionSummary,
      help: `The legacy single-server pair: workerUrl + createToken (root). The Servers group is the canonical form — tokens per server, enrollment, fan-out; this pair still works and synthesizes into it.\n\nInside: Worker URL, Create token.`,
    })
    groups.push({
      id: "servers",
      summary: servers.length ? `${servers.length} saved${active ? ` · active: ${hostOf(active.url)}` : " · none active"}` : "no membership yet",
      help: `Your share-server memberships: credentials, active destination, and per-server actions (enroll, rotate, disconnect, admin panel, test, remove). Connect adds a server by URL (+ access code on private ones).\n\nEvery ACTIVE server receives new sessions (fan-out).`,
    })
    groups.push({
      id: "sharing",
      summary: `sync ${seconds(cfg.debounceMs, 10000)} · completed ${seconds(cfg.completedDelayMs, 5000)} · TTL ${cfg.ttlDays ?? "server cap"}`,
      help: `What and how sessions stream: share mode (all/manual), sync cadence, the completed-delay, the model label on pages, share TTL, and the viewer's task-tab behavior.\n\nCadence values are clamped by the server's policy window.`,
    })
    groups.push({
      id: "readauth",
      summary: cfg.authLogin ? `${cfg.authLogin} / ****` : "none set",
      help: `Optional login gate for NEW share pages: viewers must enter login+password (PBKDF2 server-side, 7-day cookie, lockout after failures). Per-session overrides live in This session.\n\nWrite access is a separate lock — a login never lets anyone edit.`,
    })
    groups.push({
      id: "interface",
      summary: `${uiWidth} (${DIALOG_WIDTH_COLUMNS[uiWidth]} cols) · ${kvHeightPercentOf(host.kv)}% height`,
      help: `OpenShare menu sizing: width (opencode's fixed dialog widths: 60/88/116 columns) and height (a percent of terminal rows, presets compact/normal/tall/max).\n\nStored in the host's preference store — per machine, not the config file.`,
    })
    groups.push({
      id: "advanced",
      summary: "spool dir · url file · stderr",
      help: `Rarely-touched plumbing: the un-acked frame spool directory, the all-mode URL file (append log for CI), and the stderr announce lines.`,
    })
    groups.push({
      id: "configfiles",
      summary: `write: ${writeTarget.label}`,
      help: `Which file Save & exit writes (global settings home by default; other existing files selectable) and the per-key source map of the current read chain (env > options > adjacent > local > home > defaults).`,
    })

    const options: ShareDialogSelectOption<string>[] = groups.map((group) => ({
      title: GROUP_LABEL[group.id],
      value: `group:${group.id}`,
      description: group.summary,
      help: group.help,
    }))
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
    if (choice.startsWith("group:")) {
      const id = choice.slice(6) as GroupId
      if (GROUP_LABEL[id]) await groupMenu(id)
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
