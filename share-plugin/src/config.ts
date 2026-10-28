// Open(code)Share — config resolution + share-mode detection.
//
// Precedence: OPENSHARE_* env > plugin options (the [path, options] tuple
// from the plugin array) > openshare.config.json > code defaults. The
// config file is searched next to the plugin FILE first (the standalone
// single-file contract), then at the package root (dist/server.js walks
// up to the package that ships it).
//
// Share mode ("all" | "manual"):
//  - explicit `shareMode` in env/file/options wins;
//  - otherwise presence-based: an openshare TUI registration in any
//    tui.json layer (global, OPENCODE_TUI_CONFIG, project chain) means a
//    human drives sharing interactively -> "manual"; no TUI -> the server
//    plugin is alone (the CI shape) -> "all".
//  - The mode is resolved once at plugin load and fixed for the process
//    lifetime; changing it needs a restart.
//
// Detection is read-only: this plugin NEVER writes tui.json (no
// selfwiring — the two parts are installed deliberately).

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import type { ShareScope } from "./scope.js"
import { basename, dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

export type ShareMode = "all" | "manual"

/** One share-server membership. Keyed by server URL in the `servers`
 * config group; the entry with `active: true` (or the first) is where
 * new sessions share. `token` is the enrolled user token (osk_…) or the
 * legacy root CREATE_TOKEN; `code` is an enrollment access code for
 * private servers (used once when no token is held); `adminToken` is the
 * server's root CREATE_TOKEN for the /openshare admin console (optional
 * convenience — the hoster's own machines only). */
export type ServerEntry = {
  token?: string
  code?: string
  label?: string
  active?: boolean
  adminToken?: string
  /** The user DECLINED onboarding for this server (asked once, remembered):
   * shares go out anonymously (public servers only). Cleared by enrolling. */
  anonymous?: boolean
}

export type ShareConfig = {
  workerUrl: string
  createToken: string
  /** Multi-server memberships (URL -> entry). Legacy workerUrl/createToken
   * synthesize into this group at load; the group is the canonical form. */
  servers?: Record<string, ServerEntry>
  debounceMs: number
  completedDelayMs: number
  modelLabel: string
  /** Default share lifetime in HOURS (Wave 3; default 2160 = 90d).
   * Legacy ttlDays config/env is accepted and converted x24. */
  ttlHours: number
  authLogin: string
  authPassword: string
  spoolDir: string
  urlFile: string
  /** urlFile line format: "url" (default, one bare URL per line) or
   * "json" (one JSON object per line: id, url, status, gated) for CI
   * consumers that want machine-readable lines without parsing URLs. */
  urlFileFormat: "url" | "json"
  /** false silences the `[openshare] live:` (and `url file:`) stderr
   * lines. The share itself is unaffected. */
  announceStderr: boolean
  /** Wave 3 redaction: user-supplied regex rules (client-side only)
   * applied beside the built-in detectors on UNGATED shares. */
  redact?: { patterns?: string[] }
  /** Wave 3 partial share: what leaves the machine (opt-in scoping). */
  scope?: ShareScope
  /** B4: which named config set on the server token this agent uses
   * (unset = the token's first/default set). Rides the create frame. */
  configSet?: string
  /** Free-form string metadata stamped onto every share at create
   * (labels for team directories/admin listings). Values may reference
   * env vars as ${NAME} - interpolated at send time; unresolved refs
   * stay literal so misconfiguration is visible. */
  meta?: Record<string, string>
  shareMode?: ShareMode
}

export const METADATA_KEY = "openshare"

/** Sentinel urlFile value that disables the URL file entirely
 * (`""` stays "unset = default path"; "none" is an explicit opt-out). */
export const URL_FILE_NONE = "none"

export const DEFAULTS: ShareConfig = {
  workerUrl: "", // empty = plugin disabled until configured
  createToken: "",
  debounceMs: 10000,
  // opencode's idle IS authoritative turn end (busy is held through steps,
  // tool runs and permission waits), so the flip needs only enough grace
  // to cover an automation's gap before the next prompt. Uniform across
  // profiles; server-capped (COMPLETED_DELAY_MAX_MS). Dispose flushes a
  // pending flip, so CI runs still land their final status.
  completedDelayMs: 5000,
  modelLabel: "$Provider/$Model",
  ttlHours: 90 * 24,
  authLogin: "",
  authPassword: "",
  spoolDir: "",
  urlFile: "",
  urlFileFormat: "url",
  configSet: "",
  announceStderr: true,
}

const CONFIG_NAME = "openshare.config.json"
const LOCAL_NAME = "openshare.local.json"

/** Directory of this module file (bundled standalone: the single file's
 * directory; package: dist/). */
export function moduleDir(): string {
  return dirname(fileURLToPath((import.meta as { pathname?: string }).pathname ?? import.meta.url))
}

/** Nearest ancestor (starting at `start`) containing package.json. */
export function packageRoot(start: string): string {
  let current = start
  for (let guard = 0; guard < 16; guard++) {
    if (existsSync(join(current, "package.json"))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return start
}

/** Config file search paths for a plugin living at `pluginDir`.
 *
 * Order (first FOUND wins; env vars still override everything):
 *  1. `openshare.config.json` adjacent to the plugin file (CI bundles
 *     ship it alongside; the package ships a commented template).
 *  2. `openshare.local.json` walking up from the plugin dir (repo-local
 *     overrides for dev/testing; gitignored by convention).
 *  3. `openshare.config.json` in the opencode config folder
 *     (`~/.config/opencode/`) — the interactive settings home, same
 *     sidecar pattern the family plugins use.
 */
export function configPaths(pluginDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const paths = [join(pluginDir, CONFIG_NAME)]
  const root = packageRoot(pluginDir)
  if (root !== pluginDir) paths.push(join(root, CONFIG_NAME))
  // bounded upward walk for the local-override slot
  let current = pluginDir
  for (let i = 0; i < 5; i++) {
    paths.push(join(current, LOCAL_NAME))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  paths.push(join(globalConfigDir(env), CONFIG_NAME))
  return paths
}

/** Canonical settings target (what the TUI dialog writes when no
 * adjacent config exists): the opencode config folder. */
export function configHomePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), CONFIG_NAME)
}

export type WriteCandidate = { path: string; label: string; always?: boolean }

/** Write-target candidates for the TUI picker: the global settings home
 * (always writable) plus every OTHER file in the read chain that already
 * exists on disk (deploy-time overrides are never created from the TUI —
 * owner rule). Order: global first (default), then the rest by read
 * precedence (highest first). */
export function writeCandidates(pluginDir: string, env: NodeJS.ProcessEnv = process.env): WriteCandidate[] {
  const candidates: WriteCandidate[] = [{ path: configHomePath(env), label: "global settings (~/.config/opencode)", always: true }]
  const labels: Array<[string, string]> = [
    [join(pluginDir, CONFIG_NAME), "plugin folder (adjacent template)"],
    [join(packageRoot(pluginDir), CONFIG_NAME), "package root"],
  ]
  let current = pluginDir
  for (let i = 0; i < 5; i++) {
    labels.push([join(current, LOCAL_NAME), `local override (${relative(process.cwd(), join(current, LOCAL_NAME)) || join(current, LOCAL_NAME)})`])
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const [path, label] of labels) {
    if (path === candidates[0].path) continue
    if (existsSync(path)) candidates.push({ path, label })
  }
  return candidates
}

/** Per-key source attribution mirroring loadConfig precedence exactly
 * (env > adjacent > package root > local walks > global > default).
 * Values of "" count as unset for the credential/path keys. */
export function configSourceMap(pluginDir: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const emptyMeansUnset = new Set(["workerUrl", "createToken", "urlFile", "spoolDir"])
  const known = new Set([...(Object.keys(DEFAULTS) as string[]), "shareMode", "servers"])
  const sources: Record<string, string> = {}
  const envKeys: Record<string, string | undefined> = {
    workerUrl: env.OPENSHARE_WORKER_URL,
    createToken: env.OPENSHARE_CREATE_TOKEN,
    debounceMs: env.OPENSHARE_DEBOUNCE_MS,
    completedDelayMs: env.OPENSHARE_COMPLETED_DELAY_MS,
    modelLabel: env.OPENSHARE_MODEL_LABEL,
    ttlHours: env.OPENSHARE_TTL_HOURS,
    ttlDays: env.OPENSHARE_TTL_DAYS,
    authLogin: env.OPENSHARE_AUTH_LOGIN,
    authPassword: env.OPENSHARE_AUTH_PASSWORD,
    urlFile: env.OPENSHARE_URL_FILE,
    urlFileFormat: env.OPENSHARE_URL_FILE_FORMAT,
    configSet: env.OPENSHARE_CONFIG_SET,
    spoolDir: env.OPENSHARE_SPOOL_DIR,
    announceStderr: env.OPENSHARE_ANNOUNCE_STDERR,
    shareMode: env.OPENSHARE_SHARE_MODE,
  }
  for (const [key, value] of Object.entries(envKeys)) {
    if (value !== undefined && value !== "") sources[key] = "environment"
  }
  // legacy days-shaped env feeds the same knob as ttlHours
  if (sources.ttlDays && !sources.ttlHours) sources.ttlHours = sources.ttlDays
  delete sources.ttlDays
  // OPENSHARE_CONFIG_JSON sits between env and the files: it loses only
  // to a specific env var, so it overrides any file's key
  if (env.OPENSHARE_CONFIG_JSON) {
    try {
      const raw = JSON.parse(env.OPENSHARE_CONFIG_JSON)
      if (raw && typeof raw === "object") {
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue
          if (sources[key] === "environment") continue
          if (key === "servers" || known.has(key)) sources[key] = "OPENSHARE_CONFIG_JSON"
        }
      }
    } catch {}
  }
  // configPaths() is ordered lowest-priority-first? No: index 0 is the
  // ADJACENT file (highest). Merge order reverses it; attribution walks
  // it as-is so the first hit is the winning (highest) source.
  for (const path of configPaths(pluginDir, env)) {
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(readFileSync(path, "utf8"))
      if (!raw || typeof raw !== "object") continue
    } catch {
      continue
    }
    const label = basename(path) === LOCAL_NAME ? `openshare.local.json (${dirname(path).split(/[\\/]/).pop()})` : `${basename(path)} (${dirname(path).split(/[\\/]/).pop()})`
    for (const [key, value] of Object.entries(raw)) {
      if (key === "servers") {
        if (sources.servers === undefined && normalizeServers(value)) sources.servers = label
        continue
      }
      if (sources[key] !== undefined || !known.has(key)) continue
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue
      if (typeof value === "string" && value === "" && emptyMeansUnset.has(key)) continue
      sources[key] = label
    }
  }
  return sources
}

