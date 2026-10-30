// S14 — enrollment suite: the plugin's identity lifecycle against a real
// wrangler worker. No pre-existing credential — the plugin must enroll
// itself (code on private servers, nothing on public), persist the token,
// reuse it across processes, re-enroll after revocation, and block
// gracefully when enrollment is impossible.
//
// Run: npm run test:enroll
//
// Two independent halves keep the wall clock down: the private-server
// lifecycles run as two CONCURRENT chains (own worker, serve port and
// sandbox) — first-contact/persistence, and revoke/re-enroll/blocked with
// its own rebuilt baseline — while the public-server semantics (P5/P6)
// run in their own worker.

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
  startBunServer,
  killPortOwners,
  startServe,
  stopServe,
  CREATE_TOKEN,
  WORKER_PORT,
  WORKER_URL,
  LLM_PORT,
  PROVIDER,
  SERVE_PORT,
} from "./suite-lib.mjs"

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url))
const ROOT = here("../")
const PKG = join(ROOT, "dist", "server.js").replace(/\\/g, "/")

// OPENSHARE_BACKEND=bun runs the same engine lifecycle against the
// portable Bun server (../share-server) - engine-level backend parity
const BACKEND = process.env.OPENSHARE_BACKEND === "bun" || process.argv.includes("bun") ? "bun" : "wrangler"
const B1_PORT = BACKEND === "bun" ? 8795 : WORKER_PORT
const B2_PORT = B1_PORT + 10
const W2_PORT = B1_PORT + 20
const W1_URL = BACKEND === "bun" ? `http://127.0.0.1:${B1_PORT}` : WORKER_URL
const W2_URL = `http://127.0.0.1:${W2_PORT}`
const startBackend = (suiteDir, opts = {}) =>
  BACKEND === "bun" ? startBunServer(suiteDir, { ...opts, port: opts.port ?? B1_PORT }) : startWorker(suiteDir, opts)

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

