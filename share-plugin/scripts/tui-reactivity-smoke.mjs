import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

// In-process reactivity smoke for the OpenShare TUI: compiles the fixture
// through the same solid transform as dist/tui.js (so the test sees exactly
// what the host loads), then drives the REAL dialogs against the REAL
// @opentui renderer. Catches the "painted once, never repaints" class that
// mock-host flow tests cannot see.

const root = fileURLToPath(new URL("..", import.meta.url))

async function buildFixture(entry, outdir) {
  const { createSolidTransformPlugin } = await import("@opentui/solid/bun-plugin")
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: "bun",
    format: "esm",
    packages: "external",
    plugins: [createSolidTransformPlugin()],
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error("reactivity fixture failed to compile")
  }
}

const distTui = path.join(root, "dist", "tui.js")
const compiled = readFileSync(distTui, "utf8")
if (compiled.includes("@opentui/solid/jsx-runtime") && !compiled.includes("createComponent")) {
  throw new Error("dist/tui.js was built without the reactive solid transform")
}

const failures = []

// --- share-settings resolver (pure unit; no fs, no env) --------------------
// The tier model is load-bearing for the TUI, the engine's create frames
// and PATCH pushes — a silent precedence flip would mis-gate or mis-price
// shares, so the resolution rules are pinned here.
{
  const { resolveShareSettings } = await import(path.join(root, "src", "share-settings.ts"))
  const general = { ttlHours: 10, authLogin: "", authPassword: "" }
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want)
    console.log(`${ok ? "ok  " : "FAIL"} ${name}`)
    if (!ok) {
      failures.push(name)
      console.error(`     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`)
    }
  }
  eq(
    "resolver: ttl precedence share > server > general",
    [
      resolveShareSettings({ general, server: { ttlHours: 20 }, share: { ttlHours: 30 }, mirror: {} })?.ttlHours,
      resolveShareSettings({ general, server: { ttlHours: 20 }, share: {}, mirror: {} })?.ttlHours,
      resolveShareSettings({ general, server: {}, share: {}, mirror: {} })?.ttlHours,
    ],
    [{ value: 30, source: "share" }, { value: 20, source: "server" }, { value: 10, source: "general" }],
  )
  eq(
    "resolver: auth resolves as a pair-unit (half pairs fall through)",
    [
      resolveShareSettings({ general: { ...general, authLogin: "g" }, server: { authLogin: "s", authPassword: "p" }, share: {}, mirror: {} })?.auth,
      resolveShareSettings({ general, server: { authLogin: "s", authPassword: "p" }, share: { authLogin: "x" }, mirror: {} })?.auth,
      resolveShareSettings({ general, server: { authLogin: "s" }, share: {}, mirror: {} })?.auth,
    ],
    [
      { value: { login: "s", password: "p" }, source: "server" },
      { value: { login: "s", password: "p" }, source: "server" },
      undefined,
    ],
  )
  eq(
    "resolver: half-pair diagnostics flag without a gate",
    resolveShareSettings({ general, server: { authLogin: "lonely" }, share: {}, mirror: {} })?.authHalfPair,
    true,
  )
  eq(
    "resolver: paused/title live only at the share tier",
    [
      resolveShareSettings({ general, server: { paused: true, title: "s" }, share: {}, mirror: {} })?.paused,
      resolveShareSettings({ general, server: {}, share: { paused: true, title: "t" }, mirror: {} })?.paused?.value,
      resolveShareSettings({ general, server: {}, share: { paused: true, title: "t" }, mirror: {} })?.title,
    ],
    [undefined, true, { value: "t", source: "share" }],
  )
  eq(
    "resolver: the binding mirror merges UNDER the config share tier",
    [
      resolveShareSettings({ general, server: {}, share: { ttlHours: 8 }, mirror: { ttlHours: 5 } })?.ttlHours,
      resolveShareSettings({ general, server: {}, share: {}, mirror: { ttlHours: 5 } })?.ttlHours,
    ],
    [{ value: 8, source: "share" }, { value: 5, source: "share" }],
  )
  eq("resolver: no tiers set -> server defaults", resolveShareSettings({ general: {}, server: {}, share: {}, mirror: {} }), {})
}

const temp = mkdtempSync(path.join(root, "scripts", ".tui-reactivity-"))
try {
  await buildFixture(path.join(root, "scripts", "fixtures", "tui-reactivity.tsx"), temp)
  const output = path.join(temp, "tui-reactivity.js")
  const fixtureCode = readFileSync(output, "utf8")
  if (fixtureCode.includes("@opentui/solid/jsx-runtime") && !fixtureCode.includes("effect")) {
    throw new Error("reactivity fixture used non-reactive automatic JSX runtime")
  }
  const fixture = await import(`${pathToFileURL(output).href}?${Date.now()}`)
  const checks = [
    ["menu selection repaints on up/down", fixture.verifyMenuSelectionRepaints],
    ["menu with divider fits without scrolling at compact height", fixture.verifyMenuWithDividerFitsWithoutScrolling],
    ["info dialog has a keyboard surface", fixture.verifyInfoDialogKeyboardSurface],
    ["info dialog focus moves and enter activates it", fixture.verifyInfoDialogFocusRepaints],
    ["info dialog buttons keep geometry across focus switch", fixture.verifyInfoDialogButtonsKeepGeometry],
    ["prompt input round-trips through keys", fixture.verifyPromptInputRoundTrips],
    ["size picker adjusts live", fixture.verifySizePickerAdjusts],
  ]
  for (const [name, check] of checks) {
    try {
      await check()
      console.log(`ok  ${name}`)
    } catch (error) {
      failures.push(name)
      console.error(`FAIL ${name}: ${error?.stack ?? error}`)
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}
if (failures.length) {
  console.error(`tui-reactivity: ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log("tui-reactivity: all checks passed")
