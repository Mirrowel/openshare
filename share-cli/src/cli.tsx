/** Headless command surface: every TUI action has a one-line equivalent
 *  here for scripts and agents. Output is human by default, --json for
 *  machines; exit 0 on ok, 1 on any failure. */
import { Api } from "./api"
import * as cfg from "./config"

type Args = { pos: string[]; flags: Record<string, string | boolean> }

function parse(argv: string[]): Args {
  const pos: string[] = []
  const flags: Record<string, string | boolean> = {}
  const valueFlags = new Set(["code", "token", "label", "name", "secret", "login", "pass", "user", "kind", "id", "ttl-hours", "max-shares", "max-ttl-hours", "daily-creates", "activations", "meta", "set", "o", "since", "url", "mode", "limit", "sort", "expires-in-minutes", "expires-in-hours", "expires-in-days"])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) { pos.push(a); continue }
    const key = a.slice(2)
    if (valueFlags.has(key)) { flags[key] = argv[++i] ?? "" } else flags[key] = true
  }
  return { pos, flags }
}

const str = (f: Record<string, string | boolean>, k: string): string | undefined => (typeof f[k] === "string" ? (f[k] as string) : undefined)
const num = (s: string | undefined): number | undefined => { const n = Number(s); return s !== undefined && Number.isFinite(n) ? n : undefined }
const fail = (msg: string): never => { console.error(`error: ${msg}`); process.exit(1) }

function out(flags: Record<string, string | boolean>, data: unknown, human: string): void {
  if (flags.json) console.log(JSON.stringify(data, null, 2))
  else console.log(human)
}

type Cur = { api: Api; name: string; kind?: string }

function client(): Cur {
  const c = cfg.load()
  const cur = cfg.current(c)
  if (!cur) fail("no server configured - run: osh login <url>")
  const e = cur as { name: string; entry: cfg.ServerEntry }
  return { api: new Api({ url: e.entry.url, token: e.entry.token }), name: e.name, kind: e.entry.kind }
}

async function assertOk(r: { status: number; body: any }, what: string): Promise<any> {
  if (r.status === 0 || r.status >= 400 || r.body?.ok === false) {
    fail(`${what} failed (${r.status}): ${JSON.stringify(r.body?.error ?? r.body)}`)
  }
  return r.body
}

const fmtDate = (ms?: number): string => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "-")

