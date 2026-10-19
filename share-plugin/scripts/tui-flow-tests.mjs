// OpenShare TUI flow tests — headless end-to-end for the share/unshare
// logic (the real share-flow.ts code paths) against a real `opencode serve`
// instance with the real server plugin, the mock LLM, and a local worker.
//
// The terminal surface (palette commands, dialog rendering, sidebar slot)
// is exercised live by the user; this suite drives the SAME flows with a
// scripted mock host (auto-consent dialogs, captured toasts/clipboard).
//
//   F1 share (first run): consent gate -> confirmShare -> binding URL +
//      clipboard capture -> backfilled share data on the worker
//   F2 share again: copies the existing link (no new share)
//   F3 unshare: flag cleared + worker page deleted (404)
//   F4 config round-trip: saveConfig writes the sandbox config file with
//      $comment preserved; currentConfig reads it back

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  sleep,
  waitFor,
  httpGet,
  killPortOwners,
  killWranglerSuites,
  startMockLLM,
  startWorker,
  startServe,
  stopServe,
  CREATE_TOKEN,
  WORKER_URL,
  WORKER_PORT,
  SERVE_PORT,
  LLM_PORT,
  PROVIDER,
  bindingUrlOf,
} from "./suite-lib.mjs"

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url))
const ROOT = here("../")
const distUrl = (name) => new URL(`../dist/${name}`, import.meta.url).href

const WATCHDOG_MS = 10 * 60 * 1000
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

// a scripted ShareHostApi: dialogs auto-answer from a queue, toasts and
// clipboard writes are captured for assertions
function mockHost(client, { consent = true } = {}) {
  const state = {
    toasts: [],
    clipboard: [],
    kv: new Map(),
    dialogAnswers: [],
    promptAnswers: [],
    menuAnswers: [],
  }
  const confirmAnswer = () => state.dialogAnswers.shift() ?? consent
  return {
    state,
    host: {
      client,
      kv: {
        get(key, fallback) {
          return state.kv.has(key) ? state.kv.get(key) : fallback
        },
        set(key, value) {
          state.kv.set(key, value)
        },
      },
      lifecycle: { onDispose() {} },
      theme: { current: {} },
      ui: {
        toast(input) {
          state.toasts.push(input)
        },
        dialog: {
          // scripted flows drive the Dialog* components directly; the
          // stack itself is a no-op in the mock
          replace() {},
          clear() {},
          setSize() {},
        },
        async showMenu(props) {
          return state.menuAnswers.shift() ?? props.options[0]?.value
        },
        async showConfirm(props) {
          return confirmAnswer()
        },
        async showAlert() {},
        async showPrompt() {
          return state.promptAnswers.shift() ?? ""
        },
        DialogSelect(props) {
          props.onSelect(props.options[0])
        },
        DialogPrompt(props) {
          props.onConfirm("")
        },
        DialogConfirm(props) {
          if (confirmAnswer()) props.onConfirm()
          else props.onCancel?.()
        },
        DialogAlert(props) {
          props.onConfirm?.()
        },
      },
      keymap: {
        registerLayer() {
          return () => {}
        },
      },
      sessionInfo: () => undefined,
      currentSessionID: () => undefined,
      clipboard: {
        async write(text) {
          state.clipboard.push(text)
          return true
        },
      },
    },
  }
}

// v1-shaped client over the serve HTTP API
function httpClient(base) {
  const call = async (method, path, body) => {
    const res = await httpGet(`${base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`)
    return { data: await res.json() }
  }
  return {
    session: {
      get: ({ path }) => call("GET", `/session/${path.id}`),
      update: ({ path, body }) => call("PATCH", `/session/${path.id}`, body),
    },
  }
}

const suiteDir = mkdtempSync(join(tmpdir(), "openshare-tuiflow-"))
console.log(`suite dir: ${suiteDir}`)

