/** Headless command surface: every TUI action has a one-line equivalent
 *  here for scripts and agents. Output is human by default, --json for
 *  machines; exit 0 on ok, 1 on any failure. */
import { Api } from "./api"
import * as cfg from "./config"

type Args = { pos: string[]; flags: Record<string, string | boolean> }

function parse(argv: string[]): Args {
  const pos: string[] = []
  const flags: Record<string, string | boolean> = {}
  const valueFlags = new Set(["code", "token", "label", "name", "secret", "login", "pass", "user", "kind", "id", "ttl-hours", "max-shares", "max-ttl-hours", "daily-creates", "activations", "meta", "set", "o", "since", "url", "mode", "limit"])
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

function client(): { api: Api; name: string } {
  const c = cfg.load()
  const cur = cfg.current(c)
  if (!cur) fail("no server configured - run: osh login <url>")
  const e = cur as { name: string; entry: cfg.ServerEntry }
  return { api: new Api({ url: e.entry.url, token: e.entry.token }), name: e.name }
}

function isAdminToken(entry: cfg.ServerEntry | undefined): boolean {
  // root tokens are only knowable by what they can do; /health says the
  // mode, /api/me says whether the credential is a user identity
  return !!entry && entry.kind === "root"
}

async function assertOk(r: { status: number; body: any }, what: string): Promise<any> {
  if (r.status === 0 || r.status >= 400 || r.body?.ok === false) {
    fail(`${what} failed (${r.status}): ${JSON.stringify(r.body?.error ?? r.body)}`)
  }
  return r.body
}

const fmtDate = (ms?: number): string => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "-")

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

shares ls                      list shares (admin: all; user: own)
shares info ID                 status, rev, item census
shares data ID [--since REV]   raw share data
shares rm ID [--secret S]      delete a share
shares patch ID --secret S [--ttl-hours N] [--login L --pass P] [--meta JSON]
shares auth ID --login L --pass P   viewer login (gated share)
shares snapshot ID [-o FILE]   download the offline HTML

users ls | new --label L | freeze ID | unfreeze ID | rm ID [--mode delete]
tokens ls | new --user U [--kind scoped] [--label L] [limits] | rotate [--label L] [limits]
       | update [ID] [--label L] [limits] | revoke ID | freeze-shares ID
       | sets [get | put --json JSON]
       limits: --max-shares N --max-ttl-hours N --daily-creates N
