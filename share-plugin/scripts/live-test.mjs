// Open(code)Share LIVE test — no mocks: real `opencode run`, the machine's
// default model, the real deployed worker, real tools (glob/read/grep/bash/
// edit/task), and the config read from the opencode config folder
// (~/.config/opencode/openshare.config.json).
//
//   Phase A: CI single-file bundle via OPENCODE_CONFIG (one-file config)
//   Phase B: the proper package via a PROJECT merge config (plugin entry)
//
// Run: npm run test:live   (not part of `npm run test` — costs real tokens)

import { spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { sleep, waitFor, httpGet } from "./suite-lib.mjs"

const CI_BUNDLE = fileURLToPath(new URL("../ci/openshare.js", import.meta.url)).replace(/\\/g, "/")
const PKG_DIR = fileURLToPath(new URL("..", import.meta.url)).replace(/\\/g, "/")
const LIVE_CFG = join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".config", "opencode", "openshare.config.json")

const WATCHDOG_MS = 20 * 60 * 1000
const watchdog = setTimeout(() => {
  console.error("WATCHDOG: live test exceeded hard time limit — aborting")
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

const live = JSON.parse(readFileSync(LIVE_CFG, "utf8"))
const WORKER = live.workerUrl
if (!WORKER || !live.createToken) throw new Error(`live config missing workerUrl/createToken: ${LIVE_CFG}`)
console.log(`worker: ${WORKER} (config: ${LIVE_CFG})`)

const TOOL_PROMPT = [
  "Use your tools on this repo, in order:",
  "1) glob for *.js and *.md files",
  "2) read NOTES.md fully",
  "3) grep the repo for the marker string LIVESHARE-MARKER-7f3a",
  "4) run `node --version` in bash",
  "5) append the line 'live-test verified' to NOTES.md",
  "6) spawn a task subagent (explore agent) that counts the .js files and reports the number",
  "Finish with a one-paragraph summary of what you did.",
].join(". ")

function makeProject(root) {
  const project = join(root, "project")
  mkdirSync(join(project, "src"), { recursive: true })
  writeFileSync(join(project, "NOTES.md"), "# live test\n\nmarker: LIVESHARE-MARKER-7f3a\nscratch project for openshare live verification.\n")
  writeFileSync(join(project, "src", "app.js"), "// LIVESHARE-MARKER-7f3a\nconsole.log('hello live test')\n")
  writeFileSync(join(project, "src", "util.js"), "// helper\nexport const marker = 'LIVESHARE-MARKER-7f3a'\n")
  return project
}

function runOpencode(args, cwd, extraEnv = {}) {
  return new Promise((resolve) => {
    // opencode resolves to a real .exe here — NO shell, so the prompt
    // text passes as one literal argv entry (cmd quoting was mangling it).
    // Full XDG isolation: the real model + real worker stay real, but the
    // sessions land in the disposable sandbox — never in the user's
    // session browser (data root = machine-wide session DB on v1.18).
    const root = mkdtempSync(join(tmpdir(), "openshare-live-run-"))
    const child = spawn("opencode", args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(root, "xdg"),
        XDG_DATA_HOME: join(root, "xdg-data"),
        XDG_STATE_HOME: join(root, "xdg-state"),
        ...extraEnv,
      },
    })
    let out = ""
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (out += d))
    child.on("close", (code) => resolve({ code, out }))
    child.on("error", (err) => resolve({ code: -1, out: String(err) }))
  })
}

