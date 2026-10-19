// OpenShare share flows — host-agnostic logic behind /share, /unshare and
// the settings dialog's "this session" actions. Runs against the
// ShareHostApi facade (tui-host.ts) and the shared config module, so the
// same compiled code serves the v1 TUI and the v2 adapter.
//
// Flow contracts (mirrored by scripts/manual-tests.mjs):
//  /share     resolve root session -> config check (onboard to settings
//             when unconfigured) -> consent once -> set the enabled flag
//             (with per-session opts when present) -> wait for the server
//             plugin to publish the binding URL into session metadata
//             (~seconds; worker-down surfaces as a timeout toast) -> copy.
//  /unshare   resolve root -> confirm -> read binding -> clear flag ->
//             DELETE the share directly via the worker (belt and braces:
//             works even if the server plugin never saw the flag event) ->
//             the server-side flag-removal path cleans up on its own.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { loadConfig, moduleDir, configPaths, configHomePath, METADATA_KEY, type ShareConfig } from "./config.js"
import { dbg, dbgLog } from "./sidebar.js"
import type { ClientApi, SessionInfo, SessionOpts } from "./core.js"
import type { ShareHostApi } from "./tui-host.js"

export type SessionBinding = {
  id: string
  secret: string
  rev: number
  url: string
  enabled?: boolean
  opts?: SessionOpts
}

export const CONSENT_KV_KEY = "openshare_consent"

export function pluginConfigPaths(baseDir: string = moduleDir()): string[] {
  return configPaths(baseDir)
}

export function currentConfig(baseDir: string = moduleDir()): ShareConfig {
  return loadConfig(baseDir)
}

/** Writes the config file. Target rule (owner-directed): the global
 * settings home by default, or an explicit existing file chosen in the
 * TUI — NEVER "first existing in the read chain" (that wrote TUI edits
 * into the tracked adjacent template, live-caught). $comment and foreign
 * keys preserved. */
export function saveConfig(cfg: ShareConfig, target?: string, baseDir: string = moduleDir()): { path: string } | undefined {
  const path = target ?? configHomePath()
  if (!path) return undefined
  try {
    const previous: Record<string, unknown> = existsSync(path)
      ? (() => {
          try {
            return JSON.parse(readFileSync(path, "utf8"))
          } catch {
            return {}
          }
        })()
      : {}
    // preserve $comment and any foreign keys, override with our values
    const next: Record<string, unknown> = { ...previous }
    for (const key of [
      "workerUrl",
      "createToken",
      "debounceMs",
      "completedDelayMs",
      "modelLabel",
      "ttlDays",
      "openTasksInNewTab",
      "authLogin",
      "authPassword",
      "spoolDir",
      "urlFile",
      "shareMode",
      "announceStderr",
    ] as Array<keyof ShareConfig>) {
      next[key] = cfg[key]
    }
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n")
    return { path }
  } catch {
    return undefined
  }
}

export function isConfigured(cfg: ShareConfig): boolean {
  return Boolean(cfg.workerUrl && cfg.createToken)
}

// --- session metadata helpers -------------------------------------------------

export function bindingOf(info: SessionInfo | undefined): SessionBinding | undefined {
  const raw = info?.metadata?.[METADATA_KEY]
  if (!raw || typeof raw !== "object") return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.id !== "string" || typeof record.secret !== "string") return undefined
  return {
    id: record.id,
    secret: record.secret,
    rev: typeof record.rev === "number" ? record.rev : 0,
    url: typeof record.url === "string" ? record.url : "",
    enabled: record.enabled === true ? true : undefined,
    opts: (record.opts as SessionOpts | undefined) ?? undefined,
  }
}

async function getSession(client: ClientApi | undefined, sid: string): Promise<SessionInfo | undefined> {
  if (!client?.session?.get) return undefined
  try {
    const res = await client.session.get({ path: { id: sid } })
    const info = (res as { data?: SessionInfo })?.data ?? (res as SessionInfo)
    return info && typeof info === "object" ? info : undefined
  } catch {
    return undefined
  }
}

async function patchMetadata(client: ClientApi | undefined, sid: string, metadata: Record<string, unknown>): Promise<boolean> {
  if (!client?.session?.update) {
    dbgLog(`patchMetadata(${sid}): no client.session.update`)
    return false
  }
  try {
    const res = await client.session.update({ path: { id: sid }, body: { metadata } })
    if (res && typeof res === "object" && "error" in res && (res as { error?: unknown }).error) {
      const err = (res as { error?: { name?: string; data?: { message?: string; ref?: string } } }).error
      dbgLog(`patchMetadata(${sid}) ERROR: ${err?.name}: ${err?.data?.message ?? ""} ref=${err?.data?.ref ?? ""}`)
      return false
    }
    dbgLog(`patchMetadata(${sid}): ok res=${dbg(res)}`)
    return true
  } catch (e) {
    dbgLog(`patchMetadata(${sid}) THREW: ${(e as Error)?.stack ?? e}`)
    return false
  }
}

/** Walks parentID up to the root session (the share owns the whole tree). */
export async function resolveRoot(client: ClientApi | undefined, sid: string): Promise<string> {
  let current = sid
  for (let hops = 0; hops < 10; hops++) {
    const info = await getSession(client, current)
    const parent = info?.parentID
    if (typeof parent !== "string" || !parent || parent === current) return current
    current = parent
  }
  return current
}

