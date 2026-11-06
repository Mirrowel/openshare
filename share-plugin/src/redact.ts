/**
 * Client-only redaction + light path transform (Wave 3 trust).
 *
 * Owner verdict: the server stays dumb - the client controls what leaves
 * the machine. This pass runs once at enqueue (the single choke point
 * every item crosses before any transport) on UNGATED shares only: a
 * share with login+pass is private from casual observers already, and
 * redacting there would corrupt content the server owner can see anyway
 * (documented caveat: NOT private from the server owner until Wave 3b
 * encryption lands).
 *
 * Extending: add a detector to BUILTINS (fork-friendly registry) or set
 * `redact.patterns` in the config (regex source strings, global flag).
 */

/** A detector: stable `kind` names the marker, e.g. `[redacted:aws-key]`. */
export type RedactRule = { kind: string; re: RegExp }

export const BUILTINS: RedactRule[] = [
  { kind: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "gh-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { kind: "gh-token", re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { kind: "api-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
  // PEM private-key blocks (whole block)
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // .env style assignments for secret-shaped names
  { kind: "env-secret", re: /(?<![A-Za-z0-9_])(?:export\s+)?[A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?)[A-Z0-9_]*\s*=\s*\S+/g },
  // URL connection strings with embedded passwords (password masked)
  { kind: "conn-string", re: /\b[a-z][a-z0-9+.-]*:\/\/[^:@/\s"']+:[^@/\s"']{4,}@/gi },
]

/** Config-supplied rules (regex source strings, applied globally). */
function compile(patterns: unknown): RedactRule[] {
  if (!Array.isArray(patterns)) return []
  const out: RedactRule[] = []
  for (const p of patterns) {
    if (typeof p !== "string" || !p) continue
    try {
      out.push({ kind: "user", re: new RegExp(p, "g") })
    } catch {
      // a broken user regex must never kill sharing - skip it
    }
  }
  return out
}

export type RedactionHit = { kind: string; sample: string }

/** Home-directory prefix -> `~`; applied consistently to session.directory
 * AND tool path fields so viewer-side relativization still works (both
 * ends share the ~-prefixed form). */
export function tildePath(p: string, home: string): string {
  if (!p || !home || p.length <= home.length) return p
  const norm = (s: string) => s.replace(/[\\/]+/g, "/").replace(/\/$/, "")
  const np = norm(p)
  const nh = norm(home)
  if (np === nh) return "~"
  if (np.startsWith(nh + "/")) return "~" + np.slice(nh.length)
  return p
}

const PATH_KEYS = new Set(["file", "path", "filePath", "cwd", "directory", "root"])

type Opts = { rules: RedactRule[]; home: string; enabled: boolean }
type Stats = { hits: RedactionHit[]; changed: boolean }

/**
 * Apply redaction (when enabled) + the light path transform to one
 * contract item. Returns the ORIGINAL untouched when nothing matched
 * (zero-copy fast path for clean sessions); otherwise a mutated deep
 * clone - the host's live object is never touched.
 */
export function redactItem(item: unknown, opts: Opts): { item: unknown; hits: RedactionHit[] } {
  const flat = JSON.stringify(item) ?? "null"
  const needRedact = opts.enabled && opts.rules.some((r) => { r.re.lastIndex = 0; return r.re.test(flat) })
  const needPaths = !!opts.home && flat.includes(opts.home)
  if (!needRedact && !needPaths) return { item, hits: [] }
  const clone = JSON.parse(flat) as unknown
  const stats: Stats = { hits: [], changed: false }
  walk(clone, opts, stats)
  return { item: clone, hits: stats.hits }
}

function walk(node: unknown, opts: Opts, stats: Stats, key?: string): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i]
      if (typeof v === "string") node[i] = applyString(v, opts, stats, key)
      else walk(v, opts, stats, key)
    }
    return
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (typeof v === "string") (node as Record<string, unknown>)[k] = applyString(v, opts, stats, k)
      else walk(v, opts, stats, k)
    }
  }
}

function applyString(v: string, opts: Opts, stats: Stats, key?: string): string {
  let out = v
  if (opts.enabled) {
    for (const r of opts.rules) {
      r.re.lastIndex = 0
      out = out.replace(r.re, (full) => {
        if (stats.hits.length < 8 && !stats.hits.some((h) => h.kind === r.kind)) {
          stats.hits.push({ kind: r.kind, sample: full.slice(0, 60) })
        }
        stats.changed = true
        if (r.kind === "conn-string") {
          // keep scheme://user, mask the password, keep @host
          const at = full.lastIndexOf("@")
          const colon = full.indexOf(":", full.indexOf("://") + 3) + 1
          if (at > colon && colon > 0) return full.slice(0, colon) + "[redacted:conn-string]" + full.slice(at)
        }
        return `[redacted:${r.kind}]`
      })
    }
  }
  if (key && PATH_KEYS.has(key) && opts.home && out.includes(opts.home)) {
    out = tildePath(out, opts.home)
    stats.changed = true
  }
  return out
}

/** All active rules (built-ins + compiled user patterns). */
export function activeRules(userPatterns: unknown): RedactRule[] {
  return [...BUILTINS, ...compile(userPatterns)]
}
