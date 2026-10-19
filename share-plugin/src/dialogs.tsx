/** @jsxImportSource @opentui/solid */

// OpenShare TUI dialogs — PORTED WHOLESALE from agent-variants' wizard
// MenuDialog (the family pattern, owner-verified working): one menu
// component driven by a temporary priority-10000 keymap layer + pushed
// mode + printable-key shield, settled through a single done() that
// clears the host dialog stack exactly once.
//
// Every choice UI (select / confirm / alert) is a MenuDialog instance —
// no bespoke focus handling, no host ui.DialogX components (their input
// is dead under plugin dialog.replace on opencode 1.19.x). The only
// custom component is PromptDialog (single-line text entry; needed for
// settings fields, no family precedent on 1.19.x) built on the same
// discipline.

import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { JSX } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { ShareDialogSelectOption } from "./tui-host.js"
import { dbgLog } from "./sidebar.js"
import { UI_WIDTH_KV, UI_HEIGHT_PERCENT_KV, HEIGHT_PERCENT_MIN, HEIGHT_PERCENT_MAX, clampHeightPercent, kvWidthOf, kvHeightPercentOf, type DialogWidth } from "./ui-prefs.js"

type KeyContext = { event?: { preventDefault?: () => void; stopPropagation?: () => void } }

const blockKey = (ctx: KeyContext | undefined) => {
  ctx?.event?.preventDefault?.()
  ctx?.event?.stopPropagation?.()
}

// verbatim from agent-variants (plus their punctuation coverage)
const SHIELDED_KEYS = [
  ..."abcdefghijklmnopqrstuvwxyz".split(""),
  ..."0123456789".split(""),
  "space",
  "tab",
  "backspace",
  "delete",
  "home",
  "end",
  "left",
  "right",
  "/",
  "?",
  ":",
  ";",
  "'",
  '"',
  ",",
  ".",
  "-",
  "=",
  "[",
  "]",
  "\\",
  "`",
] as const

function shieldBindings(command: string, except: readonly string[] = []) {
  const allowed = new Set(except)
  return SHIELDED_KEYS.filter((key) => !allowed.has(key)).map((key) => ({ key, cmd: command, desc: "Keep input inside OpenShare" }))
}

function collectEditors(root: { getChildren?: () => unknown[] }): Array<{ showCursor: boolean; isDestroyed?: boolean; getChildren?: () => unknown[] }> {
  const children = root.getChildren?.() ?? []
  return [
    ...((root as { showCursor?: boolean }).showCursor !== undefined ? [root as { showCursor: boolean; isDestroyed?: boolean; getChildren?: () => unknown[] }] : []),
    ...children.flatMap((child) => collectEditors(child as { getChildren?: () => unknown[] })),
  ]
}

/** verbatim from agent-variants: hide the prompt editor's cursor while a dialog is up */
function useHidePromptCursor(api: TuiPluginApi) {
  const editors = collectEditors(api.renderer.root)
  const previous = editors.map((editor) => ({ editor, showCursor: editor.showCursor }))
  for (const editor of editors) {
    editor.showCursor = false
  }
  onCleanup(() => {
    for (const item of previous) {
      if (item.editor.isDestroyed) continue
      item.editor.showCursor = item.showCursor
    }
  })
}

// --- dialog sizing (agent-variants/config-studio machinery, kv-backed) ---------
// Keys/clamps live in ui-prefs.ts (host-agnostic — the settings dialog edits
// them too). Width maps to the host's fixed dialog widths; height is a
// percent of terminal rows clamped 25-100.

const HEIGHT_PRESETS: Array<{ label: string; value: number; key: string }> = [
  { label: "compact", value: 35, key: "1" },
  { label: "normal", value: 50, key: "2" },
  { label: "tall", value: 70, key: "3" },
  { label: "max", value: 100, key: "4" },
]

export function dialogWidthOf(api: TuiPluginApi): DialogWidth {
  return kvWidthOf(api.kv)
}

