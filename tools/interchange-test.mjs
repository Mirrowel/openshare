// Interchange self-check: pack <-> export roundtrip on the committed export
// fixtures, plus (when opencode is on PATH) a real import roundtrip through
// a throwaway XDG home.
//
//   node tools/interchange-test.mjs            # roundtrip + import
//   node tools/interchange-test.mjs --no-import  # roundtrip only (fast)
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { envelopeFromExports, exportFromItems, itemsFromValue, sessionIDs } from "./osh-session.mjs"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const EXPORTS = ["example/export/main.json", "example/export/child.json"]
  .map((p) => join(ROOT, p))
  .filter((p) => existsSync(p))

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
}

if (EXPORTS.length < 2) {
  console.error("skipped: example/export/{main,child}.json are missing")
  process.exit(1)
}

// ---- 1. export -> envelope -> export keeps every message and part
const sources = EXPORTS.map((p) => JSON.parse(readFileSync(p, "utf8")))
const items = envelopeFromExports(sources)
const ids = sessionIDs(items)
check("both sessions present", ids.length === 2, ids.join(", "))

// contract v2 has no equivalent for step-* / snapshot / patch parts (the
// plugin drops them by design), so the roundtrip compares the content
// parts that survive every shape: text, reasoning, tool
const KEPT = new Set(["text", "reasoning", "tool"])
const shape = (doc) =>
  JSON.stringify(
    doc.messages.map((m) => [
      m.info.role,
      m.info.agent,
      m.info.modelID,
      (m.parts ?? [])
        .filter((p) => KEPT.has(p.type))
        .map((p) => [p.type, p.text ?? p.tool ?? "", p.state?.status ?? "", p.state?.input ? Object.keys(p.state.input).sort().join("+") : ""]),
    ]),
  )

for (const src of sources) {
  const sid = String(src.info.id)
  const round = exportFromItems(items, sid)
  check(`${sid.slice(-6)} message count`, round.messages.length === src.messages.length, `${round.messages.length}/${src.messages.length}`)
  check(`${sid.slice(-6)} structure`, shape(round) === shape(src))
  check(`${sid.slice(-6)} ids preserved`, round.info.id === sid && round.messages.every((m) => m.info.id.startsWith("msg_")))
  const partIds = round.messages.flatMap((m) => m.parts.map((p) => p.id))
  check(`${sid.slice(-6)} part ids valid+unique`, partIds.every((id) => id.startsWith("prt_")) && new Set(partIds).size === partIds.length)
}

// ---- 2. envelope is itself a valid input (idempotent re-read)
check("envelope re-read", sessionIDs(itemsFromValue({ v: 2, items })).length === 2)

// ---- 3. real `opencode import` roundtrip (throwaway XDG, no user state)
if (!process.argv.includes("--no-import")) {
  let ok = true
  try {
    execFileSync("opencode", ["--version"], { stdio: "ignore" })
  } catch {
    ok = false
    console.log("skip opencode import — `opencode` is not on PATH")
  }
  if (ok) {
    const dir = mkdtempSync(join(tmpdir(), "osh-interchange-"))
    const env = { ...process.env, XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"), XDG_STATE_HOME: join(dir, "state") }
    try {
      const sid = String(sources[0].info.id)
      const doc = exportFromItems(items, sid)
      const file = join(dir, "export.json")
      writeFileSyncSafe(file, JSON.stringify(doc))
      const out = execFileSync("opencode", ["import", file], { cwd: dir, env, encoding: "utf8", timeout: 120_000, shell: process.platform === "win32" })
      check("opencode import accepts the export", out.includes("Imported session"), out.trim().split("\n").pop())
      const back = execFileSync("opencode", ["export", sid], { cwd: dir, env, encoding: "utf8", timeout: 120_000, shell: process.platform === "win32" })
      const parsed = JSON.parse(back)
      check("opencode export roundtrip message count", parsed.messages.length === doc.messages.length, `${parsed.messages.length}/${doc.messages.length}`)
      const roles = parsed.messages.map((m) => m.info.role).join(",")
      check("roles preserved", roles === doc.messages.map((m) => m.info.role).join(","))
    } catch (e) {
      check("opencode import roundtrip", false, String(e?.message ?? e).slice(0, 200))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

function writeFileSyncSafe(path, data) {
  writeFileSync(path, data)
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
