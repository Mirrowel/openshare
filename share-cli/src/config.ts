/** Profile store: named servers (url + credential) in
 *  ~/.config/openshare/cli.json (override: OPENSHARE_CLI_CONFIG). The
 *  "stateful" half of the console - the token lives here, not in every
 *  curl invocation. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export type ServerEntry = { url: string; token: string; label?: string; kind?: string }
export type CliConfig = { current?: string; servers: Record<string, ServerEntry> }

export function configPath(): string {
  return process.env.OPENSHARE_CLI_CONFIG ?? path.join(homedir(), ".config", "openshare", "cli.json")
}

export function load(): CliConfig {
  const p = configPath()
  if (!existsSync(p)) return { servers: {} }
  try {
    const c = JSON.parse(readFileSync(p, "utf8"))
    if (c && typeof c === "object" && c.servers && typeof c.servers === "object") return c
  } catch { /* corrupt file = fresh state; never crash the console */ }
  return { servers: {} }
}

export function save(c: CliConfig): void {
  const p = configPath()
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(c, null, 2) + "\n")
}

export function current(c: CliConfig): { name: string; entry: ServerEntry } | null {
  const names = Object.keys(c.servers)
  if (!names.length) return null
  const name = c.current && c.servers[c.current] ? c.current : names[0]
  return { name, entry: c.servers[name] }
}

export function setToken(c: CliConfig, name: string, token: string, kind?: string): void {
  if (c.servers[name]) {
    c.servers[name].token = token
    if (kind) c.servers[name].kind = kind
  }
}