export function setDialogWidth(api: TuiPluginApi, width: DialogWidth) {
  api.kv.set(UI_WIDTH_KV, width)
  try {
    api.ui.dialog.setSize(width)
  } catch {}
}

export function dialogHeightPercentOf(api: TuiPluginApi): number {
  return kvHeightPercentOf(api.kv)
}

export function setDialogHeightPercent(api: TuiPluginApi, value: number) {
  api.kv.set(UI_HEIGHT_PERCENT_KV, clampHeightPercent(value))
}

/** agent-variants' wizardMaxRows: the menu body may use at most
 * heightPercent% of the terminal (and never more than terminal minus
 * chrome; short lists stay compact via cappedHeight). */
function maxRows(api: TuiPluginApi, terminalHeight: number, chromeRows: number, minRows: number) {
  const usable = Math.max(minRows, terminalHeight - chromeRows)
  return Math.max(minRows, Math.min(usable, Math.floor(terminalHeight * (dialogHeightPercentOf(api) / 100))))
}

function useDialogSize(api: TuiPluginApi) {
  try {
    api.ui.dialog.setSize(dialogWidthOf(api))
  } catch {}
  onCleanup(() => {
    try {
      api.ui.dialog.setSize("medium")
    } catch {}
  })
}

function cappedHeight(count: number, max: number, min = 1) {
  if (count <= 0) return min
  return Math.max(min, Math.min(count, max))
}

/** rows a wrapped message occupies at a given content width */
function estimatedVisualRows(message: string, width: number) {
  return message.split(/\r?\n/).reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / Math.max(1, width))), 0)
}

/** title column cap (family menuTitleWidth, live-caught need: a server URL
 * as a row title stretched the column to 55+, wasting the middle band).
 * Capped + ellipsized; the [i] pane carries the full text. */
function menuTitleWidth(width: DialogWidth, options: readonly { title: string }[]) {
  const longest = Math.max(0, ...options.map((option) => option.title.length)) + 2
  if (width === "xlarge") return Math.min(Math.max(24, longest), 38)
  if (width === "large") return Math.min(Math.max(22, longest), 34)
  return Math.min(Math.max(20, longest), 26)
}

function ellipsize(text: string, width: number) {
  return text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text
}

/** OpenShare visual frame: rounded accent border + accent title row. The
 * logic inside the menus stays the ported family pattern; this wrapper is
 * purely presentation (owner-preferred styling). Natural width — the host
 * dialog panel provides the container; the border hugs the content. */
function DialogFrame(props: { api: TuiPluginApi; title: string; children: JSX.Element }): JSX.Element {
  const theme = () => props.api.theme.current
  return (
    <box borderStyle="rounded" borderColor={theme().accent} flexDirection="column" paddingLeft={1} paddingRight={1}>
      <text fg={theme().accent}><b>{props.title}</b></text>
      <box flexDirection="column" paddingTop={1}>
        {props.children}
      </box>
    </box>
  )
}

/** Stylized key legend row: key glyphs in accent (boxed feel via inverse
 * panel background), verbs muted, separated by dim dots. The esc token is
 * clickable. */
function KeyLegend(props: { api: TuiPluginApi; keys: Array<[string, string]>; onBack?: () => void }): JSX.Element {
  const theme = () => props.api.theme.current
  return (
    <box flexDirection="row" gap={1} paddingTop={1} paddingLeft={1} alignItems="center">
      <For each={props.keys}>
        {(pair, index) => (
          <>
            <box backgroundColor={theme().backgroundPanel} paddingLeft={1} paddingRight={1} onMouseUp={() => { if (pair[0] === "esc") props.onBack?.() }}>
              <text fg={theme().accent}><b>{pair[0]}</b></text>
            </box>
            <text fg={theme().textMuted}>{pair[1]}</text>
            <Show when={index() < props.keys.length - 1}>
              <text fg={theme().textMuted}>·</text>
            </Show>
          </>
        )}
      </For>
    </box>
  )
}