codes  ls | new --activations N [--label L] [--ttl-hours N] | disable ID | lineage ID
settings get | put --json JSON
purge --yes                    remove EVERY share (root)

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
            // not a user credential - root, or garbage; health tells which side of the fence
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
        out(flags, r.body, `${api.url}\n  version ${r.body.version ?? "?"}\n  auth: ${r.body.auth?.mode ?? "?"}`)
        return 0
      }

      case "me": {
        const { api, name } = client()
        const r = await api.me()
        if (r.status !== 0 && r.status < 400 && r.body?.ok) {
          out(flags, r.body, `server ${name}: user ${r.body.userId} (${r.body.label})\n  token: ${r.body.token?.kind} "${r.body.token?.label ?? ""}"`)
        } else if (isAdminToken(cfg.current(cfg.load())?.entry)) {
          out(flags, { ok: true, role: "root" }, `server ${name}: ROOT token (admin; not a user identity)`)
        } else fail(`not logged in as a user (${r.status}): ${r.body?.error ?? ""}`)
        return 0
      }

      case "shares": {
        const { api } = client()
        const sub = pos[1] ?? "ls"
        if (sub === "ls") {
          const admin = await api.sharesAdmin()
          if (admin.status === 200 && admin.body?.ok) {
            const rows = admin.body.shares ?? []
            out(flags, rows, ["id           session                 owner            created"].concat(rows.map((s: any) => `${(s.id ?? "").slice(0, 12)} ${(s.sessionID ?? "").padEnd(23)} ${(s.ownerId ?? "-").padEnd(16)} ${fmtDate(s.createdAt)}`)).join("\n"))
          } else {
            const mine = await assertOk(await api.meShares(), "list shares")
            out(flags, mine.shares ?? [], ["session                 created           by-token"].concat((mine.shares ?? []).map((s: any) => `${(s.sessionID ?? s.id ?? "").padEnd(23)} ${fmtDate(s.createdAt)} ${s.creatorTokenId ?? "-"}`)).join("\n"))
          }
          return 0
        }
        const id = pos[2] ?? fail("share id required")
        if (sub === "info") {
          const r = await api.shareData(id)
          await assertOk(r, "share info")
          const d = r.body?.data ?? []
          const types: Record<string, number> = {}
          for (const it of d) types[it.type] = (types[it.type] ?? 0) + 1
          const info = { id, url: `${api.url}/s/${id}`, status: r.body.status, rev: r.body.rev, items: d.length, types, sessionID: d.find((x: any) => x.type === "session")?.sessionID }
          out(flags, info, `${info.url}\n  status ${info.status} · rev ${info.rev} · ${info.items} items (${Object.entries(types).map(([k, v]) => `${k}=${v}`).join(" ")})`)
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
          const res = await fetch(`${api.url}/s/${id}/snapshot?download=1`, { headers: thisHeaders(api), signal: AbortSignal.timeout(120000) })
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
          out(flags, r.users, ["id           label              shares tokens frozen created"].concat((r.users ?? []).map((u: any) => `${u.id.padEnd(13)} ${(u.label ?? "").padEnd(18)} ${String(u.shares).padEnd(6)} ${String(u.tokensActive).padEnd(6)} ${u.frozen ? "FROZEN" : "      "} ${fmtDate(u.createdAt)}`)).join("\n"))
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
        const { api } = client()
        const sub = pos[1] ?? "ls"
        const limits = () => {
          const o: Record<string, number> = {}
          if (num(str(flags, "max-shares")) !== undefined) o.maxLiveShares = num(str(flags, "max-shares"))!
          if (num(str(flags, "max-ttl-hours")) !== undefined) o.maxTtlHours = num(str(flags, "max-ttl-hours"))!
          if (num(str(flags, "daily-creates")) !== undefined) o.dailyCreates = num(str(flags, "daily-creates"))!
          return Object.keys(o).length ? o : undefined
        }
        if (sub === "ls") {
          const admin = await api.tokens()
          if (admin.status === 200 && admin.body?.ok) {
            const rows: any[] = admin.body.tokens ?? []
            out(flags, rows, ["id           kind    label              used             revoked created"].concat(rows.map((t) => `${t.id.padEnd(13)} ${(t.kind ?? "").padEnd(7)} ${(t.label ?? "").padEnd(18)} ${fmtDate(t.lastUsedAt || undefined).padEnd(16)} ${t.revoked ? "REVOKED" : "       "} ${fmtDate(t.createdAt)}`)).join("\n"))
          } else {
            const mine = await assertOk(await api.me(), "tokens")
            out(flags, [mine.token], `current token: ${mine.token?.id} (${mine.token?.kind}) "${mine.token?.label ?? ""}"`)
          }
          return 0
        }
        if (sub === "new") {
          const user = str(flags, "user") ?? fail("--user <userId> required (or omit for self-mint: osh tokens self)")
          const r = await assertOk(await api.tokenMint({ userId: user, kind: str(flags, "kind"), label: str(flags, "label"), limits: limits() }), "mint token")
          out(flags, r, `minted ${r.id} (${r.kind}) for ${r.userId}\n  token: ${r.token}`)
          return 0
        }
        if (sub === "self") {
          const r = await assertOk(await api.tokenSelfMint({ kind: str(flags, "kind"), label: str(flags, "label"), limits: limits() }), "self-mint token")
          const c = cfg.load(); const cur = cfg.current(c)
          if (cur) cfg.setToken(c, cur.name, r.token, r.kind)
          cfg.save(c)
          out(flags, r, `minted ${r.id} (${r.kind}) - saved as current credential\n  token: ${r.token}`)
          return 0
        }
        if (sub === "rotate") {
          const r = await assertOk(await api.tokenRotate({ label: str(flags, "label"), limits: limits() }), "rotate")
          const c = cfg.load(); const cur = cfg.current(c)
          if (cur) { cfg.setToken(c, cur.name, r.token, r.tokenKind); cfg.save(c) }
          out(flags, r, `rotated -> ${r.token}\n  saved as current credential (${r.tokenKind}, label "${r.label ?? ""}")`)
          return 0
        }
        if (sub === "update") {
          // root credentials are not user identities - they go through the
          // admin route; user tokens use self-service
          const c = cfg.load(); const cur = cfg.current(c)
          const r0 = cur?.entry.kind === "root" && pos[2]
            ? await api.tokenAdminUpdate(pos[2], { label: str(flags, "label"), limits: limits() })
            : await api.tokenUpdate({ tokenId: pos[2], label: str(flags, "label"), limits: limits() })
          const r = await assertOk(r0, "update token")
          out(flags, r, `updated ${r.token.id}: "${r.token.label}" ${JSON.stringify(r.token.limits)}`)
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
          out(flags, r.codes, ["id           label              left   used  created"].concat((r.codes ?? []).map((c: any) => `${c.id.padEnd(13)} ${(c.label ?? "").padEnd(18)} ${String(c.activationsLeft).padEnd(6)} ${String(c.used).padEnd(5)} ${fmtDate(c.createdAt)}`)).join("\n"))
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
        const { api } = client()
        const sub = pos[1] ?? "get"
        if (sub === "get") { const r = await assertOk(await api.meSettings(), "read settings"); out(flags, r, JSON.stringify(r.settings ?? r, null, 2)); return 0 }
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

function thisHeaders(api: Api): Record<string, string> {
  const h: Record<string, string> = {}
  if (api.token) h.authorization = `Bearer ${api.token}`
  if (api.cookies.size) h.cookie = [...api.cookies].map(([k, v]) => `${k}=${v}`).join("; ")
  return h
}
