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

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export type ShareMode = "all" | "manual"

export type ShareConfig = {
  workerUrl: string
  createToken: string
  debounceMs: number
  completedDelayMs: number
  modelLabel: string
  ttlDays: number
  openTasksInNewTab: boolean
  authLogin: string
  authPassword: string
  spoolDir: string
  urlFile: string
  shareMode?: ShareMode
}

export const METADATA_KEY = "openshare"

export const DEFAULTS: ShareConfig = {
  workerUrl: "", // empty = plugin disabled until configured
  createToken: "",
  debounceMs: 10000,
  // opencode goes genuinely idle between sequential prompts (automation
  // workflows); flipping the share to "completed" on the first idle is
  // misleading mid-workflow. Idle must PERSIST this long before the
  // share says completed; a busy signal cancels it. 0 = immediate
  // (legacy behavior). Process exit (dispose) flushes the pending
  // completed status immediately, so `opencode run` CI shares still land
  // their final status.
  completedDelayMs: 20000,
  modelLabel: "$Provider/$Model",
  ttlDays: 90,
  openTasksInNewTab: true,
  authLogin: "",
  authPassword: "",
  spoolDir: "",
  urlFile: "",
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

function num(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
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
  for (const path of [...configPaths(pluginDir)].reverse()) {
    try {
      // strict JSON: the $comment key (what our templates use) is valid
      // JSON; comment-stripping is deliberately avoided because a naive
      // stripper eats "//" inside workerUrl values
      const raw = JSON.parse(readFileSync(path, "utf8"))
      if (!raw || typeof raw !== "object") continue
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!known.has(key)) continue
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue
        if (typeof value === "string" && value === "" && emptyMeansUnset.has(key)) continue
        ;(cfg as Record<string, unknown>)[key] = value
      }
    } catch {}
  }

  if (options && typeof options === "object") {
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
  if (env.OPENSHARE_WORKER_URL) cfg.workerUrl = env.OPENSHARE_WORKER_URL
  if (env.OPENSHARE_CREATE_TOKEN) cfg.createToken = env.OPENSHARE_CREATE_TOKEN
  if (env.OPENSHARE_DEBOUNCE_MS) cfg.debounceMs = num(env.OPENSHARE_DEBOUNCE_MS, cfg.debounceMs)
  if (env.OPENSHARE_COMPLETED_DELAY_MS !== undefined) cfg.completedDelayMs = num(env.OPENSHARE_COMPLETED_DELAY_MS, cfg.completedDelayMs)
  if (env.OPENSHARE_MODEL_LABEL !== undefined) cfg.modelLabel = env.OPENSHARE_MODEL_LABEL
  if (env.OPENSHARE_TTL_DAYS) cfg.ttlDays = num(env.OPENSHARE_TTL_DAYS, cfg.ttlDays)
  if (env.OPENSHARE_AUTH_LOGIN !== undefined) cfg.authLogin = env.OPENSHARE_AUTH_LOGIN
  if (env.OPENSHARE_AUTH_PASSWORD !== undefined) cfg.authPassword = env.OPENSHARE_AUTH_PASSWORD
  if (env.OPENSHARE_URL_FILE) cfg.urlFile = env.OPENSHARE_URL_FILE
  if (env.OPENSHARE_SPOOL_DIR) cfg.spoolDir = env.OPENSHARE_SPOOL_DIR
  if (env.OPENSHARE_SHARE_MODE === "all" || env.OPENSHARE_SHARE_MODE === "manual") cfg.shareMode = env.OPENSHARE_SHARE_MODE

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

/** Does this plugin spec (tui.json entry) point at the openshare package? */
export function isOpenShareSpec(spec: unknown): spec is string {
  if (typeof spec !== "string" || spec.length === 0) return false
  if (spec === NPM_NAME || spec.startsWith(`${NPM_NAME}@`)) return true
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
