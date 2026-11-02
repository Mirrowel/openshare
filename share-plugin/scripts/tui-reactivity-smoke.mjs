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

const temp = mkdtempSync(path.join(root, "scripts", ".tui-reactivity-"))
const failures = []
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