function num(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/** Sanitized `servers` group from raw config JSON (invalid entries
 * dropped; url keys kept verbatim). */
export function normalizeServers(raw: unknown): Record<string, ServerEntry> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const out: Record<string, ServerEntry> = {}
  for (const [url, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!url.startsWith("http") || !value || typeof value !== "object") continue
    const e = value as Record<string, unknown>
    const entry: ServerEntry = {}
    if (typeof e.token === "string" && e.token) entry.token = e.token
    if (typeof e.code === "string" && e.code) entry.code = e.code
    if (typeof e.label === "string" && e.label) entry.label = e.label
    if (typeof e.adminToken === "string" && e.adminToken) entry.adminToken = e.adminToken
    if (e.active === true) entry.active = true
    if (e.anonymous === true) entry.anonymous = true
    out[url] = entry
  }
  return Object.keys(out).length ? out : undefined
}

/** Field-level merge of servers groups: entries only carry present fields
 * (normalizeServers), so a static `code` in plugin options and a persisted
 * `token` in the settings home combine instead of shadowing — per-URL
 * wholesale replacement would re-enroll on every boot (live-caught in
 * suite design review). */
export function mergeServerGroups(base: Record<string, ServerEntry> | undefined, add: Record<string, ServerEntry>): Record<string, ServerEntry> {
  const merged: Record<string, ServerEntry> = { ...(base ?? {}) }
  for (const [url, entry] of Object.entries(add)) merged[url] = { ...(merged[url] ?? {}), ...entry }
  return merged
}

