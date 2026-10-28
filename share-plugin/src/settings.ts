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
  patchSessionBinding,
  readBinding,
  readBindings,
  resolveRoot,
  rotateAtServer,
  runUnshareFlow,
  saveConfig,
  saveServerEntry,
  meClient,
  serverEntries,
  setShareFlag,
  setShareOpts,
  shareWithConsent,
  workerDeleteShare,
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

function showConfirm(ui: UI, props: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
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
type LabelMeta = { label: string; help: string; kind: EditKind; section: string; info?: string; def?: string; /** fixed vocabulary — edits via a selection menu, not a prompt */ options?: string[] }

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
    help: '"all" shares every session; "manual" needs /share. Default: TUI presence. Takes effect after opencode restarts.',
    kind: "text",
    options: ["auto", "all", "manual"],
    section: "Sharing",
    info: 'all: every NEW session shares automatically (CI posture). Sessions that existed before the plugin started are never auto-shared - share those explicitly. manual: sessions stay private until you run /share.\n\nDefault (empty): TUI presence decides - installing the TUI part means manual, server-only means all.\n\nNOTE: the mode is resolved once at plugin load. Changing it here saves immediately but only takes effect after opencode restarts - until then new sessions keep following the OLD mode.',
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
    options: ["true", "false"],
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
  if (key === "announceStderr") return cfg.announceStderr !== false ? "on" : "off"
  const value = (cfg as unknown as Record<string, unknown>)[key]
  return value === undefined || value === "" ? "(not set)" : String(value)
}

async function editKey(host: ShareHostApi, cfg: ShareConfig, key: string): Promise<ShareConfig | undefined> {
  const meta = LABELS[key]
  if (!meta) return undefined
  // selection-backed settings (owner: "setting share mode i need to enter it
  // manually? No selection?") — fixed vocabularies become menus
  if (meta.options) {
    const current = String((cfg as unknown as Record<string, unknown>)[key] ?? "")
    const picked = await showSelect(host.ui, {
      title: meta.label,
      options: meta.options.map((option) => ({
        title: option,
        value: option,
        description: option === current ? "● current" : "",
      })),
      current,
    })
    if (picked === undefined) return undefined
    const next = { ...cfg } as unknown as Record<string, unknown>
    if (key === "shareMode") next[key] = picked === "auto" ? undefined : picked
    else if (key === "announceStderr") next[key] = picked === "true"
    else next[key] = picked
    return next as ShareConfig
  }
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
  } else if (key === "urlFile") {
    // "" = default path, "none" = disabled, anything else = explicit path
    next[key] = raw.trim().toLowerCase() === "none" ? "none" : raw
  } else {
    next[key] = raw
  }
  return next as ShareConfig
}

/** Connect (add + enroll) a server - the /share first-run flow and the
 * settings "Connect to a server" row share it. Prompts the URL, probes
 * the auth mode, then ASKS ONCE (owner directive - no silent
 * auto-enroll): onboard to an account, or stay anonymous (public
 * servers only; anonymous shares sit under the server's global caps).
 * Onboarding detects whether a code is needed and only then prompts for
 * one (a code already in config is used without asking). The outcome is
 * remembered per server: a token means onboarded, an anonymous flag
 * means declined. */