// --- the menu (ported from agent-variants' MenuDialog) -----------------------

export type MenuOption<Value = string> = {
  title: string
  description?: string
  value: Value
  disabled?: boolean
  /** long-form detail for the [i] pane: what it is, current value + source,
   * why it matters, full data the row truncates (URLs, ids, statuses). */
  help?: string
}

export function MenuDialog<Value>(props: {
  api: TuiPluginApi
  title: string
  options: MenuOption<Value>[]
  current?: Value
  hint?: string
  onDone: (value: Value | undefined) => void
}): JSX.Element {
  const theme = () => props.api.theme.current
  useDialogSize(props.api)
  useHidePromptCursor(props.api)
  const dimensions = useTerminalDimensions()
  const listHeight = createMemo(() => cappedHeight(props.options.length, maxRows(props.api, dimensions().height, 12, 4), 4))
  // fixed title column shared by every row (family menuTitleWidth): flex
  // columns stagger per-row because flex splits by content — a computed
  // width is what makes the value/description column align (live-caught).
  const width = dialogWidthOf(props.api)
  const titleWidth = createMemo(() => menuTitleWidth(width, props.options))
  const hasHelp = createMemo(() => props.options.some((option) => option.help))
  const [inspecting, setInspecting] = createSignal(false)
  let listScroll: ScrollBoxRenderable | undefined
  let infoScroll: ScrollBoxRenderable | undefined
  const popMode = props.api.mode.push("openshare.dialog")
  const [selected, setSelected] = createSignal(Math.max(0, props.options.findIndex((option) => option.value === props.current)))
  const current = createMemo(() => props.options[selected()] ?? props.options[0])
  const move = (delta: number) =>
    setSelected((value) => {
      const next = Math.max(0, Math.min(props.options.length - 1, value + delta))
      listScroll?.scrollTo(Math.max(0, next - 2))
      return next
    })
  const vertical = (delta: number) => {
    if (inspecting()) infoScroll?.scrollBy(delta)
    else move(delta)
  }
  const choose = () => {
    const option = current()
    if (!option || option.disabled) return
    props.onDone(option.value)
  }
  const inspect = () => {
    const option = current()
    if (!option || !option.help) return
    setInspecting(true)
    infoScroll?.scrollTo(0)
  }
  const commandPrefix = `openshare.menu.${Math.random().toString(36).slice(2)}`
  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands: [
      { name: `${commandPrefix}.up`, title: "Previous item", run: (ctx: KeyContext) => { blockKey(ctx); vertical(-1) } },
      { name: `${commandPrefix}.down`, title: "Next item", run: (ctx: KeyContext) => { blockKey(ctx); vertical(1) } },
      { name: `${commandPrefix}.select`, title: "Select item", run: (ctx: KeyContext) => { blockKey(ctx); if (inspecting()) setInspecting(false); else choose() } },
      { name: `${commandPrefix}.inspect`, title: "Option info", run: (ctx: KeyContext) => { blockKey(ctx); if (!inspecting()) inspect() } },
      { name: `${commandPrefix}.back`, title: "Back", run: (ctx: KeyContext) => { blockKey(ctx); if (inspecting()) setInspecting(false); else props.onDone(undefined) } },
      { name: `${commandPrefix}.shield`, title: "Block background input", run: blockKey },
    ],
    bindings: [
      { key: "up", cmd: `${commandPrefix}.up`, desc: "Previous item" },
      { key: "ctrl+p", cmd: `${commandPrefix}.up`, desc: "Previous item" },
      { key: "down", cmd: `${commandPrefix}.down`, desc: "Next item" },
      { key: "ctrl+n", cmd: `${commandPrefix}.down`, desc: "Next item" },
      { key: "enter", cmd: `${commandPrefix}.select`, desc: "Select item" },
      { key: "i", cmd: `${commandPrefix}.inspect`, desc: "Option info" },
      { key: "escape", cmd: `${commandPrefix}.back`, desc: "Back" },
      ...shieldBindings(`${commandPrefix}.shield`, ["i"]),
    ],
  })
  onCleanup(() => {
    unregister()
    popMode()
  })

  return (
    <DialogFrame api={props.api} title={props.title}>
      <Show when={props.hint}>
        <box marginBottom={1} paddingLeft={1} paddingRight={1}>
          <text fg={theme().textMuted} wrapMode="none" overflow="hidden">{props.hint}</text>
        </box>
      </Show>
      <Show
        when={inspecting() && current()?.help}
        fallback={
          <scrollbox maxHeight={listHeight()} ref={(element: ScrollBoxRenderable) => (listScroll = element)}>
            <box flexDirection="column" gap={0}>
              <For each={props.options}>
                {(option, index) => {
                  const active = createMemo(() => selected() === index())
                  const fg = createMemo(() => (active() ? theme().background : option.disabled ? theme().textMuted : theme().text))
                  const descFg = createMemo(() => (active() ? theme().background : theme().textMuted))
                  return (
                    <box
                      flexDirection="row"
                      width="100%"
                      gap={1}
                      paddingLeft={1}
                      paddingRight={1}
                      backgroundColor={active() ? theme().primary : theme().backgroundPanel}
                      onMouseOver={() => setSelected(index())}
                      onMouseUp={() => {
                        if (!option.disabled) props.onDone(option.value)
                      }}
                    >
                      <text width={2} flexShrink={0} fg={fg()}>{active() ? "❯" : " "}</text>
                      <text width={titleWidth()} flexShrink={0} fg={fg()} wrapMode="none" overflow="hidden"><b>{ellipsize(option.title, titleWidth())}</b></text>
                      <text flexGrow={1} fg={descFg()} wrapMode="none" overflow="hidden">{option.help ? "ⓘ " : ""}{option.description ?? ""}</text>
                    </box>
                  )
                }}
              </For>
            </box>
          </scrollbox>
        }
      >
        <box flexDirection="column">
          <box marginBottom={1} paddingLeft={1}>
            <text fg={theme().text} wrapMode="none" overflow="hidden"><b>{current()?.title ?? ""}</b></text>
          </box>
          <scrollbox maxHeight={listHeight()} ref={(element: ScrollBoxRenderable) => (infoScroll = element)}>
            <box flexDirection="column" paddingLeft={1} paddingRight={1}>
              <For each={(current()?.help ?? "").split("\n")}>
                {(line) => {
                  // family InfoDialog styling: headings accent, body muted, blanks spaced
                  const heading = line.length > 0 && !line.startsWith(" ") && (line.endsWith(":") || /^[A-Z][A-Za-z ]{2,}$/.test(line))
                  return line.length === 0 ? (
                    <text> </text>
                  ) : (
                    <text fg={heading ? theme().accent : theme().text} wrapMode="word">{heading ? <b>{line}</b> : line}</text>
                  )
                }}
              </For>
            </box>
          </scrollbox>
        </box>
      </Show>
      <KeyLegend
        api={props.api}
        keys={inspecting() ? [["↑↓", "scroll"], ["⏎", "back"], ["esc", "back"]] : hasHelp() ? [["↑↓", "move"], ["⏎", "select"], ["i", "info"], ["esc", "back"]] : [["↑↓", "move"], ["⏎", "select"], ["esc", "back"]]}
        onBack={() => {
          if (inspecting()) setInspecting(false)
          else props.onDone(undefined)
        }}
      />
    </DialogFrame>
  )
}

