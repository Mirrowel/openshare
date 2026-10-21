// S16 - big-session suite: sharded item storage, byte-aware chunked sync,
// oversize fit, tombstone cascade at scale, per-frame last-wins semantics.
// Pure HTTP against the real backend — wrangler dev (default) or the
// portable Bun server (OPENSHARE_BACKEND=bun / argv "bun") for parity.
//
// Run: npm run test:big  (matrix-reusable on the shared worker)

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CREATE_TOKEN,
  WORKER_PORT,
  killPortOwners,
  killWranglerSuites,
  startBunServer,
  startWorker,
  waitFor,
} from "./suite-lib.mjs"

const BACKEND = process.env.OPENSHARE_BACKEND === "bun" || process.argv.includes("bun") ? "bun" : "wrangler"
const startBackend = (dir) => (BACKEND === "bun" ? startBunServer(dir, { port: WORKER_PORT }) : startWorker(dir))

const SUITE = BACKEND === "bun" ? "big(bun)" : "big"
let passed = 0
let failed = 0
const failures = []

function ok(name, cond, detail = "") {
  if (cond) {
    passed++
    console.log(`  ok  ${name}`)
  } else {
    failed++
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`)
    console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`)
  }
}

async function req(url, method, path, { token, body, timeoutMs = 30000 } = {}) {
  const headers = { "content-type": "application/json" }
  if (token) headers.authorization = `Bearer ${token}`
  const r = await fetch(url + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json = null
  try { json = await r.json() } catch {}
  return { status: r.status, json }
}

// The plugin's chunk budget, mirrored here: min(200 items, 512KB)/frame.
function chunkItems(items, maxItems, maxBytes) {
  const chunks = []
  let cur = []
  let curBytes = 0
  for (const it of items) {
    const n = JSON.stringify(it).length
    if (cur.length && (cur.length >= maxItems || curBytes + n > maxBytes)) {
      chunks.push(cur)
      cur = []
      curBytes = 0
    }
    cur.push(it)
    curBytes += n
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

const CREATE = "/api/share/00" // hex-suffix route; bare /api/share 404s
const suiteDir = mkdtempSync(join(tmpdir(), "openshare-big-"))
let worker

try {
  console.log(`[${SUITE}] starting ${BACKEND} backend…`)
  worker = await startBackend(suiteDir)
  const W = worker.url

  // ---- B1: 3,000-item backfill via chunked syncs -------------------------
  const created = await req(W, "POST", CREATE, { token: CREATE_TOKEN, body: { sessionID: "ses_big" } })
  ok("B1 share created", created.json?.ok === true && typeof created.json?.secret === "string", JSON.stringify(created.json).slice(0, 160))
  const ID = created.json?.id ?? ""
  const SECRET = created.json?.secret ?? ""

  const items = [{ type: "session", data: { id: "ses_big", title: "big" } }]
  const PARTS_PER_MSG = 2
  const MSGS = 999
  for (let m = 0; m < MSGS; m++) {
    const mid = `msg_big_${String(m).padStart(4, "0")}`
    items.push({ type: "message", data: { id: mid, role: m % 2 ? "assistant" : "user", sessionID: "ses_big" } })
    for (let p = 0; p < PARTS_PER_MSG; p++) {
      items.push({ type: "part", data: { id: `prt_${m}_${p}`, messageID: mid, type: "text", text: `turn ${m} part ${p} — the quick brown fox jumps over the lazy dog `.repeat(4) } })
    }
  }
  items.push({ type: "session_diff", sessionID: "ses_big", data: { files: [{ file: "a.ts", status: "modified", patch: "@@ -1 +1 @@" }] } })
  items.push({ type: "prefs", data: { view: "classic" } })
  const TOTAL = 1 + MSGS * (1 + PARTS_PER_MSG) + 1 + 1
  ok("B1 fixture is 3000 items", TOTAL === 3000, String(TOTAL))

  const chunks = chunkItems(items, 200, 512 * 1024)
  ok("B1 backfill rides multiple chunks", chunks.length >= 10, String(chunks.length))
  let syncFail = 0
  let lastRev = 0
  for (const chunk of chunks) {
    const r = await req(W, "POST", `/api/share/${ID}/sync`, { body: { secret: SECRET, data: chunk, status: "live" } })
    if (!r.json?.ok) syncFail++
    else lastRev = r.json.rev ?? lastRev
  }
  ok("B1 every chunk sync ok", syncFail === 0, `${syncFail}/${chunks.length} failed`)
  ok("B1 rev advanced per chunk", lastRev >= chunks.length, `${lastRev} vs ${chunks.length}`)

  const d1 = await req(W, "GET", `/api/share/${ID}/data`, { timeoutMs: 60000 })
  ok("B1 /data holds all 3000", (d1.json?.data ?? []).length === TOTAL, String(d1.json?.data?.length))
  const ids = new Set((d1.json?.data ?? []).filter((i) => i?.type === "message").map((i) => i.data?.id))
  ok("B1 first+last messages present", ids.has("msg_big_0000") && ids.has(`msg_big_${String(MSGS - 1).padStart(4, "0")}`))
  ok("B1 session_diff + prefs present", (d1.json?.data ?? []).some((i) => i?.type === "session_diff") && (d1.json?.data ?? []).some((i) => i?.type === "prefs"))

  // ---- B2: 1.2MB parts ride intact (under the ~1.5MB fit cap) -----------
  const big1 = "x".repeat(1_200_000)
  const bigMsg = { type: "message", data: { id: "msg_huge", role: "assistant", sessionID: "ses_big" } }
  const hugeParts = [1, 2, 3].map((n) => ({ type: "part", data: { id: `prt_huge_${n}`, messageID: "msg_huge", type: "text", text: big1 + `#${n}` } }))
  const r2 = await req(W, "POST", `/api/share/${ID}/sync`, { body: { secret: SECRET, data: [bigMsg, ...hugeParts] } })
  ok("B2 3×1.2MB sync ok", r2.json?.ok === true)
  const d2 = await req(W, "GET", `/api/share/${ID}/data`, { timeoutMs: 60000 })
  const gotParts = (d2.json?.data ?? []).filter((i) => i?.type === "part" && String(i?.data?.id ?? "").startsWith("prt_huge_"))
  ok("B2 huge parts intact (not truncated)", gotParts.length === 3 && gotParts.every((p) => p.data.text.length === big1.length + 2 && !p._oshTruncated), `${gotParts.length}/${gotParts.map((p) => p.data.text.length).join(",")}`)

  // ---- B3: a 2.5MB item is fitted, never wedges the share ----------------
  const oversize = { type: "part", data: { id: "prt_oversize", messageID: "msg_huge", type: "text", text: "z".repeat(2_500_000) } }
  const r3 = await req(W, "POST", `/api/share/${ID}/sync`, { body: { secret: SECRET, data: [oversize] } })
  ok("B3 oversize sync accepted", r3.json?.ok === true, JSON.stringify(r3.json).slice(0, 160))
  const d3 = await req(W, "GET", `/api/share/${ID}/data`, { timeoutMs: 60000 })
  const fitted = (d3.json?.data ?? []).find((i) => i?.data?.id === "prt_oversize")
  ok("B3 oversize fitted with marker", fitted != null && fitted._oshTruncated === true && typeof fitted.data.text === "string" && fitted.data.text.length < 2_500_000, fitted ? `len=${fitted.data.text?.length}` : "missing")
  const r3b = await req(W, "POST", `/api/share/${ID}/sync`, { body: { secret: SECRET, data: [{ type: "message", data: { id: "msg_after_oversize", role: "user", sessionID: "ses_big" } }] } })
  ok("B3 share not wedged after oversize", r3b.json?.ok === true)

  // ---- B4: tombstone cascade at scale ------------------------------------
  const casMsg = { type: "message", data: { id: "msg_cas", role: "assistant", sessionID: "ses_big" } }
  const casParts = Array.from({ length: 50 }, (_, i) => ({ type: "part", data: { id: `prt_cas_${i}`, messageID: "msg_cas", type: "text", text: `cascade ${i}` } }))
  const before = ((await req(W, "GET", `/api/share/${ID}/data`, { timeoutMs: 60000 })).json?.data ?? []).length
  const r4 = await req(W, "POST", `/api/share/${ID}/sync`, { body: { secret: SECRET, data: [casMsg, ...casParts] } })
  ok("B4 cascade fixture staged", r4.json?.ok === true)
  const mid = ((await req(W, "GET", `/api/share/${ID}/data`, { timeoutMs: 60000 })).json?.data ?? []).length
  ok("B4 staged count exact", mid === before + 51, `${before} -> ${mid}`)
  const r4b = await req(W, "POST", `/api/share/${ID}/sync`, { body: { secret: SECRET, data: [{ type: "message", data: { id: "msg_cas" }, del: true }] } })
  ok("B4 tombstone accepted", r4b.json?.ok === true)
  const after = (await req(W, "GET", `/api/share/${ID}/data`, { timeoutMs: 60000 })).json
  const afterItems = after.data ?? []
  ok("B4 cascade removed message + all 50 parts", afterItems.length === mid - 51 && !afterItems.some((i) => i?.data?.id === "msg_cas") && !afterItems.some((i) => String(i?.data?.id ?? "").startsWith("prt_cas_")), `${mid} -> ${afterItems.length}`)
  ok("B4 status still queryable", after.status === "live" || after.status === "completed", after.status)

  // ---- B5: per-frame last-wins ordering ----------------------------------
  const X = { type: "message", data: { id: "msg_lw_X", role: "user", sessionID: "ses_big" } }
  const Y = { type: "message", data: { id: "msg_lw_Y", role: "user", sessionID: "ses_big" } }
  const r5a = await req(W, "POST", `/api/share/${ID}/sync`, { body: { secret: SECRET, data: [{ ...X, del: true }, X] } })
  ok("B5 tombstone-then-upsert accepted", r5a.json?.ok === true)
  const r5b = await req(W, "POST", `/api/share/${ID}/sync`, { body: { secret: SECRET, data: [Y, { ...Y, del: true }] } })
  ok("B5 upsert-then-tombstone accepted", r5b.json?.ok === true)
  const d5 = (await req(W, "GET", `/api/share/${ID}/data`, { timeoutMs: 60000 })).json?.data ?? []
  ok("B5 last-wins: X live, Y gone", d5.some((i) => i?.data?.id === "msg_lw_X") && !d5.some((i) => i?.data?.id === "msg_lw_Y"))

  // ---- B6: status settles via sync ----------------------------------------
  const r6 = await req(W, "POST", `/api/share/${ID}/sync`, { body: { secret: SECRET, data: [], status: "completed" } })
  ok("B6 status-only sync ok", r6.json?.ok === true)
  ok("B6 status landed", ((await req(W, "GET", `/api/share/${ID}/data`, { timeoutMs: 60000 })).json ?? {}).status === "completed")

  // ---- B7: delete share cleans up ----------------------------------------
  const r7 = await req(W, "DELETE", `/api/share/${ID}`, { body: { secret: SECRET } })
  ok("B7 share deleted", r7.json?.ok === true || r7.status === 200)
  ok("B7 gone after delete", ((await req(W, "GET", `/api/share/${ID}/data`)).json ?? {}).status === "gone")
} catch (e) {
  failed++
  failures.push(`suite crashed: ${e?.stack || e}`)
  console.log(`CRASH ${e?.stack || e}`)
  const tail = worker?.output?.() ?? ""
  if (tail) console.log(`--- backend tail ---\n${tail.slice(-3000)}`)
} finally {
  try { worker?.kill() } catch {}
  await waitFor(async () => false, "settle", 1000).catch(() => {})
  if (BACKEND === "wrangler") killWranglerSuites(WORKER_PORT)
  else killPortOwners(WORKER_PORT)
  try { rmSync(suiteDir, { recursive: true, force: true }) } catch {}
}

console.log(`\n[${SUITE}] ${passed} passed, ${failed} failed`)
if (failures.length) {
  console.log("failures:")
  for (const f of failures) console.log("  - " + f)
  process.exit(1)
}
