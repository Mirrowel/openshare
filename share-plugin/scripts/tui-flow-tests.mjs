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
  startBunServer,
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
    menus: [],
    prompts: [],
    alerts: [],
    sizePickerAnswers: [],
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
        showBusy() {
          return () => {}
        },
        async showMenu(props) {
          state.menus.push(props)
          return state.menuAnswers.shift() ?? props.options[0]?.value
        },
        async showConfirm(props) {
          return confirmAnswer()
        },
        async showAlert(props) {
          state.alerts.push(props)
        },
        async showPrompt(props) {
          state.prompts.push(props)
          return state.promptAnswers.shift() ?? ""
        },
        async showSizePicker() {
          return state.sizePickerAnswers.shift()
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

    // F1: consent is EXPLICIT every time (no remembered consent). Declining
    // must not create anything; consenting creates + copies the URL.
    {
      const declinedHost = mockHost(client, { consent: false })
      const declined = await flows.shareWithConsent(declinedHost.host, sid)
      check("F1: declined consent does not share", declined.ok === false && !declined.url, declined.message)
    }
    const shared = await flows.shareWithConsent(host, sid)
    check("F1: consented share succeeds", shared.ok === true && !!shared.url, shared.message)
    check("F1: URL copied to clipboard", state.clipboard.at(-1) === shared.url, `${state.clipboard.at(-1)} vs ${shared.url}`)

    const shareId = shared.url.split("/").pop()
    const body = await waitFor(async () => {
      const r = await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)
      if (!r.ok) throw new Error(`${r.status}`)
      const parsed = await r.json()
      const hasContent = (parsed.data ?? []).some((i) => i.type === "message" && Array.isArray(i.data?.content) && i.data.content.length > 0)
      return parsed.status === "completed" && hasContent && (parsed.data ?? []).some((i) => i.type === "model") ? parsed : undefined
    }, "F1: share data backfilled")
    check("F1: worker carries the backfilled share", !!body)

    // F2: share again copies the link (already-shared short-circuits the
    // consent gate — nothing new is being published), no new share
    const again = await flows.shareWithConsent(host, sid)
    check("F2: second share copies existing link", again.ok === true && again.url === shared.url, again.message)
    const after = await httpGet(`${serve.base}/session/${sid}`)
    const bindingNow = (await after.json())?.metadata?.openshare
    check("F2: no duplicate share created", bindingUrlOf(bindingNow)?.split("/").pop() === shareId)

    // F12a: opts persistence NEVER publishes (D1). The TTL/read-auth
    // editors once routed through setShareFlag, which stamps enabled:true
    // - editing a preference on an unshared session published it with no
    // consent. On a live share the opts must land without touching
    // enabled or the share id.
    {
      const set = await flows.setShareOpts(client, sid, { ttlDays: 33 })
      check("F12a: setShareOpts ok", set === true)
      const rec = (await (await httpGet(`${serve.base}/session/${sid}`)).json())?.metadata?.openshare
      check("F12a: opts stored", rec?.opts?.ttlDays === 33, JSON.stringify(rec?.opts))
      check("F12a: enabled state untouched", rec?.enabled === true, JSON.stringify({ enabled: rec?.enabled }))
      check("F12a: no new share", bindingUrlOf(rec)?.split("/").pop() === shareId, bindingUrlOf(rec))
    }

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

    // F12b: on an UNSHARED session, opts sit dormant - no enabled, no
    // share. This is the D1 consent-bypass lock: the editor saves the
    // preference and publishes nothing.
    {
      check("F12b: setShareOpts ok (unshared)", (await flows.setShareOpts(client, sid, { ttlDays: 21 })) === true)
      const rec = (await (await httpGet(`${serve.base}/session/${sid}`)).json())?.metadata?.openshare
      check("F12b: opts stored dormant", rec?.opts?.ttlDays === 21 && rec?.enabled !== true, JSON.stringify(rec))
      check("F12b: no binding url (nothing published)", bindingUrlOf(rec) === undefined, bindingUrlOf(rec))
    }

    // F13: read-auth editor enforces both-or-none (D2). A login without a
    // password rendered "protected" while the server never built a gate.
    {
      const h2 = mockHost(client)
      h2.state.menuAnswers.push("group:session", "session:auth", "__back", "action:exit")
      h2.state.promptAnswers.push("alice", "")
      await settings.settingsDialog(h2.host, sid)
      check("F13: half pair rejected with an explicit toast", h2.state.toasts.some((t) => /both a login and a password/i.test(t.message ?? "")), JSON.stringify(h2.state.toasts.map((t) => t.message)))
      const rec = (await (await httpGet(`${serve.base}/session/${sid}`)).json())?.metadata?.openshare
      check("F13: opts unchanged after rejection", rec?.opts?.authLogin === undefined && rec?.opts?.ttlDays === 21, JSON.stringify(rec?.opts))
      const h3 = mockHost(client)
      h3.state.menuAnswers.push("group:session", "session:auth", "__back", "action:exit")
      h3.state.promptAnswers.push("alice", "wonderland")
      await settings.settingsDialog(h3.host, sid)
      const rec2 = (await (await httpGet(`${serve.base}/session/${sid}`)).json())?.metadata?.openshare
      check("F13b: full pair saved", rec2?.opts?.authLogin === "alice" && rec2?.opts?.authPassword === "wonderland", JSON.stringify(rec2?.opts))
    }

    // F14: leave-as-is keeps control (D4). The snapshot path once dropped
    // id/secret - the page could never be deleted or re-shared from the
    // TUI again. Now the entry keeps both under an optedOut marker, a
    // fully opted-out session re-asks consent, and re-share re-attaches
    // the SAME page.
    {
      const reshared = await flows.shareWithConsent(host, sid)
      check("F14: re-share after unshare works", reshared.ok === true && !!reshared.url, reshared.message)
      const shareId2 = reshared.url.split("/").pop()
      // the re-share inherits the session opts (F13b set alice/wonderland)
      // - the gate applying on create is itself D1/D3 coverage
      await waitFor(async () => {
        const r = await httpGet(`${WORKER_URL}/api/share/${shareId2}/data`)
        if (r.status === 404) throw new Error("not there yet")
        return r.status === 401 ? true : undefined
      }, "F14: share #2 live and gated")
      const h4 = mockHost(client)
      h4.state.menuAnswers.push("group:session", "session:unshare", "leave", "__back", "action:exit")
      await settings.settingsDialog(h4.host, sid)
      const rec = (await (await httpGet(`${serve.base}/session/${sid}`)).json())?.metadata?.openshare
      const entry = Object.values(rec?.servers ?? {})[0]
      check("F14a: snapshot keeps id+secret+optedOut", entry?.id === shareId2 && typeof entry?.secret === "string" && entry?.optedOut === true, JSON.stringify(entry))
      const bindings = await flows.readBindings(client, sid)
      check("F14b: TUI still sees the snapshot (deletable later)", bindings.length === 1 && bindings[0].optedOut === true, JSON.stringify(bindings))
      const declinedSnap = await flows.shareWithConsent(mockHost(client, { consent: false }).host, sid)
      check("F14c: opted-out session re-asks consent (decline = nothing)", declinedSnap.ok === false && !declinedSnap.url, declinedSnap.message)
      const again2 = await flows.shareWithConsent(host, sid)
      check("F14d: re-share after snapshot succeeds", again2.ok === true && !!again2.url, again2.message)
      const rec2 = (await (await httpGet(`${serve.base}/session/${sid}`)).json())?.metadata?.openshare
      const entry2 = Object.values(rec2?.servers ?? {})[0]
      check("F14e: same page re-attached, marker cleared", again2.url.endsWith(shareId2) && entry2?.optedOut !== true, `${again2.url} entry=${JSON.stringify(entry2)}`)
    }

    // F4: config round-trip in a sandbox base dir ($comment preserved).
    // env is set for the flows, so assert on a non-env key (ttlHours).
    // The legacy days-shaped key converts x24 at load (Wave 3).
    const cfgDir = join(sandbox, "cfg")
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, "openshare.config.json"), JSON.stringify({ $comment: "keep me", ttlDays: 42 }, null, 2))
    const cfg = flows.currentConfig(cfgDir)
    check("F4: currentConfig reads sandbox file (legacy days -> hours)", cfg.ttlHours === 42 * 24 && cfg.ttlDays === undefined, `ttlHours=${cfg.ttlHours} ttlDays=${cfg.ttlDays}`)
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
    const byDefault = flows.saveConfig({ ...cfg, ttlHours: 168 }, undefined, cfgDir)
    check("F5: default target is the global home", byDefault?.path === expectedHome, `got ${byDefault?.path}`)
    check("F5: adjacent template NOT written", !readFileSync(join(cfgDir, "openshare.config.json"), "utf8").includes('"ttlHours": 168'))
    const explicitPath = join(cfgDir, "chosen.config.json")
    writeFileSync(explicitPath, "{}")
    const byExplicit = flows.saveConfig({ ...cfg, ttlHours: 216 }, explicitPath, cfgDir)
    check("F5: explicit target honored", byExplicit?.path === explicitPath && JSON.parse(readFileSync(explicitPath, "utf8")).ttlHours === 216)
    const candidates = (await import(distUrl("config.js"))).writeCandidates(cfgDir)
    check("F5: writeCandidates lists global + existing adjacent only", candidates[0].path === expectedHome && candidates.some((c) => c.path === join(cfgDir, "openshare.config.json")) && !candidates.some((c) => c.path === explicitPath), candidates.map((c) => c.path).join(" | "))

    // F5b: TUI-presence detection accepts every documented spec form.
    // The docs once shipped the /tui subpath while detection matched only
    // the bare name — presence silently failed and all-mode kept
    // auto-sharing while the user believed they were in manual mode
    // (review-caught 2026-10-20). Lock every form: bare, @version,
    // subpath, @version+subpath — and a lookalike stays negative.
    const isOpenShareSpec = (await import(distUrl("config.js"))).isOpenShareSpec
    const specs = [
      ["@mirrowel/opencode-openshare", true],
      ["@mirrowel/opencode-openshare@0.1.0", true],
      ["@mirrowel/opencode-openshare/tui", true],
      ["@mirrowel/opencode-openshare@0.1.0/tui", true],
      ["file:///C:/dir/share-plugin", true],
      ["@mirrowel/opencode-openshare-fork", false],
      ["@other/openshare", false],
    ]
    for (const [spec, expected] of specs) {
      check(`F5b: presence detection ${expected ? "accepts" : "rejects"} ${spec}`, isOpenShareSpec(spec) === expected)
    }

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
    // persist the rotated token like the real serverMenu rotate handler —
    // otherwise the engine's credential stays the now-REVOKED token and
    // every later create is refused (live-caught by F8)
    flows.saveServerEntry(WORKER_URL, { token: rotated.token })
    const oldMe = await httpGet(`${WORKER_URL}/api/me`, { headers: { authorization: `Bearer ${savedTok}` } })
    const newMe = await httpGet(`${WORKER_URL}/api/me`, { headers: { authorization: `Bearer ${rotated.token}` } })
    check("F6: old token revoked, new valid", oldMe.status === 401 && newMe.status === 200, `${oldMe.status}/${newMe.status}`)

    // F7: admin console — legacy createToken resolves as the admin
    // credential; the underlying admin surface round-trips end to end.
    // Server info must render the policy FORMATTED (no raw JSON blob) and
    // explain what "private" auth needs.
    state.menuAnswers.push(WORKER_URL, "info", "__back", "__back")
    await settings.adminConsole(host)
    check("F7: admin console walks (legacy root token, info, back)", true)
    const infoAlert = state.alerts.find((a) => a.title === "Server info")
    check("F7: server info formats policy lines", !!infoAlert && /turnGraceMs: \d/.test(infoAlert.message) && !infoAlert.message.includes('{"mode"'), infoAlert?.message.slice(0, 120))
    check("F7: server info explains private auth", !!infoAlert && infoAlert.message.includes("private — joining needs an access code"), infoAlert?.message.slice(0, 200))
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

    // F15: connect flow on a PUBLIC server asks ONCE (onboard or stay
    // anonymous); anonymous saves the declined flag with no token
    const PUB_PORT = 8961
    const pubSrv = await startBunServer(suiteDir, { port: PUB_PORT, name: "tuiflow-pub", authMode: "public", vars: { AUTH_MODE: "public" } })
    const PUB_URL = pubSrv.url
    // menu -> "Stay anonymous"
    const hostA = mockHost()
    hostA.state.promptAnswers.push(PUB_URL)
    hostA.state.menuAnswers.push("anon")
    const connectedA = await settings.connectServerFlow(hostA.host)
    check("F15: anonymous connect ok", connectedA.ok === true && /anonymously/.test(connectedA.message), connectedA.message)
    const pubA = flows.serverEntries().find((sv) => sv.url === PUB_URL)
    check("F15: anonymous entry saved (flag, active, no token)", pubA?.active === true && pubA?.entry?.anonymous === true && !pubA?.entry?.token, JSON.stringify(pubA?.entry ?? null))
    // onboard on the same public server (codeless off): menu -> onboard ->
    // codeless enroll refused -> code prompt -> enroll with the code
    const codeA = await (await httpGet(`${PUB_URL}/api/admin/codes`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + CREATE_TOKEN },
      body: JSON.stringify({ label: "pubcode", activations: 2 }),
    })).json()
    const hostB = mockHost()
    hostB.state.promptAnswers.push(PUB_URL, codeA.code)
    hostB.state.menuAnswers.push("onboard")
    const connectedB = await settings.connectServerFlow(hostB.host)
    check("F15b: onboard via code connects", connectedB.ok === true && /as "/.test(connectedB.message), connectedB.message)
    const pubB = flows.serverEntries().find((sv) => sv.url === PUB_URL)
    check("F15b: token saved, anonymous flag cleared", pubB?.entry?.token?.startsWith("osk_") && pubB?.entry?.anonymous !== true, JSON.stringify(pubB?.entry ?? null))
    flows.saveServerEntry(PUB_URL, { active: undefined, token: undefined, anonymous: undefined, code: undefined })
    try { pubSrv.kill() } catch {}
    killPortOwners(PUB_PORT)

    // F8: gone detection — a binding whose page died server-side (purge /
    // TTL / delete) is auto-cleared when /share opens, with a
    // "Share is gone" modal; the probe is credential-free (/data 404 before
    // the read-auth gate). shareWithConsent itself does NOT probe liveness
    // (the /share command's gone sweep owns that) - clear the stale
    // binding the way the sweep does, then a consented re-share creates
    // the fresh page.
    await flows.clearShareFlag(client, sid)
    // drop the inherited read-auth override so F8's plain reads work
    await flows.setShareOpts(client, sid, { ttlDays: 21 })
    const reshard = await flows.shareWithConsent(host, sid)
    check("F8: re-share after purge creates a fresh page", reshard.ok === true && !!reshard.url, reshard.message)
    const shareId2 = reshard.url.split("/").pop()
    await waitFor(async () => {
      const r = await httpGet(`${WORKER_URL}/api/share/${shareId2}/data`)
      if (!r.ok) throw new Error(`${r.status}`)
      return (await r.json()).status === "completed" ? true : undefined
    }, "F8: fresh share completed")
    check("F8: verifyShare says live before the purge", (await flows.verifyShare(WORKER_URL, shareId2)) === "live")
    await admin.purge()
    check("F8: verifyShare says gone after the purge", (await flows.verifyShare(WORKER_URL, shareId2)) === "gone")
    const commands = await import(distUrl("commands.js"))
    const shareCommand = commands.buildShareCommand(host, () => sid)
    state.menuAnswers.push("close")
    await shareCommand.run({})
    const goneMenu = state.menus.at(-1)
    check("F8: gone modal shown", goneMenu?.title === "Share is gone", goneMenu?.title ?? "(no menu)")
    const metaAfter = (await (await httpGet(`${serve.base}/session/${sid}`)).json())?.metadata?.openshare
    check("F8: gone binding entry auto-cleared", !(metaAfter?.servers ?? {})[WORKER_URL], JSON.stringify(metaAfter?.servers ?? null))

    // F9: interface prefs — one combined "Menu size…" row (the config-studio
    // picker is facade-driven; the mock scripts its result). Root lists
    // GROUPS only; every group row carries [i] help.
    state.sizePickerAnswers.push({ width: "xlarge", heightPercent: 66 })
    state.menuAnswers.push("group:interface", "ui:size", "__back", "action:exit")
    await settings.settingsDialog(host)
    check("F9: size picker persisted both dims in kv", state.kv.get("openshare.ui-width") === "xlarge" && state.kv.get("openshare.ui-height-percent") === 66, JSON.stringify([...state.kv]))
    const rootMenu = state.menus.findLast((m) => m.title === "OpenShare settings")
    check("F9: root is compact groups only", !!rootMenu && rootMenu.options.length <= 9 && !rootMenu.options.some((o) => o.value.startsWith("key:")), JSON.stringify(rootMenu?.options.map((o) => o.value)))
    check("F9: no separate connection group", !rootMenu?.options.some((o) => o.value === "group:connection"))
    check("F9: group rows carry [i] help", rootMenu?.options.filter((o) => typeof o.help === "string" && o.help.length > 40).length === 6, JSON.stringify(rootMenu?.options.map((o) => [o.value, !!o.help])))
    const interfaceMenu = state.menus.findLast((m) => m.title === "OpenShare — Interface")
    check("F9: interface group is the single size row", !!interfaceMenu && interfaceMenu.options.filter((o) => o.value === "ui:size").length === 1, JSON.stringify(interfaceMenu?.options.map((o) => o.value)))

    // F10: root-token holder adopts a user identity — the "admin can't be
    // a user" fix. Craft the legacy-synthesis state (token === root), then
    // Servers → server → "Get a user token" (label prompt, prefilled) →
    // minted osk_ saved as token, root stays in adminToken.
    flows.saveServerEntry(WORKER_URL, { token: CREATE_TOKEN, adminToken: CREATE_TOKEN, active: true })
    state.menuAnswers.push("group:servers", `server:${WORKER_URL}`, "adopt", "__back", "__back", "action:exit")
    state.promptAnswers.push("boss")
    await settings.settingsDialog(host)
    const adoptCfg = JSON.parse(readFileSync(expectedHome, "utf8"))
    const adopted = adoptCfg.servers?.[WORKER_URL]
    check("F10: user token adopted (osk_, not root)", typeof adopted?.token === "string" && adopted.token.startsWith("osk_") && adopted.token !== CREATE_TOKEN, JSON.stringify(adopted ?? null))
    check("F10: root stays as adminToken", adopted?.adminToken === CREATE_TOKEN)
    const adoptPrompt = state.prompts.find((p) => p.title.includes("user label"))
    check("F10: label prompt prefilled with admin-<host>", !!adoptPrompt && /admin-/.test(String(adoptPrompt.value)), JSON.stringify(adoptPrompt?.value))
    const serverMenuShown = state.menus.filter((m) => m.title === "Share server")
    check("F10: root holder sees Get a user token", serverMenuShown.some((m) => m.options.some((o) => o.value === "adopt")), JSON.stringify(serverMenuShown.at(-1)?.options.map((o) => o.value)))

    // F11: fixed-vocabulary settings edit via SELECTION, not typing:
    // shareMode → auto/all/manual menu; saved through Save & exit.
    const homeBefore = existsSync(expectedHome) ? JSON.parse(readFileSync(expectedHome, "utf8")) : {}
    delete homeBefore.shareMode
    writeFileSync(expectedHome, JSON.stringify(homeBefore, null, 2))
    state.menuAnswers.push("group:sharing", "key:shareMode", "manual", "__back", "__back", "action:exit")
    await settings.settingsDialog(host)
    const modeCfg = JSON.parse(readFileSync(expectedHome, "utf8"))
    check("F11: share mode set via selection", modeCfg.shareMode === "manual", JSON.stringify(modeCfg.shareMode))
    const modeMenu = state.menus.findLast((m) => m.title === "Share mode")
    check("F11: selection menu offers auto/all/manual", !!modeMenu && ["auto", "all", "manual"].every((v) => modeMenu.options.some((o) => o.value === v)), JSON.stringify(modeMenu?.options.map((o) => o.value)))
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
  if (!process.env.OPENSHARE_TEST_WORKER_URL) killWranglerSuites() // matrix reuse: don't kill the shared worker
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