/** showMenuOnce, verbatim discipline from agent-variants. */
export function showMenuOnce<Value>(api: TuiPluginApi, props: { title: string; options: MenuOption<Value>[]; current?: Value; hint?: string }): Promise<Value | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: Value | undefined, clear = true) => {
      if (settled) return
      settled = true
      dbgLog(`menu(${props.title}) -> ${value === undefined ? "cancel" : String(value)}`)
      resolve(value)
      if (clear) {
        try {
          api.ui.dialog.clear()
        } catch {}
      }
    }
    dbgLog(`menu(${props.title}) OPEN (${props.options.length} options)`)
    api.ui.dialog.replace(
      () => <MenuDialog api={api} title={props.title} options={props.options} current={props.current} hint={props.hint} onDone={done} />,
      () => done(undefined, false),
    )
  })
}

// --- confirm / alert as menus -------------------------------------------------

export function showConfirmMenu(api: TuiPluginApi, props: { title: string; message: string; confirmLabel?: string }): Promise<boolean> {
  return showMenuOnce<string>(api, {
    title: props.title,
    hint: props.message,
    options: [
      { title: props.confirmLabel ?? "Confirm", value: "yes" },
      { title: "Cancel", value: "no" },
    ],
  }).then((value) => value === "yes")
}

export function showAlertMenu(api: TuiPluginApi, props: { title: string; message: string }): Promise<void> {
  return showMenuOnce<string>(api, { title: props.title, hint: props.message, options: [{ title: "OK", value: "ok" }] }).then(() => undefined)
}

