// Console smoke: the CLI's routing matrix against a real local Bun
// backend. No wrangler, no network beyond loopback: boots share-server
// in a sandbox, drives `osh` subcommands as child processes, asserts
// exit codes and output. Locks the role-routing surface (root vs scoped
// vs unconfigured) that HTTP-level auth suites cannot see.
//
// Run: npm test   (from share-cli; requires `bun` on PATH and a built
// dist/osh.mjs — npm run build)

import { spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url))
const CLI_DIR = here("../")
const SERVER_DIR = join(CLI_DIR, "..", "share-server")
const OSH = join(CLI_DIR, "dist", "osh.mjs")
const PORT = 8993
const URL_ = `http://127.0.0.1:${PORT}`
const ROOT_TOKEN = "smoke-root-token"

const WATCHDOG_MS = 3 * 60 * 1000
const watchdog = setTimeout(() => {
  console.error("WATCHDOG: smoke exceeded hard time limit — aborting")
  process.exit(124)
}, WATCHDOG_MS)

const failures = []
const check = (label, ok, detail = "") => {
  if (ok) console.log(`PASS ${label}`)
  else {
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`)
    failures.push(label)
  }
}

function run(args, cfgPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [OSH, ...args], {
      cwd: CLI_DIR,
      env: { ...process.env, OPENSHARE_CLI_CONFIG: cfgPath },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

async function httpGet(path, opts = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    return await fetch(`${URL_}${path}`, { ...opts, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function waitFor(fn, label, timeoutMs = 30000) {
  const t0 = Date.now()
  let lastErr = ""
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn()
      if (v !== undefined && v !== false) return v
    } catch (e) {
      lastErr = String(e?.message ?? e)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? ` (last: ${lastErr})` : ""}`)
}

const suiteDir = mkdtempSync(join(tmpdir(), "openshare-cli-smoke-"))
const rootCfg = join(suiteDir, "cli-root.json")
const scopedCfg = join(suiteDir, "cli-scoped.json")
const dbPath = join(suiteDir, "smoke.db")

let server
try {
  server = spawn("bun", ["server.ts"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(PORT), CREATE_TOKEN: ROOT_TOKEN, OPENSHARE_DB: dbPath, AUTH_MODE: "private" },
  })
  let serverOut = ""
  server.stdout.on("data", (d) => (serverOut += d))
  server.stderr.on("data", (d) => (serverOut += d))
  await waitFor(async () => {
    try {
      return (await httpGet("/health")).ok
    } catch {
      return false
    }
  }, "bun server /health", 30000)
  check("S1: local backend boots", true)

  // S2: no server configured — guidance, not a stack trace
  {
    const r = await run(["tokens", "ls"], join(suiteDir, "empty.json"))
    check("S2: unconfigured console names the fix", r.code === 1 && /no server configured/.test(r.stderr), `${r.code} ${r.stderr.slice(0, 120)}`)
  }

  // S3: root login + profile listing
  {
    const r = await run(["login", URL_, "--token", ROOT_TOKEN], rootCfg)
    const ls = await run(["servers"], rootCfg)
    check("S3: root login and servers list", r.code === 0 && ls.code === 0 && ls.stdout.includes("root"), `${r.code}/${ls.code} ${ls.stdout.slice(0, 120)}`)
  }

  // S4-S6: root pre-flight guards (the footgun class)
  {
    const upd = await run(["tokens", "update", "--label", "x"], rootCfg)
    const self = await run(["tokens", "self"], rootCfg)
    const rot = await run(["tokens", "rotate"], rootCfg)
    check("S4: root update-no-id names the admin form", upd.code === 1 && /token ID/i.test(upd.stderr), `${upd.code} ${upd.stderr.slice(0, 120)}`)
    check("S5: root self-mint explains identity", self.code === 1 && /no user identity/i.test(self.stderr), `${self.code} ${self.stderr.slice(0, 120)}`)
    check("S6: root rotate says not rotatable", rot.code === 1 && /cannot rotate/i.test(rot.stderr), `${rot.code} ${rot.stderr.slice(0, 120)}`)
  }

// --json output is pretty-printed (multi-line): parse the whole stdout,
// falling back to the substring from the first "{" (any leading chatter)
const parseJsonOut = (s) => {
  const t = s.trim()
  try {
    return JSON.parse(t)
  } catch {
    return JSON.parse(t.slice(t.indexOf("{")))
  }
}

// S7: admin lifecycle — create user, mint a scoped token for it
let userId = ""
let scopedToken = ""
  {
    const u = await run(["users", "new", "--label", "smoke-user", "--json"], rootCfg)
    const user = parseJsonOut(u.stdout)
    userId = user.userId
    const t = await run(["tokens", "new", "--user", userId, "--kind", "scoped", "--label", "smoke-scoped", "--json"], rootCfg)
    const tok = parseJsonOut(t.stdout)
    scopedToken = tok.token
    check("S7: user + scoped token minted via console", u.code === 0 && t.code === 0 && typeof scopedToken === "string" && scopedToken.startsWith("osk_"), `${u.code}/${t.code} ${u.stderr.slice(0, 80)}`)
  }

  // S8: scoped credential sees only itself
  {
    writeFileSync(scopedCfg, JSON.stringify({ current: "smoke", servers: { smoke: { url: URL_, token: scopedToken, kind: "scoped" } } }, null, 2))
    const r = await run(["tokens", "ls", "--json"], scopedCfg)
    const rows = parseJsonOut(r.stdout)
    check("S8: scoped ls shows only own token", r.code === 0 && Array.isArray(rows) && rows.length === 1 && rows[0].label === "smoke-scoped", `${r.code} ${r.stdout.slice(0, 120)}`)
  }

  // S9/S10: scoped self-service — label yes, limits no
  {
    const rename = await run(["tokens", "update", "--label", "renamed-self"], scopedCfg)
    const lift = await run(["tokens", "update", "--max-shares", "99"], scopedCfg)
    check("S9: scoped self-rename ok", rename.code === 0, `${rename.code} ${rename.stderr.slice(0, 120)}`)
    check("S10: scoped cannot lift own limits", lift.code === 1 && /403|forbidden/i.test(lift.stderr), `${lift.code} ${lift.stderr.slice(0, 120)}`)
  }

  // S11: cleanup through the console itself
  {
    const r = await run(["users", "rm", userId, "--yes", "--mode", "delete"], rootCfg)
    check("S11: user delete via console", r.code === 0, `${r.code} ${r.stderr.slice(0, 120)}`)
  }
} catch (e) {
  failures.push(`suite crashed: ${e?.stack || e}`)
  console.log(`CRASH ${e?.stack || e}`)
} finally {
  clearTimeout(watchdog)
  try {
    server?.kill()
  } catch {}
  await new Promise((r) => setTimeout(r, 300))
  try {
    rmSync(suiteDir, { recursive: true, force: true })
  } catch {}
}

console.log(`\n[cli-smoke] ${failures.length === 0 ? "all checks passed" : `${failures.length} FAILURES`}`)
if (failures.length) {
  for (const f of failures) console.log("  - " + f)
  process.exit(1)
}
process.exit(0)
