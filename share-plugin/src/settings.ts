// OpenShare settings dialog (/openshare): select -> edit flows over the
// host facade's dialog stack. No custom JSX — every screen is a
// DialogSelect/DialogPrompt/DialogConfirm composition, so the same flows
// run on the v1 TUI and the v2 dialog bridge.
//
// Sections: Connection, Sharing, Read auth, Advanced, This session.

import {
  configSourceMap,
  deleteShareOverrides,
  liveShares,
  moduleDir,
  pluginVersion,
  saveServerOverrides,
  saveShareOverrides,
  writeCandidates,
  type ShareConfig,
  type ShareOverrides,
  type WriteCandidate,
} from "./config.js"
import { resolveFor, type SettingProvenance } from "./share-settings.js"
import {
  adminClient,
  adminTokenFor,
  clearShareFlag,
  confirmShare,
  currentConfig,
  deleteServerEntry,
  disconnectAtServer,
  enrollAtServer,
  fmtHours,
  parseTtlHours,
  hostOf,
  isConfigured,
  normServerUrl,
  probeAuthMode,
  probeWorker,
  patchSessionBinding,
  patchShareOpts,
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

// --- share-settings tiers ----------------------------------------------------

const SRC_LABEL: Record<SettingProvenance, string> = { general: "general", server: "server default", share: "this share" }

/** Row-description suffix naming the tier a value came from. */
const srcSuffix = (p: SettingProvenance | undefined) => (p ? ` · ${SRC_LABEL[p]}` : "")

/** Server TTL cap from /health, cached per server (0 = unknown/uncapped).
 * Surfaces the "90d general, 30d server cap" case BEFORE sharing. */
const ttlCapCache = new Map<string, number>()
async function serverTtlCap(url: string): Promise<number> {
  const hit = ttlCapCache.get(url)
  if (hit !== undefined) return hit
  let cap = 0
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(5000) })
    const body = (await res.json().catch(() => ({}))) as { maxTtlHours?: number }
    if (Number(body.maxTtlHours) > 0) cap = Math.floor(Number(body.maxTtlHours))
  } catch {}
  ttlCapCache.set(url, cap)
  return cap
}

/** Write one per-share override end to end: config shares{} (authoritative),
 * session binding opts (the runtime mirror the engine resolves against),
 * then an immediate REST PATCH on every live page (attaches heal the rest).
 * A key set to undefined CLEARS the override at this tier — and the clear
 * must TRAVEL: the server keeps its copy until told (auth ""+"" removes
 * the gate, title "" restores the live title), so a clear-only patch still
 * PATCHes. Returns how many live pages took the PATCH. */
async function applyShareOverride(
  host: ShareHostApi,
  sid: string,
  patch: Partial<ShareOverrides>,
): Promise<number> {
  const root = await resolveRoot(host.client, sid)
  const binding = await readBinding(host.client, root)
  const opts: SessionOpts = { ...(binding?.opts ?? {}) }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (opts as Record<string, unknown>)[k]
    else (opts as Record<string, unknown>)[k] = v
  }
  saveShareOverrides(sid, patch)
  await setShareOpts(host.client, root, opts)
  const all = await readBindings(host.client, root)
  const live = all.filter((b) => b.url && b.enabled !== false && b.id && b.secret)
  if (!live.length) return 0
  const flat: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) flat[k] = v
    else if (k === "authLogin" || k === "authPassword") {
      flat.authLogin = ""
      flat.authPassword = ""
    } else if (k === "title") flat.title = ""
    // ttlHours has no server-side unset: the TTL handler re-sends the next
    // tier's value; paused clears PATCH false at the pause handler
  }
  if (!Object.keys(flat).length) return 0
  const results = await Promise.all(live.map((b) => patchShareOpts(b.server, b.id!, flat as Parameters<typeof patchShareOpts>[2], b.secret!)))
  return results.filter((r) => r.ok).length
}

/** Drop shares{} overrides whose sessions no longer exist (the plugin was
 * not running when they were deleted). Best-effort and guarded: nothing is
 * pruned unless the host returned a believable non-empty session list. */
