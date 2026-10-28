// S13 — auth suite: enrollment, codes, tokens, ownership, freeze, limits,
// reassign, public mode. Pure HTTP + WS against the real wrangler worker
// (no opencode needed — this is the server contract).
//
// Run: npm run test:auth

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CREATE_TOKEN,
  WORKER_PORT,
  killPortOwners,
  killWranglerSuites,
  startWorker,
  startBunServer,
  waitFor,
} from "./suite-lib.mjs"

// OPENSHARE_BACKEND=bun (or a "bun" argv token, e.g. `-- --backend bun`)
// runs the SAME checks against the portable Bun server (../share-server)
// — the parity guarantee between backends.
const BACKEND = process.env.OPENSHARE_BACKEND === "bun" || process.argv.includes("bun") ? "bun" : "wrangler"
const B1_PORT = BACKEND === "bun" ? 8795 : WORKER_PORT
const B2_PORT = B1_PORT + 10
const B3_PORT = B1_PORT + 20
const startBackend = (suiteDir, opts = {}) =>
  BACKEND === "bun" ? startBunServer(suiteDir, { ...opts, port: opts.port ?? B1_PORT }) : startWorker(suiteDir, opts)

const SUITE = "auth"
let passed = 0
let failed = 0
const failures = []

function ok(name, cond, detail = "") {
  if (cond) {
    passed++
    console.log(`  ok  ${name}`)
  } else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`)
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

async function req(url, method, path, { token, body, headers: extra } = {}) {
  const headers = { "content-type": "application/json", ...(extra ?? {}) }
  if (token) headers.authorization = `Bearer ${token}`
  const r = await fetch(url + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  let json = null
  try { json = await r.json() } catch {}
  return { status: r.status, json, res: r }
}

/** Open a plugin control socket, send frames, collect replies until an
 * expected op (or timeout). */
function wsSession(url, token) {
  let ws
  let waiters = []
  const log = []
  const open = () =>
    new Promise((resolve, reject) => {
      ws = new WebSocket(`${url}/api/ws?token=${encodeURIComponent(token ?? "")}`)
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(new Error("ws error: " + (e?.message ?? "")))
      ws.onmessage = (m) => {
        const frame = JSON.parse(m.data)
        log.push(frame)
        waiters = waiters.filter((w) => {
          if (frame.op === w.op) {
            w.resolve(frame)
            return false
          }
          return true
        })
      }
      setTimeout(() => reject(new Error("ws open timeout")), 10000)
    })
  const send = (frame) => ws.send(JSON.stringify(frame))
  const wait = (op, ms = 15000) =>
    new Promise((resolve, reject) => {
      const w = { op, resolve }
      waiters.push(w)
      const hit = log.find((f) => f.op === op)
      if (hit) return resolve(hit)
      setTimeout(() => reject(new Error(`ws wait timeout: ${op}`)), ms)
    })
  const close = () => { try { ws.close() } catch {} }
  const lastInit = async () => log.filter((f) => f.op === "init").at(-1)
  const logOf = (op) => log.filter((f) => f.op === op)
  return { open, send, wait, close, lastInit, logOf }
}

// The HTTP create route requires a hex URL suffix (POST /api/share/<hex>);
// bare /api/share 404s by design — the suffix is ignored, an id is minted.
const CREATE = "/api/share/00"

// --- run -------------------------------------------------------------------

const suiteDir = mkdtempSync(join(tmpdir(), "openshare-auth-"))
let worker1
let worker2
let worker3

try {
  console.log(`[${SUITE}] starting private-mode worker…`)
  worker1 = await startBackend(suiteDir, { configSuffix: "priv", name: "b1" })
  const W1 = worker1.url

  // T01 — health advertises auth mode
  const health = await req(W1, "GET", "/health")
  ok("T01 health auth.mode=private", health.json?.auth?.mode === "private")

  // T02/T03 — private enrollment needs a valid code
  ok("T02 enroll without code rejected", (await req(W1, "POST", "/api/enroll", { body: {} })).status === 403)
  ok("T03 enroll with bad code rejected", (await req(W1, "POST", "/api/enroll", { body: { code: "osc_deadbeef" } })).status === 403)

  // T04 — root mints a 1-activation code
  const codeResp = await req(W1, "POST", "/api/admin/codes", { token: CREATE_TOKEN, body: { label: "friends", activations: 1 } })
  ok("T04 admin code minted", codeResp.status === 200 && typeof codeResp.json?.code === "string" && codeResp.json.code.startsWith("osc_"), JSON.stringify(codeResp.json))
  const CODE = codeResp.json?.code ?? ""
  ok("T04b codes list shows budget", ((await req(W1, "GET", "/api/admin/codes", { token: CREATE_TOKEN })).json?.codes ?? []).some((c) => c.activationsLeft === 1 && c.label === "friends"))

  // T05 — enroll with the code; T06 — budget burned
  const enroll1 = await req(W1, "POST", "/api/enroll", { body: { code: CODE } })
  ok("T05 enrollment issues user token", enroll1.status === 200 && typeof enroll1.json?.token === "string" && typeof enroll1.json?.userId === "string", JSON.stringify(enroll1.json).slice(0, 200))
  const U1 = enroll1.json?.userId ?? ""
  const A = enroll1.json?.token ?? ""
  ok("T05b label derives from code", enroll1.json?.label === "friends-1", enroll1.json?.label)
  ok("T06 code exhausted", (await req(W1, "POST", "/api/enroll", { body: { code: CODE } })).status === 403)

  // T07 — /api/me
  const me = await req(W1, "GET", "/api/me", { token: A })
  ok("T07 me returns identity", me.json?.userId === U1 && me.json?.label === "friends-1" && me.json?.token?.limits != null, JSON.stringify(me.json).slice(0, 200))

  // T08 — anonymous create rejected on private
  ok("T08 anonymous create rejected", (await req(W1, "POST", CREATE, { body: { sessionID: "ses_anon" } })).status === 401)

  // T09 — root creates ownerless (legacy path)
  const rootCreate = await req(W1, "POST", CREATE, { token: CREATE_TOKEN, body: { sessionID: "ses_root" } })
  ok("T09 root create ownerless", rootCreate.json?.ok === true && typeof rootCreate.json?.secret === "string", JSON.stringify(rootCreate.json))

  // T10 — user create owned + registry
  const u1create = await req(W1, "POST", CREATE, { token: A, body: { sessionID: "ses_u1", ttlDays: 90 } })
  ok("T10 user create owned", u1create.json?.ok === true, JSON.stringify(u1create.json))
  const U1_SHARE = u1create.json?.id ?? ""
  const U1_SECRET = u1create.json?.secret ?? ""
  const adminShares = (await req(W1, "GET", "/api/admin/shares", { token: CREATE_TOKEN })).json?.shares ?? []
  ok("T10b share registered to owner", adminShares.some((s) => s.id === U1_SHARE && s.ownerId === U1), JSON.stringify(adminShares.find((s) => s.id === U1_SHARE)))
  const meShares = (await req(W1, "GET", "/api/me/shares", { token: A })).json?.shares ?? []
  ok("T10c me/shares lists it", meShares.some((s) => s.id === U1_SHARE && s.status === "live"), JSON.stringify(meShares))

  // T11 — WS create + sync with user token
  const ws1 = wsSession(W1, A)
  await ws1.open()
  ws1.send({ op: "init", create: { sessionID: "ses_ws1" } })
  const ws1init = await ws1.wait("init")
  ok("T11 ws create with user token", ws1init.ok === true && typeof ws1init.secret === "string", JSON.stringify(ws1init).slice(0, 200))
  ws1.send({ op: "sync", items: [{ type: "message", data: { id: "msg_ws1", role: "user", text: "hello" } }] })
  const ws1ack = await ws1.wait("ack")
  ok("T11b ws sync acked", ws1ack.ok === true && ws1ack.rev >= 1)
  const ws1data = await req(W1, "GET", `/api/share/${ws1init.id}/data`)
  ok("T11c synced item visible", (ws1data.json?.data ?? []).some((i) => i?.data?.id === "msg_ws1"))
  ws1.close()

  // T12 — attach + control via owner token (no secret)
  const ws2 = wsSession(W1, A)
  await ws2.open()
  ws2.send({ op: "init", attach: { id: U1_SHARE } })
  const ws2init = await ws2.wait("init")
  ok("T12 owner-token attach (no secret)", ws2init.ok === true && ws2init.rev >= 0, JSON.stringify(ws2init).slice(0, 200))
  ws2.send({ op: "sync", items: [{ type: "message", data: { id: "msg_owner", role: "user", text: "via token" } }] })
  ok("T12b owner-token sync acked", (await ws2.wait("ack")).ok === true)
  ws2.close()

  // T13 — root attach without secret; T14 — wrong secret rejected
  const ws3 = wsSession(W1, CREATE_TOKEN)
  await ws3.open()
  ws3.send({ op: "init", attach: { id: U1_SHARE } })
  ok("T13 root attach controls any share", (await ws3.wait("init")).ok === true)
  ws3.close()
  const ws4 = wsSession(W1, "")
  await ws4.open()
  ws4.send({ op: "init", attach: { id: U1_SHARE, secret: "wrong" } })
  ok("T14 wrong-secret attach rejected", (await ws4.wait("init")).ok === false)
  ws4.close()

  // T15 — rotate: old dies, new lives
  const rot = await req(W1, "POST", "/api/token/rotate", { token: A })
  ok("T15 rotate issues new token", rot.json?.ok === true && typeof rot.json?.token === "string")
  const A2 = rot.json?.token ?? ""
  ok("T15b old token dead", (await req(W1, "GET", "/api/me", { token: A })).status === 401)
  ok("T15c new token alive", (await req(W1, "GET", "/api/me", { token: A2 })).json?.userId === U1)

  // T16 — limits: dedicated user with tight caps
  const u2 = await req(W1, "POST", "/api/admin/users", { token: CREATE_TOKEN, body: { label: "limited" } })
  const U2 = u2.json?.userId ?? ""
  const u2tok = await req(W1, "POST", "/api/admin/tokens", { token: CREATE_TOKEN, body: { userId: U2, label: "capped", limits: { maxLiveShares: 2, maxTtlDays: 2 } } })
  const B = u2tok.json?.token ?? ""
  ok("T16 admin minted capped token", typeof B === "string" && B.startsWith("osk_"), JSON.stringify(u2tok.json).slice(0, 200))
  const c1 = await req(W1, "POST", CREATE, { token: B, body: { sessionID: "ses_c1" } })
  const c2 = await req(W1, "POST", CREATE, { token: B, body: { sessionID: "ses_c2" } })
  const c3 = await req(W1, "POST", CREATE, { token: B, body: { sessionID: "ses_c3" } })
  ok("T16b first two creates pass", c1.json?.ok === true && c2.json?.ok === true)
  ok("T16c third create blocked (max shares)", c3.status === 403 && /max shares/.test(c3.json?.error ?? ""), `${c3.status} ${c3.json?.error}`)
  ok("T16d ttl clamped to token max (hours)", c1.json?.ttlHours === 48, JSON.stringify(c1.json))
  // delete one via secret to free a slot and prove registry bookkeeping
  ok("T16e secret delete frees slot", (await req(W1, "DELETE", `/api/share/${c1.json.id}`, { body: { secret: c1.json.secret } })).json?.ok === true)
  ok("T16f create passes after free", (await req(W1, "POST", CREATE, { token: B, body: { sessionID: "ses_c4" } })).json?.ok === true)

  // T16g-j — user defaultTtlDays applies when create omits ttlDays (explicit wins)
  const u5 = await req(W1, "POST", "/api/admin/users", { token: CREATE_TOKEN, body: { label: "def-ttl" } })
  const U5 = u5.json?.userId ?? ""
  const u5tok = await req(W1, "POST", "/api/admin/tokens", { token: CREATE_TOKEN, body: { userId: U5, limits: { maxTtlDays: 30 } } })
  const E = u5tok.json?.token ?? ""
  ok("T16g user settings persist (hours)", (await req(W1, "PUT", "/api/me/settings", { token: E, body: { defaultTtlDays: 7 } })).json?.settings?.defaultTtlHours === 168)
  const d1 = await req(W1, "POST", CREATE, { token: E, body: { sessionID: "ses_defttl" } })
  ok("T16h default TTL applied on create (hours)", d1.json?.ttlHours === 168, JSON.stringify(d1.json))
  const d2 = await req(W1, "POST", CREATE, { token: E, body: { sessionID: "ses_defttl2", ttlDays: 3 } })
  ok("T16i explicit legacy ttlDays beats default", d2.json?.ttlHours === 72, JSON.stringify(d2.json))
  const ws6 = wsSession(W1, E)
  await ws6.open()
  ws6.send({ op: "init", create: { sessionID: "ses_defttlws" } })
  const ws6init = await ws6.wait("init")
  ok("T16j ws create applies default TTL (hours)", ws6init.ok === true && ws6init.ttlHours === 168, JSON.stringify(ws6init).slice(0, 140))
  ws6.close()

  // T21 — DELETE auth enforcement (Bun once trusted raw-body root/ownerId:
  // any viewer could delete any share by id). Spoofed identity must 403;
  // the real secret must work.
  const d3 = await req(W1, "POST", CREATE, { token: E, body: { sessionID: "ses_spoof" } })
  ok("T21 share staged", d3.json?.ok === true)
  const spoofRoot = await req(W1, "DELETE", `/api/share/${d3.json.id}`, { body: { root: true } })
  ok("T21b spoofed root rejected", spoofRoot.status === 403, `${spoofRoot.status} ${spoofRoot.json?.error}`)
  const spoofOwner = await req(W1, "DELETE", `/api/share/${d3.json.id}`, { body: { ownerId: U5 } })
  ok("T21c spoofed ownerId rejected", spoofOwner.status === 403, `${spoofOwner.status}`)
  ok("T21d share survived the spoofs", (await req(W1, "GET", `/api/share/${d3.json.id}/data`)).status === 200)
  ok("T21e real secret deletes", (await req(W1, "DELETE", `/api/share/${d3.json.id}`, { body: { secret: d3.json.secret } })).json?.ok === true)

  // T22 — read auth end-to-end: login mints a cookie token that /data and
  // the WS actually accept (Bun once compared the token hash against the
  // PASSWORD hash — gated shares were unviewable forever)
  const gated = await req(W1, "POST", CREATE, { token: E, body: { sessionID: "ses_gated", authLogin: "view", authPassword: "pw123" } })
  ok("T22 gated share created", gated.json?.ok === true, JSON.stringify(gated.json).slice(0, 120))
  await req(W1, "POST", `/api/share/${gated.json.id}/sync`, { body: { secret: gated.json.secret, data: [{ type: "message", data: { id: "msg_gated", role: "user", content: [{ type: "text", text: "secret text" }] } }] } })
  ok("T22b unauthenticated data 401", (await req(W1, "GET", `/api/share/${gated.json.id}/data`)).status === 401)
  const login = await req(W1, "POST", `/api/share/${gated.json.id}/auth`, { body: { login: "view", password: "pw123" } })
  const setCookie = login.res?.headers?.get?.("set-cookie") ?? ""
  const cookieToken = /osh_[0-9a-f]+=([^;]+)/.exec(setCookie)?.[1] ?? ""
  ok("T22c login mints cookie", login.status === 200 && cookieToken.length > 20, `${login.status} ${setCookie.slice(0, 40)}`)
  const withCookie = await req(W1, "GET", `/api/share/${gated.json.id}/data`, { headers: { cookie: `osh_${gated.json.id}=${cookieToken}` } })
  ok("T22d cookie token reads data", withCookie.status === 200 && (withCookie.json?.data ?? []).some((i) => i?.data?.id === "msg_gated"), `${withCookie.status} items=${withCookie.json?.data?.length}`)
  const wrongCookie = await req(W1, "GET", `/api/share/${gated.json.id}/data`, { headers: { cookie: `osh_${gated.json.id}=deadbeef` } })
  ok("T22e wrong cookie rejected", wrongCookie.status === 401)
  ok("T22f cleanup", (await req(W1, "DELETE", `/api/share/${gated.json.id}`, { body: { secret: gated.json.secret } })).json?.ok === true)

  // T37 - Wave 3 data-inventory split: pmeta items (machine-local facts)
  // never become public item shards. They land in the share's private
  // block, which only AUTHENTICATED (gated) reads carry. An ungated share
  // stores them dormant - /data never exposes them.
  {
    const g37 = await req(W1, "POST", CREATE, { token: E, body: { sessionID: "ses_t37", authLogin: "v", authPassword: "p" } })
    await req(W1, "POST", `/api/share/${g37.json.id}/sync`, {
      body: {
        secret: g37.json.secret,
        data: [
          { type: "session", sessionID: "ses_t37", data: { id: "ses_t37", title: "split test", version: "1.18" } },
          { type: "pmeta", sessionID: "ses_t37", data: { directory: "/home/u/proj", worktree: "/home/u/proj" } },
        ],
      },
    })
    const l37 = await req(W1, "POST", `/api/share/${g37.json.id}/auth`, { body: { login: "v", password: "p" } })
    const ck37 = /osh_[0-9a-f]+=([^;]+)/.exec(l37.res?.headers?.get?.("set-cookie") ?? "")?.[1] ?? ""
    const read37 = async () => JSON.parse(await (await fetch(`${W1}/api/share/${g37.json.id}/data`, { headers: { cookie: `osh_${g37.json.id}=${ck37}` } })).text())
    const d37 = { json: await read37() }
    ok("T37 gated authed read carries the private block", d37.json?.private?.["ses_t37"]?.directory === "/home/u/proj", JSON.stringify(d37.json?.private))
    ok("T37a pmeta never appears as an item", !(d37.json?.data ?? []).some((i) => i?.type === "pmeta"), JSON.stringify((d37.json?.data ?? []).map((i) => i?.type)))
    // pmeta tombstone drops the entry
    await req(W1, "POST", `/api/share/${g37.json.id}/sync`, { body: { secret: g37.json.secret, data: [{ type: "pmeta", sessionID: "ses_t37", del: true, data: { id: "ses_t37" } }] } })
    const d37b = { json: await read37() }
    ok("T37b pmeta tombstone drops the entry", !d37b.json?.private?.["ses_t37"], JSON.stringify(d37b.json?.private))
    ok("T37c cleanup gated", (await req(W1, "DELETE", `/api/share/${g37.json.id}`, { body: { secret: g37.json.secret } })).json?.ok === true)

    // ungated share: pmeta stored dormant, NEVER in the public envelope
    const u37 = await req(W1, "POST", CREATE, { token: E, body: { sessionID: "ses_t37u" } })
    await req(W1, "POST", `/api/share/${u37.json.id}/sync`, {
      body: { secret: u37.json.secret, data: [{ type: "session", sessionID: "ses_t37u", data: { id: "ses_t37u", title: "anon" } }, { type: "pmeta", sessionID: "ses_t37u", data: { directory: "/secret/dir" } }] },
    })
    const d37u = await req(W1, "GET", `/api/share/${u37.json.id}/data`)
    const flat37 = JSON.stringify(d37u.json ?? {})
    ok("T37d ungated read exposes no private block", d37u.json?.private === undefined, flat37.slice(0, 140))
    ok("T37e ungated read leaks no pmeta path", !flat37.includes("secret/dir") && !flat37.includes('"pmeta"'), flat37.slice(0, 200))
    ok("T37f cleanup ungated", (await req(W1, "DELETE", `/api/share/${u37.json.id}`, { body: { secret: u37.json.secret } })).json?.ok === true)
  }

  // T23 - route shape: share-referencing paths need a real 32-hex id
  ok("T23 short id 404s", (await req(W1, "GET", `/api/share/${"a".repeat(31)}/data`)).status === 404)
  ok("T23b junk id 404s", (await req(W1, "POST", `/api/share/zzzz/sync`, { body: {} })).status === 404)

  // T24 — WS sync acks echo the client frame seq (the plugin tracks
  // pending per-chunk; an unsequenced ack would fall back to clear-all)
  const ws7 = wsSession(W1, E)
  await ws7.open()
  ws7.send({ op: "init", create: { sessionID: "ses_seq" } })
  await ws7.wait("init")
  ws7.send({ op: "sync", seq: 41, items: [{ type: "message", data: { id: "msg_seq", role: "user", content: [{ type: "text", text: "hi" }] } }] })
  const ws7ack = await ws7.wait("ack")
  ok("T24 ack echoes seq", ws7ack.seq === 41, JSON.stringify(ws7ack).slice(0, 120))
  ws7.close()
  // T24b — the seq-test share actually gets cleaned up (root delete, then gone)
  const seqShare = (await req(W1, "GET", "/api/admin/shares", { token: CREATE_TOKEN })).json?.shares?.find((s) => s.sessionID === "ses_seq")
  ok("T24b seq share found for cleanup", !!seqShare, JSON.stringify(seqShare).slice(0, 120))
  if (seqShare) {
    ok("T24b2 root delete works", (await req(W1, "DELETE", `/api/share/${seqShare.id}`, { token: CREATE_TOKEN })).json?.ok === true)
    const after = (await req(W1, "GET", "/api/admin/shares", { token: CREATE_TOKEN })).json?.shares ?? []
    ok("T24b3 seq share gone", !after.some((s) => s.id === seqShare.id))
  }

  // T25 — request-size cap: a >8MB sync body is refused BEFORE parsing
  // (the engine's HTTP fallback chunks at 4MB; only a hostile/buggy
  // client exceeds 8MB). The route 413s before the share lookup, so a
  // synthetic id works.
  {
    const big = "x".repeat(8_500_000)
    const capRes = await fetch(`${W1}/api/share/${"a".repeat(32)}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CREATE_TOKEN}` },
      body: JSON.stringify({ secret: "irrelevant", data: [{ type: "message", data: { id: big } }] }),
      signal: AbortSignal.timeout(15000),
    })
    ok("T25 oversized sync body refused (413)", capRes.status === 413, String(capRes.status))
    const okRes = await req(W1, "POST", `/api/share/${"a".repeat(32)}/sync`, { body: { secret: "x", data: [] } })
    ok("T25b normal-size body reaches the route (not 413)", okRes.status !== 413, String(okRes.status))
  }

  // T26 — /data?since handshake (poll delta): flat rev answers EMPTY,
  // changed rev answers ONLY the touched items, tombstones ride the
  // delta, and the full read prunes deleted items. Regression lock for
  // the router forward (the delta was once dead on Cloudflare while Bun
  // served it — the router hardcoded ?token= and dropped url.search).
  {
    const c = await req(W1, "POST", CREATE, { token: CREATE_TOKEN, body: { sessionID: "ses_since" } })
    ok("T26 share staged", c.json?.ok === true, JSON.stringify(c.json))
    const SID = c.json?.id ?? ""
    const SECRET = c.json?.secret ?? ""
    const s1 = await req(W1, "POST", `/api/share/${SID}/sync`, { body: { secret: SECRET, data: [{ type: "message", data: { id: "msg_s1", role: "user" } }, { type: "message", data: { id: "msg_s2", role: "user" } }] } })
    const rev1 = s1.json?.rev ?? 0
    ok("T26a initial sync", s1.json?.ok === true && rev1 > 0, JSON.stringify(s1.json))
    const flat = await req(W1, "GET", `/api/share/${SID}/data?since=${rev1}`)
    ok("T26b flat rev answers empty delta", flat.json?.rev === rev1 && (flat.json?.data ?? []).length === 0, JSON.stringify({ rev: flat.json?.rev, n: (flat.json?.data ?? []).length }))
    const s2 = await req(W1, "POST", `/api/share/${SID}/sync`, { body: { secret: SECRET, data: [{ type: "message", data: { id: "msg_s3", role: "user" } }] } })
    const rev2 = s2.json?.rev ?? 0
    const delta = await req(W1, "GET", `/api/share/${SID}/data?since=${rev1}`)
    const deltaIds = (delta.json?.data ?? []).map((i) => i.data?.id)
    ok("T26c changed rev answers only the delta", delta.json?.rev === rev2 && deltaIds.length === 1 && deltaIds[0] === "msg_s3", JSON.stringify(deltaIds))
    const s3 = await req(W1, "POST", `/api/share/${SID}/sync`, { body: { secret: SECRET, data: [{ type: "message", del: true, data: { id: "msg_s1", role: "user" } }] } })
    const rev3 = s3.json?.rev ?? 0
    const dtd = await req(W1, "GET", `/api/share/${SID}/data?since=${rev2}`)
    const td = (dtd.json?.data ?? []).find((i) => i.data?.id === "msg_s1")
    ok("T26d tombstone rides the delta", dtd.json?.rev === rev3 && td?.del === true, JSON.stringify(dtd.json?.data))
    const full = await req(W1, "GET", `/api/share/${SID}/data`)
    const fullIds = (full.json?.data ?? []).map((i) => i.data?.id)
    ok("T26e full read prunes the deleted item", fullIds.includes("msg_s2") && fullIds.includes("msg_s3") && !fullIds.includes("msg_s1"), JSON.stringify(fullIds))
    // WS first-frame delta: a reconnecting viewer (since=rev1, delta=1)
    // gets ONLY what it missed (msg_s3 + the tombstone), not the whole
    // share — the full first frame on rev-miss was the last whole-share
    // transfer on the reconnect path
    const wsFirst = await new Promise((resolve, reject) => {
      const w = new WebSocket(`${W1.replace(/^http/, "ws")}/api/share/${SID}/ws?since=${rev1}&delta=1`)
      const timer = setTimeout(() => { try { w.close() } catch {} ; reject(new Error("ws first-frame timeout")) }, 10000)
      w.addEventListener("message", (ev) => {
        clearTimeout(timer)
        try { w.close() } catch {}
        try { resolve(JSON.parse(ev.data)) } catch { reject(new Error("bad json")) }
      })
      w.addEventListener("error", () => { clearTimeout(timer); reject(new Error("ws error")) })
    })
    const wsIds = (wsFirst.items ?? []).map((i) => i.data?.id)
    ok("T26f WS first frame is a delta (kind marker)", wsFirst.kind === "delta" && wsFirst.rev === rev3, JSON.stringify({ kind: wsFirst.kind, rev: wsFirst.rev, ids: wsIds }))
    ok("T26g WS delta carries only the missed items + tombstone", wsIds.includes("msg_s3") && wsIds.includes("msg_s1") && !wsIds.includes("msg_s2") && (wsFirst.items ?? []).some((i) => i.data?.id === "msg_s1" && i.del === true), JSON.stringify(wsIds))
    // and an old-style client (no delta=1) still gets the FULL first
    // frame — backward compat for cached bundles that can only replace
    const wsOld = await new Promise((resolve, reject) => {
      const w = new WebSocket(`${W1.replace(/^http/, "ws")}/api/share/${SID}/ws?since=${rev1}`)
      const timer = setTimeout(() => { try { w.close() } catch {} ; reject(new Error("ws first-frame timeout")) }, 10000)
      w.addEventListener("message", (ev) => {
        clearTimeout(timer)
        try { w.close() } catch {}
        try { resolve(JSON.parse(ev.data)) } catch { reject(new Error("bad json")) }
      })
      w.addEventListener("error", () => { clearTimeout(timer); reject(new Error("ws error")) })
    })
    const oldIds = (wsOld.items ?? []).map((i) => i.data?.id)
    ok("T26h no-delta client gets the full first frame", wsOld.kind !== "delta" && oldIds.includes("msg_s2") && !oldIds.includes("msg_s1"), JSON.stringify(oldIds))
    await req(W1, "DELETE", `/api/share/${SID}`, { body: { secret: SECRET } })
  }

  // T27 - live settings sync: a re-attach over an OPEN control socket
  // retroactively applies read auth (rotating viewer tokens) and REMOVES
  // it when the pair goes empty - settings changes must not wait for a
  // reconnect (owner rule: every connection heals all staleness)
  {
    const c = await req(W1, "POST", CREATE, { token: CREATE_TOKEN, body: { sessionID: "ses_liveauth" } })
    const SID = c.json?.id ?? ""
    const SECRET = c.json?.secret ?? ""
    await req(W1, "POST", `/api/share/${SID}/sync`, { body: { secret: SECRET, data: [{ type: "message", data: { id: "msg_la1", role: "user" } }] } })
    ok("T27 share staged ungated", (await req(W1, "GET", `/api/share/${SID}/data`)).status === 200)
    const w = wsSession(W1, CREATE_TOKEN)
    await w.open()
    w.send({ op: "init", attach: { id: SID, secret: SECRET, authLogin: "live", authPassword: "gate" } })
    ok("T27a re-attach ok", (await w.wait("init")).ok === true)
    ok("T27a2 ack reports the live gate (auth:true)", (await w.lastInit()).auth === true, JSON.stringify(await w.lastInit()))
    ok("T27b gate applied live (no reconnect)", (await req(W1, "GET", `/api/share/${SID}/data`)).status === 401)
    const login = await req(W1, "POST", `/api/share/${SID}/auth`, { body: { login: "live", password: "gate" } })
    const setCookie27 = login.res?.headers?.get?.("set-cookie") ?? ""
    const cookie27 = /osh_[0-9a-f]+=([^;]+)/.exec(setCookie27)?.[1] ?? ""
    ok("T27c viewer can log in", login.status === 200 && cookie27.length > 20, `${login.status} ${setCookie27.slice(0, 40)}`)
    w.send({ op: "init", attach: { id: SID, secret: SECRET, authLogin: "", authPassword: "" } })
    // wait("init") resolves from the log's FIRST ack; poll for the second
    let ack27d = null
    for (let i = 0; i < 50 && !ack27d; i++) {
      await new Promise((r) => setTimeout(r, 200))
      const inits = w.logOf("init")
      if (inits.length >= 2) ack27d = inits.at(-1)
    }
    ok("T27d empty pair re-attach ok", ack27d?.ok === true, JSON.stringify(ack27d))
    ok("T27d2 ack reports no gate after removal (auth:false)", ack27d?.auth === false, JSON.stringify(ack27d))
    ok("T27e gate removed live", (await req(W1, "GET", `/api/share/${SID}/data`)).status === 200)
    w.close()
    await req(W1, "DELETE", `/api/share/${SID}`, { body: { secret: SECRET } })
  }

  // T29 - free-form meta on WS create (B5): the plugin's labels ride the
  // create frame, the ack carries the resolved auth flag, and the admin
  // shares listing exposes the custom object on both backends
  {
    const w = wsSession(W1, CREATE_TOKEN)
    await w.open()
    w.send({ op: "init", create: { sessionID: "ses_meta", ttlDays: 5, authLogin: "", authPassword: "", meta: { run: "ci-42", branch: "main" } } })
    const init29 = await w.wait("init")
    const SID29 = init29.id ?? ""
    ok("T29 meta create ok", init29.ok === true && !!SID29, JSON.stringify(init29))
    ok("T29a create ack reports no gate (auth:false)", init29.auth === false, JSON.stringify(init29))
    w.send({ op: "init", create: { sessionID: "ses_meta2", authLogin: "m", authPassword: "g", meta: { k: "v" } } })
    let init29b = init29
    for (let i = 0; i < 50 && init29b === init29; i++) {
      await new Promise((r) => setTimeout(r, 200))
      init29b = await w.lastInit()
    }
    ok("T29b gated create ack reports auth:true", init29b.ok === true && init29b.auth === true, JSON.stringify(init29b))
    w.close()
    const admin = await req(W1, "GET", "/api/admin/shares", { token: CREATE_TOKEN })
    const all = admin.json?.shares ?? []
    const mine = all.find((s) => s.id === SID29)
    ok("T29c admin listing carries custom meta", mine?.custom?.run === "ci-42" && mine?.custom?.branch === "main", JSON.stringify(mine?.custom))
    await req(W1, "DELETE", `/api/share/${SID29}`, { body: { secret: init29.secret } })
    await req(W1, "DELETE", `/api/share/${init29b.id}`, { body: { secret: init29b.secret } })
  }

  // T28 - revocation freezes control (owner rule): a user whose LAST valid
  // token is revoked loses control of ALL their shares - user token AND
  // share secret both - while viewing continues; rotation keeps control
  {
    const u4 = await req(W1, "POST", "/api/admin/users", { token: CREATE_TOKEN, body: { label: "revokeme" } })
    const U4 = u4.json?.userId ?? ""
    const t4a = await req(W1, "POST", "/api/admin/tokens", { token: CREATE_TOKEN, body: { userId: U4 } })
    const T4 = t4a.json?.token ?? ""
    const sh = await req(W1, "POST", CREATE, { token: T4, body: { sessionID: "ses_rev" } })
    const RS = sh.json?.id ?? ""
    const RSEC = sh.json?.secret ?? ""
    ok("T28 user+token+share staged", sh.json?.ok === true)
    // rotate first: old token dies, fresh one keeps control
    const rot = await req(W1, "POST", "/api/token/rotate", { token: T4 })
    ok("T28a rotate mints a replacement", rot.json?.ok === true && !!rot.json?.token, JSON.stringify(rot.json))
    const T4b = rot.json?.token ?? ""
    ok("T28b rotation keeps control", (await req(W1, "POST", `/api/share/${RS}/sync`, { body: { secret: RSEC, data: [{ type: "message", data: { id: "msg_rot", role: "user" } }] } })).json?.ok === true)
    // revoke the (rotated) only token: everything freezes
    const rev = await req(W1, "DELETE", "/api/token", { token: T4b })
    ok("T28c self-revoke reports freeze", rev.json?.ok === true && rev.json?.frozen === true, JSON.stringify(rev.json))
    const deadSecret = await req(W1, "POST", `/api/share/${RS}/sync`, { body: { secret: RSEC, data: [{ type: "message", data: { id: "msg_dead", role: "user" } }] } })
    ok("T28d secret path frozen after revoke", deadSecret.status === 403 && deadSecret.json?.error === "frozen", `${deadSecret.status} ${deadSecret.json?.error}`)
    const deadToken = await req(W1, "GET", "/api/me", { token: T4b })
    ok("T28e revoked token dead", deadToken.status === 401, String(deadToken.status))
    ok("T28f viewing unaffected", (await req(W1, "GET", `/api/share/${RS}/data`)).status === 200)
    ok("T28g admin unfreeze is the rescue", (await req(W1, "POST", `/api/admin/users/${U4}/unfreeze`, { token: CREATE_TOKEN })).json?.ok === true)
    const rescued = await req(W1, "POST", `/api/share/${RS}/sync`, { body: { secret: RSEC, data: [{ type: "message", data: { id: "msg_rescue", role: "user" } }] } })
    ok("T28h unfreeze restores the secret path", rescued.json?.ok === true, JSON.stringify(rescued.json))
    await req(W1, "DELETE", `/api/admin/users/${U4}`, { token: CREATE_TOKEN, body: { mode: "delete" } })
  }

  // T17 — freeze severs both control paths, keeps view
  ok("T17 freeze user", (await req(W1, "POST", `/api/admin/users/${U1}/freeze`, { token: CREATE_TOKEN })).json?.ok === true)
  const frozenSecretSync = await req(W1, "POST", `/api/share/${U1_SHARE}/sync`, { body: { secret: U1_SECRET, data: [{ type: "message", data: { id: "msg_frozen", role: "user" } }] } })
  ok("T17b secret sync rejected (frozen)", frozenSecretSync.status === 403 && frozenSecretSync.json?.error === "frozen", `${frozenSecretSync.status} ${frozenSecretSync.json?.error}`)
  ok("T17c view unaffected", (await req(W1, "GET", `/api/share/${U1_SHARE}/data`)).status === 200)
  const ws5 = wsSession(W1, A2)
  await ws5.open()
  ws5.send({ op: "init", attach: { id: U1_SHARE, secret: U1_SECRET } })
  ok("T17d token attach dead on frozen", (await ws5.wait("init")).ok === false)
  ws5.close()
  const rootSync = await req(W1, "POST", `/api/share/${U1_SHARE}/sync`, { token: CREATE_TOKEN, body: { data: [{ type: "message", data: { id: "msg_root_ok", role: "user" } }] } })
  ok("T17e root bypasses freeze", rootSync.json?.ok === true, JSON.stringify(rootSync.json))
  ok("T17f unfreeze restores", (await req(W1, "POST", `/api/admin/users/${U1}/unfreeze`, { token: CREATE_TOKEN })).json?.ok === true
    && (await req(W1, "POST", `/api/share/${U1_SHARE}/sync`, { body: { secret: U1_SECRET, data: [{ type: "message", data: { id: "msg_back", role: "user" } }] } })).json?.ok === true)

  // T18 — user delete: default freezes; mode=delete removes everything
  const u3 = await req(W1, "POST", "/api/admin/users", { token: CREATE_TOKEN, body: { label: "doomed" } })
  const U3 = u3.json?.userId ?? ""
  const u3tok = await req(W1, "POST", "/api/admin/tokens", { token: CREATE_TOKEN, body: { userId: U3 } })
  const C = u3tok.json?.token ?? ""
  const u3share = await req(W1, "POST", CREATE, { token: C, body: { sessionID: "ses_doomed" } })
  ok("T18 user+token+share staged", u3share.json?.ok === true)
  ok("T18b default delete freezes", (await req(W1, "DELETE", `/api/admin/users/${U2}`, { token: CREATE_TOKEN })).json?.frozen === true)
  const delResp = await req(W1, "DELETE", `/api/admin/users/${U3}`, { token: CREATE_TOKEN, body: { mode: "delete" } })
  ok("T18c mode=delete removes shares", delResp.json?.mode === "delete", JSON.stringify(delResp.json))
  ok("T18d deleted share gone", (await req(W1, "GET", `/api/share/${u3share.json.id}/data`)).json?.status === "gone")
  ok("T18e deleted user's token dead", (await req(W1, "GET", "/api/me", { token: C })).status === 401)

  // T19 — reassign moves ownership (rescue path)
  const u4 = await req(W1, "POST", "/api/admin/users", { token: CREATE_TOKEN, body: { label: "rescue" } })
  const U4 = u4.json?.userId ?? ""
  const u4tok = await req(W1, "POST", "/api/admin/tokens", { token: CREATE_TOKEN, body: { userId: U4 } })
  const D = u4tok.json?.token ?? ""
  const u4share = await req(W1, "POST", CREATE, { token: D, body: { sessionID: "ses_rescue" } })
  ok("T19 reassign executes", (await req(W1, "POST", `/api/admin/shares/${u4share.json.id}/reassign`, { token: CREATE_TOKEN, body: { userId: U1 } })).json?.ok === true)
  const rescued = await req(W1, "POST", `/api/share/${u4share.json.id}/sync`, { token: A2, body: { data: [{ type: "message", data: { id: "msg_rescue", role: "user" } }] } })
  ok("T19b new owner controls via token", rescued.json?.ok === true, JSON.stringify(rescued.json))
  const meShares2 = (await req(W1, "GET", "/api/me/shares", { token: A2 })).json?.shares ?? []
  ok("T19c registry moved", meShares2.some((s) => s.id === u4share.json.id))

  // T30 — token classes: FULL mints SCOPED; scoped creates/touches ONLY
  // its own shares; scoped cannot mint or edit settings; scoped self-
  // rotate stays scoped; scoped listing shows only its shares
  {
    const u5 = await req(W1, "POST", "/api/admin/users", { token: CREATE_TOKEN, body: { label: "token-classes" } })
    const full = await req(W1, "POST", "/api/admin/tokens", { token: CREATE_TOKEN, body: { userId: u5.json?.userId } })
    const FULL = full.json?.token
    ok("T30 full token minted", typeof FULL === "string", JSON.stringify(full.json))
    // full creates share A
    const shareA = await req(W1, "POST", CREATE, { token: FULL, body: { sessionID: "ses_t30a" } })
    ok("T30a full creates share A", shareA.json?.ok === true, JSON.stringify(shareA.json))
    // full self-mints a scoped token
    const scopedMint = await req(W1, "POST", "/api/token", { token: FULL, body: { kind: "scoped", label: "ci" } })
    const SCOPED = scopedMint.json?.token
    ok("T30b full self-mints scoped", scopedMint.json?.ok === true && scopedMint.json?.kind === "scoped", JSON.stringify(scopedMint.json))
    // scoped creates share B (allowed within limits)
    const shareB = await req(W1, "POST", CREATE, { token: SCOPED, body: { sessionID: "ses_t30b" } })
    ok("T30c scoped creates its own share", shareB.json?.ok === true, JSON.stringify(shareB.json))
    // scoped CANNOT sync share A (created by the full token)
    const touchA = await req(W1, "POST", `/api/share/${shareA.json?.id}/sync`, { token: SCOPED, body: { data: [{ type: "message", data: { id: "msg_x", role: "user" } }] } })
    ok("T30d scoped cannot touch the full token's share", touchA.json?.ok === false, JSON.stringify(touchA.json))
    // scoped CAN sync its own share B
    const touchB = await req(W1, "POST", `/api/share/${shareB.json?.id}/sync`, { token: SCOPED, body: { data: [{ type: "message", data: { id: "msg_y", role: "user" } }] } })
    ok("T30e scoped syncs its own share", touchB.json?.ok === true, JSON.stringify(touchB.json))
    // scoped cannot mint
    const scopedMint2 = await req(W1, "POST", "/api/token", { token: SCOPED, body: { kind: "scoped" } })
    ok("T30f scoped cannot mint", scopedMint2.status === 403, JSON.stringify(scopedMint2.json))
    // scoped cannot edit user settings
    const scopedSet = await req(W1, "PUT", "/api/me/settings", { token: SCOPED, body: { defaultTtlDays: 5 } })
    ok("T30g scoped cannot edit settings", scopedSet.status === 403, JSON.stringify(scopedSet.json))
    // scoped listing shows ONLY share B
    const scopedList = await req(W1, "GET", "/api/me/shares", { token: SCOPED })
    const ids = (scopedList.json?.shares ?? []).map((s) => s.id)
    ok("T30h scoped lists only its shares", ids.includes(shareB.json?.id) && !ids.includes(shareA.json?.id), JSON.stringify(ids))
    // scoped self-rotate stays scoped, and the successor still reaches B
    const rot = await req(W1, "POST", "/api/token/rotate", { token: SCOPED })
    ok("T30i scoped rotation stays scoped", rot.json?.ok === true && rot.json?.tokenKind === "scoped", JSON.stringify(rot.json))
    const touchB2 = await req(W1, "POST", `/api/share/${shareB.json?.id}/sync`, { token: rot.json?.token, body: { data: [{ type: "message", data: { id: "msg_z", role: "user" } }] } })
    ok("T30j rotated scoped still reaches its share", touchB2.json?.ok === true, JSON.stringify(touchB2.json))
    // T31 — revoking the LAST full token freezes everything INCLUDING
    // scoped shares (scoped never keeps the account alive)
    const scopedRow = (await req(W1, "GET", "/api/admin/tokens", { token: CREATE_TOKEN })).json?.tokens ?? []
    const fullId = scopedRow.find((t) => t.userId === u5.json?.userId && t.kind === "full" && !t.revoked)?.id
    const revFull = await req(W1, "DELETE", `/api/admin/tokens/${fullId}`, { token: CREATE_TOKEN })
    ok("T31 last full revoked -> frozen", revFull.json?.ok === true && revFull.json?.frozen === true, JSON.stringify(revFull.json))
    const afterFreeze = await req(W1, "POST", `/api/share/${shareB.json?.id}/sync`, { token: rot.json?.token, body: { data: [] } })
    ok("T31b scoped path severed too", afterFreeze.json?.ok === false, JSON.stringify(afterFreeze.json))
    const viewStill = await req(W1, "GET", `/api/share/${shareB.json?.id}/data`)
    ok("T31c viewing untouched", viewStill.status === 200, String(viewStill.status))
    await req(W1, "DELETE", `/api/share/${shareB.json?.id}`, { token: CREATE_TOKEN, body: {} })
    await req(W1, "DELETE", `/api/share/${shareA.json?.id}`, { token: CREATE_TOKEN, body: {} })
  }

  // T32 — freeze-by-token bulk op: freezes only the shares one token
  // created, leaving the owner's other shares writable
  {
    const u6 = await req(W1, "POST", "/api/admin/users", { token: CREATE_TOKEN, body: { label: "bulk" } })
    const t6full = await req(W1, "POST", "/api/admin/tokens", { token: CREATE_TOKEN, body: { userId: u6.json?.userId } })
    const T6FULL = t6full.json?.token
    const s6own = await req(W1, "POST", CREATE, { token: T6FULL, body: { sessionID: "ses_t32own" } })
    const t6scoped = await req(W1, "POST", "/api/token", { token: T6FULL, body: { kind: "scoped", label: "ci2" } })
    const T6SCOPED = t6scoped.json?.token
    const s6ci = await req(W1, "POST", CREATE, { token: T6SCOPED, body: { sessionID: "ses_t32ci" } })
    // find the scoped token's row id for the bulk op
    const rows6 = (await req(W1, "GET", "/api/admin/tokens", { token: CREATE_TOKEN })).json?.tokens ?? []
    const scopedId6 = rows6.find((t) => t.userId === u6.json?.userId && t.kind === "scoped" && !t.revoked)?.id
    const bulk = await req(W1, "POST", `/api/admin/tokens/${scopedId6}/freeze-shares`, { token: CREATE_TOKEN, body: {} })
    ok("T32 freeze-by-token froze the scoped shares", bulk.json?.ok === true && bulk.json?.shares === 1, JSON.stringify(bulk.json))
    const ciTouch = await req(W1, "POST", `/api/share/${s6ci.json?.id}/sync`, { token: T6SCOPED, body: { data: [] } })
    ok("T32a frozen CI share refuses writes", ciTouch.json?.ok === false, JSON.stringify(ciTouch.json))
    const ownTouch = await req(W1, "POST", `/api/share/${s6own.json?.id}/sync`, { token: T6FULL, body: { data: [{ type: "message", data: { id: "msg_t32", role: "user" } }] } })
    ok("T32b owner's other share untouched", ownTouch.json?.ok === true, JSON.stringify(ownTouch.json))
    await req(W1, "DELETE", `/api/share/${s6ci.json?.id}`, { token: CREATE_TOKEN, body: {} })
    await req(W1, "DELETE", `/api/share/${s6own.json?.id}`, { token: CREATE_TOKEN, body: {} })
  }

  // T33 — code-lineage revoke: one call kills every token of every user
  // the code onboarded and freezes their shares
  {
    const linCode = await req(W1, "POST", "/api/admin/codes", { token: CREATE_TOKEN, body: { label: "lineage", activations: 2 } })
    const e1 = await req(W1, "POST", "/api/enroll", { body: { code: linCode.json?.code, label: "lin-1" } })
    const e1share = await req(W1, "POST", CREATE, { token: e1.json?.token, body: { sessionID: "ses_t33" } })
    ok("T33 lineage user enrolled + shared", e1.json?.ok === true && e1share.json?.ok === true, JSON.stringify(e1.json))
    const linRevoke = await req(W1, "POST", `/api/admin/codes/${linCode.json?.id}/revoke-lineage`, { token: CREATE_TOKEN, body: {} })
    ok("T33a lineage revoke hit the user", linRevoke.json?.ok === true && linRevoke.json?.users === 1 && linRevoke.json?.revoked >= 1, JSON.stringify(linRevoke.json))
    const deadTouch = await req(W1, "POST", `/api/share/${e1share.json?.id}/sync`, { token: e1.json?.token, body: { data: [] } })
    ok("T33b lineage user's token dead", deadTouch.json?.ok === false, JSON.stringify(deadTouch.json))
    // the code itself is disabled: no further onboarding from it
    const e2 = await req(W1, "POST", "/api/enroll", { body: { code: linCode.json?.code } })
    ok("T33c code disabled after lineage revoke", e2.json?.ok === false, JSON.stringify(e2.json))
    await req(W1, "DELETE", `/api/share/${e1share.json?.id}`, { token: CREATE_TOKEN, body: {} })
  }

  // T34 — PATCH /api/share/:id (#13): edit login/pass, ttl and meta after
  // creation over REST; auth change rotates viewer tokens; scoped tokens
  // can patch only their own shares
  {
    const c34 = await req(W1, "POST", CREATE, { token: CREATE_TOKEN, body: { sessionID: "ses_t34" } })
    const SID34 = c34.json?.id ?? ""
    const SECRET34 = c34.json?.secret ?? ""
    ok("T34 share staged", !!SID34, JSON.stringify(c34.json))

  // T36 - ttlHours native: hours accepted directly, floor is one hour,
  // legacy days inputs still convert, per-token caps clamp in hours
  {
    const c36 = await req(W1, "POST", CREATE, { token: CREATE_TOKEN, body: { sessionID: "ses_t36", ttlHours: 6 } })
    ok("T36 hours-native create", c36.json?.ok === true && c36.json?.ttlHours === 6, JSON.stringify(c36.json))
    const c36b = await req(W1, "POST", CREATE, { token: CREATE_TOKEN, body: { sessionID: "ses_t36b", ttlDays: 2 } })
    ok("T36a legacy days converts x24", c36b.json?.ttlHours === 48, JSON.stringify(c36b.json))
    const p36 = await req(W1, "PATCH", `/api/share/${c36.json?.id}`, { body: { secret: c36.json?.secret, ttlHours: 1 } })
    ok("T36b PATCH one-hour floor accepted", p36.json?.ok === true && p36.json?.ttlHours === 1, JSON.stringify(p36.json))
    await req(W1, "DELETE", `/api/share/${c36.json?.id}`, { body: { secret: c36.json?.secret } })
    await req(W1, "DELETE", `/api/share/${c36b.json?.id}`, { body: { secret: c36b.json?.secret } })
  }
    // gate on via PATCH
    const p1 = await req(W1, "PATCH", `/api/share/${SID34}`, { body: { secret: SECRET34, authLogin: "u", authPassword: "p" } })
    ok("T34a PATCH sets the gate", p1.json?.ok === true && p1.json?.auth === true, JSON.stringify(p1.json))
    ok("T34b viewer needs login now", (await req(W1, "GET", `/api/share/${SID34}/data`)).status === 401)
    // viewer logs in, then a credential CHANGE rotates their token
    const l1 = await req(W1, "POST", `/api/share/${SID34}/auth`, { body: { login: "u", password: "p" } })
    const ck1 = /osh_[0-9a-f]+=([^;]+)/.exec(l1.res?.headers?.get?.("set-cookie") ?? "")?.[1] ?? ""
    const p2 = await req(W1, "PATCH", `/api/share/${SID34}`, { body: { secret: SECRET34, authLogin: "u2", authPassword: "p2" } })
    ok("T34c PATCH rotates creds", p2.json?.ok === true && p2.json?.auth === true, JSON.stringify(p2.json))
    ok("T34d old viewer token dead after rotation", ck1.length > 20 && (await req(W1, "GET", `/api/share/${SID34}/data`, { headers: { cookie: `osh_${SID34}=${ck1}` } })).status === 401)
    // gate off
    const p3 = await req(W1, "PATCH", `/api/share/${SID34}`, { body: { secret: SECRET34, authLogin: "", authPassword: "" } })
    ok("T34e PATCH removes the gate", p3.json?.ok === true && p3.json?.auth === false, JSON.stringify(p3.json))
    ok("T34f viewer reads freely again", (await req(W1, "GET", `/api/share/${SID34}/data`)).status === 200)
    // ttl + meta
    const p4 = await req(W1, "PATCH", `/api/share/${SID34}`, { body: { secret: SECRET34, ttlHours: 7, meta: { via: "patch" } } })
    ok("T34g PATCH ttl(hours)+meta", p4.json?.ok === true && p4.json?.ttlHours === 7 && p4.json?.custom?.via === "patch", JSON.stringify(p4.json))
    const admin34 = await req(W1, "GET", "/api/admin/shares", { token: CREATE_TOKEN })
    const row34 = (admin34.json?.shares ?? []).find((sh) => sh.id === SID34)
    ok("T34h admin listing carries the patched meta", row34?.custom?.via === "patch", JSON.stringify(row34?.custom))
    // half pair refused
    const p5 = await req(W1, "PATCH", `/api/share/${SID34}`, { body: { secret: SECRET34, authLogin: "x" } })
    ok("T34i half auth pair refused", p5.status === 400, JSON.stringify(p5.json))
    // wrong secret refused
    const p6 = await req(W1, "PATCH", `/api/share/${SID34}`, { body: { secret: "nope", ttlDays: 3 } })
    ok("T34j wrong secret refused", p6.json?.ok === false, JSON.stringify(p6.json))
    // scoped token cannot PATCH another token's share
    const u34 = await req(W1, "POST", "/api/admin/users", { token: CREATE_TOKEN, body: { label: "t34scoped" } })
    const t34full = await req(W1, "POST", "/api/admin/tokens", { token: CREATE_TOKEN, body: { userId: u34.json?.userId } })
    const t34scoped = await req(W1, "POST", "/api/token", { token: t34full.json?.token, body: { kind: "scoped" } })
    const p7 = await req(W1, "PATCH", `/api/share/${SID34}`, { token: t34scoped.json?.token, body: { ttlDays: 5 } })
    ok("T34k scoped cannot patch others' shares", p7.json?.ok === false, JSON.stringify(p7.json))
    await req(W1, "DELETE", `/api/share/${SID34}`, { body: { secret: SECRET34 } })
  }

  // T35 — B4 token config sets: named sets on one token; Class A applies
  // at create server-side (never transported); Class B fetch is safe
  {
    const u35 = await req(W1, "POST", "/api/admin/users", { token: CREATE_TOKEN, body: { label: "sets" } })
    const t35 = await req(W1, "POST", "/api/admin/tokens", { token: CREATE_TOKEN, body: { userId: u35.json?.userId } })
    const T35 = t35.json?.token
    // provision two sets: default (first) + "ci"
    const putSets = await req(W1, "PUT", "/api/token/sets", {
      token: T35,
      body: { sets: {
        default: { authLogin: "d", authPassword: "k", ttlDays: 11, modelLabel: "server-model" },
        ci: { ttlDays: 2, modelLabel: "ci-model", shareMode: "manual" },
      } },
    })
    ok("T35 sets provisioned", putSets.json?.ok === true && Object.keys(putSets.json?.sets ?? {}).length === 2, JSON.stringify(putSets.json))
    const raw = JSON.stringify(putSets.json ?? {})
    ok("T35a Class A never in any client response", !raw.includes("authLogin") && !raw.includes("authPassword") && !raw.includes("ttlDays"), raw.slice(0, 160))
    // GET view is Class-B-only too
    const getS = await req(W1, "GET", "/api/token/sets", { token: T35 })
    const graw = JSON.stringify(getS.json ?? {})
    ok("T35b GET view carries Class B only", getS.json?.sets?.ci?.modelLabel === "ci-model" && !graw.includes("authLogin"), graw.slice(0, 160))
    // create WITHOUT a set name: the default (first) set applies - gated,
    // ttl 11, without the client sending either
    const c35 = await req(W1, "POST", CREATE, { token: T35, body: { sessionID: "ses_t35a" } })
    ok("T35c default set applied at create (ttl 264h)", c35.json?.ok === true && c35.json?.ttlHours === 264, JSON.stringify(c35.json))
    ok("T35d default set gated the share", (await req(W1, "GET", `/api/share/${c35.json?.id}/data`)).status === 401)
    // create with set:"ci": ttl 2, NO gate
    const c35b = await req(W1, "POST", CREATE, { token: T35, body: { sessionID: "ses_t35b", set: "ci" } })
    ok("T35e named set applied (ttl 48h, ungated)", c35b.json?.ok === true && c35b.json?.ttlHours === 48, JSON.stringify(c35b.json))
    ok("T35f ci set has no gate", (await req(W1, "GET", `/api/share/${c35b.json?.id}/data`)).status === 200)
    // scoped token: reads its own sets, cannot PUT
    const sc35 = await req(W1, "POST", "/api/token", { token: T35, body: { kind: "scoped" } })
    const scGet = await req(W1, "GET", "/api/token/sets", { token: sc35.json?.token })
    ok("T35g scoped reads its sets", scGet.json?.ok === true && scGet.json?.sets?.default?.modelLabel === "server-model", JSON.stringify(scGet.json))
    const scPut = await req(W1, "PUT", "/api/token/sets", { token: sc35.json?.token, body: { sets: { x: { modelLabel: "evil" } } } })
    ok("T35h scoped cannot edit sets", scPut.status === 403, JSON.stringify(scPut.json))
    // admin PUT by id
    const admPut = await req(W1, "PUT", `/api/admin/tokens/${t35.json?.id}/sets`, { token: CREATE_TOKEN, body: { sets: { only: { ttlDays: 3 } } } })
    ok("T35i admin edits sets by id", admPut.json?.ok === true && Object.keys(admPut.json?.sets ?? {}).length === 0, JSON.stringify(admPut.json))
    await req(W1, "DELETE", `/api/share/${c35.json?.id}`, { token: CREATE_TOKEN, body: {} })
    await req(W1, "DELETE", `/api/share/${c35b.json?.id}`, { token: CREATE_TOKEN, body: {} })
  }

  // T20 — public mode worker: codeless onboarding is OFF by default, so
  // enrollment needs a code even on public; anonymous creates stay open
  console.log(`[${SUITE}] starting public-mode worker…`)
  worker2 = await startBackend(suiteDir, { port: B2_PORT, configSuffix: "pub", name: "b2", vars: { AUTH_MODE: "public" }, authMode: "public" })
  const W2 = worker2.url
  const h2 = await req(W2, "GET", "/health")
  ok("T20 health auth.mode=public", h2.json?.auth?.mode === "public")
  const noCode = await req(W2, "POST", "/api/enroll", { body: {} })
  ok("T20b codeless enrollment refused by default", noCode.status === 403 && /code required/.test(noCode.json?.error ?? ""), JSON.stringify(noCode.json))
  // code path still onboards on a public server
  const pubCode = await req(W2, "POST", "/api/admin/codes", { token: CREATE_TOKEN, body: { label: "pub", activations: 3 } })
  const pubEnroll = await req(W2, "POST", "/api/enroll", { body: { code: pubCode.json?.code } })
  ok("T20b2 code enrolls on public", pubEnroll.json?.ok === true && typeof pubEnroll.json?.token === "string", JSON.stringify(pubEnroll.json))
  ok("T20c anonymous ownerless create", (await req(W2, "POST", CREATE, { body: { sessionID: "ses_pubanon" } })).json?.ok === true)
  ok("T20d owned create with pub token", (await req(W2, "POST", CREATE, { token: pubEnroll.json?.token, body: { sessionID: "ses_pubuser" } })).json?.ok === true)

  // T20e — codeless onboarding explicitly enabled: enroll without a code
  // is allowed, on a separate instance (flag is per-deployment)
  worker3 = await startBackend(suiteDir, { port: B3_PORT, configSuffix: "pub2", name: "b3", vars: { AUTH_MODE: "public", CODELESS_ONBOARDING: "1" }, authMode: "public" })
  const W3 = worker3.url
  const clEnroll = await req(W3, "POST", "/api/enroll", { body: { label: "codeless-one" } })
  ok("T20e codeless onboarding when enabled", clEnroll.json?.ok === true && typeof clEnroll.json?.token === "string", JSON.stringify(clEnroll.json))
} catch (e) {
  failed++
  failures.push(`suite crashed: ${e?.stack || e}`)
  console.log(`CRASH ${e?.stack || e}`)
  const tail = worker1?.output?.() ?? ""
  if (tail) console.log(`--- wrangler(1) tail ---\n${tail.slice(-3000)}`)
} finally {
  try { worker1?.kill() } catch {}
  try { worker2?.kill() } catch {}
  try { worker3?.kill() } catch {}
  await waitFor(async () => false, "settle", 1500).catch(() => {})
  if (BACKEND === "wrangler") {
    killWranglerSuites(B1_PORT)
    killWranglerSuites(B2_PORT)
    killWranglerSuites(B3_PORT)
  } else {
    killPortOwners(B1_PORT)
    killPortOwners(B2_PORT)
    killPortOwners(B3_PORT)
  }
  try { rmSync(suiteDir, { recursive: true, force: true }) } catch {}
}

console.log(`\n[${SUITE}] ${passed} passed, ${failed} failed`)
if (failures.length) {
  console.log("failures:")
  for (const f of failures) console.log("  - " + f)
  process.exit(1)
}
