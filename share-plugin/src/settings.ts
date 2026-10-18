// OpenShare settings dialog (/openshare): select -> edit flows over the
// host facade's dialog stack. No custom JSX — every screen is a
// DialogSelect/DialogPrompt/DialogConfirm composition, so the same flows
// run on the v1 TUI and the v2 dialog bridge.
//
// Sections: Connection, Sharing, Read auth, Advanced, This session.

import type { ShareConfig } from "./config.js"
import {
  clearShareFlag,
  confirmShare,
  currentConfig,
  isConfigured,
  probeWorker,
  readBinding,
  resolveRoot,
  saveConfig,
  setShareFlag,
} from "./share-flow.js"
import type { SessionOpts } from "./core.js"
import type { ShareDialogSelectOption, ShareHostApi } from "./tui-host.js"

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
  return new Promise((resolve) => {
    let settled = false
    const done = (value: Value | undefined) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    ui.dialog.replace(
      () =>
        ui.DialogSelect<Value>({
          title: props.title,
          placeholder: props.placeholder ?? "Type to filter...",
          options: props.options,
          current: props.current,
          flat: props.options.length < 12,
          onSelect: (option) => {
            done(option.value)
            ui.dialog.clear()
          },
        }),
      () => done(undefined),
    )
  })
}

function showPrompt(ui: UI, props: { title: string; placeholder?: string; value?: string }): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: string | undefined) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    ui.dialog.replace(
      () =>
        ui.DialogPrompt({
          title: props.title,
          placeholder: props.placeholder,
          value: props.value,
          onConfirm: (value) => {
            done(value)
            ui.dialog.clear()
          },
          onCancel: () => done(undefined),
        }),
      () => done(undefined),
    )
  })
}

function showConfirm(ui: UI, props: { title: string; message: string; confirmLabel?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    ui.dialog.replace(
      () =>
        ui.DialogConfirm({
          title: props.title,
          message: props.message,
          confirmLabel: props.confirmLabel,
          onConfirm: () => {
            done(true)
            ui.dialog.clear()
          },
          onCancel: () => done(false),
        }),
      () => done(false),
    )
  })
}

function showInfo(ui: UI, props: { title: string; message: string }): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }
    ui.dialog.replace(
      () =>
        ui.DialogAlert({
          title: props.title,
          message: props.message,
          onConfirm: () => {
            done()
            ui.dialog.clear()
          },
        }),
      () => done(),
    )
  })
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
  urlFile: { label: "URL file", help: "Extra file each share URL is written to (all-mode only).", kind: "text", section: "Advanced" },
  shareMode: { label: "Share mode", help: '"all" shares every session; "manual" needs /share. Default: TUI presence.', kind: "text", section: "Sharing" },
}

function displayValue(key: string, cfg: ShareConfig): string {
  if (key === "createToken" || key === "authPassword") return mask(String(cfg[key] ?? ""))
  if (key === "openTasksInNewTab") return String(cfg.openTasksInNewTab !== false)
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
  } else if (key === "openTasksInNewTab") {
    next[key] = raw === "true" || raw === "yes" || raw === "1"
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

/** The settings dialog. Returns when the user exits. */
export async function settingsDialog(host: ShareHostApi, startAtSession?: string): Promise<void> {
  let cfg = currentConfig()
  let dirty = false

  while (true) {
    const binding = startAtSession ? await readBinding(host.client, await resolveRoot(host.client, startAtSession)) : undefined
    const shared = binding?.url ? (binding.enabled === false ? "attached (dormant)" : "live") : "not shared"

    const options: ShareDialogSelectOption<string>[] = []
    for (const [key, meta] of Object.entries(LABELS)) {
      if (meta.section === "Connection") options.push({ title: meta.label, value: `key:${key}`, description: displayValue(key, cfg) })
    }
    options.push({ title: "Test connection", value: "action:test", description: "Probe the worker's /health endpoint" })
    for (const [key, meta] of Object.entries(LABELS)) {
      if (meta.section === "Sharing") options.push({ title: meta.label, value: `key:${key}`, description: displayValue(key, cfg) })
    }
    for (const [key, meta] of Object.entries(LABELS)) {
      if (meta.section === "Read auth") options.push({ title: meta.label, value: `key:${key}`, description: displayValue(key, cfg) })
    }
    for (const [key, meta] of Object.entries(LABELS)) {
      if (meta.section === "Advanced") options.push({ title: meta.label, value: `key:${key}`, description: displayValue(key, cfg) })
    }
    if (startAtSession) {
      options.push({ title: `— This session (${shared}) —`, value: "session:none", description: "Per-session actions and overrides", disabled: true })
      options.push({ title: binding?.url ? "Copy share link" : "Share this session", value: "session:share", description: binding?.url ?? "Set the share flag; the server plugin creates the page" })
      if (binding?.url) options.push({ title: "Stop sharing", value: "session:unshare", description: "Delete the share page and clear the flag" })
      options.push({ title: "Session TTL override (days)", value: "session:ttl", description: binding?.opts?.ttlDays !== undefined ? String(binding.opts.ttlDays) : "(worker default)" })
      options.push({ title: "Session read auth", value: "session:auth", description: binding?.opts?.authLogin ? `${binding.opts.authLogin} / ****` : "(config default)" })
    }
    options.push({ title: dirty ? "Save & exit" : "Exit", value: "action:exit", description: dirty ? "Write openshare.config.json" : "No changes" })

    const choice = await showSelect(host.ui, { title: "OpenShare settings", options })
    if (choice === undefined || choice === "action:exit") {
      if (dirty) {
        const saved = saveConfig(cfg)
        if (saved) host.ui.toast({ variant: "success", title: "OpenShare", message: `Saved ${saved.path}` })
        else host.ui.toast({ variant: "error", title: "OpenShare", message: "Could not write the config file." })
      }
      host.ui.dialog.clear()
      return
    }

    if (choice === "action:test") {
      host.ui.toast({ variant: "info", title: "OpenShare", message: "Testing worker connection..." })
      const result = await probeWorker(cfg.workerUrl)
      await showInfo(host.ui, {
        title: result.ok ? "Worker reachable" : "Worker unreachable",
        message: `${cfg.workerUrl || "(no workerUrl set)"} — ${result.detail}${result.ok && !cfg.createToken ? "\nNote: createToken is still required for sharing." : ""}`,
      })
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

/** Onboarding shown by /share when the plugin is unconfigured. */
export async function onboardingDialog(host: ShareHostApi): Promise<void> {
  const ok = await showConfirm(host.ui, {
    title: "Welcome to Open(code)Share",
    message: "Sharing needs your openshare-worker URL and its create token.\nOpen the settings dialog now?",
    confirmLabel: "Open settings",
  })
  if (ok) await settingsDialog(host)
  else host.ui.dialog.clear()
}
