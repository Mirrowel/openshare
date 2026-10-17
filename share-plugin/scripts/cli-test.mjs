// OpenShare CLI install test — runs the REAL opencode CLI against a
// SANDBOXED config-home that registers the package directory globally
// (`file:///…/share-plugin`, server only, no TUI → expect share-ALL mode).
// The real machine config and the machine-wide session DB stay untouched
// (full XDG_CONFIG/DATA/STATE isolation — see suite-lib).
//
// A scratch project provides a mock OpenAI-compatible provider so the run
// costs no tokens; OPENSHARE_* env points the plugin at a local wrangler
// worker. Verifies: mode=all (debug file), stderr announce line, urlFile,
// worker /data contents + completed status.
//
// NOT part of `npm run test` (drives real `opencode run` binaries).

import { spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { sleep, waitFor, httpGet, killWranglerSuites, startMockLLM, startWorker, WORKER_URL, WORKER_PORT, LLM_PORT } from "./suite-lib.mjs"

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url)).replace(/\\/g, "/")

const WATCHDOG_MS = 8 * 60 * 1000
const watchdog = setTimeout(() => {
  console.error("WATCHDOG: cli test exceeded hard time limit — aborting")
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

const suiteDir = mkdtempSync(join(tmpdir(), "openshare-cli-"))
console.log(`suite dir: ${suiteDir}`)

let worker
let llm
try {
  llm = await startMockLLM()
  worker = await startWorker(suiteDir)
  console.log("worker ready")

  const projectDir = join(suiteDir, "project")
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(
    join(projectDir, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        provider: {
          mock: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `http://127.0.0.1:${LLM_PORT}/v1`, apiKey: "mock" },
            models: { "mock-1": { name: "Mock 1" } },
          },
        },
        model: "mock/mock-1",
      },
      null,
      2,
    ),
  )

  const urlFile = join(suiteDir, "share-url.txt")
  const debugFile = join(suiteDir, "openshare-debug.json")
  // phase-1 "global install" sandbox: a config-home that registers the
  // package GLOBALLY (the real machine config stays untouched, and the
  // session DB never leaves the sandbox — full XDG isolation)
  const globalHome = join(suiteDir, "global-home")
  for (const sub of ["opencode", "data", "state"]) mkdirSync(join(globalHome, sub), { recursive: true })
  writeFileSync(
    join(globalHome, "opencode", "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [`file:///${PKG_DIR}`] }, null, 2),
  )
  const run = (args, extraEnv = {}) =>
    new Promise((resolve) => {
      const child = spawn("opencode", args, {
        cwd: projectDir,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          XDG_CONFIG_HOME: globalHome,
          XDG_DATA_HOME: join(globalHome, "data"),
          XDG_STATE_HOME: join(globalHome, "state"),
          OPENSHARE_WORKER_URL: WORKER_URL,
          OPENSHARE_CREATE_TOKEN: "suite-create-token",
          OPENSHARE_URL_FILE: urlFile,
          OPENSHARE_SPOOL_DIR: join(suiteDir, "spool"),
          OPENSHARE_DEBOUNCE_MS: "300",
          OPENSHARE_DEBUG_FILE: debugFile,
          ...extraEnv,
        },
      })
      let out = ""
      child.stdout.on("data", (d) => (out += d))
      child.stderr.on("data", (d) => (out += d))
      child.on("close", (code) => resolve({ code, out }))
    })

  // 1) plain run: creates a session, shares it (all-mode)
  const first = await run(["run", "-m", "mock/mock-1", "--message", "cli test: hello"], {})
  console.log(`opencode run exit=${first.code}`)
  const shareLine = first.out.split("\n").find((l) => l.includes("[openshare]"))
  check("CLI: [openshare] announce line on stderr", Boolean(shareLine), first.out.slice(-500))

  let mode
  try {
    mode = JSON.parse(readFileSync(debugFile, "utf8")).mode
  } catch {}
  check("CLI: mode is all (no TUI registered)", mode === "all", `mode=${mode}`)

  const shareUrl = await waitFor(() => {
    try {
      const content = readFileSync(urlFile, "utf8").trim()
      return content || undefined
    } catch {
      return undefined
    }
  }, "CLI: urlFile written")
  const shareId = shareUrl.split("/").pop()
  console.log(`  share: ${shareId}`)

  const body = await waitFor(async () => {
    const r = await httpGet(`${WORKER_URL}/api/share/${shareId}/data`)
    if (!r.ok) throw new Error(`${r.status}`)
    const parsed = await r.json()
    const types = (parsed.data ?? []).map((i) => i.type)
    return parsed.status === "completed" && types.includes("session") && types.includes("message") && types.includes("part") ? parsed : undefined
  }, "CLI: share data complete")
  console.log(`  items: ${(body.data ?? []).map((i) => i.type).join(",")}`)
  check("CLI: share complete on the worker", true)
  const leaked = (body.data ?? []).filter((i) => i.data?.metadata && "openshare" in i.data.metadata)
  check("CLI: binding never reaches viewers", leaked.length === 0)

  // 2) second run = second session = second share (all-mode shares
  // everything). urlFile APPENDS: one file carries every share URL.
  const firstUrl = readFileSync(urlFile, "utf8").trim()
  const second = await run(["run", "-m", "mock/mock-1", "--message", "cli test: second session"], {})
  await waitFor(() => {
    const now = readFileSync(urlFile, "utf8").trim()
    return now.split("\n").filter(Boolean).length === 2
  }, "CLI: second run appends its share URL")
  const urls = readFileSync(urlFile, "utf8").trim().split("\n").filter(Boolean)
  check("CLI: urlFile carries both share URLs (append)", urls.length === 2 && urls[0] === firstUrl, JSON.stringify(urls))
  console.log(`  second run exit=${second.code}`)
  console.log(`  share 1: ${urls[0]?.split("/").pop()}  share 2: ${urls[1]?.split("/").pop()}`)

  // both sessions shared: the first share still exists and is complete
  const firstStillThere = await waitFor(async () => {
    const r = await httpGet(`${WORKER_URL}/api/share/${urls[0].split("/").pop()}/data`)
    if (!r.ok) return false
    return (await r.json()).status === "completed"
  }, "CLI: first share still on the worker")
  check("CLI: both sessions shared (all-mode)", Boolean(firstStillThere))

  // 3) SINGLE-FILE install (the CI pattern): OPENCODE_CONFIG one-file
  // config pointing at ci/openshare.js — no global config involved.
  // NO explicit urlFile: the default `openshare.urls.txt` must appear in
  // the working/session directory, not some fixed place.
  const CI_BUNDLE = fileURLToPath(new URL("../ci/openshare.js", import.meta.url)).replace(/\\/g, "/")
  const ciSandbox = join(suiteDir, "ci")
  const ciProject = join(ciSandbox, "project")
  mkdirSync(ciProject, { recursive: true })
  for (const sub of ["xdg", "xdg-data", "xdg-state"]) mkdirSync(join(ciSandbox, sub), { recursive: true })
  const ciConfig = join(ciSandbox, "opencode.json")
  writeFileSync(
    ciConfig,
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugin: [CI_BUNDLE],
        provider: {
          mock: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `http://127.0.0.1:${LLM_PORT}/v1`, apiKey: "mock" },
            models: { "mock-1": { name: "Mock 1" } },
          },
        },
        model: "mock/mock-1",
      },
      null,
      2,
    ),
  )
  const ciDebugFile = join(ciSandbox, "openshare-debug.json")
  const ciRun = (args) =>
    new Promise((resolve) => {
      const child = spawn("opencode", args, {
        cwd: ciProject,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          // hermetic, all three XDG roots (config alone is NOT isolation on
          // v1.18: data root holds the machine-wide session DB — without
          // the redirect, test sessions flood the user's TUI browser and
          // carry zombie plugin configs in with them; state home carries
          // the global flock)
          XDG_CONFIG_HOME: join(ciSandbox, "xdg"),
          XDG_DATA_HOME: join(ciSandbox, "xdg-data"),
          XDG_STATE_HOME: join(ciSandbox, "xdg-state"),
          OPENCODE_CONFIG: ciConfig,
          OPENSHARE_WORKER_URL: WORKER_URL,
          OPENSHARE_CREATE_TOKEN: "suite-create-token",
          OPENSHARE_SPOOL_DIR: join(ciSandbox, "spool"),
          OPENSHARE_DEBOUNCE_MS: "300",
          OPENSHARE_DEBUG_FILE: ciDebugFile,
        },
      })
      let out = ""
      child.stdout.on("data", (d) => (out += d))
      child.stderr.on("data", (d) => (out += d))
      child.on("close", (code) => resolve({ code, out }))
    })

  const ciFirst = await ciRun(["run", "-m", "mock/mock-1", "--message", "ci single-file test"])
  console.log(`\nsingle-file opencode run exit=${ciFirst.code}`)
  const ciShareLine = ciFirst.out.split("\n").filter((l) => l.includes("[openshare]"))
  check("single-file: [openshare] announce lines", ciShareLine.length > 0, ciFirst.out.slice(-400))
  for (const line of ciShareLine) console.log(`  ${line.trim()}`)
  const engineLoads = ciFirst.out.split("\n").filter((l) => l.includes("share mode")).length
  check("single-file: exactly one plugin engine (hermetic)", engineLoads === 1, `engine loads: ${engineLoads}`)

  let ciMode
  try {
    ciMode = JSON.parse(readFileSync(ciDebugFile, "utf8")).mode
  } catch {}
  check("single-file: mode is all (always)", ciMode === "all", `mode=${ciMode}`)

  const defaultUrlFile = join(ciProject, "openshare.urls.txt")
  const ciShareUrl = await waitFor(() => {
    try {
      const content = readFileSync(defaultUrlFile, "utf8").trim()
      return content || undefined
    } catch {
      return undefined
    }
  }, "single-file: default openshare.urls.txt in the working dir")
  check("single-file: default url file lives in the session dir", defaultUrlFile.startsWith(ciProject), defaultUrlFile)
  const ciShareId = ciShareUrl.split("\n").pop()?.trim().split("/").pop()

  const ciBody = await waitFor(async () => {
    const r = await httpGet(`${WORKER_URL}/api/share/${ciShareId}/data`)
    if (!r.ok) throw new Error(`${r.status}`)
    const parsed = await r.json()
    const types = (parsed.data ?? []).map((i) => i.type)
    return parsed.status === "completed" && types.includes("session") && types.includes("message") && types.includes("part") ? parsed : undefined
  }, "single-file: share data complete")
  console.log(`  share: ${ciShareId}  items: ${(ciBody.data ?? []).map((i) => i.type).join(",")}`)
  check("single-file: share complete on the worker", true)

  // what it makes: the file footprint of a CI run (project dir files +
  // the sandbox: spool, debug)
  console.log("  files made:")
  const listFiles = (dir, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        // xdg = the isolation shim (opencode installs its own modules
        // there); project internals stay out except its new files
        if (entry.name !== "project" && entry.name !== ".opencode" && entry.name !== "xdg") listFiles(p, `${prefix}${entry.name}/`)
      } else {
        console.log(`    ${prefix}${entry.name} (${statSync(p).size}b)`)
      }
    }
  }
  try {
    listFiles(ciSandbox)
    for (const entry of readdirSync(ciProject, { withFileTypes: true })) {
      if (entry.isFile()) console.log(`    project/${entry.name} (${statSync(join(ciProject, entry.name)).size}b)`)
    }
  } catch {}
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
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s) — CLI test FAILED`)
  console.error(`suite dir kept for inspection: ${suiteDir}`)
  clearTimeout(watchdog)
  process.exit(1)
}
console.log("\nall checks passed")
rmSync(suiteDir, { recursive: true, force: true })
clearTimeout(watchdog)
process.exit(0)
