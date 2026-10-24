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
  return { open, send, wait, close }
}

// The HTTP create route requires a hex URL suffix (POST /api/share/<hex>);
// bare /api/share 404s by design — the suffix is ignored, an id is minted.
const CREATE = "/api/share/00"

// --- run -------------------------------------------------------------------

const suiteDir = mkdtempSync(join(tmpdir(), "openshare-auth-"))
let worker1
let worker2

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
  ok("T16d ttl clamped to token max", c1.json?.ttlDays === 2, String(c1.json?.ttlDays))
  // delete one via secret to free a slot and prove registry bookkeeping
  ok("T16e secret delete frees slot", (await req(W1, "DELETE", `/api/share/${c1.json.id}`, { body: { secret: c1.json.secret } })).json?.ok === true)
  ok("T16f create passes after free", (await req(W1, "POST", CREATE, { token: B, body: { sessionID: "ses_c4" } })).json?.ok === true)

  // T16g-j — user defaultTtlDays applies when create omits ttlDays (explicit wins)
  const u5 = await req(W1, "POST", "/api/admin/users", { token: CREATE_TOKEN, body: { label: "def-ttl" } })
  const U5 = u5.json?.userId ?? ""
  const u5tok = await req(W1, "POST", "/api/admin/tokens", { token: CREATE_TOKEN, body: { userId: U5, limits: { maxTtlDays: 30 } } })
  const E = u5tok.json?.token ?? ""
  ok("T16g user settings persist", (await req(W1, "PUT", "/api/me/settings", { token: E, body: { defaultTtlDays: 7 } })).json?.settings?.defaultTtlDays === 7)
  const d1 = await req(W1, "POST", CREATE, { token: E, body: { sessionID: "ses_defttl" } })
  ok("T16h default TTL applied on create", d1.json?.ttlDays === 7, String(d1.json?.ttlDays))
  const d2 = await req(W1, "POST", CREATE, { token: E, body: { sessionID: "ses_defttl2", ttlDays: 3 } })
  ok("T16i explicit ttlDays beats default", d2.json?.ttlDays === 3, String(d2.json?.ttlDays))
  const ws6 = wsSession(W1, E)
  await ws6.open()
  ws6.send({ op: "init", create: { sessionID: "ses_defttlws" } })
  const ws6init = await ws6.wait("init")
  ok("T16j ws create applies default TTL", ws6init.ok === true && ws6init.ttlDays === 7, JSON.stringify(ws6init).slice(0, 120))
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

  // T23 — route shape: share-referencing paths need a real 32-hex id
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
    await req(W1, "DELETE", `/api/share/${SID}`, { body: { secret: SECRET } })
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

  // T20 — public mode worker: open enrollment + anonymous creates
  console.log(`[${SUITE}] starting public-mode worker…`)
  worker2 = await startBackend(suiteDir, { port: B2_PORT, configSuffix: "pub", name: "b2", vars: { AUTH_MODE: "public" }, authMode: "public" })
  const W2 = worker2.url
  const h2 = await req(W2, "GET", "/health")
  ok("T20 health auth.mode=public", h2.json?.auth?.mode === "public")
  const pubEnroll = await req(W2, "POST", "/api/enroll", { body: {} })
  ok("T20b open enrollment", pubEnroll.json?.ok === true && typeof pubEnroll.json?.token === "string")
  ok("T20c anonymous ownerless create", (await req(W2, "POST", CREATE, { body: { sessionID: "ses_pubanon" } })).json?.ok === true)
  ok("T20d owned create with pub token", (await req(W2, "POST", CREATE, { token: pubEnroll.json?.token, body: { sessionID: "ses_pubuser" } })).json?.ok === true)
} catch (e) {
  failed++
  failures.push(`suite crashed: ${e?.stack || e}`)
  console.log(`CRASH ${e?.stack || e}`)
  const tail = worker1?.output?.() ?? ""
  if (tail) console.log(`--- wrangler(1) tail ---\n${tail.slice(-3000)}`)
} finally {
  try { worker1?.kill() } catch {}
  try { worker2?.kill() } catch {}
  await waitFor(async () => false, "settle", 1500).catch(() => {})
  if (BACKEND === "wrangler") {
    killWranglerSuites(B1_PORT)
    killWranglerSuites(B2_PORT)
  } else {
    killPortOwners(B1_PORT)
    killPortOwners(B2_PORT)
  }
  try { rmSync(suiteDir, { recursive: true, force: true }) } catch {}
}

console.log(`\n[${SUITE}] ${passed} passed, ${failed} failed`)
if (failures.length) {
  console.log("failures:")
  for (const f of failures) console.log("  - " + f)
  process.exit(1)
}