async function verifyShare(label, shareId, expectSubagent) {
  const body = await waitFor(async () => {
    const r = await httpGet(`${WORKER}/api/share/${shareId}/data`, { timeoutMs: 15000 })
    if (!r.ok) throw new Error(`${r.status}`)
    const parsed = await r.json()
    const types = (parsed.data ?? []).map((i) => i.type)
    return parsed.status === "completed" && types.includes("session") && types.includes("message") && types.includes("part") ? parsed : undefined
  }, `${label}: share complete on the live worker`, 180000)
  const items = body.data
  const types = items.map((i) => i.type)
  console.log(`  items: ${[...new Set(types)].join(",")}`)
  check(`${label}: model item present`, types.includes("model"))
  check(`${label}: session_diff present`, types.includes("session_diff"))
  check(`${label}: prefs present`, types.includes("prefs"))

  const tools = [...new Set(items.filter((i) => i.type === "part" && i.data?.type === "tool").map((i) => i.data.tool))]
  console.log(`  tool parts: ${tools.join(",")}`)
  check(`${label}: bash tool ran`, tools.includes("bash"))
  check(`${label}: read tool ran`, tools.includes("read") || tools.includes("glob") || tools.includes("grep"))

  const sessions = items.filter((i) => i.type === "session")
  const children = sessions.filter((i) => i.data?.parentID)
  console.log(`  sessions: ${sessions.length} (children: ${children.length})`)
  if (expectSubagent) check(`${label}: subagent session on the share page`, children.length >= 1)

  const leaked = items.filter((i) => i.data?.metadata && "openshare" in i.data.metadata)
  check(`${label}: binding never reaches viewers`, leaked.length === 0)
  return body
}

async function phaseA(root) {
  console.log("\n=== Phase A: CI single-file bundle (OPENCODE_CONFIG) ===")
  const sandbox = join(root, "a")
  const project = makeProject(sandbox)
  const config = join(sandbox, "opencode.json")
  writeFileSync(
    config,
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugin: [CI_BUNDLE],
        permission: { edit: "allow", bash: "allow" },
      },
      null,
      2,
    ),
  )
  const res = await runOpencode(["run", "--message", TOOL_PROMPT], project, { OPENCODE_CONFIG: config })
  console.log(`opencode run exit=${res.code}`)
  const shareLines = res.out.split("\n").filter((l) => l.includes("[openshare]"))
  for (const line of shareLines) console.log(`  ${line.trim()}`)
  check("A: announce lines present", shareLines.some((l) => l.includes("live: ")), res.out.slice(-600))

  const urlFile = join(project, "openshare.urls.txt")
  const shareUrl = await waitFor(() => {
    try {
      return readFileSync(urlFile, "utf8").trim().split("\n").filter(Boolean).pop() ?? undefined
    } catch {
      return undefined
    }
  }, "A: default openshare.urls.txt in the project dir", 120000)
  check("A: url file in the session dir (default, no env)", shareUrl.startsWith(WORKER), shareUrl)
  await verifyShare("A", shareUrl.split("/").pop(), true)
  return shareUrl
}

async function phaseB(root) {
  console.log("\n=== Phase B: proper package (project merge config) ===")
  const sandbox = join(root, "b")
  const project = makeProject(sandbox)
  // merge config: project-level opencode.json registers the package
  writeFileSync(
    join(project, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugin: [`file:///${PKG_DIR.replace(/\\/g, "/")}`],
        permission: { edit: "allow", bash: "allow" },
      },
      null,
      2,
    ),
  )
  const res = await runOpencode(["run", "--message", TOOL_PROMPT], project, {})
  console.log(`opencode run exit=${res.code}`)
  const shareLines = res.out.split("\n").filter((l) => l.includes("[openshare]"))
  for (const line of shareLines) console.log(`  ${line.trim()}`)
  check("B: announce lines present", shareLines.some((l) => l.includes("live: ")), res.out.slice(-600))

  const urlFile = join(project, "openshare.urls.txt")
  const shareUrl = await waitFor(() => {
    try {
      return readFileSync(urlFile, "utf8").trim().split("\n").filter(Boolean).pop() ?? undefined
    } catch {
      return undefined
    }
  }, "B: openshare.urls.txt in the project dir", 120000)
  check("B: url file written", shareUrl.startsWith(WORKER), shareUrl)
  await verifyShare("B", shareUrl.split("/").pop(), true)
  return shareUrl
}

const root = mkdtempSync(join(tmpdir(), "openshare-live-"))
console.log(`sandbox: ${root}`)
const urls = []
const phase = process.env.LIVE_PHASE ?? "ab"
try {
  if (phase.includes("a")) urls.push(await phaseA(root))
  if (phase.includes("b")) urls.push(await phaseB(root))
} catch (error) {
  console.error("LIVE TEST ERROR:", error.message)
  failures.push(`error: ${error.message}`)
}

console.log("\n=== share pages (open these) ===")
for (const url of urls) console.log(`  ${url}`)
console.log(`sandbox kept: ${root}`)

clearTimeout(watchdog)
process.exit(failures.length ? 1 : 0)