/** The server new sessions share to: the `active` entry (or the first).
 * Legacy workerUrl/createToken merge in as the implicit first entry — with
 * the root token ALSO filed as adminToken (the createToken IS root; filing
 * it only as `token` made the TUI offer user-actions like rotate to a root
 * holder — live-caught "can either be admin or user but not both"). */
export function resolveServer(cfg: ShareConfig): { url: string; token: string; entry: ServerEntry } | undefined {
  const servers: Record<string, ServerEntry> = {}
  if (cfg.workerUrl) servers[cfg.workerUrl] = { token: cfg.createToken || "", adminToken: cfg.createToken || "", active: true }
  if (cfg.servers) for (const [url, entry] of Object.entries(cfg.servers)) servers[url] = entry
  const urls = Object.keys(servers)
  if (!urls.length) return undefined
  const url = urls.find((u) => servers[u].active) ?? urls[0]
  return { url, token: servers[url].token ?? "", entry: servers[url] }
}

/** Persist a field patch for a server entry into the settings-home
 * config's `servers` group — surgical merge (never rewrites other keys,
 * never touches deploy-time files). */
export function saveServerEntry(url: string, patch: Partial<ServerEntry>, target?: string): string | undefined {
  const path = target ?? configHomePath()
  if (!path || !url.startsWith("http")) return undefined
  try {
    let previous: Record<string, unknown> = {}
    try {
      previous = JSON.parse(readFileSync(path, "utf8"))
      if (!previous || typeof previous !== "object") previous = {}
    } catch {}
    const servers = normalizeServers(previous.servers) ?? {}
    servers[url] = { ...servers[url], ...patch }
    previous.servers = servers
    writeFileSync(path, JSON.stringify(previous, null, 2) + "\n")
    return path
  } catch {
    return undefined
  }
}