// --- prompt (text entry — the one custom piece) -------------------------------

const PROMPT_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789 ://.-_?&=%~+#@"

export function PromptDialog(props: {
  api: TuiPluginApi
  title: string
  placeholder?: string
  value?: string
  onDone: (value: string | undefined) => void
}): JSX.Element {
  const theme = () => props.api.theme.current
  useDialogSize(props.api)
  useHidePromptCursor(props.api)
  const [text, setText] = createSignal(props.value ?? "")
  const popMode = props.api.mode.push("openshare.dialog")
  const commandPrefix = `openshare.prompt.${Math.random().toString(36).slice(2)}`
  const commands: Array<{ name: string; title: string; run: (ctx: KeyContext) => void }> = [
    { name: `${commandPrefix}.ok`, title: "Confirm", run: (ctx) => { blockKey(ctx); props.onDone(text()) } },
    { name: `${commandPrefix}.back`, title: "Cancel", run: (ctx) => { blockKey(ctx); props.onDone(undefined) } },
    { name: `${commandPrefix}.del`, title: "Backspace", run: (ctx) => { blockKey(ctx); setText((v) => v.slice(0, -1)) } },
    { name: `${commandPrefix}.shield`, title: "Block background input", run: blockKey },
  ]
  const bindings: Array<{ key: string; cmd: string; desc?: string }> = [
    { key: "enter", cmd: `${commandPrefix}.ok`, desc: "Confirm" },
    { key: "escape", cmd: `${commandPrefix}.back`, desc: "Cancel" },
    { key: "backspace", cmd: `${commandPrefix}.del`, desc: "Backspace" },
    { key: "space", cmd: `${commandPrefix}.type_space`, desc: "Space" },
  ]
  commands.push({ name: `${commandPrefix}.type_space`, title: "Type space", run: (ctx) => { blockKey(ctx); setText((v) => v + " ") } })
  for (const ch of PROMPT_CHARS) {
    if (ch === " ") continue
    const name = `type_${ch.codePointAt(0)}`
    commands.push({ name: `${commandPrefix}.${name}`, title: `Type ${ch}`, run: (ctx) => { blockKey(ctx); setText((v) => v + ch) } })
    bindings.push({ key: ch, cmd: `${commandPrefix}.${name}` })
  }
  const unregister = props.api.keymap.registerLayer({ priority: 10000, commands, bindings })
  onCleanup(() => {
    unregister()
    popMode()
  })
  return (
    <DialogFrame api={props.api} title={props.title}>
      <box backgroundColor={theme().backgroundPanel} paddingLeft={1} paddingRight={1} marginBottom={1}>
        <text fg={text() ? theme().text : theme().textMuted}>{text() || props.placeholder || ""}</text>
        <text fg={theme().accent}>{"▌"}</text>
      </box>
      <KeyLegend api={props.api} keys={[["a-z0-9", "type"], ["⌫", "delete"], ["⏎", "confirm"], ["esc", "cancel"]]} onBack={() => props.onDone(undefined)} />
    </DialogFrame>
  )
}