async function pruneStaleShareOverrides(host: ShareHostApi): Promise<void> {
  try {
    const entries = Object.keys(liveShares())
    if (!entries.length || !host.client?.session?.list) return
    const raw = await host.client.session.list({})
    const list = Array.isArray(raw) ? raw : ((raw as { data?: unknown })?.data as unknown[] | undefined)
    if (!Array.isArray(list) || list.length === 0) return
    const alive = new Set<string>()
    for (const s of list) {
      const id = (s as { id?: string }).id
      if (typeof id === "string" && id) alive.add(id)
    }
    if (!alive.size) return
    for (const sid of entries) if (!alive.has(sid)) deleteShareOverrides(sid)
  } catch {}
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
  ttlHours: {
    label: "TTL (hours)",
    help: "Share lifetime in hours (2d writes 48); capped server-side.",
    kind: "number",
    section: "Sharing",
    info: "How long pages live before the server's sweeper deletes them, in HOURS. The DEFAULTS tier: per-server defaults (Servers -> a server -> Share defaults) and per-share overrides (This session) both beat this value. Capped server-side: the deployment's MAX_TTL_HOURS and the token's limit both apply; the floor is one hour.",
    def: "worker cap (2160h = 90d on the reference deployment)",
  },
  authLogin: {
    label: "Read auth: login",
    help: "Default read gate for share pages. Empty removes protection on the next attach.",
    kind: "text",
    section: "Read auth",
    info: "Optional username for a login gate on NEW shares — the DEFAULTS tier. Viewers must enter login+password (PBKDF2-hashed server-side, 7-day cookie, lockout after failures). Per-server defaults and per-share overrides (This session) beat this value.\n\nWrite access is a separate lock — a login never lets anyone edit.",
    def: "(empty — no gate)",
  },
  authPassword: {
    label: "Read auth: password",
    help: "Default read gate for share pages.",
    kind: "password",
    section: "Read auth",
    info: "The password half of the default read gate. Stored in plain text in the config file — prefer per-share auth for anything sensitive. Only the hash ever reaches the server.",
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
    help: '"all" | "status" | "url" | "off": which [openshare] info lines reach stderr.',
    kind: "text",
    options: ["all", "status", "url", "off"],
    section: "Advanced",
    info: "The stderr ladder for informational [openshare] lines (all-mode/CI). all: announce lines (live:/url file:) plus status lines (mode banner, enrollment, adoption notes). status: status lines only - the share URL never touches stderr (public CI logs). url: announce lines only (private runners scraping the share URL). off: no info lines. Error-class lines (worker down, refused, timeouts) ALWAYS reach stderr regardless. In manual mode stderr is errors-only by design.",
    def: "all",
  },
  urlFileFormat: {
    label: "URL file format",
    help: '"url" (one bare URL per line) or "json" (id, url, status, gated per line) — CI consumers that want machine-readable lines.',
    kind: "text",
    options: ["url", "json"],
    section: "Advanced",
    info: 'What each line of the all-mode URL file looks like. "url": the bare share URL. "json": {"id","url","status","gated"} — pipeline steps can branch on status without parsing URLs.',
    def: "url",
  },
  configSet: {
    label: "Config set",
    help: "Which named config set the server token provisions (empty = the token's first/default set).",
    kind: "text",
    section: "Connection",
    info: "B4 named config sets: a server-side token can carry named bundles of share defaults (auth, TTL). This picks which set THIS agent uses; empty uses the token's default set. Managed on the server (token settings), not here.",
    def: "(empty — token default)",
  },
  redactPatterns: {
    label: "Redaction patterns",
    help: "Extra regex rules redacted from UNGATED shares (comma-separated), beside the built-in detectors.",
    kind: "text",
    section: "Sharing",
    info: 'Client-side redaction (Wave 3): user-supplied regex patterns applied to share content next to the built-in secret detectors. Only UNGATED shares are redacted — a login-gated share keeps full fidelity for its viewers. Comma-separated here; the config file form is an array: "redact": {"patterns": ["sk-[A-Za-z0-9]+", …]} (max 50, 500 chars each).',
    def: "(none — built-in detectors only)",
  },
  metaLabels: {
    label: "Meta labels",
    help: 'Free-form labels stamped on every share ("k=v, k2=v2"); ${VAR} interpolates env at send time.',
    kind: "text",
    section: "Sharing",
    info: 'Free-form string metadata for team directories and admin listings (B5): "team=core, run=${CI_JOB_ID}" — values may reference env vars (${NAME}), unresolved refs stay literal so misconfiguration is visible. 20 keys max, 64-char names, 500-char values. Config file form: "meta": {"team": "core"}.',
    def: "(none)",
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
  if (key === "redactPatterns") return cfg.redact?.patterns?.length ? cfg.redact.patterns.join(", ") : "(none)"
  if (key === "metaLabels") {
    const entries = Object.entries(cfg.meta ?? {})
    return entries.length ? entries.map(([k, v]) => `${k}=${v}`).join(", ") : "(none)"
  }
  const value = (cfg as unknown as Record<string, unknown>)[key]
  return value === undefined || value === "" ? "(not set)" : String(value)
}

async function editKey(host: ShareHostApi, cfg: ShareConfig, key: string): Promise<ShareConfig | undefined> {
  const meta = LABELS[key]
  if (!meta) return undefined
  // selection-backed settings: fixed vocabularies become menus instead of
  // asking for a typed value
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
    else next[key] = picked
    return next as ShareConfig
  }
  // composite keys map onto config sub-objects (redact.patterns / meta):
  // edited as comma lists, persisted as their structured forms
  if (key === "redactPatterns" || key === "metaLabels") {
    const current = displayValue(key, cfg)
    const raw = await showPrompt(host.ui, {
      title: meta.label,
      placeholder: key === "redactPatterns" ? "regex, regex, …" : "k=v, k2=v2",
      value: current === "(none)" ? "" : current,
    })
    if (raw === undefined) return undefined
    const next = { ...cfg } as ShareConfig
    if (key === "redactPatterns") {
      const patterns = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0 && s.length < 500).slice(0, 50)
      next.redact = patterns.length ? { patterns } : undefined
    } else {
      const clean: Record<string, string> = {}
      for (const pair of raw.split(",")) {
        const i = pair.indexOf("=")
        const k = i > 0 ? pair.slice(0, i).trim() : ""
        const v = i > 0 ? pair.slice(i + 1).trim() : ""
        if (k && k.length <= 64 && v.length <= 500) clean[k] = v
      }
      next.meta = Object.keys(clean).length ? clean : undefined
    }
    return next
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
 * the auth mode, then ASKS ONCE: onboard to an account, or stay anonymous
 * (public servers only; anonymous shares sit under the server's global
 * caps). Onboarding detects whether a code is needed and only then prompts
 * for one (a code already in config is used without asking). The outcome is
 * remembered per server: a token means onboarded, an anonymous flag means
 * declined. */
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
 * holders get "Get a user token" (the admin mints their own user identity;
 * root stays as adminToken, since being admin and being a user are not
 * mutually exclusive). */
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
    options.push({
      title: "Share defaults…",
      value: "defaults",
      description: `TTL · read auth for every share sent here (beats the general config)`,
      help: `## Per-server share defaults\nThe middle tier of the settings model: values here beat the general config for every share THIS agent sends to ${url}, and lose only to per-share overrides.\n\nApplies when a share is created or next attaches. Existing live pages keep their resolved settings until then.`,
    })
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
    if (choice === "defaults") {
      await serverDefaultsMenu(host, url)
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

/** Per-server share defaults (the middle tier): TTL + read-auth that beat
 * the general config for every share sent to THIS server, losing only to
 * per-share overrides. Persisted in the servers{} entry (settings home). */
async function serverDefaultsMenu(host: ShareHostApi, url: string): Promise<void> {
  while (true) {
    const cfg = currentConfig()
    const entry = serverEntries(cfg).find((s) => s.url === url)?.entry
    const ov = entry?.overrides
    const hasTtl = !!ov?.ttlHours
    const hasAuth = !!(ov?.authLogin && ov?.authPassword)
    const cap = await serverTtlCap(url)
    const res = resolveFor(cfg, url, undefined)
    const authSrc = res.auth?.source
    const options: ShareDialogSelectOption<string>[] = [
      {
        title: "Lifetime (TTL)",
        value: "ttl",
        description: `${res.ttlHours ? fmtHours(res.ttlHours.value) : "(server default)"}${cap && res.ttlHours && res.ttlHours.value > cap ? ` · server caps at ${fmtHours(cap)}` : ""}${srcSuffix(res.ttlHours?.source)}`,
        dim: !hasTtl,
        edited: hasTtl,
        help: `Default lifetime for shares sent to ${url}. Beats the general TTL; a per-share override beats this.\n\nEffective now: ${res.ttlHours ? `${fmtHours(res.ttlHours.value)}${srcSuffix(res.ttlHours.source)}` : "(server default)"}${cap ? `\nServer cap: ${fmtHours(cap)} (higher requests are clamped)` : ""}\nEmpty input clears this tier's override (the general config applies again). Applies when a share is created or next attaches.`,
      },
      {
        title: "Read auth",
        value: "auth",
        description: res.auth ? `${res.auth.value.login} / ****${srcSuffix(res.auth.source)}` : `no gate${srcSuffix(authSrc)}`,
        dim: !hasAuth,
        edited: hasAuth,
        help: `Default login gate for shares sent to ${url} — e.g. one server public, another gated, without per-share work. Beats the general read-auth; a per-share override beats this.\n\nEffective now: ${res.auth ? `${res.auth.value.login} / (password set)${srcSuffix(res.auth.source)}` : "no gate"}\nBoth login and password (or neither). Empty login clears this tier's override.`,
      },
      { title: "Clear all defaults", value: "clear", description: "this server inherits the general config again", danger: true, disabled: !ov },
      { title: "Back", value: "__back" },
    ]
    const choice = await showSelect(host.ui, { title: `Share defaults — ${hostOf(url)}`, options })
    if (choice === undefined || choice === "__back") return
    if (choice === "clear") {
      const sure = await showConfirm(host.ui, { title: "Clear server defaults", message: `Drop the TTL and read-auth overrides for ${hostOf(url)}?\nThe general config applies to this server's shares again.`, confirmLabel: "Clear" })
      if (!sure) continue
      saveServerOverrides(url, null)
      host.ui.toast({ variant: "success", title: "OpenShare", message: `Defaults cleared for ${hostOf(url)} — the general config applies.` })
      continue
    }
    if (choice === "ttl") {
      const raw = await showPrompt(host.ui, { title: "Server default TTL", placeholder: `6h, 2d or 48 — empty clears${!hasTtl && res.ttlHours ? ` (inherits ${fmtHours(res.ttlHours.value)})` : ""}`, value: hasTtl && ov?.ttlHours ? fmtHours(ov.ttlHours) : "" })
      if (raw === undefined) continue
      if (raw === "") {
        saveServerOverrides(url, { ttlHours: undefined })
        host.ui.toast({ variant: "success", title: "OpenShare", message: "Server TTL default cleared." })
        continue
      }
      const hours = parseTtlHours(raw)
      if (hours === undefined) {
        host.ui.toast({ variant: "error", title: "OpenShare", message: "TTL must be 6h / 2d style or a positive number of hours." })
        continue
      }
      saveServerOverrides(url, { ttlHours: hours })
      host.ui.toast({ variant: "success", title: "OpenShare", message: `Server default TTL: ${fmtHours(hours)}${cap && hours > cap ? ` (server caps at ${fmtHours(cap)})` : ""}.` })
      continue
    }
    if (choice === "auth") {
      const login = await showPrompt(host.ui, { title: "Server read auth: login", placeholder: "empty = clear this tier's override", value: hasAuth ? ov!.authLogin! : "" })
      if (login === undefined) continue
      const password = login === "" ? "" : (await showPrompt(host.ui, { title: "Server read auth: password", placeholder: "password (required with a login)" })) ?? ""
      if (login !== "" && password === "") continue
      if ((login === "") !== (password === "")) {
        host.ui.toast({ variant: "error", title: "OpenShare", message: "Read auth needs both a login and a password - or neither." })
        continue
      }
      saveServerOverrides(url, login === "" ? { authLogin: undefined, authPassword: undefined } : { authLogin: login, authPassword: password })
      host.ui.toast({ variant: "success", title: "OpenShare", message: login === "" ? "Server read-auth default cleared." : "Server read-auth default saved." })
      continue
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

/** Server info, the readable version (the raw JSON policy line escapes
 * the dialog border): formatted policy lines, auth explained in words,
 * YOUR standing on this server, and follow-up actions. */
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
 * summaries) opening focused submenus. Two-level by design: one flat ~25-row
 * dump is unreadable. Save semantics unchanged: root Exit saves when dirty;
 * submenu Back just returns. */
export async function settingsDialog(host: ShareHostApi, startAtSession?: string, startGroup?: "session"): Promise<void> {
  let cfg = currentConfig()
  let dirty = false
  // Write target: global settings home by default; any other existing
  // file in the read chain may be chosen explicitly. The TUI never
  // creates deploy-time override files.
  const candidates = writeCandidates(moduleDir())
  let writeTarget: WriteCandidate = candidates[0]
  const sources = configSourceMap(moduleDir())
  // fire-and-forget: shares{} overrides for sessions deleted while the
  // plugin was off must not pile up, but they must not delay the dialog
  void pruneStaleShareOverrides(host)

  type GroupId = "session" | "servers" | "config" | "interface"
  const GROUP_LABEL: Record<GroupId, string> = {
    session: "This session",
    servers: "Servers",
    config: "Config",
    interface: "Interface",
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
    const rows: ShareDialogSelectOption<string>[] = []
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
          "Every ACTIVE server receives new sessions (fan-out); one active server is the normal setup. Tokens persist in the settings home; enroll once, then it just works. The per-server submenu (enter) holds the admin panel and this server's share defaults.",
        ].join("\n"),
      })
    }
    if (!rows.length) rows.push({ title: "No servers yet", value: "__none", description: "connect one below", disabled: true })
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

  /** One flat menu with section dividers: every general config key (the
   * merged Config group) plus the config-file rows. Dividers keep the
   * flat list scannable without a second navigation level. */
  const configRows = (): ShareDialogSelectOption<string>[] => {
    const rows: ShareDialogSelectOption<string>[] = []
    const sectionRows = (section: string) => rows.push(...keyRows(section))
    sectionRows("Connection")
    rows.push({ title: "— sharing —", value: "__div_sharing", divider: true } as ShareDialogSelectOption<string>)
    sectionRows("Sharing")
    rows.push({ title: "— read auth —", value: "__div_auth", divider: true } as ShareDialogSelectOption<string>)
    sectionRows("Read auth")
    rows.push({ title: "— advanced —", value: "__div_adv", divider: true } as ShareDialogSelectOption<string>)
    sectionRows("Advanced")
    rows.push({ title: "— files —", value: "__div_files", divider: true } as ShareDialogSelectOption<string>)
    rows.push({
      title: "Write target",
      value: "action:target",
      description: writeTarget.label,
      disabled: candidates.length <= 1,
      help: `Which file "Save & exit" writes. The global settings home is always available; other files in the read chain only when they already exist (the TUI never creates deploy-time override files).\n\nWriting: ${writeTarget.path}`,
    })
    rows.push({
      title: "Where values come from",
      value: "action:sources",
      description: summarizeSources(sources),
      help: `Config merges per key, highest priority wins: OPENSHARE_* env > plugin options > adjacent openshare.config.json > openshare.local.json (repo walk-up) > settings home > defaults. An empty string means unset for url/token keys.\n\n${sourcesMessage(sources)}`,
    })
    return rows
  }

  const sessionRows = async (): Promise<ShareDialogSelectOption<string>[]> => {
    if (!startAtSession) return []
    const root = await resolveRoot(host.client, startAtSession)
    const bindings = await readBindings(host.client, root)
    const live = bindings.filter((b) => b.url && b.enabled !== false)
    const binding = bindings[0]
    // three-tier resolution for THIS share, scoped to the first live
    // server (fan-out servers can diverge by per-server overrides; the
    // [i] pane explains the tier model)
    const scopeServer = live[0]?.server
    const res = resolveFor(cfg, scopeServer, startAtSession, binding?.opts)
    const cap = scopeServer ? await serverTtlCap(scopeServer) : 0
    const authSrc = res.auth?.source
    const rows: ShareDialogSelectOption<string>[] = []

    // status header
    const status = binding?.url ? (binding.enabled === false ? "attached (dormant)" : res.paused?.value ? "live · paused" : "live") : "not shared"
    rows.push({
      title: "Status",
      value: "__status",
      description: `${status}${live.length ? ` · ${live.length} server(s)` : ""}${binding?.rev ? ` · rev ${binding.rev}` : ""}`,
      disabled: true,
      help: `## This share\n${live.length ? `Live on:\n${live.map((b) => `• ${b.url}`).join("\n")}` : "No page exists yet — Share this session creates one."}\n\nSettings below show the EFFECTIVE value and which tier it comes from (general < server default < this share). Inherited values render dim; setting an override here wins for this share only.`,
    })

    if (live.length === 0) {
      rows.push({
        title: "Share this session",
        value: "session:share",
        description: "set the share flag; the server plugin creates the page",
        help: "Publishes this session (and its subagent sessions) to the active server. The full history lands in the page — sharing mid-session is first-class, nothing is missed. You will be asked to confirm before anything is published.",
      })
    } else {
      rows.push({ title: "— link —", value: "__div_link", divider: true } as ShareDialogSelectOption<string>)
      if (live.length === 1) {
        rows.push({
          title: "Copy share link",
          value: "session:copy",
          description: live[0].url!,
          help: `Copies the share URL to the clipboard.\n\nURL: ${live[0].url}\nShare id: ${live[0].id ?? "?"}`,
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
    }

    rows.push({ title: "— settings —", value: "__div_settings", divider: true } as ShareDialogSelectOption<string>)
    rows.push({
      title: "Read auth",
      value: "session:auth",
      description: res.auth ? `${res.auth.value.login} / ****${srcSuffix(res.auth.source)}` : `no gate${srcSuffix(authSrc)}`,
      dim: authSrc !== "share",
      edited: authSrc === "share",
      help: `Login gate for THIS share's page: viewers must log in (PBKDF2 server-side, 7-day cookie, lockout after failures). Applies immediately on live pages (credentials rotate; logged-in viewers re-login).\n\nEffective: ${res.auth ? `${res.auth.value.login} / (password set)${srcSuffix(res.auth.source)}` : "no gate"}\nSetting a login+password here overrides the general/server tiers for this share; clearing both removes the override (the lower tiers apply again). A login needs a password — both or neither.`,
    })
    rows.push({
      title: "Lifetime (TTL)",
      value: "session:ttl",
      description: res.ttlHours
        ? `${fmtHours(res.ttlHours.value)}${cap && res.ttlHours.value > cap ? ` · server caps at ${fmtHours(cap)}` : ""}${srcSuffix(res.ttlHours.source)}`
        : "(server default)",
      dim: res.ttlHours?.source !== "share",
      edited: res.ttlHours?.source === "share",
      help: `How long this page lives before the server's sweeper deletes it. Accepts 6h / 2d / 48 style input (hours).\n\nEffective: ${res.ttlHours ? `${fmtHours(res.ttlHours.value)}${srcSuffix(res.ttlHours.source)}` : "(none — server default)"}${cap ? `\nServer cap: ${fmtHours(cap)} (requests above it are clamped at create)` : ""}\nAn override here wins over the general/server tiers for this share; clearing it lets them apply again. Shortening a live page may end it at once — that is the ask.`,
    })
    rows.push({
      title: "Title",
      value: "session:title",
      description: res.title ? `"${res.title.value}" · custom` : `auto — follows session renames`,
      dim: !res.title,
      edited: !!res.title,
      help: `The share page's title. By default it follows the session's live title: renaming the session in opencode renames the page automatically.\n\nA CUSTOM title sticks — the page keeps it and ignores session renames until you clear it. Surfaces in the page header, link previews (OG card) and admin listings.`,
    })
    rows.push({
      title: "Paused",
      value: "session:paused",
      description: res.paused?.value ? "paused — syncing stopped, page keeps its last state" : "syncing normally",
      dim: !res.paused?.value,
      edited: !!res.paused?.value,
      help: `Freeze-parity, self-served: while paused NOTHING syncs — the page keeps its last status and content, exactly as a viewer last saw it. Everything keeps queueing locally, and unpausing backfills the gap (same machinery as a long reconnect). Data writes to the page are refused while paused.`,
    })

    if (live.length) {
      rows.push({ title: "— destinations —", value: "__div_dest", divider: true } as ShareDialogSelectOption<string>)
      const otherServers = serverEntries().filter((s) => !live.some((b) => b.server === s.url))
      if (otherServers.length) {
        rows.push({
          title: "Share to another server…",
          value: "session:more",
          description: otherServers.map((s) => hostOf(s.url)).join(", "),
          help: `Adds one of your other configured servers as a destination for THIS session: it becomes active and the full history is mirrored there within seconds.\n\nAvailable:\n${otherServers.map((s) => `• ${s.url}`).join("\n")}`,
        })
      }
      if (live.length > 1) {
        rows.push({
          title: "Stop on one server…",
          value: "session:unshare:one",
          description: "delete or snapshot a single server's page",
          help: `Per-server stop: pick the server, then delete its page or leave it as a read-only snapshot. Other servers are unaffected.\n\nBound servers:\n${live.map((b) => `• ${b.server} — ${b.url}`).join("\n")}`,
        })
      }
      rows.push({ title: "— danger —", value: "__div_danger", divider: true } as ShareDialogSelectOption<string>)
      rows.push({
        title: "Stop sharing",
        value: "session:unshare",
        description: live.length > 1 ? `delete every page (${live.length} servers), or leave snapshots` : "delete the page, or leave a snapshot",
        danger: true,
        help: `Choose per run: DELETE every page server-side (links stop working — final "gone" state), or LEAVE AS-IS (stop updating; pages stay readable until their TTL — a frozen snapshot).\n\nURLs:\n${live.map((b) => b.url).join("\n")}\n\nSharing again later always creates fresh page(s) with new URLs.`,
      })
    }
    if (binding?.lastError || binding?.ttlClamped) {
      const bits: string[] = []
      if (binding?.ttlClamped) bits.push(`TTL clamped ${binding.ttlClamped.requested}h -> ${binding.ttlClamped.effective}h by server/token policy`)
      if (binding?.lastError) bits.push(`last share error: ${binding.lastError}`)
      rows.push({
        title: "Share status notes",
        value: "__notes",
        description: bits[0].slice(0, 60),
        disabled: true,
        help: `Engine-recorded notes for this session's share(s):\n\n${bits.join("\n")}\n\nThe clamp note appears when the server or your token's policy reduced a requested TTL. The error note is the engine's last create/attach refusal (quota, freeze, rate limit) - it clears on the next successful sync.`,
      })
    }
    return rows
  }

  const rowsFor = async (id: GroupId): Promise<ShareDialogSelectOption<string>[]> => {
    switch (id) {
      case "session":
        return await sessionRows()
      case "servers":
        return serverRows()
      case "config":
        return configRows()
      case "interface":
        return interfaceRows()
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
              // deletable later, and re-sharing reuses the binding instead
              // of stalling on a secret-less marker that can never unshare
              // or re-share again.
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
        const resT = resolveFor(cfg, live[0]?.server, startAtSession, current?.opts)
        const raw = await showPrompt(host.ui, {
          title: "Share lifetime (TTL)",
          placeholder: `6h, 2d or 48 — empty clears${resT.ttlHours && resT.ttlHours.source !== "share" ? ` (inherits ${fmtHours(resT.ttlHours.value)})` : ""}`,
          value: resT.ttlHours?.source === "share" ? fmtHours(resT.ttlHours.value) : "",
        })
        if (raw === undefined) return
        if (raw === "") {
          // clear the share override: lower tiers apply again. Live pages
          // get the re-resolved value immediately (the engine's attach
          // re-sync carries the same number)
          await applyShareOverride(host, startAtSession, { ttlHours: undefined })
          const nextTier = resolveFor(cfg, live[0]?.server, startAtSession, undefined)
          if (live.length && nextTier.ttlHours) {
            await Promise.all(live.map((b) => (b.id && b.secret ? patchShareOpts(b.server, b.id, { ttlHours: nextTier.ttlHours!.value }, b.secret) : Promise.resolve({ ok: false }))))
          }
          host.ui.toast({
            variant: "success",
            title: "OpenShare",
            message: live.length ? `TTL override cleared — ${nextTier.ttlHours ? fmtHours(nextTier.ttlHours.value) : "server default"} applies now.` : "TTL override cleared.",
          })
          return
        }
        const hours = parseTtlHours(raw)
        if (hours === undefined) {
          host.ui.toast({ variant: "error", title: "OpenShare", message: "TTL must be 6h / 2d style or a positive number of hours." })
          return
        }
        const pushed = await applyShareOverride(host, startAtSession, { ttlHours: hours })
        host.ui.toast({
          variant: live.length ? "success" : "info",
          title: "OpenShare",
          message: live.length
            ? `Lifetime: ${fmtHours(hours)} — applied now${pushed < live.length ? ` (${live.length - pushed} server(s) heal on next connect)` : ""}.`
            : `Lifetime: ${fmtHours(hours)} — saved, applies when you share.`,
        })
        return
      }
      if (choice === "session:auth") {
        const resA = resolveFor(cfg, live[0]?.server, startAtSession, current?.opts)
        const inherited = resA.auth && resA.auth.source !== "share" ? resA.auth : undefined
        const login = await showPrompt(host.ui, {
          title: "Share read auth: login",
          placeholder: inherited ? `empty = clear override (inherits ${inherited.value.login})` : "empty = no gate",
          value: resA.auth?.source === "share" ? resA.auth.value.login : "",
        })
        if (login === undefined) return
        const password = await showPrompt(host.ui, { title: "Share read auth: password", placeholder: login === "" ? "(unused)" : "password (required with a login)" })
        if (password === undefined) return
        // both-or-none: the server builds a gate only from a full pair, and
        // rendering half a pair would show protection that does not exist
        if ((login === "") !== (password === "")) {
          host.ui.toast({ variant: "error", title: "OpenShare", message: "Read auth needs both a login and a password - or neither (no gate)." })
          return
        }
        const pushed = await applyShareOverride(host, startAtSession, login === "" ? { authLogin: undefined, authPassword: undefined } : { authLogin: login, authPassword: password })
        host.ui.toast({
          variant: live.length ? "success" : "info",
          title: "OpenShare",
          message: live.length
            ? `Read auth ${login === "" ? "override cleared" : "saved"} — applied now${pushed < live.length ? ` (${live.length - pushed} server(s) heal on next connect)` : ""}.`
            : `Read auth ${login === "" ? "cleared" : "saved"} — applies when you share.`,
        })
        return
      }
      if (choice === "session:title") {
        const resTt = resolveFor(cfg, live[0]?.server, startAtSession, current?.opts)
        const raw = await showPrompt(host.ui, { title: "Share title", placeholder: "empty = auto (follows session renames)", value: resTt.title?.value ?? "" })
        if (raw === undefined) return
        const value = raw.trim().slice(0, 300)
        const pushed = await applyShareOverride(host, startAtSession, value === "" ? { title: undefined } : { title: value })
        host.ui.toast({
          variant: live.length ? "success" : "info",
          title: "OpenShare",
          message: live.length
            ? value === ""
              ? "Custom title cleared — the page follows session renames again."
              : `Title set — applied now${pushed < live.length ? ` (${live.length - pushed} server(s) heal on next connect)` : ""}.`
            : value === ""
              ? "Custom title cleared."
              : "Title saved — applies when you share.",
        })
        return
      }
      if (choice === "session:paused") {
        const resP = resolveFor(cfg, live[0]?.server, startAtSession, current?.opts)
        const next = !resP.paused?.value
        if (next) {
          const sure = await showConfirm(host.ui, {
            title: "Pause syncing",
            message: "Stop syncing every page of this session?\nThe page keeps its last status and content — viewers see nothing change. Everything queues locally; unpausing backfills the gap.",
            confirmLabel: "Pause",
          })
          if (!sure) return
        }
        // ORDER: pause flips the ENGINE first (stop sending), then the
        // server flag (block foreign writers). Unpause reverses it — the
        // server must accept writes before the backfill drain fires.
        const root2 = await resolveRoot(host.client, startAtSession)
        if (!next) {
          await Promise.all(live.map((b) => (b.id && b.secret ? patchShareOpts(b.server, b.id, { paused: false }, b.secret) : Promise.resolve({ ok: false }))))
        }
        const binding2 = await readBinding(host.client, root2)
        const opts2: SessionOpts = { ...(binding2?.opts ?? {}), paused: next === true ? true : undefined }
        saveShareOverrides(startAtSession, next ? { paused: true } : { paused: undefined })
        await setShareOpts(host.client, root2, opts2)
        if (next) {
          await Promise.all(live.map((b) => (b.id && b.secret ? patchShareOpts(b.server, b.id, { paused: true }, b.secret) : Promise.resolve({ ok: false }))))
        }
        host.ui.toast({ variant: "success", title: "OpenShare", message: next ? "Paused — pages keep their last state; unpausing backfills everything." : "Unpaused — backfilling now." })
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
        help: `The share dashboard for the session this dialog was opened on: status, link, per-share settings (read auth, TTL, title, pause), destinations, stop.\n\nStatus: ${shared}${binding?.url ? `\nURL: ${binding.url}` : ""}\nPer-share values override the Config and server tiers for this share only.`,
      })
    }
    groups.push({
      id: "servers",
      summary: servers.length
        ? `${servers.length} saved${active ? ` · active: ${hostOf(active.url)}` : " · none active"}${cfg.workerUrl ? " · legacy pair set" : ""}`
        : cfg.workerUrl
          ? `${hostOf(cfg.workerUrl)} · legacy pair`
          : "no server yet",
      help: `Server memberships: enroll, rotate, disconnect, per-server share defaults, the admin panel. Connect to a server is here too.\n\nEvery ACTIVE server receives new sessions (fan-out); one active server is the normal setup.`,
    })
    groups.push({
      id: "config",
      summary: `sync ${seconds(cfg.debounceMs, 10000)} · TTL ${fmtHours(cfg.ttlHours ?? 2160)} · auth ${cfg.authLogin ? "on" : "off"}`,
      help: `Every general (all-shares) setting in one place: connection (server URL, config set), sharing (mode, cadence, TTL, model label, redaction, meta labels), read-auth defaults, advanced plumbing (spool, url file, stderr) — plus the config-file tools (write target, source map).\n\nThese are the DEFAULTS tier: per-server defaults and per-share overrides beat them.`,
    })
    groups.push({
      id: "interface",
      summary: `${uiWidth} (${DIALOG_WIDTH_COLUMNS[uiWidth]} cols) · ${kvHeightPercentOf(host.kv)}% height`,
      help: `OpenShare menu sizing: width (opencode's fixed dialog widths: 60/88/116 columns) and height (a percent of terminal rows, presets compact/normal/tall/max).\n\nStored in the host's preference store — per machine, not the config file.`,
    })

    const options: ShareDialogSelectOption<string>[] = groups.map((group) => ({
      title: GROUP_LABEL[group.id],
      value: `group:${group.id}`,
      description: group.summary,
      help: group.help,
    }))
    options.push({ title: dirty ? "Save & exit" : "Exit", value: "action:exit", description: dirty ? `Write ${writeTarget.path}` : "No changes" })

    const choice = await showSelect(host.ui, { title: `OpenShare v${pluginVersion()} · settings`, options })
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