/** Token persistence (engine enrollment) — entry-patch special case. */
export function saveServerToken(url: string, token: string, target?: string): string | undefined {
  return saveServerEntry(url, { token }, target)
}

/** Remove a server membership from the settings home (per-field merge
 * means entries born in plugin options/env survive — that's the override
 * owner's business, shown by the sources view). */
export function deleteServerEntry(url: string, target?: string): string | undefined {
  const path = target ?? configHomePath()
  if (!path) return undefined
  try {
    let previous: Record<string, unknown> = {}
    try {
      previous = JSON.parse(readFileSync(path, "utf8"))
      if (!previous || typeof previous !== "object") previous = {}
    } catch {}
    const servers = normalizeServers(previous.servers) ?? {}
    delete servers[url]
    previous.servers = servers
    writeFileSync(path, JSON.stringify(previous, null, 2) + "\n")
    return path
  } catch {
    return undefined
  }
}

/** Load the effective config. `options` is the plugin-array options tuple
 * object (env still wins over it). Files MERGE lowest→highest priority
 * (later files override per key); empty strings in credential/path keys
 * mean "unset" — a shipped template with blank workerUrl/createToken
 * never shadows the real config elsewhere. */
export function loadConfig(pluginDir: string, options?: Record<string, unknown>): ShareConfig {
  const cfg: ShareConfig = { ...DEFAULTS }

  const emptyMeansUnset = new Set(["workerUrl", "createToken", "urlFile", "spoolDir"])
  const known = new Set([...(Object.keys(DEFAULTS) as string[]), "shareMode"])
  const applyObject = (raw: unknown) => {
    if (!raw || typeof raw !== "object") return
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (key === "servers") {
        const servers = normalizeServers(value)
        if (servers) cfg.servers = mergeServerGroups(cfg.servers, servers)
        continue
      }
      if (key === "scope") {
        if (value && typeof value === "object") {
          const sc = value as Record<string, unknown>
          const scope: ShareScope = {}
          const ft = Math.floor(Number(sc.fromTurn))
          if (Number.isFinite(ft) && ft > 1) scope.fromTurn = ft
          for (const k of ["reasoning", "tools", "subagents", "fileContents"] as const) {
            if (typeof sc[k] === "boolean") scope[k] = sc[k] as boolean
          }
          if (Object.keys(scope).length) cfg.scope = scope
        }
        continue
      }
      if (key === "redact") {
        if (value && typeof value === "object" && Array.isArray((value as { patterns?: unknown }).patterns)) {
          const pats = (value as { patterns: unknown[] }).patterns.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length < 500).slice(0, 50)
          cfg.redact = { patterns: pats }
        }
        continue
      }
      if (key === "meta") {
        // string-to-string only: meta rides the create frame verbatim
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const clean: Record<string, string> = {}
          for (const [mk, mv] of Object.entries(value as Record<string, unknown>)) {
            if (typeof mv === "string" && mv.length <= 500 && mk.length <= 64) clean[mk] = mv
          }
          if (Object.keys(clean).length) cfg.meta = { ...cfg.meta, ...clean }
        }
        continue
      }
      if (key === "ttlDays") {
        // legacy days-shaped file/options value converts to hours once
        const d = Math.floor(Number(value))
        if (Number.isFinite(d) && d > 0) cfg.ttlHours = d * 24
        continue
      }
      if (!known.has(key)) continue
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue
      if (typeof value === "string" && value === "" && emptyMeansUnset.has(key)) continue
      ;(cfg as Record<string, unknown>)[key] = value
    }
  }

  for (const path of [...configPaths(pluginDir)].reverse()) {
    try {
      // strict JSON: the $comment key (what our templates use) is valid
      // JSON; comment-stripping is deliberately avoided because a naive
      // stripper eats "//" inside workerUrl values
      applyObject(JSON.parse(readFileSync(path, "utf8")))
    } catch (e) {
      // a malformed config file is a real setup error the user must hear
      // about - silence here looks like "no share server configured".
      // (Absent files are normal chain candidates - only broken content
      // is worth a line.)
      if (existsSync(path)) console.error(`[openshare] config file ${path} could not be parsed - ignored:`, (e as Error)?.message ?? e)
    }
  }

  if (options && typeof options === "object") {
    const serversOpt = normalizeServers((options as Record<string, unknown>).servers)
    if (serversOpt) cfg.servers = mergeServerGroups(cfg.servers, serversOpt)
    for (const key of Object.keys(DEFAULTS) as Array<keyof ShareConfig>) {
      const value = options[key]
      if (value === undefined || value === null) continue
      if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
        ;(cfg as Record<string, unknown>)[key] = value
      }
    }
    const mode = str(options.shareMode)
    if (mode === "all" || mode === "manual") cfg.shareMode = mode
  }

  const env = process.env
  // OPENSHARE_CONFIG_JSON: a complete config object in one env var. Sits
  // between the file/options layers and the per-key OPENSHARE_* env (a
  // specific env var still wins) - CI sets one variable instead of nine,
  // and secrets never touch a file. Malformed JSON is a loud error, not
  // silence (same rule as files).
  if (env.OPENSHARE_CONFIG_JSON) {
    try {
      applyObject(JSON.parse(env.OPENSHARE_CONFIG_JSON))
    } catch (e) {
      console.error("[openshare] OPENSHARE_CONFIG_JSON could not be parsed - ignored:", (e as Error)?.message ?? e)
    }
  }
  if (env.OPENSHARE_WORKER_URL) cfg.workerUrl = env.OPENSHARE_WORKER_URL
  if (env.OPENSHARE_CREATE_TOKEN) cfg.createToken = env.OPENSHARE_CREATE_TOKEN
  if (env.OPENSHARE_DEBOUNCE_MS) cfg.debounceMs = num(env.OPENSHARE_DEBOUNCE_MS, cfg.debounceMs)
  if (env.OPENSHARE_COMPLETED_DELAY_MS !== undefined) cfg.completedDelayMs = num(env.OPENSHARE_COMPLETED_DELAY_MS, cfg.completedDelayMs)
  if (env.OPENSHARE_MODEL_LABEL !== undefined) cfg.modelLabel = env.OPENSHARE_MODEL_LABEL
  if (env.OPENSHARE_TTL_HOURS) cfg.ttlHours = num(env.OPENSHARE_TTL_HOURS, cfg.ttlHours)
  if (env.OPENSHARE_TTL_DAYS) cfg.ttlHours = Math.max(1, Math.floor(num(env.OPENSHARE_TTL_DAYS, 90) * 24))
  if (env.OPENSHARE_AUTH_LOGIN !== undefined) cfg.authLogin = env.OPENSHARE_AUTH_LOGIN
  if (env.OPENSHARE_AUTH_PASSWORD !== undefined) cfg.authPassword = env.OPENSHARE_AUTH_PASSWORD
  if (env.OPENSHARE_URL_FILE !== undefined) cfg.urlFile = env.OPENSHARE_URL_FILE
  if (env.OPENSHARE_URL_FILE_FORMAT === "json" || env.OPENSHARE_URL_FILE_FORMAT === "url") cfg.urlFileFormat = env.OPENSHARE_URL_FILE_FORMAT
  if (env.OPENSHARE_CONFIG_SET) cfg.configSet = env.OPENSHARE_CONFIG_SET
  if (env.OPENSHARE_SPOOL_DIR) cfg.spoolDir = env.OPENSHARE_SPOOL_DIR
  if (env.OPENSHARE_ANNOUNCE_STDERR !== undefined) cfg.announceStderr = !/^(0|false|no|off)$/i.test(env.OPENSHARE_ANNOUNCE_STDERR.trim())
  if (env.OPENSHARE_SHARE_MODE === "all" || env.OPENSHARE_SHARE_MODE === "manual") cfg.shareMode = env.OPENSHARE_SHARE_MODE

  // normalize the disable sentinel (case-insensitive from any source)
  if (cfg.urlFile.trim().toLowerCase() === URL_FILE_NONE) cfg.urlFile = URL_FILE_NONE

  // URL hygiene: a trailing slash on a server url becomes
  // wss://host//api/ws and https://host//s/<id> downstream - strip once,
  // at the source, so every consumer agrees
  if (cfg.workerUrl) cfg.workerUrl = cfg.workerUrl.trim().replace(/\/+$/, "")
  if (cfg.servers) {
    const fixed: Record<string, ServerEntry> = {}
    for (const [u, e] of Object.entries(cfg.servers)) fixed[u.trim().replace(/\/+$/, "")] = e
    cfg.servers = fixed
  }

  return cfg
}

