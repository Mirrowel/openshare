/** @jsxImportSource @opentui/solid */

// In-process reactivity rig for the OpenShare TUI dialogs (the family
// plugins' discipline, ported). Mounts the REAL compiled dialogs through
// testRender, invokes the keymap layer commands exactly the way the host
// keymap does, and asserts the visible tree actually changed — plus
// surfaces any throw inside a command or flush with its stack.

import type { BoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { __testInternals } from "../../dist/tui.js"

type Layer = { commands: Array<{ name: string; run: (ctx?: unknown) => void }>; bindings: Array<{ key: string; cmd: string }> }
type RenderHandle = Awaited<ReturnType<typeof testRender>>

const theme = {
  accent: "#ffaa00",
  error: "#ff0000",
  success: "#00ff00",
  text: "#ffffff",
  textMuted: "#888888",
  background: "#000000",
  backgroundPanel: "#111111",
  primary: "#00ff00",
  warning: "#ffff00",
}

function mockApi(state: { layers: Layer[] }, kv?: Record<string, unknown>) {
  return {
    kv: { get: (_key: string, fallback?: unknown) => (kv && _key in kv ? kv[_key] : fallback), set: () => {} },
    theme: { current: theme },
    mode: { push: () => () => {} },
    keymap: {
      registerLayer(layer: Layer) {
        state.layers.push(layer)
        return () => {}
      },
    },
    renderer: { root: {} },
    ui: { dialog: { setSize: () => {} } },
  } as never
}

/** DFS walk collecting every box/text renderable in the painted tree. */
function collect(root: { getChildren?: () => Array<{ getChildren?: () => unknown[] }> }): BoxRenderable[] {
  const out: BoxRenderable[] = []
  const walk = (node: { getChildren?: () => unknown[] }) => {
    const box = node as BoxRenderable
    if (box && typeof box === "object") out.push(box)
    for (const child of node.getChildren?.() ?? []) walk(child as { getChildren?: () => unknown[] })
  }
  walk(root)
  return out
}

function textContent(t: { content?: { chunks?: Array<{ text?: string }> } }): string {
  const content = t.content
  if (!content) return ""
  if (Array.isArray(content.chunks)) return content.chunks.map((chunk) => chunk.text ?? "").join("")
  return ""
}

function boxText(box: BoxRenderable): string {
  let text = ""
  for (const child of box.getChildren?.() ?? []) {
    const t = child as unknown as { content?: { chunks?: Array<{ text?: string }> } }
    if (t && typeof t === "object" && t.content !== undefined) text += textContent(t)
  }
  return text
}

const PRIMARY_BG = "rgba(0.00, 1.00, 0.00, 1.00)"
const PANEL_BG = "rgba(0.07, 0.07, 0.07, 1.00)"

/** DFS indices of boxes carrying the selection highlight. */
function highlightedIndices(root: { getChildren?: () => unknown[] }): number[] {
  return collect(root)
    .map((box, index) => [(box.backgroundColor?.toString?.() ?? "") === PRIMARY_BG ? index : -1])
    .filter(([index]) => index >= 0)
    .map(([index]) => index)
}

/** Row titles carrying the selection highlight (primary background). */
function highlightedTitles(root: { getChildren?: () => unknown[] }): string[] {
  const boxes = collect(root)
  return highlightedIndices(root).map((index) => boxText(boxes[index]).trim())
}

function runCommand(state: { layers: Layer[] }, suffix: string): void {
  const layer = state.layers[0]
  if (!layer) throw new Error(`no keymap layer registered (looking for .${suffix})`)
  const cmd = layer.commands.find((command) => command.name.endsWith(`.${suffix}`))
  if (!cmd) throw new Error(`command .${suffix} not registered; have: ${layer.commands.map((c) => c.name).join(", ")}`)
  cmd.run({})
}

async function mount(component: () => unknown): Promise<RenderHandle> {
  const app = await testRender(component as never, { width: 100, height: 30 })
  await app.flush()
  return app
}

export async function verifyMenuSelectionRepaints(): Promise<void> {
  const state = { layers: [] as Layer[] }
  const api = mockApi(state)
  const options = [
    { title: "Share", value: "yes", description: "publish + copy link", help: "Publishes the session and every subagent session to the worker.\n\n## What ships\nmessages, tool calls, diffs" },
    { title: "Cancel", value: "no", description: "do not share" },
    { title: "Third row", value: "third", description: "to see movement past two" },
  ]
  const app = await mount(() => __testInternals.MenuDialog({ api, title: "Share Session", options, current: "yes", onDone: () => {} }))
  try {
    const beforeIdx = highlightedIndices(app.renderer.root)
    const before = highlightedTitles(app.renderer.root)
    runCommand(state, "down")
    await app.flush()
    const afterIdx = highlightedIndices(app.renderer.root)
    const after = highlightedTitles(app.renderer.root)
    if (before.length === 0) throw new Error("no highlighted row at mount — selection paint is broken")
    if (after.length === 0) throw new Error("highlight vanished after down — repaint is broken")
    if (beforeIdx.join(",") === afterIdx.join(",")) throw new Error(`selection highlight did not move on down (still ${JSON.stringify(after)})`)
    runCommand(state, "up")
    await app.flush()
    const back = highlightedTitles(app.renderer.root)
    if (back[0] !== before[0]) throw new Error("selection did not return on up")
  } finally {
    app.renderer.destroy()
  }
}

export async function verifyInfoDialogKeyboardSurface(): Promise<void> {
  const state = { layers: [] as Layer[] }
  const api = mockApi(state)
  const actions = [
    { title: "Share", value: "yes", danger: false },
    { title: "Cancel", value: "no", danger: false },
  ]
  const app = await mount(() => __testInternals.InfoDialog({ api, title: "Share Session", message: "Publish this session (and its subagent sessions) to your openshare worker?\nserver: https://example.com - TTL: 90d - read auth: off", actions, onDone: () => {} }))
  try {
    const layer = state.layers[0]
    if (!layer) throw new Error("InfoDialog registered no keymap layer")
    // keyboard surface = per-action key bindings (act_<value> commands) OR a
    // focus command moving between actions. Shield bindings (printable keys
    // mapped to blockKey) are NOT a keyboard surface: arrows then do nothing
    // visible and the dialog reads as frozen to keyboard users.
    const actionKeyBindings = layer.bindings.filter((binding) => binding.cmd.includes(".act_"))
    const selectable = layer.commands.find((command) => command.name.endsWith(".focusDown") || command.name.endsWith(".select"))
    if (actionKeyBindings.length === 0 && !selectable) {
      throw new Error("InfoDialog binds no per-action keys and has no selection — keyboard users see a dead dialog (arrows do nothing)")
    }
  } finally {
    app.renderer.destroy()
  }
}

export async function verifyInfoDialogFocusRepaints(): Promise<void> {
  const state = { layers: [] as Layer[] }
  const api = mockApi(state)
  let delivered: string | undefined
  const actions = [
    { title: "Share", value: "yes", danger: false },
    { title: "Cancel", value: "no", danger: false },
  ]
  const app = await mount(() => __testInternals.InfoDialog({ api, title: "Share Session", message: "Publish this session?", actions, onDone: (value: string | undefined) => { delivered = value } }))
  try {
    const focusIndexBefore = highlightedIndices(app.renderer.root)
    runCommand(state, "focusDown")
    await app.flush()
    const focusIndexAfter = highlightedIndices(app.renderer.root)
    if (focusIndexBefore.join(",") === focusIndexAfter.join(",")) throw new Error("focused action highlight did not move on down")
    runCommand(state, "close")
    await app.flush()
    if (delivered !== "no") throw new Error(`enter activated the wrong action (got ${JSON.stringify(delivered)}, expected the focused "no")`)
  } finally {
    app.renderer.destroy()
  }
}

export async function verifyInfoDialogButtonsKeepGeometry(): Promise<void> {
  const state = { layers: [] as Layer[] }
  const api = mockApi(state)
  const actions = [
    { title: "Share", value: "yes", danger: false },
    { title: "Cancel", value: "no", danger: false },
  ]
  const app = await mount(() => __testInternals.InfoDialog({ api, title: "Share Session", message: "Publish this session?", actions, onDone: () => {} }))
  try {
    const buttonRow = (root: { getChildren?: () => unknown[] }) => {
      const focusedBox = collect(root).find((box) => (box.backgroundColor?.toString?.() ?? "") === PRIMARY_BG)
      if (!focusedBox) throw new Error("no focused button painted")
      const parent = collect(root).find((box) => (box.getChildren?.() ?? []).includes(focusedBox))
      if (!parent) throw new Error("focused button has no row parent")
      return { parent, buttons: parent.getChildren?.() ?? [] }
    }
    const rowBefore = buttonRow(app.renderer.root)
    const heightsBefore = rowBefore.buttons.map((box) => (box as BoxRenderable).height)
    if (new Set(heightsBefore).size !== 1) throw new Error(`buttons differ in height in one state: ${heightsBefore.join(",")}`)
    const rowHeightBefore = (rowBefore.parent as BoxRenderable).height
    runCommand(state, "focusDown")
    await app.flush()
    const rowAfter = buttonRow(app.renderer.root)
    const heightsAfter = rowAfter.buttons.map((box) => (box as BoxRenderable).height)
    if (new Set(heightsAfter).size !== 1) throw new Error(`buttons differ in height after switching focus: ${heightsAfter.join(",")}`)
    if ((rowAfter.parent as BoxRenderable).height !== rowHeightBefore) {
      throw new Error(`button row reflowed on focus switch (${rowHeightBefore} -> ${(rowAfter.parent as BoxRenderable).height})`)
    }
  } finally {
    app.renderer.destroy()
  }
}

export async function verifyMenuWithDividerFitsWithoutScrolling(): Promise<void> {
  const state = { layers: [] as Layer[] }
  // compact stored height percent — the exact reported clip: a 6-row menu
  // plus a divider rendering shorter than its own content
  const api = mockApi(state, { "openshare.ui-height-percent": 35 })
  const options = [
    { title: "Worker URL", value: "key:workerUrl", description: "https://example.com" },
    { title: "Create token", value: "key:createToken", description: "credential" },
    { title: "— saved servers —", value: "__divider", divider: true },
    { title: "https://example.com", value: "server:x", description: "token saved · ACTIVE" },
    { title: "Connect to a server", value: "server:add", description: "URL (+ access code)" },
    { title: "Test connection", value: "action:test", description: "probe /health" },
    { title: "Back", value: "__back" },
  ]
  const app = await mount(() => __testInternals.MenuDialog({ api, title: "OpenShare — Servers", options, onDone: () => {} }))
  try {
    const boxes = collect(app.renderer.root)
    const paintedRows = boxes.filter((box) => (box.backgroundColor?.toString?.() ?? "") === PANEL_BG)
    const optionCount = options.filter((option) => !option.divider).length
    if (paintedRows.length < optionCount) {
      throw new Error(`only ${paintedRows.length}/${optionCount} option rows painted — the menu clips its own options`)
    }
    const scroll = boxes.find((box) => box.constructor?.name === "ScrollBoxRenderable")
    if (!scroll) throw new Error("menu list scrollbox not found")
    if (scroll.scrollHeight > scroll.height) {
      throw new Error(`list content (${scroll.scrollHeight} rows) exceeds the body (${scroll.height}) — it scrolls instead of expanding`)
    }
  } finally {
    app.renderer.destroy()
  }
}

export async function verifyPromptInputRoundTrips(): Promise<void> {
  const state = { layers: [] as Layer[] }
  const api = mockApi(state)
  let submitted: string | undefined
  let settled = false
  const app = await mount(() => __testInternals.PromptDialog({ api, title: "Worker URL", placeholder: "https://…", onDone: (value: string | undefined) => { submitted = value; settled = true } }))
  try {
    const typeH = state.layers[0].commands.find((command) => command.name.endsWith(".type_104"))
    const ok = state.layers[0].commands.find((command) => command.name.endsWith(".ok"))
    if (!typeH || !ok) throw new Error("prompt char/confirm commands missing")
    typeH.run({})
    typeH.run({})
    await app.flush()
    ok.run({})
    await app.flush()
    if (!settled || submitted !== "hh") throw new Error(`prompt did not deliver typed text via keys (got ${JSON.stringify(submitted)})`)
  } finally {
    app.renderer.destroy()
  }
}

export async function verifySizePickerAdjusts(): Promise<void> {
  const state = { layers: [] as Layer[] }
  const api = mockApi(state)
  let saved: { width: string; heightPercent: number } | undefined
  const app = await mount(() => __testInternals.SizePickerDialog({ api, current: { width: "medium", heightPercent: 50 }, onDone: (value: { width: string; heightPercent: number } | undefined) => { saved = value ?? undefined } }))
  try {
    runCommand(state, "right")
    await app.flush()
    runCommand(state, "save")
    await app.flush()
    if (saved?.heightPercent !== 51) throw new Error(`size picker did not apply +1% via keys (got ${JSON.stringify(saved)})`)
  } finally {
    app.renderer.destroy()
  }
}
