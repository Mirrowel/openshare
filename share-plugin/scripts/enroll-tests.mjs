// S14 — enrollment suite: the plugin's identity lifecycle against a real
// wrangler worker. No pre-existing credential — the plugin must enroll
// itself (code on private servers, nothing on public), persist the token,
// reuse it across processes, re-enroll after revocation, and block
// gracefully when enrollment is impossible.
//
// Run: npm run test:enroll

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  sleep,
  waitFor,
  httpGet,
  killWranglerSuites,
  startMockLLM,
  startWorker,
  startServe,
  stopServe,
  CREATE_TOKEN,
  WORKER_PORT,
  WORKER_URL,
  LLM_PORT,
  PROVIDER,
} from "./suite-lib.mjs"

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url))
const ROOT = here("../")
const PKG = join(ROOT, "dist", "server.js").replace(/\\/g, "/")
const W2_PORT = WORKER_PORT + 10
const W2_URL = `http://127.0.0.1:${W2_PORT}`

const WATCHDOG_MS = 14 * 60 * 1000
const watchdog = setTimeout(() => {
  console.error("WATCHDOG: suite exceeded hard time limit — aborting")
  process.exit(124)
}, WATCHDOG_MS)

const failures = []
const check = (label, ok, detail) => {
  if (ok) console.log(`PASS ${label}`)
  else {
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`)
    failures.push(label)
  }
}

async function admin(method, path, body, workerUrl = WORKER_URL) {
  const r = await httpGet(`${workerUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${CREATE_TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, json: await r.json().catch(() => null) }
}

async function createAndPrompt(serve, title) {
  const created = await httpGet(`${serve.base}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  })
  if (!created.ok) throw new Error(`session create ${created.status}`)
  const session = await created.json()
  const prompted = await httpGet(`${serve.base}/session/${session.id}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: { providerID: PROVIDER.id, modelID: PROVIDER.model },
      parts: [{ type: "text", text: `suite: ${title}` }],
    }),
    timeoutMs: 60000,
  })
  if (!prompted.ok) throw new Error(`prompt ${prompted.status}: ${(await prompted.text()).slice(0, 200)}`)
  return session.id
}

function urlFileLines(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter((l) => l.trim())
  } catch {
    return []
  }
}

const suiteDir = mkdtempSync(join(tmpdir(), "openshare-enroll-"))
const projectDir = join(suiteDir, "project")
mkdirSync(projectDir, { recursive: true })
const urlFile = join(suiteDir, "share-url.txt")

// Suite hermeticity: the repo-root openshare.local.json dev slot (prod URL
// + real root token) sits in the package's config read chain and fills in
// behind empty env vars. Env pins WORKER_URL at the local worker; options
// `createToken: ""` explicitly blanks the file-borne root token (options
// outrank files), so enrollment is genuinely the plugin's own doing.
const NEUTRAL_ROOT = { OPENSHARE_CREATE_TOKEN: "" }
const opts = (workerUrl, extra = {}) => ({ createToken: "", servers: { [workerUrl]: { active: true, ...extra } } })

const variant = (name, options) => ({ name, path: PKG, options })

let worker
let worker2
let llm
let CODE