export function showPromptOnce(api: TuiPluginApi, props: { title: string; placeholder?: string; value?: string }): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: string | undefined, clear = true) => {
      if (settled) return
      settled = true
      dbgLog(`prompt(${props.title}) -> ${value === undefined ? "cancel" : `len=${value.length}`}`)
      resolve(value)
      if (clear) {
        try {
          api.ui.dialog.clear()
        } catch {}
      }
    }
    dbgLog(`prompt(${props.title}) OPEN`)
    api.ui.dialog.replace(
      () => <PromptDialog api={api} title={props.title} placeholder={props.placeholder} value={props.value} onDone={done} />,
      () => done(undefined, false),
    )
  })
}

/** host-facade adapter: ShareDialogSelectOption (flows) -> MenuOption */
export function toMenuOptions<Value>(options: ShareDialogSelectOption<Value>[]): MenuOption<Value>[] {
  return options.map((o) => ({ title: o.title, description: o.description, value: o.value, disabled: o.disabled, help: o.help }))
}

// --- height slider (agent-variants' HeightSliderDialog, our styling) ----------

type HeightSliderChoice = { action: "save" | "custom"; value: number }

export function showHeightSliderOnce(api: TuiPluginApi, current: number): Promise<HeightSliderChoice | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: HeightSliderChoice | undefined, clear = true) => {
      if (settled) return
      settled = true
      resolve(value)
      if (clear) {
        try {
          api.ui.dialog.clear()
        } catch {}
      }
    }
    api.ui.dialog.replace(
      () => <HeightSliderDialog api={api} current={current} onDone={done} />,
      () => done(undefined, false),
    )
  })
}