export async function connectServerFlow(host: ShareHostApi): Promise<{ ok: boolean; message: string; url?: string }> {
  const raw = await showPrompt(host.ui, { title: "Share server URL", placeholder: "https://your-openshare-host" })
  if (raw === undefined || raw === "") return { ok: false, message: "Cancelled." }
  const url = normServerUrl(raw)
  if (!/^https?:\/\//.test(url)) return { ok: false, message: "URL must start with http:// or https://" }
  host.ui.toast({ variant: "info", title: "OpenShare", message: `Probing ${url}:` })
  const probe = await probeAuthMode(url)
  if (!probe.ok) return { ok: false, message: `${url}: ${probe.detail}` }
  const existing = serverEntries().find((sv) => sv.url === url)?.entry ?? {}
  const deactivateOthers = () => {
    for (const other of serverEntries()) {
      if (other.url !== url) saveServerEntry(other.url, { active: undefined })
    }
  }
  if (probe.mode === "public") {
    // the ask: an account is a real thing (own shares, own limits,
    // revocable credentials) - but anonymous sharing works too
    const picked = await showSelect(host.ui, {
      title: `${url} - account?`,
      options: [
        {
          value: "onboard",
          title: "Onboard (get an account)",
          description: "your own user, tokens and share limits; survives the server's anonymous caps",
          help: "An account gives you a revocable identity with your own share registry and limits. Depending on the server you may need a one-time access code from the hoster - you'll be asked only if it's required.",
        },
        {
          value: "anon",
          title: "Stay anonymous",
          description: "share without an account; counts against the server-wide anonymous limits",
          help: "No identity, no token to manage. Shares are ownerless: whoever holds the share's secret controls them, and the server may throttle anonymous creates globally. You can onboard later from Servers -> the server -> Enroll now.",
        },
      ],
    })
    if (picked === "anon") {
      saveServerEntry(url, { ...(existing.token ? {} : { anonymous: true }), label: existing.label, active: true })
      return { ok: true, message: `Connected to ${url} anonymously - sharing works, no account.`, url }
    }
    if (picked === undefined || picked === null) return { ok: false, message: "Cancelled." }
    // onboard: try without a code (codeless servers), fall through to
    // the code prompt exactly when the server demands one
    let code = existing.code ?? ""
    if (!code) {
      const free = await enrollAtServer(url, "")
      if (free.ok) {
        deactivateOthers()
        saveServerEntry(url, { token: free.token, label: free.label, anonymous: undefined, active: true })
        return { ok: true, message: `Connected to ${url} as "${free.label}" - sharing goes there now.`, url }
      }
      const typed = await showPrompt(host.ui, { title: `${url} needs an access code`, placeholder: "osc_: (from the hoster)" })
      if (typed === undefined) return { ok: false, message: "Cancelled - this server needs a code to onboard." }
      code = typed.trim()
    }
    const res = await enrollAtServer(url, code)
    if (!res.ok) return { ok: false, message: `Enrollment refused: ${res.error}` }
    deactivateOthers()
    saveServerEntry(url, { token: res.token, label: res.label, code: code || undefined, anonymous: undefined, active: true })
    return { ok: true, message: `Connected to ${url} as "${res.label}" - sharing goes there now.`, url }
  }
  // private server: a code is required, full stop
  let code = existing.code ?? ""
  if (!code) {
    const typed = await showPrompt(host.ui, { title: `${url} needs an access code`, placeholder: "osc_: (from the hoster)" })
    if (typed === undefined) return { ok: false, message: "Cancelled - private servers need a code." }
    code = typed.trim()
  }
  const res = await enrollAtServer(url, code)
  if (!res.ok) return { ok: false, message: `Enrollment refused: ${res.error}` }
  deactivateOthers()
  saveServerEntry(url, { token: res.token, label: res.label, code: code || undefined, active: true })
  return { ok: true, message: `Connected to ${url} as "${res.label}" - sharing goes there now.`, url }
}

/** Per-server submenu: identity status + membership actions. Root-token
 * holders get "Get a user token" (admin mints their own user identity —
 * root stays as adminToken; being admin and being a user are NOT mutually
 * exclusive, live-caught). */
async function serverMenu(host: ShareHostApi, url: string): Promise<void> {
  while (true) {
    const entries = serverEntries()
    const mine = entries.find((s) => s.url === url)
    if (!mine) return
    const holdsRoot = !!mine.entry.token && mine.entry.token === (mine.entry.adminToken ?? adminTokenFor(url))
    const cred = holdsRoot
      ? `ROOT token ${mask(mine.entry.token)} — admin, no user identity`
      : mine.entry.token
        ? `token ${mask(mine.entry.token)}`
        : mine.entry.code
          ? "no token (code saved, enrolls on demand)"
          : mine.entry.anonymous
            ? "anonymous (declined onboarding)"
            : "no token (public server, shares anonymously)"
    const options: ShareDialogSelectOption<string>[] = [
      { title: url, value: "info", description: `${mine.entry.label ?? "(no label)"} · ${cred}${mine.active ? " · ACTIVE" : ""}`, disabled: true },
    ]
    if (!mine.active) options.push({ title: "Set active", value: "active", description: "new sessions share here" })
    if (holdsRoot) {
      options.push({
        title: "Get a user token",
        value: "adopt",
        description: "admin-mint YOUR user token; root stays saved",
        help: `You hold the server's ROOT token — full admin, but root is not a user identity: rotate/disconnect act on user tokens, and a root-holder "user" doesn't exist.\n\nThis creates your own user on ${url} (label prompt, prefilled), mints its token, and saves it as this server's user token. The root token stays in adminToken for the admin panel. You become admin AND user.`,
      })
    }
    if (!mine.entry.token || holdsRoot) options.push({ title: "Enroll now", value: "enroll", description: holdsRoot ? "join as a user via code/public enrollment" : "get a user token immediately" })
    if (mine.entry.token && !holdsRoot) options.push({ title: "Rotate token", value: "rotate", description: "new token, old one revoked" })
    if (mine.entry.token && !holdsRoot) options.push({ title: "Your account", value: "account", description: "limits, token expiry, your shares" })
    if (mine.entry.token && !holdsRoot) options.push({ title: "Disconnect", value: "disconnect", description: "revoke the token server-side and forget it", danger: true })
    options.push({
      title: "Admin panel",
      value: "admin",
      description: "root-token console: users, codes, tokens, shares",
      help: `Opens the admin console for THIS server: manage users (freeze/unfreeze/mint/delete), revoke tokens, create access codes, list/reassign/delete shares, purge.\n\nNeeds the server's root CREATE_TOKEN (saved admin token used first; prompted otherwise, and then saved). User tokens cannot administer.`,
    })
    options.push({ title: "Test this server", value: "test", description: "probe /health" })
    options.push({ title: "Remove from config", value: "remove", description: "drop the saved membership (server-side state untouched)", danger: true })
    options.push({ title: "Back", value: "__back" })

    const choice = await showSelect(host.ui, { title: "Share server", options })
    if (choice === undefined || choice === "__back") return

    if (choice === "active") {
      // make-primary WITHOUT collapsing fan-out: other explicit actives
      // stay active (the engine targets every active entry); silently
      // deactivating them destroyed hand-built multi-server setups
      saveServerEntry(url, { active: true })
      const stillActive = serverEntries().filter((s) => s.active)
      host.ui.toast({
        variant: "success",
        title: "OpenShare",
        message: stillActive.length > 1 ? `${url} is primary - ${stillActive.length} servers stay ACTIVE (fan-out): new sessions mirror to all of them.` : `${url} is now the active server.`,
      })
      return
    }
    if (choice === "adopt") {
      const rootToken = mine.entry.adminToken ?? adminTokenFor(url)
      if (!rootToken) {
        await showInfo(host.ui, { title: "No admin token", message: "The root token is needed to mint your user token. Open the Admin panel once (it saves the token), then retry." })
        continue
      }
      const prefill = `admin-${hostOf(url).replace(/[^a-z0-9-]/gi, "") || "user"}`
      const label = (await showPrompt(host.ui, { title: "Your user label on this server", placeholder: "shown in the admin user list", value: prefill }))?.trim()
      if (!label) continue
      const client = adminClient(url, rootToken)
      const made = await client.createUser(label)
      if (!made.ok || !made.data?.userId) {
        await showInfo(host.ui, { title: "User creation failed", message: `${url}: ${made.error ?? "unknown error"}` })
        continue
      }
      const minted = await client.mintToken(made.data.userId, label)
      if (!minted.ok || !minted.data?.token) {
        await showInfo(host.ui, { title: "Token mint failed", message: `${url}: ${minted.error ?? "unknown error"} (user was created — retry mint from the admin panel)` })
        continue
      }
      saveServerEntry(url, { token: minted.data.token, label, adminToken: rootToken })
      host.ui.toast({ variant: "success", title: "OpenShare", message: `User token for "${label}" saved — rotate and disconnect now work; root stays for the admin panel.` })
      continue
    }
    if (choice === "enroll") {
      const probe = await probeAuthMode(url)
      if (!probe.ok) {
        await showInfo(host.ui, { title: "Unreachable", message: `${url}: ${probe.detail}` })
        continue
      }
      let code = mine.entry.code ?? ""
      if (!code) {
        // codeless first: only prompt when the server actually demands
        // a code (public + codeless-on boards silently, like connect)
        const free = await enrollAtServer(url, "")
        if (free.ok) {
          saveServerEntry(url, { token: free.token, label: free.label, anonymous: undefined })
          host.ui.toast({ variant: "success", title: "OpenShare", message: `Enrolled as "${free.label}".` })
          continue
        }
        if (!/code required/i.test(free.error ?? "")) {
          await showInfo(host.ui, { title: "Enrollment refused", message: free.error ?? "unknown error" })
          continue
        }
        const typed = await showPrompt(host.ui, { title: `${url} needs an access code`, placeholder: "osc_: (from the hoster)" })
        if (typed === undefined) continue
        code = typed.trim()
        if (code) saveServerEntry(url, { code })
      }
      const res = await enrollAtServer(url, code)
      if (res.ok) {
        saveServerEntry(url, { token: res.token, label: res.label, anonymous: undefined })
        host.ui.toast({ variant: "success", title: "OpenShare", message: `Enrolled as "${res.label}".` })
      } else {
        await showInfo(host.ui, { title: "Enrollment refused", message: res.error ?? "unknown error" })
      }
      continue
    }
    if (choice === "account") {
      const me = meClient(url, mine.entry.token ?? "")
      const [meRes, sharesRes] = await Promise.all([me.me(), me.myShares()])
      if (!meRes.ok) {
        await showInfo(host.ui, { title: "Account", message: `Could not read your account: ${meRes.error ?? "error"}.\nIf the token was revoked server-side, use Enroll now instead.` })
        continue
      }
      const d = meRes.data!
      const lim = d.token?.limits ?? {}
      const fmt = (v: number | undefined) => (v ? String(v) : "unlimited")
      const lines = [
        `User: ${d.label} (${d.userId})`,
        `Token: ${d.token?.label ?? "?"} - expires ${d.token?.expiresAt ? new Date(d.token.expiresAt).toISOString().slice(0, 10) : "never"}`,
        `Limits: live shares ${fmt(lim.maxLiveShares)} - max TTL ${fmt(lim.maxTtlDays)}d - daily creates ${fmt(lim.dailyCreates)}`,
      ]
      if (sharesRes.ok) {
        const shares = sharesRes.data?.shares ?? []
        lines.push(`Shares: ${shares.length} (${shares.filter((s) => s.status === "live").length} live)`)
        for (const s of shares.slice(0, 10)) lines.push(`  ${s.id} - ${s.status} - ${new Date(s.createdAt).toISOString().slice(0, 10)}`)
        if (shares.length > 10) lines.push(`  ...and ${shares.length - 10} more`)
      }
      await showInfo(host.ui, { title: "Your account", message: lines.join("\n") })
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
      const sure = await showConfirm(host.ui, {
        title: "Disconnect",
        message: `Revoke the token at ${url} and forget it?\nRevoking your last token freezes control of ALL your shares there (even with the share secrets) - pages stay readable until their TTL; only the server admin can restore control.`,
        confirmLabel: "Disconnect",
        danger: true,
      })
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
      const sure = await showConfirm(host.ui, { title: "Remove server", message: `Remove the saved membership for\n${url}?`, confirmLabel: "Remove", danger: true })
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

  // 3) the console loop — busy dialog around the fetch batch (config-studio
  // port: zero feedback while four network calls run reads as a freeze)
  while (true) {
    const users: AdminUser[] = []
    const tokens: Array<{ id: string; userId: string; label: string; createdAt: number; lastUsedAt: number; revoked: boolean }> = []
    const codes: Array<{ id: string; label: string; activationsLeft: number; used: number; disabled: boolean }> = []
    const shares: AdminShare[] = []
    await withBusy(host, `Loading ${hostOf(url)}…`, async () => {
      const [usersR, tokensR, codesR, sharesR] = await Promise.all([client.users(), client.tokens(), client.codes(), client.shares()])
      users.push(...(usersR.data?.users ?? []))
      tokens.push(...(tokensR.data?.tokens ?? []))
      codes.push(...(codesR.data?.codes ?? []))
      shares.push(...(sharesR.data?.shares ?? []))
    })

    const choice = await showSelect(host.ui, {
      title: `Admin — ${url}`,
      options: [
        { title: "Server info", value: "info", description: "health, policy, auth mode, your standing", help: `Full server state: service version, socket policy (formatted, not a JSON blob), what joining requires, and what THIS plugin instance holds (user token / root / none) — with follow-up actions.` },
        { title: `Users (${users.length})`, value: "users", description: `${users.filter((u) => u.frozen).length} frozen` },
        { title: `Tokens (${tokens.length})`, value: "tokens", description: `${tokens.filter((t) => !t.revoked).length} active` },
        { title: `Access codes (${codes.length})`, value: "codes", description: "invite codes with activation budgets" },
        { title: `Shares (${shares.length})`, value: "shares", description: "every share on this server" },
        { title: "Mint my user token", value: "adopt", description: "admin-mint YOUR user token and save it", help: `Creates your own user on ${url} and saves its token as this server's user credential — so rotate/disconnect and share ownership work for you. The root token stays untouched in adminToken.` },
        { title: "Purge ALL shares", value: "purge", description: "delete every share — maintenance", danger: true },
        { title: "Back", value: "__back" },
      ],
    })
    if (choice === undefined || choice === "__back") return

    if (choice === "info") {
      await serverInfoScreen(host, url, client)
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
    if (choice === "adopt") {
      await adoptUserToken(host, url, adminToken)
      continue
    }
    if (choice === "purge") {
      const sure = await showConfirm(host.ui, {
        title: "Purge every share",
        message: `Delete ALL ${shares.length} shares on\n${url}?\nViewers get a final "gone" frame. Users, tokens and codes are untouched.`,
        confirmLabel: "Purge",
        danger: true,
      })
      if (!sure) continue
      const res = await client.purge()
      host.ui.toast({ variant: res.ok ? "success" : "error", title: "OpenShare", message: res.ok ? `Removed ${res.data?.removed ?? "?"} shares.` : `Purge failed: ${res.error}` })
      continue
    }
  }
}

/** Busy dialog (config-studio showBusy port): non-cancelable, and the
 * teardown ordering matters — the busy dialog must finish clearing BEFORE
 * the next menu opens, or its clear() wipes the replacing menu. Facade
 * method (v1 renders it; the mock is a no-op). */
async function withBusy(host: ShareHostApi, title: string, work: Promise<void> | (() => Promise<void>)): Promise<void> {
  const doneBusy = host.ui.showBusy?.(title)
  try {
    await (typeof work === "function" ? work() : work)
  } catch {}
  doneBusy?.()
}

/** Server info, the readable version (live-caught: the raw JSON policy line
 * escaped the dialog border): formatted policy lines, auth explained in
 * words, YOUR standing on this server, and follow-up actions. */
async function serverInfoScreen(host: ShareHostApi, url: string, client: ReturnType<typeof adminClient>): Promise<void> {
  const h = await client.health()
  if (!h.ok) {
    await showInfo(host.ui, { title: "Unreachable", message: `${url}: ${h.error ?? "unreachable"}` })
    return
  }
  const policy = (h.data?.policy ?? {}) as Record<string, unknown>
  const policyLines = Object.entries(policy).map(([key, value]) => {
    if (typeof value === "number" && /ms$/i.test(key)) return `${key}: ${value >= 60000 ? `${Math.round(value / 60000)}m` : `${Math.round(value / 1000)}s`} (${value}ms)`
    return `${key}: ${String(value)}`
  })
  const mode = h.data?.auth?.mode
  const entry = serverEntries().find((s) => s.url === url)?.entry
  const standing = entry?.token
    ? entry.token === (entry.adminToken ?? adminTokenFor(url))
      ? `root token only — admin, NO user identity (see "Get a user token")`
      : `user token ${mask(entry.token)}${entry.adminToken ? " + root adminToken" : ""}`
    : entry?.code
      ? "access code saved — enrolls on demand"
      : "no credential held — public enrollment on demand"
  const message = [
    `${url}`,
    `service: ${h.data?.service ?? "?"}`,
    "",
    "Auth:",
    mode === "private" ? "private — joining needs an access code (osc_…) issued by the hoster" : mode === "public" ? "public — anyone with the URL may enroll and share" : `unknown (${String(mode)})`,
    "You hold: " + standing,
    "",
    "Policy (server-owned; clients get clamped into it):",
    ...policyLines,
  ].join("\n")
  await showInfo(host.ui, { title: "Server info", message })
  const followUp = await showSelect(host.ui, {
    title: "Server info — actions",
    options: [
      { title: "Create access code", value: "code", description: "invite: N activations, each issues a user token", help: `Mints an osc_ access code on ${url}. Each activation creates a new user + token; the budget limits how many. Shown once — copy it right away.` },
      { title: "Back", value: "__back" },
    ],
  })
  if (followUp === "code") {
    const raw = await showPrompt(host.ui, { title: "Activations budget", placeholder: "how many users this code may create", value: "1" })
    if (raw === undefined) return
    const activations = Math.max(1, Math.floor(Number(raw) || 1))
    const res = await client.createCode(`info-${new Date().toISOString().slice(0, 10)}`, activations)
    if (res.ok && res.data?.code) {
      await host.clipboard.write(res.data.code).catch(() => false)
      await showInfo(host.ui, { title: "Access code created", message: `${res.data.code}\n\n${activations} activation(s). Copied to the clipboard — shown once.` })
    } else {
      await showInfo(host.ui, { title: "Creation failed", message: res.error ?? "unknown error" })
    }
  }
}

/** Admin-mint your own user identity on a server (the "admin can't be a
 * user" fix; shared by the admin console and the server submenu). */
async function adoptUserToken(host: ShareHostApi, url: string, rootToken: string): Promise<void> {
  const prefill = `admin-${hostOf(url).replace(/[^a-z0-9-]/gi, "") || "user"}`
  const label = (await showPrompt(host.ui, { title: "Your user label on this server", placeholder: "shown in the admin user list", value: prefill }))?.trim()
  if (!label) return
  const client = adminClient(url, rootToken)
  const made = await client.createUser(label)
  if (!made.ok || !made.data?.userId) {
    await showInfo(host.ui, { title: "User creation failed", message: `${url}: ${made.error ?? "unknown error"}` })
    return
  }
  const minted = await client.mintToken(made.data.userId, label)
  if (!minted.ok || !minted.data?.token) {
    await showInfo(host.ui, { title: "Token mint failed", message: `${url}: ${minted.error ?? "unknown error"} (user was created — retry mint from the admin panel)` })
    return
  }
  saveServerEntry(url, { token: minted.data.token, label, adminToken: rootToken })
  host.ui.toast({ variant: "success", title: "OpenShare", message: `User token for "${label}" saved — root stays for the admin panel.` })
}

async function adminUsersMenu(host: ShareHostApi, client: ReturnType<typeof adminClient>, url: string, users: AdminUser[]): Promise<void> {
  const options: ShareDialogSelectOption<string>[] = users.map((u) => ({
    title: u.label,
    value: u.id,
    description: `${u.shares} shares · ${u.tokensActive}/${u.tokens} tokens${u.frozen ? " · FROZEN" : ""}`,
  }))
  options.push({ title: "Create user", value: "__create", description: "empty user record; mint a token next" })
  options.push({ title: "Back", value: "__back" })
  if (users.length === 0) options.splice(0, 0, { title: "No users yet", value: "__empty", description: "create one below, or share an access code", disabled: true })
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
        { title: "Delete user", value: "delete", description: "default freezes; delete mode also removes shares + tokens", danger: true },
        { title: "Back", value: "__back" },
      ],
    })
    if (action === undefined || action === "__back") continue
    if (action === "freeze") {
      const res = user.frozen ? await client.unfreeze(user.id) : await client.freeze(user.id)
      host.ui.toast({ variant: res.ok ? "success" : "error", title: "OpenShare", message: res.ok ? (user.frozen ? "Unfrozen." : `Frozen (${res.data?.shares ?? "?"} shares locked).`) : `Failed: ${res.error}` })
      continue
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
          { title: "Delete everything", value: "delete", description: "remove their shares + tokens + user", danger: true },
          { title: "Cancel", value: "__cancel" },
        ],
      })
      if (mode === undefined || mode === "__cancel") continue
      const res = await client.deleteUser(user.id, mode === "delete" ? "delete" : "freeze")
      host.ui.toast({ variant: res.ok ? "success" : "error", title: "OpenShare", message: res.ok ? (mode === "delete" ? `Deleted (${res.data?.shares ?? "?"} shares removed).` : "Frozen.") : `Failed: ${res.error}` })
      continue
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
    if (options.length === 0) options.push({ title: "No active tokens", value: "__empty", description: "mint one from a user in Users", disabled: true })
    options.push({ title: "Back", value: "__back" })
    const picked = await showSelect(host.ui, { title: `Active tokens (${options.length - 1}) — revoke`, options })
    if (picked === undefined || picked === "__back") return
    const sure = await showConfirm(host.ui, { title: "Revoke token", message: `Revoke ${picked}?\nThe holder can no longer write (existing shares keep their secrets unless the user is frozen).`, confirmLabel: "Revoke", danger: true })
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
    if (fresh.length === 0) options.push({ title: "No access codes yet", value: "__empty", description: "create one below to invite users", disabled: true })
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
    if (fresh.length === 0) options.push({ title: "No shares on this server", value: "__empty", description: "nothing is being shared right now", disabled: true })
    options.push({ title: "Back", value: "__back" })
    const picked = await showSelect(host.ui, { title: `Shares — ${url}`, options })
    if (picked === undefined || picked === "__back" || picked === "__empty") return
    const share = fresh.find((s) => s.id === picked)
    if (!share) continue
    const action = await showSelect(host.ui, {
      title: `Share ${picked.slice(0, 12)}…`,
      options: [
        { title: "Reassign owner", value: "reassign", description: `currently ${labelOf(share.ownerId)} — the rescue path` },
        { title: "Delete share", value: "delete", description: "viewers get a final gone frame", danger: true },
        { title: "Back", value: "__back" },
      ],
    })
    if (action === undefined || action === "__back") continue
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
      const sure = await showConfirm(host.ui, { title: "Delete share", message: `Delete ${picked} permanently?`, confirmLabel: "Delete", danger: true })
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
export async function settingsDialog(host: ShareHostApi, startAtSession?: string, startGroup?: "session"): Promise<void> {
  let cfg = currentConfig()
  let dirty = false
  // Write target (owner rule): global settings home by default; any other
  // existing file in the read chain may be chosen explicitly. The TUI
  // never creates deploy-time override files.
  const candidates = writeCandidates(moduleDir())
  let writeTarget: WriteCandidate = candidates[0]
  const sources = configSourceMap(moduleDir())

  type GroupId = "session" | "servers" | "sharing" | "readauth" | "interface" | "advanced" | "configfiles"
  const GROUP_LABEL: Record<GroupId, string> = {
    session: "This session",
    servers: "Servers",
    sharing: "Sharing",
    readauth: "Read auth",
    interface: "Interface",
    advanced: "Advanced",
    configfiles: "Config files",
  }
  // which keys have edits pending in this dialog (green "edited" markers)
  const dirtyKeys = new Set<string>()

  // ---- row builders (one per group) ---------------------------------------

  const keyRows = (section: string): ShareDialogSelectOption<string>[] =>
    Object.entries(LABELS)
      .filter(([, meta]) => meta.section === section)
      .map(([key, meta]) => ({ title: meta.label, value: `key:${key}`, description: withSource(displayValue(key, cfg), sources[key]), help: helpForKey(key, cfg, sources), edited: dirtyKeys.has(key) }))

  const serverRows = (): ShareDialogSelectOption<string>[] => {
    const servers = serverEntries(cfg)
    const rows: ShareDialogSelectOption<string>[] = keyRows("Connection")
    rows.push({ title: "— saved servers —", value: "__divider_servers", divider: true } as ShareDialogSelectOption<string>)
    for (const s of servers) {
      const cred = s.entry.token ? "token saved" : s.entry.code ? "code saved" : "enrolls on demand"
      rows.push({
        title: s.url,
        value: `server:${s.url}`,
        description: `${s.entry.label ? s.entry.label + " · " : ""}${cred}${s.active ? " · ACTIVE" : ""}`,
        help: [
          `## Server`,
          `Server: ${s.url}`,
          `Label: ${s.entry.label ?? "(none)"}`,
          `Credential: ${s.entry.token ? `user token ${mask(s.entry.token)}` : s.entry.code ? "access code saved — enrolls on demand" : "none — public server, enrolls on demand"}`,
          `Receives new sessions: ${s.active ? "YES (active)" : "no"}`,
          "",
          "## Notes",
          "Every ACTIVE server receives new sessions (fan-out); one active server is the normal setup. Tokens persist in the settings home; enroll once, then it just works. The per-server submenu (enter) adds the admin panel for this server.",
        ].join("\n"),
      })
    }
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
        title: "Menu size…",
        value: "ui:size",
        description: `${uiWidth} (${DIALOG_WIDTH_COLUMNS[uiWidth]} cols) · ${uiHeight}% height`,
        help: `## Width\nmedium = 60, large = 88, xlarge = 116 columns — opencode exposes fixed widths only. In the picker, w cycles the width and the dialog resizes live.\n\n## Height\nA percent of terminal rows (25-100), capped at 75% of the terminal minus chrome (the host's backdrop offset). Presets: compact 35, normal 50, tall 70, max 100. The picker's live preview shows the true capped height.\n\nCurrent: ${uiWidth} (${DIALOG_WIDTH_COLUMNS[uiWidth]} columns) at ${uiHeight}%\nStored per host (opencode's own preference store), not in the config file.`,
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
    const root = await resolveRoot(host.client, startAtSession)
    const bindings = await readBindings(host.client, root)
    const live = bindings.filter((b) => b.url && b.enabled !== false)
    const rows: ShareDialogSelectOption<string>[] = []
    if (live.length === 0) {
      rows.push({
        title: "Share this session",
        value: "session:share",
        description: "set the share flag; the server plugin creates the page",
        help: "Publishes this session (and its subagent sessions) to the active server. The full history lands in the page — sharing mid-session is first-class, nothing is missed. You will be asked to confirm before anything is published.",
      })
    } else if (live.length === 1) {
      const b = live[0]
      rows.push({
        title: "Copy share link",
        value: "session:copy",
        description: "copy the share URL to the clipboard",
        help: `Copies the share URL to the clipboard.\n\nURL: ${b.url}\nShare id: ${b.id ?? "?"}`,
      })
    } else {
      for (const b of live) {
        rows.push({
          title: `Copy link — ${hostOf(b.url || b.server)}`,
          value: `session:copy:${b.server}`,
          description: b.url,
          help: `Copies this server's share URL to the clipboard.\n\nURL: ${b.url}\nShare id: ${b.id}\n\nEach server carries an independent page of the same session.`,
        })
      }
      rows.push({
        title: "Copy all links",
        value: "session:copyall",
        description: `${live.length} servers`,
        help: `Copies every bound server's share URL.\n\n${live.map((b) => `• ${b.url}`).join("\n")}`,
      })
    }
    if (live.length) {
      rows.push({
        title: "Stop sharing",
        value: "session:unshare",
        description: live.length > 1 ? `delete every page (${live.length} servers), or leave snapshots` : "delete the page, or leave a snapshot",
        danger: true,
        help: `Choose per run: DELETE every page server-side (links stop working — final "gone" state), or LEAVE AS-IS (stop updating; pages stay readable until their TTL — a frozen snapshot).\n\nURLs:\n${live.map((b) => b.url).join("\n")}\n\nSharing again later always creates fresh page(s) with new URLs.`,
      })
      if (live.length > 1) {
        rows.push({
          title: "Stop on one server…",
          value: "session:unshare:one",
          description: "delete or snapshot a single server's page",
          help: `Per-server stop: pick the server, then delete its page or leave it as a read-only snapshot. Other servers are unaffected.\n\nBound servers:\n${live.map((b) => `• ${b.server} — ${b.url}`).join("\n")}`,
        })
        const otherServers = serverEntries().filter((s) => !live.some((b) => b.server === s.url))
        if (otherServers.length) {
          rows.push({
            title: "Share to another server…",
            value: "session:more",
            description: otherServers.map((s) => hostOf(s.url)).join(", "),
            help: `Adds one of your other configured servers as a destination for THIS session: it becomes the active server and the full history is mirrored there within seconds.\n\nAvailable:\n${otherServers.map((s) => `• ${s.url}`).join("\n")}`,
          })
        }
      }
    }
    const binding = bindings[0]
    if (binding?.lastError || binding?.ttlClamped) {
      const bits: string[] = []
      if (binding?.ttlClamped) bits.push(`TTL clamped ${binding.ttlClamped.requested}d -> ${binding.ttlClamped.effective}d by server/token policy`)
      if (binding?.lastError) bits.push(`last share error: ${binding.lastError}`)
      rows.push({ title: "Share status notes", value: "__notes", description: bits[0].slice(0, 60), disabled: true, help: `Engine-recorded notes for this session's share(s):\n\n${bits.join("\n")}\n\nThe clamp note appears when the server or your token's policy reduced a requested TTL. The error note is the engine's last create/attach refusal (quota, freeze, rate limit) - it clears on the next successful sync.` })
    }
    rows.push({
      title: "Session TTL override (days)",
      value: "session:ttl",
      description: binding?.opts?.ttlDays !== undefined ? String(binding.opts.ttlDays) : "(worker default)",
      help: `Per-session share lifetime. Overrides the config ttlDays for THIS session's pages; still capped by the server's MAX_TTL_DAYS and the token's maxTtlDays. On a live share it applies immediately (shortening may end an older page at once); otherwise it is used when you share.\n\nCurrent: ${binding?.opts?.ttlDays !== undefined ? `${binding.opts.ttlDays} days` : "(none — config default)"}`,
    })
    rows.push({
      title: "Session read auth",
      value: "session:auth",
      description: binding?.opts?.authLogin ? `${binding.opts.authLogin} / ****` : "(config default)",
      help: `Login gate for THIS session's page only — viewers must log in (7-day cookie, lockout). Overrides the config read auth; a login and password are both required (or neither). On a live share it applies immediately; otherwise when you share. Removing the login removes the gate.\n\nCurrent: ${binding?.opts?.authLogin ? `${binding.opts.authLogin} / (password set)` : "(none — config default applies)"}`,
    })
    return rows
  }

  const rowsFor = async (id: GroupId): Promise<ShareDialogSelectOption<string>[]> => {
    switch (id) {
      case "session":
        return await sessionRows()
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

    if (choice === "ui:size") {
      if (host.ui.showSizePicker) {
        const result = await host.ui.showSizePicker({ width: kvWidthOf(host.kv), heightPercent: kvHeightPercentOf(host.kv) })
        if (result) {
          // the picker persisted through the raw api on v1; mirror it on
          // hosts where showSizePicker is an adapter (idempotent there)
          host.kv.set(UI_WIDTH_KV, result.width)
          host.kv.set(UI_HEIGHT_PERCENT_KV, clampHeightPercent(result.heightPercent))
          host.ui.toast({ variant: "info", title: "OpenShare", message: `Menu size: ${result.width} · ${result.heightPercent}% of terminal.` })
        }
      } else {
        // non-v1 hosts: prompt fallback (width cycle + height number)
        const rawHeight = await showPrompt(host.ui, { title: "Menu height percent", placeholder: "25-100", value: String(kvHeightPercentOf(host.kv)) })
        if (rawHeight !== undefined) {
          const parsed = Number(rawHeight)
          if (!Number.isFinite(parsed)) {
            host.ui.toast({ variant: "error", title: "OpenShare", message: "Height must be a number from 25 to 100." })
            return
          }
          host.kv.set(UI_HEIGHT_PERCENT_KV, clampHeightPercent(parsed))
          host.kv.set(UI_WIDTH_KV, nextDialogWidth(kvWidthOf(host.kv)))
          host.ui.toast({ variant: "info", title: "OpenShare", message: `Menu size: ${kvWidthOf(host.kv)} · ${kvHeightPercentOf(host.kv)}%` })
        }
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
      const key = choice.slice(4)
      const next = await editKey(host, cfg, key)
      if (next) {
        cfg = next
        dirty = true
        dirtyKeys.add(key)
      }
      return
    }

    if (choice.startsWith("session:") && startAtSession) {
      const root = await resolveRoot(host.client, startAtSession)
      const all = await readBindings(host.client, root)
      const live = all.filter((b) => b.url && b.enabled !== false)
      const current = all[0]
      if (choice === "session:share") {
        if (!isConfigured(cfg)) {
          await showInfo(host.ui, { title: "Not configured", message: "Connect a server (Servers group) first, then share." })
          return
        }
        const result = await shareWithConsent(host, startAtSession)
        host.ui.toast({ variant: result.ok ? "success" : "error", title: "OpenShare", message: result.message, duration: result.ok ? 8000 : 15000 })
        return
      }
      if (choice === "session:copy" && live[0]) {
        const okw = await host.clipboard.write(live[0].url!)
        host.ui.toast({ variant: okw ? "success" : "error", title: "OpenShare", message: okw ? `Share URL copied: ${live[0].url}` : `Clipboard failed — ${live[0].url}` })
        return
      }
      if (choice.startsWith("session:copy:") ) {
        const b = live.find((x) => `session:copy:${x.server}` === choice)
        if (b) {
          const okw = await host.clipboard.write(b.url!)
          host.ui.toast({ variant: okw ? "success" : "error", title: "OpenShare", message: okw ? `Share URL copied: ${b.url}` : `Clipboard failed — ${b.url}` })
        }
        return
      }
      if (choice === "session:copyall") {
        const joined = live.map((b) => b.url).filter(Boolean).join("\n")
        const okw = await host.clipboard.write(joined)
        host.ui.toast({ variant: okw ? "success" : "error", title: "OpenShare", message: okw ? `${live.length} share URL(s) copied` : "Clipboard failed" })
        return
      }
      if (choice === "session:unshare:one") {
        const pick = await showSelect(host.ui, {
          title: "Stop on which server",
          options: [...live.map((b) => ({ title: hostOf(b.url || b.server), value: b.server, description: b.url })), { title: "Cancel", value: "__cancel" }],
        })
        if (!pick || pick === "__cancel") return
        const target = live.find((b) => b.server === pick)
        if (!target) return
        const how = await showSelect(host.ui, {
          title: `Stop sharing — ${hostOf(target.url || target.server)}`,
          options: [
            { title: "Delete the page", value: "delete", description: "this link stops working for everyone", danger: true },
            { title: "Leave as-is (snapshot)", value: "leave", description: "stop updating; the page stays until its TTL" },
            { title: "Cancel", value: "__cancel" },
          ],
        })
        if (!how || how === "__cancel") return
        if (how === "leave") {
          await patchSessionBinding(host.client, root, (servers) => {
            delete servers[target.server]
            servers[target.server] = { optedOut: true }
          })
          host.ui.toast({ variant: "success", title: "OpenShare", message: `${hostOf(target.url || target.server)} left as-is — a snapshot until its TTL.` })
          return
        }
        const targetEntry = all.find((b) => b.server === target.server)
        if (!targetEntry?.secret) {
          host.ui.toast({ variant: "error", title: "OpenShare", message: "No secret for this page — cannot delete it server-side; binding cleared." })
          await patchSessionBinding(host.client, root, (servers) => {
            delete servers[target.server]
          })
          return
        }
        const gone = await workerDeleteShare(target.server, target.id!, targetEntry.secret)
        await patchSessionBinding(host.client, root, (servers) => {
          delete servers[target.server]
        })
        host.ui.toast({ variant: gone ? "success" : "warning", title: "OpenShare", message: gone ? `Page deleted on ${hostOf(target.url || target.server)}.` : `Could not delete the page (it may already be gone) — binding cleared.` })
        return
      }
      if (choice === "session:more") {
        const otherServers = serverEntries().filter((s) => !live.some((b) => b.server === s.url))
        if (!otherServers.length) return
        const pick = await showSelect(host.ui, {
          title: "Share to another server",
          options: [...otherServers.map((s) => ({ title: hostOf(s.url), value: s.url, description: s.entry.label })), { title: "Cancel", value: "__cancel" }],
        })
        if (!pick || pick === "__cancel") return
        // fan-out add: activate the picked server WITHOUT deactivating the
        // current ones - this session (and new sessions) mirror everywhere
        saveServerEntry(pick, { active: true })
        const nActive = serverEntries().filter((s) => s.active).length
        host.ui.toast({ variant: "success", title: "OpenShare", message: `${hostOf(pick)} activated (${nActive} active) - this session mirrors there within seconds.` })
        return
      }
      if (choice === "session:unshare") {
        const how = await showSelect(host.ui, {
          title: "Stop sharing",
          options: [
            { title: "Delete every page", value: "delete", description: "all links stop working", danger: true, help: "Deletes every bound server's page and clears the share flag. Viewers see a final gone state." },
            { title: "Leave as-is (snapshot)", value: "leave", description: "stop updating; pages stay until their TTL", help: "Stops mirroring without deleting anything — pages stay readable as frozen snapshots until their TTL expires." },
            { title: "Cancel", value: "__cancel" },
          ],
        })
        if (how === undefined || how === "__cancel") return
        if (how === "leave") {
          const allB = await readBindings(host.client, root)
          const okPatch = await patchSessionBinding(host.client, root, (servers) => {
            for (const b of allB) {
              if (!b.server) continue
              // keep id/secret on the opt-out marker: the snapshot stays
              // deletable later and re-sharing reuses the binding instead
              // of stalling on a secret-less marker (live-caught as "can
              // never unshare or re-share after leave-as-is")
              servers[b.server] = { ...(servers[b.server] as Record<string, unknown> | undefined), id: b.id, secret: b.secret, rev: b.rev, url: b.url, optedOut: true }
            }
          })
          host.ui.toast({ variant: okPatch ? "success" : "error", title: "OpenShare", message: okPatch ? "Left as-is — snapshots until their TTLs (delete stays available here)." : "Could not update the binding." })
          return
        }
        const sureAll = await showConfirm(host.ui, {
          title: "Delete every page?",
          message: `Permanently delete ${live.length} share page(s) and stop sharing?\nEvery link stops working for everyone. This cannot be undone.`,
          confirmLabel: "Delete every page",
          danger: true,
        })
        if (!sureAll) return
        const result = await runUnshareFlow(host, startAtSession)
        host.ui.toast({ variant: result.ok ? "success" : "error", title: "OpenShare", message: result.message })
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
        await setShareOpts(host.client, root, opts)
        const liveNow = live.length > 0
        host.ui.toast({
          variant: "success",
          title: "OpenShare",
          message: liveNow
            ? `Session TTL: ${opts.ttlDays !== undefined ? `${opts.ttlDays}d - applied now (shortening may end an older page immediately)` : "(default) - applied now"}.`
            : `Session TTL: ${opts.ttlDays !== undefined ? `${opts.ttlDays}d` : "(default)"} - saved, applies when you share.`,
        })
        return
      }
      if (choice === "session:auth") {
        const login = await showPrompt(host.ui, { title: "Session read auth: login", placeholder: "empty = no read auth", value: current?.opts?.authLogin ?? "" })
        if (login === undefined) return
        const password = await showPrompt(host.ui, { title: "Session read auth: password", placeholder: login === "" ? "(unused)" : "password (required with a login)" })
        if (password === undefined) return
        // both-or-none: the server builds a gate only from a full pair, and
        // rendering half a pair would show protection that does not exist
        if ((login === "") !== (password === "")) {
          host.ui.toast({ variant: "error", title: "OpenShare", message: "Read auth needs both a login and a password - or neither (no gate)." })
          return
        }
        const opts: SessionOpts = { ...(current?.opts ?? {}) }
        if (login === "") {
          delete opts.authLogin
          delete opts.authPassword
        } else {
          opts.authLogin = login
          opts.authPassword = password
        }
        await setShareOpts(host.client, root, opts)
        const liveNow2 = live.length > 0
        host.ui.toast({ variant: "success", title: "OpenShare", message: liveNow2 ? `Read auth ${login === "" ? "removed" : "saved"} - applied now.` : `Read auth ${login === "" ? "cleared" : "saved"} - applies when you share.` })
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

  // /share on a shared session lands HERE, straight in the session menu -
  // one selection sooner (Back still reaches the full root)
  if (startAtSession && startGroup === "session") await groupMenu("session")

  const seconds = (ms: number | undefined, fallback: number) => `${Math.round((ms ?? fallback) / 100) / 10}s`
  while (true) {
    const servers = serverEntries(cfg)
    const active = servers.find((s) => s.active)
    const uiWidth = kvWidthOf(host.kv)

    const groups: Array<{ id: GroupId; summary: string; help: string }> = []
    if (startAtSession) {
      const binding = await readBinding(host.client, await resolveRoot(host.client, startAtSession))
      const shared = binding?.url ? (binding.enabled === false ? "attached (dormant)" : "live") : "not shared"
      groups.push({
        id: "session",
        summary: shared,
        help: `Per-session state and overrides for the session this dialog was opened on.\n\nStatus: ${shared}${binding?.url ? `\nURL: ${binding.url}` : ""}\n\nInside: share/stop sharing (delete or leave a snapshot), session TTL override, session read auth.`,
      })
    }
    groups.push({
      id: "servers",
      summary: servers.length
        ? `${servers.length} saved${active ? ` · active: ${hostOf(active.url)}` : " · none active"}${cfg.workerUrl ? " · legacy pair set" : ""}`
        : cfg.workerUrl
          ? `${hostOf(cfg.workerUrl)} · legacy pair`
          : "no server yet",
      help: `Server connection, memberships, and admin — one place (owner: "we already do connection in servers, why was it separate").\n\nInside: the legacy workerUrl + createToken pair, saved servers (enroll, rotate, disconnect, admin panel, test, remove), Connect to a server, Test connection.\n\nEvery ACTIVE server receives new sessions (fan-out).`,
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