try {
  llm = await startMockLLM()
  worker = await startWorker(suiteDir, { configSuffix: "enroll" })
  console.log("worker ready (private)")

  // a 5-activation invite code: enrollment + one re-enroll, then we
  // disable it to test the blocked path
  const codeResp = await admin("POST", "/api/admin/codes", { label: "suite", activations: 5 })
  CODE = codeResp.json?.code
  check("P0 invite code minted", typeof CODE === "string" && CODE.startsWith("osc_"), JSON.stringify(codeResp.json))

  const countUsers = async (w = WORKER_URL) => ((await admin("GET", "/api/admin/users", undefined, w)).json?.users ?? []).length

  // ---- P1: first contact enrolls via code, share is owned --------------
  let serve = await startServe(variant("enroll1", opts(WORKER_URL, { code: CODE })), suiteDir, projectDir, { ...NEUTRAL_ROOT, OPENSHARE_URL_FILE: urlFile })
  await createAndPrompt(serve, "enroll first contact")
  await waitFor(() => urlFileLines(urlFile).length >= 1, "P1 url file line", 45000)
  const users1 = (await admin("GET", "/api/admin/users")).json?.users ?? []
  check("P1 enrolled exactly one user", users1.length === 1 && users1[0].label === "suite-1", JSON.stringify(users1))
  const U1 = users1[0]?.id
  const shares1 = (await admin("GET", "/api/admin/shares")).json?.shares ?? []
  check("P1 share owned by enrolled user", shares1.length === 1 && shares1[0].ownerId === U1, JSON.stringify(shares1))

  // ---- P2: token persisted — second process reuses, no re-enroll --------
  const savedCfg = join(suiteDir, "xdg", "opencode", "openshare.config.json")
  const savedToken = existsSync(savedCfg) ? JSON.parse(readFileSync(savedCfg, "utf8")).servers?.[WORKER_URL]?.token : undefined
  check("P2 token persisted to settings home", typeof savedToken === "string" && savedToken.startsWith("osk_"), String(savedToken))
  await stopServe(serve)
  serve = await startServe(variant("enroll2", opts(WORKER_URL, { code: CODE })), suiteDir, projectDir, { ...NEUTRAL_ROOT, OPENSHARE_URL_FILE: urlFile })
  await createAndPrompt(serve, "enroll token reuse")
  await waitFor(() => urlFileLines(urlFile).length >= 2, "P2 second share", 45000)
  check("P2 no re-enrollment", (await countUsers()) === 1)
  const shares2 = (await admin("GET", "/api/admin/shares")).json?.shares ?? []
  check("P2 second share same owner", shares2.length === 2 && shares2.every((s) => s.ownerId === U1), JSON.stringify(shares2.map((s) => s.ownerId)))

  // ---- P3: revoke → token rejected → re-enroll (new identity) -----------
  const tokens = (await admin("GET", "/api/admin/tokens")).json?.tokens ?? []
  const active = tokens.filter((t) => !t.revoked && t.userId === U1)
  check("P3 user token found", active.length === 1, JSON.stringify(tokens))
  await admin("DELETE", `/api/admin/tokens/${active[0]?.id}`)
  await stopServe(serve)
  serve = await startServe(variant("enroll3", opts(WORKER_URL, { code: CODE })), suiteDir, projectDir, { ...NEUTRAL_ROOT, OPENSHARE_URL_FILE: urlFile })
  await createAndPrompt(serve, "enroll after revoke")
  await waitFor(() => urlFileLines(urlFile).length >= 3, "P3 third share", 60000)
  const users3 = (await admin("GET", "/api/admin/users")).json?.users ?? []
  check("P3 re-enrolled as new user", users3.length === 2, JSON.stringify(users3.map((u) => u.label)))
  const shares3 = (await admin("GET", "/api/admin/shares")).json?.shares ?? []
  check("P3 new share owned by new identity", shares3.length === 3 && shares3[2].ownerId !== U1, JSON.stringify(shares3.map((s) => s.ownerId)))

  // ---- P4: code disabled + token revoked → blocked, no loop ------------
  const codes = (await admin("GET", "/api/admin/codes")).json?.codes ?? []
  await admin("DELETE", `/api/admin/codes/${codes[0]?.id}`)
  const tokens4 = (await admin("GET", "/api/admin/tokens")).json?.tokens ?? []
  const u2tok = tokens4.filter((t) => !t.revoked && t.userId !== U1)
  await admin("DELETE", `/api/admin/tokens/${u2tok[0]?.id}`)
  await stopServe(serve)
  serve = await startServe(variant("enroll4", opts(WORKER_URL, { code: CODE })), suiteDir, projectDir, { ...NEUTRAL_ROOT, OPENSHARE_URL_FILE: urlFile })
  await createAndPrompt(serve, "enroll blocked path")
  await sleep(12000) // give any (wrong) share time to appear
  const shares4 = (await admin("GET", "/api/admin/shares")).json?.shares ?? []
  check("P4 no share created", shares4.length === 3, `shares=${shares4.length}`)
  check("P4 no new user", (await countUsers()) === 2)
  const out4 = serve.output()
  check("P4 failure surfaced in output", /no credential|enroll refused/i.test(out4), out4.slice(-400))
  check("P4 no reconnect storm", (out4.match(/sharing disabled/g) ?? []).length <= 3, `${(out4.match(/sharing disabled/g) ?? []).length} blocks`)

  // ---- P5: public server — zero-config enrollment ------------------------
  console.log("starting public-mode worker…")
  worker2 = await startWorker(suiteDir, { port: W2_PORT, configSuffix: "enroll-pub", vars: { AUTH_MODE: "public" } })
  await stopServe(serve)
  serve = await startServe(variant("enroll5", opts(W2_URL)), suiteDir, projectDir, { OPENSHARE_WORKER_URL: W2_URL, ...NEUTRAL_ROOT, OPENSHARE_URL_FILE: urlFile })
  await createAndPrompt(serve, "public enrollment")
  const users5 = (await admin("GET", "/api/admin/users", undefined, W2_URL)).json?.users ?? []
  check("P5 public enrollment created a user", users5.length === 1, JSON.stringify(users5))
  const shares5 = (await admin("GET", "/api/admin/shares", undefined, W2_URL)).json?.shares ?? []
  check("P5 public share owned", shares5.length === 1 && shares5[0].ownerId === users5[0]?.id, JSON.stringify(shares5))
  await stopServe(serve)
} catch (e) {
  failures.push(`suite crashed: ${e?.stack || e}`)
  console.log(`CRASH ${e?.stack || e}`)
} finally {
  clearTimeout(watchdog)
  try { await stopServe({ kill: () => {}, output: () => "" }).catch?.(() => {}) } catch {}
  try { llm?.close() } catch {}
  try { worker?.kill() } catch {}
  try { worker2?.kill() } catch {}
  await sleep(1500)
  killWranglerSuites(WORKER_PORT)
  killWranglerSuites(W2_PORT)
  try { rmSync(suiteDir, { recursive: true, force: true }) } catch {}
}

console.log(`\n[enroll] ${failures.length === 0 ? "all checks passed" : `${failures.length} FAILURES`}`)
if (failures.length) {
  for (const f of failures) console.log("  - " + f)
  process.exit(1)
}
process.exit(0)