// the flows read config through the same precedence as production; env
// wins over the (unconfigured) real config file
process.env.OPENSHARE_WORKER_URL = WORKER_URL
process.env.OPENSHARE_CREATE_TOKEN = "suite-create-token"

let worker
let llm
try {
  llm = await startMockLLM()
  worker = await startWorker(suiteDir)
  console.log("worker ready")

  const sandbox = join(suiteDir, "tui")
  const projectDir = join(sandbox, "project")
  mkdirSync(projectDir, { recursive: true })
  // In-process flow calls (saveConfig default target = configHomePath)
  // must NEVER write the real settings home — redirect XDG for the whole
  // suite process (live-caught: F4 once overwrote the owner's real
  // openshare.config.json with sandbox values).
  const homeDir = join(sandbox, "xdghome")
  mkdirSync(join(homeDir, "opencode"), { recursive: true })
  process.env.XDG_CONFIG_HOME = homeDir
  // TUI presence -> manual mode on the server
  writeFileSync(join(projectDir, "tui.json"), JSON.stringify({ plugin: [join(ROOT, "dist", "tui.js").replace(/\\/g, "/")] }))

  const flowEnv = {
    OPENSHARE_WORKER_URL: WORKER_URL,
    OPENSHARE_CREATE_TOKEN: "suite-create-token",
    OPENSHARE_DEBOUNCE_MS: "300",
  }
  const serve = await startServe({ name: "tuiflow", path: join(ROOT, "dist", "server.js") }, sandbox, projectDir, flowEnv)

  const flows = await import(distUrl("share-flow.js"))
  const settings = await import(distUrl("settings.js"))
  const client = httpClient(serve.base)

  try {
    // session + real prompt (idle by the time we share)
    const created = await httpGet(`${serve.base}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "tui flow" }),
    })
    const session = await created.json()
    const sid = session.id
    await httpGet(`${serve.base}/session/${sid}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: { providerID: PROVIDER.id, modelID: PROVIDER.model },
        parts: [{ type: "text", text: "tui flow prompt" }],
      }),
      timeoutMs: 60000,
    })

    const { host, state } = mockHost(client)

    // F1: first share run hits the consent gate
    const gated = await flows.runShareFlow(host, sid)
    check("F1: consent gate before first share", gated.message === "consent required", gated.message)

    const shared = await flows.confirmShare(host, await flows.resolveRoot(client, sid))
    check("F1: confirmShare succeeds", shared.ok === true, shared.message)
    check("F1: URL copied to clipboard", state.clipboard.at(-1) === shared.url, `${state.clipboard.at(-1)} vs ${shared.url}`)

    const shareId = shared.url.split("/").pop()
    const body = await waitFor(async () => {
      const r = await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)
      if (!r.ok) throw new Error(`${r.status}`)
      const parsed = await r.json()
      const types = (parsed.data ?? []).map((i) => i.type)
      return parsed.status === "completed" && types.includes("part") && types.includes("model") ? parsed : undefined
    }, "F1: share data backfilled")
    check("F1: worker carries the backfilled share", !!body)

    // F2: share again copies the link, no new share
    const again = await flows.runShareFlow(host, sid)
    check("F2: second share copies existing link", again.ok === true && again.url === shared.url, again.message)
    const after = await httpGet(`${serve.base}/session/${sid}`)
    const bindingNow = (await after.json())?.metadata?.openshare
    check("F2: no duplicate share created", bindingUrlOf(bindingNow)?.split("/").pop() === shareId)

    // F3: unshare deletes the page and clears the flag
    const unshared = await flows.runUnshareFlow(host, sid)
    check("F3: unshare flow reports deletion", unshared.ok === true, unshared.message)
    await waitFor(async () => {
      const r = await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)
      return r.status === 404 || r.status === 410
    }, "F3: worker page gone")
    check("F3: worker page deleted", true)
    const cleared = (await (await httpGet(`${serve.base}/session/${sid}`)).json())?.metadata
    check("F3: flag cleared from metadata", !cleared?.openshare)

    // F4: config round-trip in a sandbox base dir ($comment preserved).
    // env is set for the flows, so assert on a non-env key (ttlDays).
    const cfgDir = join(sandbox, "cfg")
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, "openshare.config.json"), JSON.stringify({ $comment: "keep me", ttlDays: 42 }, null, 2))
    const cfg = flows.currentConfig(cfgDir)
    check("F4: currentConfig reads sandbox file", cfg.ttlDays === 42, `ttlDays=${cfg.ttlDays}`)
    const saved = flows.saveConfig({ ...cfg, workerUrl: "https://new.example", createToken: "tok" }, join(cfgDir, "openshare.config.json"), cfgDir)
    check("F4: saveConfig writes", !!saved?.path && existsSync(saved.path))
    const raw = JSON.parse(readFileSync(saved.path, "utf8"))
    check("F4: $comment preserved", raw.$comment === "keep me")
    check("F4: values written", raw.workerUrl === "https://new.example" && raw.createToken === "tok")

    // F5: write-target rules (owner-directed): default is ALWAYS the
    // global settings home — never the first existing file in the read
    // chain (the adjacent template must not absorb TUI edits) — and an
    // explicit target is honored. XDG_CONFIG_HOME is suite-redirected
    // (see setup), so configHomePath() is the sandbox home.
    const expectedHome = join(homeDir, "opencode", "openshare.config.json")
    const byDefault = flows.saveConfig({ ...cfg, ttlDays: 7 }, undefined, cfgDir)
    check("F5: default target is the global home", byDefault?.path === expectedHome, `got ${byDefault?.path}`)
    check("F5: adjacent template NOT written", !readFileSync(join(cfgDir, "openshare.config.json"), "utf8").includes('"ttlDays": 7'))
    const explicitPath = join(cfgDir, "chosen.config.json")
    writeFileSync(explicitPath, "{}")
    const byExplicit = flows.saveConfig({ ...cfg, ttlDays: 9 }, explicitPath, cfgDir)
    check("F5: explicit target honored", byExplicit?.path === explicitPath && JSON.parse(readFileSync(explicitPath, "utf8")).ttlDays === 9)
    const candidates = (await import(distUrl("config.js"))).writeCandidates(cfgDir)
    check("F5: writeCandidates lists global + existing adjacent only", candidates[0].path === expectedHome && candidates.some((c) => c.path === join(cfgDir, "openshare.config.json")) && !candidates.some((c) => c.path === explicitPath), candidates.map((c) => c.path).join(" | "))

    // F6: connect flow — the /share first-run path against the real
    // worker: prompt URL, probe (private), prompt code, enroll, persist
    // token as the active server; rotate afterwards revokes the old token
    const codeRes = await httpGet(`${WORKER_URL}/api/admin/codes`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CREATE_TOKEN}` },
      body: JSON.stringify({ label: "tuiflow", activations: 1 }),
    })
    const CODE = (await codeRes.json()).code
    state.promptAnswers.push(WORKER_URL, CODE)
    const connected = await settings.connectServerFlow(host)
    check("F6: connect flow enrolls", connected.ok === true && !!connected.url, connected.message)
    const homeCfg = JSON.parse(readFileSync(expectedHome, "utf8"))
    const savedTok = homeCfg.servers?.[WORKER_URL]?.token
    check("F6: token persisted as active server", typeof savedTok === "string" && savedTok.startsWith("osk_") && homeCfg.servers?.[WORKER_URL]?.active === true, JSON.stringify(homeCfg.servers ?? null))
    const usersNow = await (await httpGet(`${WORKER_URL}/api/admin/users`, { headers: { authorization: `Bearer ${CREATE_TOKEN}` } })).json()
    check("F6: enrollment visible on the worker", (usersNow.users ?? []).some((u) => u.label === "tuiflow-1"), JSON.stringify(usersNow.users?.map((u) => u.label)))
    const entries = flows.serverEntries()
    check("F6: serverEntries lists it active", entries.some((s) => s.url === WORKER_URL && s.active))
    const rotated = await flows.rotateAtServer(WORKER_URL, savedTok)
    check("F6: rotate issues a new token", rotated.ok === true && rotated.token?.startsWith("osk_") && rotated.token !== savedTok, JSON.stringify(rotated))
    const oldMe = await httpGet(`${WORKER_URL}/api/me`, { headers: { authorization: `Bearer ${savedTok}` } })
    const newMe = await httpGet(`${WORKER_URL}/api/me`, { headers: { authorization: `Bearer ${rotated.token}` } })
    check("F6: old token revoked, new valid", oldMe.status === 401 && newMe.status === 200, `${oldMe.status}/${newMe.status}`)

    // F7: admin console — legacy createToken resolves as the admin
    // credential; the underlying admin surface round-trips end to end
    state.menuAnswers.push(WORKER_URL, "info", "back")
    await settings.adminConsole(host)
    check("F7: admin console walks (legacy root token, info, back)", true)
    const admin = flows.adminClient(WORKER_URL, CREATE_TOKEN)
    const made = await admin.createUser("adminmade")
    check("F7: admin creates user", made.ok === true && !!made.data?.userId, JSON.stringify(made))
    const minted = await admin.mintToken(made.data.userId, "console-mint")
    check("F7: admin mints token", minted.ok === true && minted.data?.token?.startsWith("osk_"))
    const mintMe = await httpGet(`${WORKER_URL}/api/me`, { headers: { authorization: `Bearer ${minted.data.token}` } })
    check("F7: minted token is live", mintMe.status === 200)
    const ownedRes = await httpGet(`${WORKER_URL}/api/share/00`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${minted.data.token}` },
      body: JSON.stringify({ sessionID: "ses_adminflow" }),
    })
    const ownedShare = await ownedRes.json()
    check("F7: minted token creates owned share", ownedShare.ok === true)
    const froze = await admin.freeze(made.data.userId)
    check("F7: freeze reports share count", froze.ok === true && froze.data?.shares === 1, JSON.stringify(froze))
    const frozenSync = await httpGet(`${WORKER_URL}/api/share/${ownedShare.id}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: ownedShare.secret, data: [{ type: "message", data: { id: "m_frozen", role: "user" } }] }),
    })
    check("F7: frozen user cannot sync", frozenSync.status === 403 && (await frozenSync.json())?.error === "frozen")
    const adminCode = await admin.createCode("console-invite", 1)
    check("F7: admin creates invite code", adminCode.ok === true && adminCode.data?.code?.startsWith("osc_"))
    const invited = await flows.enrollAtServer(WORKER_URL, adminCode.data.code)
    check("F7: invite code enrolls a user", invited.ok === true && !!invited.token, JSON.stringify(invited))
    const gone = await admin.deleteUser(made.data.userId, "delete")
    check("F7: user delete removes shares", gone.ok === true && gone.data?.shares === 1, JSON.stringify(gone))
    const purged = await admin.purge()
    const sharesAfterPurge = (await admin.shares()).data?.shares ?? []
    check("F7: purge leaves the server empty", purged.ok === true && sharesAfterPurge.length === 0, JSON.stringify(purged))
  } finally {
    await stopServe(serve);
  }
} catch (error) {
  console.error("SUITE ERROR:", error.message)
  failures.push(`suite-error: ${error.message}`)
} finally {
  try {
    worker?.kill()
  } catch {}
  try {
    llm?.close()
  } catch {}
  killWranglerSuites()
  killPortOwners(SERVE_PORT)
  killPortOwners(LLM_PORT)
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s) — suite FAILED`)
  console.error(`suite dir kept for inspection: ${suiteDir}`)
  clearTimeout(watchdog)
  process.exit(1)
}
console.log("\nall checks passed")
rmSync(suiteDir, { recursive: true, force: true })
clearTimeout(watchdog)
process.exit(0)