export function spoolDirFor(cfg: ShareConfig): string {
  if (cfg.spoolDir) return cfg.spoolDir
  const base =
    process.env.XDG_DATA_HOME || (process.env.HOME ? join(process.env.HOME, ".local", "share") : "/tmp")
  return join(base, "opencode", "openshare")
}

// ---------------------------------------------------------------------------
// TUI presence detection (read-only)
// ---------------------------------------------------------------------------

const NPM_NAME = "@mirrowel/opencode-openshare"

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

function specPath(spec: string): string | undefined {
  if (!spec.startsWith("file:")) return undefined
  try {
    let url = spec
    if (!url.startsWith("file:///") && url.startsWith("file://")) url = `file:///${url.slice("file://".length)}`
    return normalizePath(new URL(url).pathname)
  } catch {
    return undefined
  }
}

/** Does this plugin spec (tui.json entry) point at the openshare package?
 * Accepts the bare npm name, name@version, and the /tui (or any) subpath
 * form — older docs shipped the subpath spec and presence detection must
 * never silently miss it (all-mode would keep auto-sharing while the user
 * believes they installed manual mode — live-caught in review). */
export function isOpenShareSpec(spec: unknown): spec is string {
  if (typeof spec !== "string" || spec.length === 0) return false
  if (spec === NPM_NAME) return true
  // name@version, name/tui, name@version/tui
  if (spec.startsWith(`${NPM_NAME}@`) || spec.startsWith(`${NPM_NAME}/`)) return true
  const path = specPath(spec)
  if (path) {
    if (path.endsWith("/opencode-openshare") || path.endsWith("/share-plugin")) return true
    return path.includes("/opencode-openshare/") || path.includes("/share-plugin/")
  }
  const normalized = normalizePath(spec)
  if (/^[a-z]:\//.test(normalized) || normalized.startsWith("/")) {
    if (normalized.endsWith("/opencode-openshare") || normalized.endsWith("/share-plugin")) return true
    return normalized.includes("/opencode-openshare/") || normalized.includes("/share-plugin/")
  }
  return false
}