export async function readBinding(client: ClientApi | undefined, sid: string): Promise<SessionBinding | undefined> {
  return bindingOf(await getSession(client, sid))
}

/** Sets metadata.openshare = { ...existingBinding, enabled: true, opts? }. */
export async function setShareFlag(
  client: ClientApi | undefined,
  sid: string,
  opts?: SessionOpts,
): Promise<boolean> {
  const info = await getSession(client, sid)
  if (!info) return false
  const metadata: Record<string, unknown> = { ...(info.metadata ?? {}) }
  const existing = bindingOf(info)
  const value: Record<string, unknown> = {
    id: existing?.id ?? "",
    secret: existing?.secret ?? "",
    rev: existing?.rev ?? 0,
    url: existing?.url ?? "",
    enabled: true,
  }
  if (opts && Object.keys(opts).length) value.opts = opts
  metadata[METADATA_KEY] = value
  return patchMetadata(client, sid, metadata)
}

export async function clearShareFlag(client: ClientApi | undefined, sid: string): Promise<boolean> {
  const info = await getSession(client, sid)
  if (!info) return false
  const metadata: Record<string, unknown> = { ...(info.metadata ?? {}) }
  delete metadata[METADATA_KEY]
  return patchMetadata(client, sid, metadata)
}

// --- worker direct access -------------------------------------------------------

async function workerDeleteShare(workerUrl: string, id: string, secret: string): Promise<boolean> {
  try {
    const res = await fetch(`${workerUrl.replace(/\/$/, "")}/api/share/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret }),
      signal: AbortSignal.timeout(8000),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Health probe for the settings dialog's connection test. */
export async function probeWorker(workerUrl: string): Promise<{ ok: boolean; detail: string }> {
  if (!workerUrl) return { ok: false, detail: "workerUrl is empty" }
  try {
    const res = await fetch(`${workerUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` }
    const body = (await res.json().catch(() => ({}))) as { service?: string }
    return { ok: true, detail: body.service ? `service: ${body.service}` : "reachable" }
  } catch (error) {
    return { ok: false, detail: (error as Error).message }
  }
}

// --- the flows --------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Waits for the server plugin to publish the binding URL (poll; robust on
 * both hosts). Resolves the binding, or undefined on timeout. */
export async function waitForBinding(
  client: ClientApi | undefined,
  sid: string,
  timeoutMs = 25000,
): Promise<SessionBinding | undefined> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const binding = await readBinding(client, sid)
    if (binding?.url) return binding
    await sleep(600)
  }
  return undefined
}

export type FlowResult = { ok: boolean; message: string; url?: string; unconfigured?: boolean }

export async function runShareFlow(host: ShareHostApi, sessionID: string | undefined): Promise<FlowResult> {
  if (!sessionID) return { ok: false, message: "No active session to share." }
  const cfg = currentConfig()
  if (!isConfigured(cfg)) {
    return { ok: false, message: "OpenShare is not configured — run /openshare to set workerUrl and createToken.", unconfigured: true }
  }
  const root = await resolveRoot(host.client, sessionID)
  const existing = await readBinding(host.client, root)
  if (existing?.url && existing.enabled !== false) {
    // already sharing: copy the link
    await host.clipboard.write(existing.url)
    return { ok: true, message: `Share URL copied to clipboard: ${existing.url}`, url: existing.url }
  }
  if (!host.kv.get(CONSENT_KV_KEY, false)) {
    // caller shows the consent dialog before invoking confirmShare()
    return { ok: false, message: "consent required" }
  }
  return confirmShare(host, root)
}

/** Post-consent share: set the flag, wait for the URL, copy it. */
export async function confirmShare(host: ShareHostApi, rootSessionID: string): Promise<FlowResult> {
  dbgLog(`confirmShare: setShareFlag(${rootSessionID})`)
  const set = await setShareFlag(host.client, rootSessionID)
  dbgLog(`confirmShare: setShareFlag -> ${set}`)
  if (!set) return { ok: false, message: "Could not write the share flag into session metadata." }
  const binding = await waitForBinding(host.client, rootSessionID)
  dbgLog(`confirmShare: waitForBinding -> ${binding?.url ? binding.url : "timeout"}`)
  if (!binding?.url) {
    return {
      ok: false,
      message:
        "Share did not come up (timeout waiting for the URL). Is the worker reachable? Check the server plugin log for [openshare] lines.",
    }
  }
  await host.clipboard.write(binding.url)
  return { ok: true, message: `Share URL copied to clipboard: ${binding.url}`, url: binding.url }
}

export async function runUnshareFlow(host: ShareHostApi, sessionID: string | undefined): Promise<FlowResult> {
  if (!sessionID) return { ok: false, message: "No active session." }
  const cfg = currentConfig()
  const root = await resolveRoot(host.client, sessionID)
  const binding = await readBinding(host.client, root)
  if (!binding) return { ok: false, message: "This session is not shared." }
  // clear flag first (stops the forwarder), then delete the page directly —
  // the direct delete also covers server plugins that never saw the event
  await clearShareFlag(host.client, root)
  let deleted = false
  if (cfg.workerUrl && binding.id && binding.secret) {
    deleted = await workerDeleteShare(cfg.workerUrl, binding.id, binding.secret)
  }
  return {
    ok: true,
    message: deleted ? "Sharing stopped and the share page was deleted." : "Sharing stopped (page deletion will follow via the sweeper).",
  }
}