async function admin(method, path, body, workerUrl = W1_URL) {
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
// behind empty env vars. Env pins the worker URL; options `createToken: ""`
// explicitly blanks the file-borne root token (options outrank files), so
// enrollment is genuinely the plugin's own doing.
const NEUTRAL_ROOT = { OPENSHARE_CREATE_TOKEN: "", OPENSHARE_WORKER_URL: W1_URL }
const opts = (workerUrl, extra = {}) => ({ createToken: "", servers: { [workerUrl]: { active: true, ...extra } } })

const variant = (name, options) => ({ name, path: PKG, options })

let worker
let workerB
let worker2
let llm

// Public-server semantics are an independent half (own worker), so the
// matrix can run them as a parallel process; "all" keeps the suite
// runnable stand-alone.
const SHARD = process.env.OPENSHARE_ENROLL_SHARD ?? "all"
const RUN_A = SHARD === "all" || SHARD === "main" || SHARD === "a"
const RUN_B = SHARD === "all" || SHARD === "main" || SHARD === "b"
const RUN_PUBLIC = SHARD === "all" || SHARD === "public"

try {
  llm = await startMockLLM()
  if (RUN_A || RUN_B) {
    if (RUN_A) worker = await startBackend(suiteDir, { configSuffix: "enroll", name: "enroll-b1" })
    if (RUN_B) workerB = await startBackend(suiteDir, { port: B2_PORT, configSuffix: "enroll-b", name: "enroll-bb" })
    console.log("workers ready (private)")
    const WB_URL = `http://127.0.0.1:${B2_PORT}`

    // ---- chain A: first contact enrolls, token persists ------------------
    const chainA = async () => {
      const sandbox = join(suiteDir, "a")
      const project = join(sandbox, "project")
      mkdirSync(project, { recursive: true })
      const uf = join(sandbox, "share-url.txt")
      const codeA = (await admin("POST", "/api/admin/codes", { label: "suite-a", activations: 5 })).json?.code
      check("P0 invite code minted", typeof codeA === "string" && codeA.startsWith("osc_"), String(codeA))

      let s = await startServe(variant("enroll1", opts(W1_URL, { code: codeA })), sandbox, project, { ...NEUTRAL_ROOT, OPENSHARE_URL_FILE: uf }, SERVE_PORT)
      try {
        await createAndPrompt(s, "enroll first contact")
        await waitFor(() => urlFileLines(uf).length >= 1, "P1 url file line", 45000)
        const users1 = (await admin("GET", "/api/admin/users")).json?.users ?? []
        check("P1 enrolled exactly one user", users1.length === 1 && users1[0].label === "suite-a-1", JSON.stringify(users1))
        const U1 = users1[0]?.id
        const shares1 = (await admin("GET", "/api/admin/shares")).json?.shares ?? []
        check("P1 share owned by enrolled user", shares1.length === 1 && shares1[0].ownerId === U1, JSON.stringify(shares1))

        // ---- P2: token persisted — second process reuses, no re-enroll ----
        const savedCfg = join(sandbox, "xdg", "opencode", "openshare.config.json")
        const savedToken = existsSync(savedCfg) ? JSON.parse(readFileSync(savedCfg, "utf8")).servers?.[W1_URL]?.token : undefined
        check("P2 token persisted to settings home", typeof savedToken === "string" && savedToken.startsWith("osk_"), String(savedToken))
        await stopServe(s)
        s = await startServe(variant("enroll2", opts(W1_URL, { code: codeA })), sandbox, project, { ...NEUTRAL_ROOT, OPENSHARE_URL_FILE: uf }, SERVE_PORT)
        await createAndPrompt(s, "enroll token reuse")
        await waitFor(() => urlFileLines(uf).length >= 2, "P2 second share", 45000)
        check("P2 no re-enrollment", ((await admin("GET", "/api/admin/users")).json?.users ?? []).length === 1, JSON.stringify(((await admin("GET", "/api/admin/users")).json?.users ?? []).map((u) => u.label)))
        const shares2 = (await admin("GET", "/api/admin/shares")).json?.shares ?? []
        check("P2 second share same owner", shares2.length === 2 && shares2.every((x) => x.ownerId === U1), JSON.stringify(shares2))
      } finally {
        await stopServe(s)
      }
    }

    // ---- chain B: revoke → re-enroll → blocked, own baseline -------------
    const chainB = async () => {
      const sandbox = join(suiteDir, "b")
      const project = join(sandbox, "project")
      mkdirSync(project, { recursive: true })
      const uf = join(sandbox, "share-url.txt")
      const adminB = (method, path, body) => admin(method, path, body, WB_URL)
      const envB = { OPENSHARE_CREATE_TOKEN: "", OPENSHARE_WORKER_URL: WB_URL, OPENSHARE_URL_FILE: uf }
      const codeB = (await adminB("POST", "/api/admin/codes", { label: "suite-b", activations: 5 })).json?.code

      let s = await startServe(variant("reenroll1", opts(WB_URL, { code: codeB })), sandbox, project, envB, SERVE_PORT + 10)
      try {
        await createAndPrompt(s, "reenroll baseline")
        await waitFor(() => urlFileLines(uf).length >= 1, "P3 baseline share", 60000)
        const usersB1 = (await adminB("GET", "/api/admin/users")).json?.users ?? []
        check("P3 baseline user", usersB1.length === 1, JSON.stringify(usersB1))
        const UB1 = usersB1[0]?.id

        // ---- P3: revoke → token rejected → re-enroll (new identity) -------
        const tokens = (await adminB("GET", "/api/admin/tokens")).json?.tokens ?? []
        const active = tokens.filter((t) => !t.revoked && t.userId === UB1)
        check("P3 user token found", active.length === 1, JSON.stringify(tokens))
        await adminB("DELETE", `/api/admin/tokens/${active[0]?.id}`)
        await stopServe(s)
        s = await startServe(variant("reenroll2", opts(WB_URL, { code: codeB })), sandbox, project, envB, SERVE_PORT + 10)
        await createAndPrompt(s, "enroll after revoke")
        await waitFor(() => urlFileLines(uf).length >= 2, "P3 re-enrolled share", 60000)
        const usersB3 = (await adminB("GET", "/api/admin/users")).json?.users ?? []
        check("P3 re-enrolled as new user", usersB3.length === 2, JSON.stringify(usersB3.map((u) => u.label)))
        const UB2 = usersB3.find((u) => u.id !== UB1)?.id
        const sharesB3 = (await adminB("GET", "/api/admin/shares")).json?.shares ?? []
        check(
          "P3 new share owned by new identity",
          sharesB3.length === 2 && UB2 !== undefined && sharesB3.filter((x) => x.ownerId === UB2).length === 1 && sharesB3.filter((x) => x.ownerId === UB1).length === 1,
          JSON.stringify(sharesB3.map((x) => x.ownerId)),
        )

        // ---- P4: code disabled + token revoked → blocked, no loop ---------
        const codes = (await adminB("GET", "/api/admin/codes")).json?.codes ?? []
        await adminB("DELETE", `/api/admin/codes/${codes[0]?.id}`)
        const tokens4 = (await adminB("GET", "/api/admin/tokens")).json?.tokens ?? []
        const u2tok = tokens4.filter((t) => !t.revoked && t.userId !== UB1)
        await adminB("DELETE", `/api/admin/tokens/${u2tok[0]?.id}`)
        await stopServe(s)
        s = await startServe(variant("reenroll3", opts(WB_URL, { code: codeB })), sandbox, project, envB, SERVE_PORT + 10)
        await createAndPrompt(s, "enroll blocked path")
        await sleep(5000) // ample at a 300ms debounce: any (wrong) share would already exist
        const shares4 = (await adminB("GET", "/api/admin/shares")).json?.shares ?? []
        check("P4 no share created", shares4.length === 2, `shares=${shares4.length}`)
        check("P4 no new user", ((await adminB("GET", "/api/admin/users")).json?.users ?? []).length === 2)
        const out4 = s.output()
        check("P4 failure surfaced in output", /no credential|enroll refused/i.test(out4), out4.slice(-400))
        check("P4 no reconnect storm", (out4.match(/sharing disabled/g) ?? []).length <= 3, `${(out4.match(/sharing disabled/g) ?? []).length} blocks`)
      } finally {
        await stopServe(s)
      }
    }

    await Promise.all([RUN_A ? chainA() : undefined, RUN_B ? chainB() : undefined])
  }

  if (RUN_PUBLIC) {
    // ---- P5: public server — zero-config shares ANONYMOUSLY ----------------
    // (no silent auto-enroll: a public server with no configured code/token
    // shares without an account; the ask-once TUI flow is where onboarding
    // happens)
    console.log("starting public-mode worker…")
    worker2 = await startBackend(suiteDir, { port: W2_PORT, configSuffix: "enroll-pub", name: "enroll-b2", authMode: "public", vars: { AUTH_MODE: "public" } })
    let s = await startServe(variant("enroll5", opts(W2_URL)), suiteDir, projectDir, { OPENSHARE_W1_URL: W2_URL, ...NEUTRAL_ROOT, OPENSHARE_URL_FILE: urlFile })
    try {
      await createAndPrompt(s, "public anonymous")
      const users5 = (await admin("GET", "/api/admin/users", undefined, W2_URL)).json?.users ?? []
      check("P5 public zero-config creates NO user", users5.length === 0, JSON.stringify(users5))
      const shares5 = (await admin("GET", "/api/admin/shares", undefined, W2_URL)).json?.shares ?? []
      check("P5 public anonymous share (ownerless)", shares5.length === 1 && !shares5[0].ownerId, JSON.stringify(shares5))
      const out5 = s.output()
      check("P5 no enroll noise", !/enrolled at|enroll refused/i.test(out5), out5.slice(-300))
      await stopServe(s)

      // ---- P6: public + configured code = expressed intent, engine enrolls --
      const code6 = (await admin("POST", "/api/admin/codes", { label: "ci" }, W2_URL)).json
      s = await startServe(variant("enroll6", opts(W2_URL, { code: code6?.code })), suiteDir, projectDir, { OPENSHARE_W1_URL: W2_URL, ...NEUTRAL_ROOT, OPENSHARE_URL_FILE: urlFile })
      await createAndPrompt(s, "public with code")
      const users6 = (await admin("GET", "/api/admin/users", undefined, W2_URL)).json?.users ?? []
      check("P6 configured code enrolls (headless intent)", users6.length === 1, JSON.stringify(users6))
      const shares6 = (await admin("GET", "/api/admin/shares", undefined, W2_URL)).json?.shares ?? []
      check("P6 code share owned", shares6.some((sh) => sh.ownerId === users6[0]?.id), JSON.stringify(shares6))
    } finally {
      await stopServe(s)
    }
  }
} catch (e) {
  failures.push(`suite crashed: ${e?.stack || e}`)
  console.log(`CRASH ${e?.stack || e}`)
} finally {
  clearTimeout(watchdog)
  try { llm?.close() } catch {}
  try { worker?.kill() } catch {}
  try { workerB?.kill() } catch {}
  try { worker2?.kill() } catch {}
  await sleep(1500)
  if (BACKEND === "wrangler") {
    killWranglerSuites(B1_PORT)
    killWranglerSuites(B2_PORT)
    killWranglerSuites(W2_PORT)
  } else {
    killPortOwners(B1_PORT)
    killPortOwners(B2_PORT)
    killPortOwners(W2_PORT)
  }
  try { rmSync(suiteDir, { recursive: true, force: true }) } catch {}
}

console.log(`\n[enroll] ${failures.length === 0 ? "all checks passed" : `${failures.length} FAILURES`}`)
if (failures.length) {
  for (const f of failures) console.log("  - " + f)
  process.exit(1)
}
process.exit(0)