function HeightSliderDialog(props: { api: TuiPluginApi; current: number; onDone: (value: HeightSliderChoice | undefined) => void }): JSX.Element {
  const theme = () => props.api.theme.current
  useDialogSize(props.api)
  useHidePromptCursor(props.api)
  const [value, setValue] = createSignal(clampHeightPercent(props.current))
  const popMode = props.api.mode.push("openshare.dialog")
  const commandPrefix = `openshare.height.${Math.random().toString(36).slice(2)}`
  const setPreset = (label: string) => {
    const preset = HEIGHT_PRESETS.find((p) => p.label === label)
    if (preset) setValue(preset.value)
  }
  const move = (delta: number) => setValue((current) => clampHeightPercent(current + delta))
  const sliderWidth = dialogWidthOf(props.api) === "xlarge" ? 64 : dialogWidthOf(props.api) === "large" ? 48 : 34
  const sliderCells = createMemo(() => {
    const selected = Math.round(((value() - HEIGHT_PERCENT_MIN) / (HEIGHT_PERCENT_MAX - HEIGHT_PERCENT_MIN)) * (sliderWidth - 1))
    const presetPositions = new Map(HEIGHT_PRESETS.map((preset) => [Math.round(((preset.value - HEIGHT_PERCENT_MIN) / (HEIGHT_PERCENT_MAX - HEIGHT_PERCENT_MIN)) * (sliderWidth - 1)), preset.label]))
    return Array.from({ length: sliderWidth }, (_, index) => {
      const isCurrent = index === selected
      const preset = presetPositions.get(index)
      return {
        char: isCurrent ? "●" : preset ? "│" : index < selected ? "━" : "─",
        color: isCurrent ? theme().primary : preset ? theme().accent : index < selected ? theme().success : theme().textMuted,
      }
    })
  })
  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands: [
      { name: `${commandPrefix}.left`, title: "Lower height", run: (ctx: KeyContext) => { blockKey(ctx); move(-1) } },
      { name: `${commandPrefix}.right`, title: "Raise height", run: (ctx: KeyContext) => { blockKey(ctx); move(1) } },
      { name: `${commandPrefix}.down`, title: "Lower height faster", run: (ctx: KeyContext) => { blockKey(ctx); move(-5) } },
      { name: `${commandPrefix}.up`, title: "Raise height faster", run: (ctx: KeyContext) => { blockKey(ctx); move(5) } },
      ...HEIGHT_PRESETS.map((preset) => ({
        name: `${commandPrefix}.preset_${preset.label}`,
        title: `${preset.label} preset`,
        run: (ctx: KeyContext) => {
          blockKey(ctx)
          setPreset(preset.label)
        },
      })),
      { name: `${commandPrefix}.custom`, title: "Custom percent", run: (ctx: KeyContext) => { blockKey(ctx); props.onDone({ action: "custom", value: value() }) } },
      { name: `${commandPrefix}.save`, title: "Save height", run: (ctx: KeyContext) => { blockKey(ctx); props.onDone({ action: "save", value: value() }) } },
      { name: `${commandPrefix}.back`, title: "Back", run: (ctx: KeyContext) => { blockKey(ctx); props.onDone(undefined) } },
      { name: `${commandPrefix}.shield`, title: "Block background input", run: blockKey },
    ],
    bindings: [
      { key: "left", cmd: `${commandPrefix}.left`, desc: "Lower height" },
      { key: "right", cmd: `${commandPrefix}.right`, desc: "Raise height" },
      { key: "down", cmd: `${commandPrefix}.down`, desc: "Lower height faster" },
      { key: "up", cmd: `${commandPrefix}.up`, desc: "Raise height faster" },
      ...HEIGHT_PRESETS.map((preset) => ({ key: preset.key, cmd: `${commandPrefix}.preset_${preset.label}`, desc: `${preset.label} preset` })),
      { key: "c", cmd: `${commandPrefix}.custom`, desc: "Custom percent" },
      { key: "enter", cmd: `${commandPrefix}.save`, desc: "Save height" },
      { key: "escape", cmd: `${commandPrefix}.back`, desc: "Back" },
      ...shieldBindings(`${commandPrefix}.shield`, HEIGHT_PRESETS.map((preset) => preset.key).concat(["c"])),
    ],
  })
  onCleanup(() => {
    unregister()
    popMode()
  })

  return (
    <DialogFrame api={props.api} title="Menu height">
      <box flexDirection="row" justifyContent="space-between" width="100%" marginBottom={1} paddingLeft={1} paddingRight={1}>
        <text fg={theme().textMuted}>max height of OpenShare menus</text>
        <text fg={theme().accent}><b>{value()}%</b></text>
      </box>
      <box flexDirection="row" width="100%" marginBottom={1} paddingLeft={1} paddingRight={1}>
        <text fg={theme().textMuted}>{HEIGHT_PERCENT_MIN}% </text>
        <For each={sliderCells()}>{(cell) => <text fg={cell.color}>{cell.char}</text>}</For>
        <text fg={theme().textMuted}> {HEIGHT_PERCENT_MAX}%</text>
      </box>
      <box flexDirection="column" gap={0} marginBottom={1} paddingLeft={1} paddingRight={1}>
        <For each={HEIGHT_PRESETS}>
          {(preset) => (
            <text fg={value() === preset.value ? theme().accent : theme().textMuted}>
              {preset.key} {preset.label}: {preset.value}%{value() === preset.value ? "  ● current" : ""}
            </text>
          )}
        </For>
      </box>
      <KeyLegend
        api={props.api}
        keys={[["←→", "±1%"], ["↑↓", "±5%"], ["c", "custom"], ["⏎", "save"], ["esc", "back"]]}
        onBack={() => props.onDone(undefined)}
      />
    </DialogFrame>
  )
}
