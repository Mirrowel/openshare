// Three-tier share-settings resolution: general (top-level config keys) <
// per-server (servers{url}.overrides) < per-share (the shares{sid} config
// section — authoritative — over the session-binding opts mirror).
//
// Every resolved key carries its provenance so surfaces can show WHERE a
// value comes from (inherited tiers display dimmed; the TUI also layers
// server policy caps on top for TTL). Auth resolves as a pair-unit: a
// tier contributes a gate only when BOTH login and password are set —
// mixing one tier's login with another's password would display a gate
// the server never builds.

import { liveShares, type ShareConfig, type ShareOverrides } from "./config.js"

/** Mirror shape (superset is fine — only share-facing keys are read). */
export type ShareMirror = { ttlHours?: number; authLogin?: string; authPassword?: string; title?: string; paused?: boolean }

export type SettingProvenance = "general" | "server" | "share"

export type Provenanced<T> = { value: T; source: SettingProvenance }

export type ResolvedShareSettings = {
  /** Effective TTL in hours; undefined = no tier sets one (server default). */
  ttlHours?: Provenanced<number>
  /** Full read-gate pair; undefined = no gate anywhere. */
  auth?: Provenanced<{ login: string; password: string }>
  /** Sticky custom title (per-share tier only); undefined = live session title. */
  title?: Provenanced<string>
  /** Pause flag (per-share tier only). */
  paused?: Provenanced<boolean>
  /** Some tier carries exactly one auth half: the server builds gates from
   * full pairs only, so the tier silently means "no gate" — surfaces a
   * warning instead of a mystery. */
  authHalfPair?: boolean
}

/** Structural inputs so the resolver stays a leaf: callers pass the
 * general tier values, the server entry's overrides, the config's
 * per-share section entry, and the binding mirror. */
export type ShareSettingsInput = {
  general: { ttlHours?: number; authLogin?: string; authPassword?: string }
  server?: ShareOverrides
  share?: ShareOverrides
  mirror?: ShareMirror
}

type AuthTier = { login: string; password: string }

function pairFrom(tier: { authLogin?: string; authPassword?: string } | undefined): AuthTier | undefined {
  if (!tier) return undefined
  const login = tier.authLogin ?? ""
  const password = tier.authPassword ?? ""
  return login !== "" && password !== "" ? { login, password } : undefined
}

function ttlFrom(tier: { ttlHours?: number } | undefined): number | undefined {
  const h = tier?.ttlHours
  return typeof h === "number" && Number.isFinite(h) && h > 0 ? Math.floor(h) : undefined
}

/** Deep-merge the tiers with provenance. The share tier is the config
 * entry merged OVER the binding mirror (config is authoritative; the
 * mirror keeps the resolved state with the session). */
export function resolveShareSettings(input: ShareSettingsInput): ResolvedShareSettings {
  const share: ShareOverrides = { ...(input.mirror ?? {}), ...(input.share ?? {}) }
  const out: ResolvedShareSettings = {}

  const ttl = ttlFrom(share) ?? ttlFrom(input.server) ?? ttlFrom(input.general)
  if (ttl !== undefined) {
    out.ttlHours = { value: ttl, source: ttlFrom(share) !== undefined ? "share" : ttlFrom(input.server) !== undefined ? "server" : "general" }
  }

  const auth = pairFrom(share) ?? pairFrom(input.server) ?? pairFrom(input.general)
  if (auth) {
    out.auth = { value: auth, source: pairFrom(share) !== undefined ? "share" : pairFrom(input.server) !== undefined ? "server" : "general" }
  } else if ([share, input.server, input.general].some((t) => t && ((t.authLogin ?? "") !== "" || (t.authPassword ?? "") !== ""))) {
    out.authHalfPair = true
  }

  if (typeof share.title === "string" && share.title !== "") out.title = { value: share.title, source: "share" }
  if (share.paused === true) out.paused = { value: true, source: "share" }

  return out
}

/** Convenience wrapper over a loaded config. `mirror` is the session
 * binding's opts (the runtime channel the TUI writes through). The
 * per-share tier merges the config snapshot UNDER a live settings-home
 * read so TUI writes and clears apply immediately. */
export function resolveFor(
  cfg: ShareConfig,
  serverUrl: string | undefined,
  sessionID: string | undefined,
  mirror?: ShareMirror,
): ResolvedShareSettings {
  const live = sessionID ? liveShares()[sessionID] : undefined
  return resolveShareSettings({
    general: { ttlHours: cfg.ttlHours, authLogin: cfg.authLogin, authPassword: cfg.authPassword },
    server: serverUrl ? cfg.servers?.[serverUrl]?.overrides : undefined,
    share: sessionID ? { ...(cfg.shares?.[sessionID] ?? {}), ...(live ?? {}) } : undefined,
    mirror,
  })
}