function rel(ms?: number): string {
  if (!ms) return "never"
  const s = Math.max(0, Date.now() - ms) / 1000
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function relFuture(ms?: number): string {
  if (!ms) return "no expiry"
  const s = (ms - Date.now()) / 1000
  if (s <= 0) return "EXPIRED"
  if (s < 3600) return `in ${Math.ceil(s / 60)}m`
  if (s < 86400) return `in ${Math.ceil(s / 3600)}h`
  return `in ${Math.ceil(s / 86400)}d`
}

type ShareRow = { id: string; sessionID?: string; ownerId?: string | null; createdAt?: number; custom?: Record<string, unknown> }
type MetaRow = { status?: string; rev?: number; summaries?: Record<string, { title: string; agent: string; parentID: string | null; model?: string }>; auth?: { set: boolean } | null; viewerSessions?: number; pluginSeen?: number; lastViewerAt?: number; expiresAt?: number; ownerId?: string | null; creatorTokenId?: string | null; frozen?: boolean }

/** Hydrate private meta for a list of shares, bounded concurrency; a
 *  denied or missing meta degrades to null (the row still lists). */
async function hydrateAll(api: Api, ids: string[], conc = 6): Promise<Map<string, MetaRow | null>> {
  const metas = new Map<string, MetaRow | null>()
  const queue = [...ids]
  const workers = Array.from({ length: Math.min(conc, queue.length) }, async () => {
    for (;;) {
      const id = queue.shift()
      if (!id) return
      try {
        const r = await api.shareMeta(id)
        metas.set(id, r.status === 200 && r.body ? r.body : null)
      } catch { metas.set(id, null) }
    }
  })
  await Promise.all(workers)
  return metas
}

type SortSpec = { key: string; desc: boolean }
function sortRows<T>(rows: T[], spec: SortSpec | null, keyOf: (r: T) => string | number | undefined): T[] {
  if (!spec) return rows
  const dir = spec.desc ? -1 : 1
  return [...rows].sort((a, b) => {
    const ka = keyOf(a); const kb = keyOf(b)
    if (ka === kb) return 0
    if (ka === undefined || ka === null) return 1
    if (kb === undefined || kb === null) return -1
    return ka > kb ? dir : -dir
  })
}

function parseSort(f: Record<string, string | boolean>, allowed: string[]): SortSpec | null {
  const s = str(f, "sort")
  if (!s) return null
  const desc = s.startsWith("-")
  const key = (desc ? s.slice(1) : s).toLowerCase()
  if (!allowed.includes(key)) fail(`--sort must be one of: ${allowed.map((a) => a + " | -" + a).join(", ")} (prefix - for descending)`)
  return { key, desc }
}

async function sharesLs(api: Api, flags: Record<string, string | boolean>): Promise<number> {
  const admin = await api.sharesAdmin()
  let rows: ShareRow[] = []
  let scope = "own"
  if (admin.status === 200 && admin.body?.ok) {
    rows = admin.body.shares ?? []
    scope = "all"
  } else {
    const mine = await assertOk(await api.meShares(), "list shares")
    rows = (mine.shares ?? []).map((s: any) => ({ id: s.id, sessionID: s.sessionID, ownerId: null, createdAt: s.createdAt }))
  }
  // owner label join (admin only; scoped/user lists keep raw/null)
  const owners = new Map<string, string>()
  if (scope === "all" && !flags["no-meta"]) {
    const users = await api.users()
    if (users.status === 200 && users.body?.ok) for (const u of users.body.users ?? []) owners.set(u.id, u.label)
  }
  // meta hydration (skippable for raw speed)
  let metas = new Map<string, MetaRow | null>()
  if (!flags["no-meta"] && rows.length) {
    const ids = rows.slice(0, 200).map((r) => r.id)
    metas = await hydrateAll(api, ids)
  }
  const mainOf = (m: MetaRow | null | undefined, row: ShareRow): string => {
    if (!m?.summaries) return ""
    const entries = Object.values(m.summaries)
    const root = entries.find((s) => !s.parentID) ?? entries[0]
    return root?.title ?? ""
  }
  const sort = parseSort(flags, ["created", "title", "status", "owner"])
  const sorted = sortRows(rows, sort, (r) => {
    const m = metas.get(r.id)
    if (sort?.key === "title") return (mainOf(m, r) || r.sessionID || "").toLowerCase()
    if (sort?.key === "status") return m?.status ?? ""
    if (sort?.key === "owner") return (owners.get(r.ownerId ?? "") ?? r.ownerId ?? "").toLowerCase()
    return -(r.createdAt ?? 0) // created sorts newest-first naturally via negation
  })
  if (sort?.key === "created" && !sort.desc) sorted.reverse()

  const json = sorted.map((r) => {
    const m = metas.get(r.id)
    const sessions: Array<{ id: string; title: string; agent: string; parentID: string | null; model?: string }> = Object.entries(m?.summaries ?? {}).map(([sid, s]) => ({ id: sid, ...(s as { title: string; agent: string; parentID: string | null; model?: string }) }))
    return {
      id: r.id, url: `${api.url}/s/${r.id}`, sessionID: r.sessionID ?? null,
      title: mainOf(m, r) || null, status: m?.status ?? null, rev: m?.rev ?? null,
      owner: owners.get(r.ownerId ?? "") ?? r.ownerId ?? null,
      gated: m?.auth?.set ?? null, frozen: m?.frozen ?? null,
      subagents: sessions.filter((s) => s.parentID).length,
      sessions: sessions.map((s) => ({ id: s.id, title: s.title, agent: s.agent, parentID: s.parentID, model: s.model ?? null })),
      viewerSessions: m?.viewerSessions ?? null, pluginSeen: m?.pluginSeen ?? null, lastViewerAt: m?.lastViewerAt ?? null,
      expiresAt: m?.expiresAt ?? null, custom: r.custom ?? null, createdAt: r.createdAt ?? null,
    }
  })
  const head = `title                        status      owner           gated  sub  created`
  const lines = json.map((j) => {
    const title = (j.title ?? j.sessionID ?? "").slice(0, 27).padEnd(28)
    const status = String(j.status ?? "?").padEnd(11)
    const owner = String(j.owner ?? "-").slice(0, 15).padEnd(15)
    const gated = j.gated === null ? "  ?   " : j.gated ? " LOCK " : "  -   "
    const sub = String(j.subagents ?? 0).padStart(3)
    const created = rel(j.createdAt ?? undefined)
    return `${title} ${status} ${owner} ${gated} ${sub}  ${created}`
  })
  out(flags, json, [`${json.length} share(s)${scope === "all" ? " (global)" : " (yours)"}${sort ? ` sorted by ${sort.key}${sort.desc ? " desc" : ""}` : ""}${flags["no-meta"] ? " (--no-meta: unhydrated)" : ""}`, head, ...lines].join("\n"))
  return 0
}

export async function runCli(argv: string[]): Promise<number> {
  const { pos, flags } = parse(argv)
  const cmd = pos[0] ?? "help"

  try {
    switch (cmd) {
      case "help": case "--help": {
        console.log(`OpenShare admin console

usage: osh [command]
no command  -> interactive TUI

servers     list configured servers
login URL   add/attach a server (--token T | --code C | anonymous), --label L, --name N
use NAME    switch the active server
remove NAME forget a server
health      worker health + version
me          who the current credential is

shares ls [--sort created|title|status|owner] [--desc] [--no-meta] [--json]
shares info ID [--since REV]        status, sessions, liveness, expiry
shares data ID [--since REV]        raw share data
shares meta ID                      the private meta document
shares rm ID --yes [--secret S]
shares patch ID --secret S [--ttl-hours N] [--login L --pass P] [--meta JSON]
shares freeze ID --yes | unfreeze ID   single-share write gate (admin)
shares auth ID --login L --pass P   viewer login (gated share)
shares snapshot ID [-o FILE]        download the offline HTML

users ls [--sort created|label]     with code lineage + counts
users new --label L | freeze ID | unfreeze ID | rm ID --yes [--mode delete]

tokens ls [--all] [--sort created|label|kind|user]
tokens new --user U [--kind scoped] [--label L] [limits] [--expires-in-minutes N | --expires-in-hours N | --expires-in-days N]
tokens self [--kind scoped] [flags as new]
tokens rotate [--label L] [limits] [expiry]
tokens update [ID] [--label L] [limits] [expiry]
tokens revoke ID | freeze-shares ID
  limits: --max-shares N --max-ttl-hours N --daily-creates N
  expiry: --expires-in-minutes/-hours/-days N (0 clears; floor 1 minute)

codes  ls                            with lineage (who onboarded)
codes  new --activations N [--label L] [--ttl-hours N] | disable ID | lineage ID --yes

settings get | put --json JSON       user defaults (root: server policy view)
purge --yes                          remove EVERY share (root)

sorting: --sort <field>, prefix - for descending (e.g. --sort -created)
global: --json anywhere for machine output`)
        return 0
      }

      case "login": {
        const url = pos[1]
        if (!url) fail("usage: osh login <url> [--token T | --code C]")
        const c = cfg.load()
        let name = str(flags, "name") ?? url.replace(/^https?:\/\//, "").split(/[./]/)[0]
        const token = str(flags, "token") ?? ""
        const code = str(flags, "code")
        const label = str(flags, "label") ?? ""
        const api = new Api({ url, token })
        let kind: string | undefined
        let savedToken = token
        if (token) {
          const me = await api.me()
          if (me.status === 0 || me.status >= 400) {
            const h = await api.health()
            if (h.status === 0) fail(`cannot reach ${url}`)
            kind = "root"
          } else kind = me.body.token?.kind ?? "full"
        } else if (code !== undefined) {
          const r = await api.enroll(code, label)
          await assertOk(r, "enroll")
          savedToken = r.body.token
          kind = r.body.tokenKind ?? "full"
          console.log(`enrolled as ${r.body.userId ?? ""} (${kind}) - token saved`)
        } else {
          const h = await api.health()
          if (h.status === 0) fail(`cannot reach ${url}`)
          kind = "anon"
          console.log("saved without a credential (anonymous) - login again with --token or --code for control")
        }
        c.servers[name] = { url, token: savedToken, kind }
        if (!c.current) c.current = name
        cfg.save(c)
        out(flags, { ok: true, server: name, kind }, `saved server "${name}" (${kind})`)
        return 0
      }

      case "servers": {
        const c = cfg.load()
        out(flags, c.servers, Object.entries(c.servers).map(([n, e]) => `${n === c.current ? "*" : " "} ${n.padEnd(18)} ${e.url}${e.kind ? `  [${e.kind}]` : ""}`).join("\n") || "(none)")
        return 0
      }

      case "use": {
        const name = pos[1] ?? fail("usage: osh use <name>")
        const c = cfg.load()
        if (!c.servers[name]) fail(`no server "${name}"`)
        c.current = name
        cfg.save(c)
        console.log(`active: ${name}`)
        return 0
      }

      case "remove": {
        const name = pos[1] ?? fail("usage: osh remove <name>")
        const c = cfg.load()
        delete c.servers[name]
        if (c.current === name) c.current = Object.keys(c.servers)[0]
        cfg.save(c)
        console.log(`removed: ${name}`)
        return 0
      }

      case "health": {
        const { api } = client()
        const r = await api.health()
        await assertOk(r, "health")
        out(flags, r.body, `${api.url}\n  version ${r.body.version ?? "?"}\n  auth: ${r.body.auth?.mode ?? "?"}\n  policy: ${JSON.stringify(r.body.policy ?? {})}`)
        return 0
      }

      case "me": {
        const { api, name } = client()
        const r = await api.me()
        if (r.status !== 0 && r.status < 400 && r.body?.ok) {
          out(flags, r.body, `server ${name}: user ${r.body.userId} (${r.body.label})\n  token: ${r.body.token?.kind} "${r.body.token?.label ?? ""}"${r.body.token?.expiresAt ? `\n  token expires: ${relFuture(r.body.token.expiresAt)}` : ""}`)
        } else {
          const c = cfg.load(); const cur = cfg.current(c)
          if (cur?.entry.kind === "root") out(flags, { ok: true, role: "root" }, `server ${name}: ROOT token (admin; not a user identity)`)
          else fail(`not logged in as a user (${r.status}): ${r.body?.error ?? ""}`)
        }
        return 0
      }

      case "shares": {
        const { api } = client()
        const sub = pos[1] ?? "ls"
        if (sub === "ls") return await sharesLs(api, flags)
        const id = pos[2] ?? fail("share id required")
        if (sub === "info") {
          const m = await api.shareMeta(id)
          if (m.status === 200 && m.body?.ok) {
            const sessions: Array<{ id: string; title: string; agent: string; parentID: string | null; model?: string }> = Object.entries(m.body.summaries ?? {}).map(([sid, s]) => ({ id: sid, ...(s as any) }))
            const root = sessions.find((s) => !s.parentID)
            const j = {
              id, url: `${api.url}/s/${id}`,
              title: root?.title ?? null, status: m.body.status, rev: m.body.rev,
              owner: m.body.ownerId ?? null, creatorTokenId: m.body.creatorTokenId ?? null,
              gated: !!m.body.auth?.set, frozen: !!m.body.frozen,
              sessions: sessions.map((s) => ({ id: s.id, title: s.title, agent: s.agent, subagent: !!s.parentID, parentID: s.parentID, model: s.model ?? null })),
              viewerSessions: m.body.viewerSessions, lastViewerAt: m.body.lastViewerAt,
              pluginSeen: m.body.pluginSeen, ttlHours: m.body.ttlHours, expiresAt: m.body.expiresAt,
            }
            const lines = [
              j.url,
              `  "${j.title ?? m.body.sessionID ?? ""}" - ${j.status} · rev ${j.rev}${j.frozen ? " · FROZEN" : ""}${j.gated ? " · gated" : ""}`,
              `  owner ${j.owner ?? "-"}${j.creatorTokenId ? ` · by token ${j.creatorTokenId}` : ""}`,
              `  expires ${j.expiresAt ? relFuture(j.expiresAt) : "never"} (${j.ttlHours}h) · plugin seen ${rel(j.pluginSeen)} · last viewer ${rel(j.lastViewerAt)} (${j.viewerSessions} session${j.viewerSessions === 1 ? "" : "s"})`,
              ...j.sessions.map((s) => `  ${s.subagent ? "  ↳ subagent" : "session"} ${s.id} "${s.title}" [${s.agent ?? "-"}]${s.model ? ` ${s.model}` : ""}`),
            ]
            out(flags, j, lines.join("\n"))
            return 0
          }
          // fall back to the public census for non-owners
          const r = await api.shareData(id)
          await assertOk(r, "share info")
          const d = r.body?.data ?? []
          const types: Record<string, number> = {}
          for (const it of d) types[it.type] = (types[it.type] ?? 0) + 1
          out(flags, { id, status: r.body.status, rev: r.body.rev, items: d.length, types, note: "private meta not available for this credential" }, `${api.url}/s/${id}\n  status ${r.body.status} · rev ${r.body.rev} · ${d.length} items (${Object.entries(types).map(([k, v]) => `${k}=${v}`).join(" ")})\n  (private meta: admin/owner only)`)
          return 0
        }
        if (sub === "meta") {
          const r = await api.shareMeta(id)
          await assertOk(r, "share meta")
          console.log(JSON.stringify(r.body, null, 2))
          return 0
        }
        if (sub === "data") {
          const r = await api.shareData(id, num(str(flags, "since")))
          await assertOk(r, "share data")
          console.log(JSON.stringify(r.body, null, 2))
          return 0
        }
        if (sub === "rm") {
          if (!flags.yes) fail("refusing without --yes")
          const r = await api.shareDelete(id, str(flags, "secret"))
          await assertOk(r, "delete share")
          out(flags, r.body, `deleted ${id}`)
          return 0
        }
        if (sub === "freeze" || sub === "unfreeze") {
          if (!flags.yes) fail(`refusing without --yes`)
          const r = await api.shareFreeze(id, sub === "freeze")
          await assertOk(r, `${sub} share`)
          out(flags, r.body, `${sub === "freeze" ? "froze" : "unfroze"} ${id}`)
          return 0
        }
        if (sub === "patch") {
          const body: Record<string, unknown> = {}
          if (str(flags, "secret")) body.secret = str(flags, "secret")
          const ttl = num(str(flags, "ttl-hours"))
          if (ttl !== undefined) body.ttlHours = ttl
          const l = str(flags, "login"); const p = str(flags, "pass")
          if (l !== undefined || p !== undefined) { if (!l || !p) fail("--login and --pass go together"); body.authLogin = l; body.authPassword = p }
          if (str(flags, "meta")) { try { body.meta = JSON.parse(str(flags, "meta")!) } catch { fail("--meta must be JSON") } }
          const r = await api.sharePatch(id, body)
          await assertOk(r, "patch share")
          out(flags, r.body, `patched ${id}`)
          return 0
        }
        if (sub === "auth") {
          const l = str(flags, "login") ?? ""; const p = str(flags, "pass") ?? ""
          if (!l || !p) fail("--login and --pass required")
          const r = await api.shareAuth(id, l, p)
          await assertOk(r, "viewer login")
          out(flags, { ok: true, cookie: [...api.cookies.keys()] }, "viewer session established (in-memory)")
          return 0
        }
        if (sub === "snapshot") {
          const res = await fetch(`${api.url}/s/${id}/snapshot?download=1`, { headers: api.headers(), signal: AbortSignal.timeout(120000) })
          if (res.status === 404) fail("snapshot endpoint disabled on this worker (SNAPSHOT_ENDPOINT=1) - use the page button or tools/osh-snapshot.mjs")
          if (!res.ok) fail(`snapshot failed (${res.status})`)
          const file = str(flags, "o") ?? `${id}.html`
          const { writeFileSync } = await import("node:fs")
          writeFileSync(file, Buffer.from(await res.arrayBuffer()))
          out(flags, { ok: true, file }, `saved ${file}`)
          return 0
        }
        fail(`unknown shares subcommand "${sub}"`)
        break
      }

      case "users": {
        const { api } = client()
        const sub = pos[1] ?? "ls"
        if (sub === "ls") {
          const r = await assertOk(await api.users(), "list users")
          const codes = await api.codes()
          const codeLabel = new Map<string, string>()
          if (codes.status === 200 && codes.body?.ok) for (const c of codes.body.codes ?? []) codeLabel.set(c.id, c.label)
          const sort = parseSort(flags, ["created", "label"])
          const rows: any[] = sortRows(r.users ?? [], sort, (u: any) => (sort?.key === "label" ? String(u.label ?? "").toLowerCase() : -(u.createdAt ?? 0)))
          out(flags, rows, ["id           label              via code            shares tokens frozen created"].concat(rows.map((u: any) => `${u.id.padEnd(13)} ${(u.label ?? "").padEnd(18)} ${(u.createdByCode ? `${codeLabel.get(u.createdByCode) ?? u.createdByCode}` : "-").padEnd(18)} ${String(u.shares).padEnd(6)} ${String(u.tokensActive).padEnd(6)} ${u.frozen ? "FROZEN" : "      "} ${rel(u.createdAt)}`)).join("\n"))
          return 0
        }
        if (sub === "new") {
          const r = await assertOk(await api.userCreate(str(flags, "label") ?? ""), "create user")
          out(flags, r, `created ${r.userId} "${r.label}"`)
          return 0
        }
        const id = pos[2] ?? fail("user id required")
        if (sub === "freeze") { out(flags, await assertOk(await api.userFreeze(id), "freeze"), `froze ${id}`); return 0 }
        if (sub === "unfreeze") { out(flags, await assertOk(await api.userUnfreeze(id), "unfreeze"), `unfroze ${id}`); return 0 }
        if (sub === "rm") {
          if (!flags.yes) fail("refusing without --yes")
          out(flags, await assertOk(await api.userDelete(id, str(flags, "mode")), "delete user"), `removed ${id}`)
          return 0
        }
        fail(`unknown users subcommand "${sub}"`)
        break
      }

      case "tokens": {
        const { api, kind } = client()
        const sub = pos[1] ?? "ls"
        const limits = () => {
          const o: Record<string, number> = {}
          if (num(str(flags, "max-shares")) !== undefined) o.maxLiveShares = num(str(flags, "max-shares"))!
          if (num(str(flags, "max-ttl-hours")) !== undefined) o.maxTtlHours = num(str(flags, "max-ttl-hours"))!
          if (num(str(flags, "daily-creates")) !== undefined) o.dailyCreates = num(str(flags, "daily-creates"))!
          return Object.keys(o).length ? o : undefined
        }
        const expiry = () => {
          for (const k of ["expires-in-minutes", "expires-in-hours", "expires-in-days"]) {
            if (str(flags, k) !== undefined) {
              const n = num(str(flags, k))!
              const key = k.replace(/-(.)/g, (_, c) => c.toUpperCase()).replace("ExpiresIn", "expiresIn")
              return { [key]: n }
            }
          }
          return undefined
        }
        if (sub === "ls") {
          const admin = await api.tokens()
          if (admin.status === 200 && admin.body?.ok) {
            const users = await api.users()
            const userLabel = new Map<string, string>()
            if (users.status === 200 && users.body?.ok) for (const u of users.body.users ?? []) userLabel.set(u.id, u.label)
            const all: any[] = admin.body.tokens ?? []
            const rows = flags.all ? all : all.filter((t) => !t.revoked)
            const sort = parseSort(flags, ["created", "label", "kind", "user", "used"])
            const sorted = sortRows(rows, sort, (t) => {
              if (sort?.key === "label") return String(t.label ?? "").toLowerCase()
              if (sort?.key === "kind") return t.kind
              if (sort?.key === "user") return (userLabel.get(t.userId) ?? t.userId).toLowerCase()
              if (sort?.key === "used") return -(t.lastUsedAt ?? 0)
              return -(t.createdAt ?? 0)
            })
            const hidden = all.length - rows.length
            out(flags, sorted, [
              `${rows.length} token(s)${hidden ? ` (${hidden} revoked hidden, --all shows)` : ""}`,
              "id           kind    user             label              via           expires      used",
              ...sorted.map((t) => `${t.id.padEnd(13)} ${(t.kind ?? "").padEnd(7)} ${(userLabel.get(t.userId) ?? t.userId).padEnd(16)} ${(t.label ?? "").padEnd(18)} ${String(t.createdBy ?? "-").padEnd(13)} ${(t.expiresAt ? relFuture(t.expiresAt) : "-").padEnd(12)} ${t.lastUsedAt ? rel(t.lastUsedAt) : "never"}${t.revoked ? "  REVOKED" : ""}`),
            ].join("\n"))
          } else {
            const mine = await assertOk(await api.me(), "tokens")
            out(flags, [mine.token], `current token: ${mine.token?.id} (${mine.token?.kind}) "${mine.token?.label ?? ""}"${mine.token?.expiresAt ? ` expires ${relFuture(mine.token.expiresAt)}` : ""}`)
          }
          return 0
        }
        if (sub === "new") {
          const user = str(flags, "user") ?? fail("--user <userId> required (or 'osh tokens self' to self-mint)")
          const r = await assertOk(await api.tokenMint({ userId: user, kind: str(flags, "kind"), label: str(flags, "label"), limits: limits(), ...expiry() }), "mint token")
          out(flags, r, `minted ${r.id} (${r.kind}) for ${r.userId}\n  token: ${r.token}`)
          return 0
        }
        if (sub === "self") {
          // self-service routes need a user identity; the root credential
          // is not one - pre-flight instead of surfacing the server's 401
          if (cfg.current(cfg.load())?.entry.kind === "root") return fail("the root token has no user identity to mint for - use: osh tokens new --user <userId>")
          const r = await assertOk(await api.tokenSelfMint({ kind: str(flags, "kind"), label: str(flags, "label"), limits: limits(), ...expiry() }), "self-mint token")
          const c = cfg.load(); const cur = cfg.current(c)
          if (cur) cfg.setToken(c, cur.name, r.token, r.kind)
          cfg.save(c)
          out(flags, r, `minted ${r.id} (${r.kind}) - saved as current credential\n  token: ${r.token}`)
          return 0
        }
        if (sub === "rotate") {
          if (cfg.current(cfg.load())?.entry.kind === "root") return fail("the root token cannot rotate via the API - mint a full user token (osh tokens new --user <id>) and rotate that, or change the worker's CREATE_TOKEN secret")
          const r = await assertOk(await api.tokenRotate({ label: str(flags, "label"), limits: limits(), ...expiry() }), "rotate")
          const c = cfg.load(); const cur = cfg.current(c)
          if (cur) { cfg.setToken(c, cur.name, r.token, r.tokenKind); cfg.save(c) }
          out(flags, r, `rotated -> ${r.token}\n  saved as current credential (${r.tokenKind}, label "${r.label ?? ""}")${r.expiresAt ? `\n  expires ${relFuture(r.expiresAt)}` : ""}`)
          return 0
        }
        if (sub === "update") {
          const c = cfg.load(); const cur = cfg.current(c)
          if (cur?.entry.kind === "root" && !pos[2]) return fail("root must pass the token ID explicitly (list with: osh tokens ls --all)")
          const r0 = cur?.entry.kind === "root" && pos[2]
            ? await api.tokenAdminUpdate(pos[2], { label: str(flags, "label"), limits: limits(), ...expiry() })
            : await api.tokenUpdate({ tokenId: pos[2], label: str(flags, "label"), limits: limits(), ...expiry() })
          const r = await assertOk(r0, "update token")
          out(flags, r, `updated ${r.token.id}: "${r.token.label}" ${JSON.stringify(r.token.limits)}${r.token.expiresAt ? ` expires ${relFuture(r.token.expiresAt)}` : ""}`)
          return 0
        }
        const id = pos[2] ?? fail("token id required")
        if (sub === "revoke") { out(flags, await assertOk(await api.tokenRevoke(id), "revoke"), `revoked ${id}`); return 0 }
        if (sub === "freeze-shares") { const r = await assertOk(await api.tokenFreezeShares(id), "freeze shares"); out(flags, r, `froze ${r.shares} share(s) created by ${id}`); return 0 }
        fail(`unknown tokens subcommand "${sub}"`)
        break
      }

      case "codes": {
        const { api } = client()
        const sub = pos[1] ?? "ls"
        if (sub === "ls") {
          const r = await assertOk(await api.codes(), "list codes")
          const users = await api.users()
          const lineage = new Map<string, string[]>()
          if (users.status === 200 && users.body?.ok) {
            for (const u of users.body.users ?? []) {
              if (u.createdByCode) lineage.set(u.createdByCode, [...(lineage.get(u.createdByCode) ?? []), u.label || u.id])
            }
          }
          const rows = r.codes ?? []
          out(flags, rows.map((c: any) => ({ ...c, onboarded: lineage.get(c.id) ?? [] })), ["id           label              left   used  onboarded            created"].concat(rows.map((c: any) => {
            const on = lineage.get(c.id) ?? []
            const onStr = on.length ? on.slice(0, 2).join(", ") + (on.length > 2 ? ` +${on.length - 2}` : "") : "-"
            return `${c.id.padEnd(13)} ${(c.label ?? "").padEnd(18)} ${String(c.activationsLeft < 0 ? "∞" : c.activationsLeft).padEnd(6)} ${String(c.used).padEnd(5)} ${onStr.padEnd(21)} ${rel(c.createdAt)}${c.disabled ? "  OFF" : ""}`
          })).join("\n"))
          return 0
        }
        if (sub === "new") {
          const r = await assertOk(await api.codeCreate({ label: str(flags, "label"), activations: num(str(flags, "activations")), ttlHours: num(str(flags, "ttl-hours")) }), "create code")
          out(flags, r, `created ${r.id}: ${r.code} (${r.activationsLeft < 0 ? "unlimited" : r.activationsLeft} activations)`)
          return 0
        }
        const id = pos[2] ?? fail("code id required")
        if (sub === "disable") { out(flags, await assertOk(await api.codeDisable(id), "disable"), `disabled ${id}`); return 0 }
        if (sub === "lineage") {
          if (!flags.yes) fail("refusing without --yes (kills EVERY token of EVERY user this code created)")
          const r = await assertOk(await api.codeRevokeLineage(id), "revoke lineage")
          out(flags, r, `disabled code, revoked ${r.revoked} token(s) across ${r.users} user(s), froze ${r.frozen}`)
          return 0
        }
        fail(`unknown codes subcommand "${sub}"`)
        break
      }

      case "settings": {
        const { api, kind } = client()
        const sub = pos[1] ?? "get"
        if (sub === "get") {
          const r = await api.meSettings()
          if (r.status === 200 && r.body?.ok) { out(flags, r.body, JSON.stringify(r.body.settings ?? {}, null, 2)); return 0 }
          // root/anon: show the server policy instead (read-only)
          const h = await api.health()
          if (h.status === 200 && h.body?.policy) {
            out(flags, { role: kind, policy: h.body.policy }, [
              kind === "root" ? "server policy (root view - user settings need a user identity)" : "no user identity on this credential - showing server policy",
              ...Object.entries(h.body.policy).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`),
            ].join("\n"))
            return 0
          }
          fail(`cannot read settings (${r.status}): ${r.body?.error ?? ""}`)
        }
        if (sub === "put") {
          const j = str(flags, "json") ?? fail("usage: osh settings put --json <settings object>")
          let settings: unknown; try { settings = JSON.parse(j) } catch { fail("--json must be JSON") }
          const r = await assertOk(await api.meSettingsPut(settings as Record<string, unknown>), "write settings")
          out(flags, r, "settings saved")
          return 0
        }
        fail(`unknown settings subcommand "${sub}"`)
        break
      }

      case "purge": {
        if (!flags.yes) fail("refusing without --yes - this removes EVERY share on the worker")
        const { api } = client()
        const r = await assertOk(await api.purge(), "purge")
        out(flags, r, "purge issued")
        return 0
      }

      default:
        fail(`unknown command "${cmd}" - try: osh help`)
    }
  } catch (e: any) {
    fail(e?.message ?? String(e))
  }
  return 1
}