function readJson(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {}
    const data = JSON.parse(readFileSync(path, "utf8"))
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function specStrings(data: Record<string, unknown>): string[] {
  const result: string[] = []
  for (const key of ["plugin", "plugins"] as const) {
    const array = data[key]
    if (!Array.isArray(array)) continue
    for (const entry of array) {
      const spec =
        typeof entry === "string"
          ? entry
          : Array.isArray(entry) && typeof entry[0] === "string"
            ? (entry[0] as string)
            : entry && typeof entry === "object" && typeof (entry as { package?: unknown }).package === "string"
              ? (entry as { package: string }).package
              : undefined
      if (spec !== undefined) result.push(spec)
    }
  }
  return result
}

function globalConfigDir(env: NodeJS.ProcessEnv): string {
  if (env["OPENCODE_CONFIG_DIR"]) return env["OPENCODE_CONFIG_DIR"]
  if (env["XDG_CONFIG_HOME"]) return join(env["XDG_CONFIG_HOME"], "opencode")
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ""
  return join(home, ".config", "opencode")
}

/** tui.json layers the TUI reads (mirrors the family selfwire path rules,
 * read-only). The walk runs from the session directory up to the worktree
 * root when the host reports a sane worktree; hosts have been observed to
 * report "/" for non-git dirs — in that case walk to the filesystem root. */
export function tuiLayerPaths(input: { directory?: string; worktree?: string; env?: NodeJS.ProcessEnv }): string[] {
  const env = input.env ?? process.env
  const paths: string[] = []
  const globalTui = join(globalConfigDir(env), "tui.json")
  if (existsSync(globalTui)) paths.push(globalTui)
  const envTui = env["OPENCODE_TUI_CONFIG"]
  if (envTui && existsSync(envTui)) paths.push(envTui)
  if (input.directory) {
    const dir = normalizePath(input.directory)
    const worktree = input.worktree ? normalizePath(input.worktree) : undefined
    const sane =
      worktree !== undefined &&
      worktree !== "/" &&
      !/^[a-z]:\/$/.test(worktree) &&
      (dir === worktree || dir.startsWith(`${worktree}/`))
    let current: string | undefined = dir
    for (let guard = 0; guard < 64 && current; guard++) {
      for (const name of ["tui.json", ".opencode/tui.json"]) {
        const candidate = `${current}/${name}`
        if (existsSync(candidate) && !paths.includes(candidate)) paths.push(candidate)
      }
      if (sane && current === worktree) break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return paths
}

/** True when an openshare TUI part is registered in any tui.json layer. */
export function detectTuiPresence(input: { directory?: string; worktree?: string; env?: NodeJS.ProcessEnv }): boolean {
  try {
    for (const layer of tuiLayerPaths(input)) {
      if (specStrings(readJson(layer)).some((spec) => isOpenShareSpec(spec))) return true
    }
  } catch {}
  return false
}

/** Resolve the effective share mode: explicit config wins, else presence. */
export function resolveShareMode(cfg: ShareConfig, input: { directory?: string; worktree?: string; env?: NodeJS.ProcessEnv }): ShareMode {
  if (cfg.shareMode === "all" || cfg.shareMode === "manual") return cfg.shareMode
  return detectTuiPresence(input) ? "manual" : "all"
}
