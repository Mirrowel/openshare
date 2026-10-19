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
import type { JSX } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { ShareDialogSelectOption } from "./tui-host.js"
import { dbgLog } from "./sidebar.js"

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

function useDialogSize(api: TuiPluginApi) {
  try {
    api.ui.dialog.setSize("large")
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

// --- the menu (ported from agent-variants' MenuDialog) -----------------------

export type MenuOption<Value = string> = {
  title: string
  description?: string
  value: Value
  disabled?: boolean
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
  const listHeight = createMemo(() => cappedHeight(props.options.length, 14, 4))
  let scroll: ScrollBoxRenderable | undefined
  const popMode = props.api.mode.push("openshare.dialog")
  const [selected, setSelected] = createSignal(Math.max(0, props.options.findIndex((option) => option.value === props.current)))
  const current = createMemo(() => props.options[selected()] ?? props.options[0])
  const move = (delta: number) =>
    setSelected((value) => {
      const next = Math.max(0, Math.min(props.options.length - 1, value + delta))
      scroll?.scrollTo(Math.max(0, next - 2))
      return next
    })
  const choose = () => {
    const option = current()
    if (!option || option.disabled) return
    props.onDone(option.value)
  }
  const commandPrefix = `openshare.menu.${Math.random().toString(36).slice(2)}`
  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands: [
      { name: `${commandPrefix}.up`, title: "Previous item", run: (ctx: KeyContext) => { blockKey(ctx); move(-1) } },
      { name: `${commandPrefix}.down`, title: "Next item", run: (ctx: KeyContext) => { blockKey(ctx); move(1) } },
      { name: `${commandPrefix}.select`, title: "Select item", run: (ctx: KeyContext) => { blockKey(ctx); choose() } },
      { name: `${commandPrefix}.back`, title: "Back", run: (ctx: KeyContext) => { blockKey(ctx); props.onDone(undefined) } },
      { name: `${commandPrefix}.shield`, title: "Block background input", run: blockKey },
    ],
    bindings: [
      { key: "up", cmd: `${commandPrefix}.up`, desc: "Previous item" },
      { key: "ctrl+p", cmd: `${commandPrefix}.up`, desc: "Previous item" },
      { key: "down", cmd: `${commandPrefix}.down`, desc: "Next item" },
      { key: "ctrl+n", cmd: `${commandPrefix}.down`, desc: "Next item" },
      { key: "enter", cmd: `${commandPrefix}.select`, desc: "Select item" },
      { key: "escape", cmd: `${commandPrefix}.back`, desc: "Back" },
      ...shieldBindings(`${commandPrefix}.shield`),
    ],
  })
  onCleanup(() => {
    unregister()
    popMode()
  })

  return (
    <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%" marginBottom={1}>
        <text fg={theme().text}><b>{props.title}</b></text>
        <text fg={theme().textMuted} onMouseUp={() => props.onDone(undefined)}>esc</text>
      </box>
      <Show when={props.hint}>
        <box marginBottom={1}>
          <text fg={theme().textMuted}>{props.hint}</text>
        </box>
      </Show>
      <box flexDirection="row" gap={3} marginBottom={1}>
        <text fg={theme().textMuted}>enter select</text>
        <text fg={theme().textMuted}>up/down move</text>
      </box>
      <scrollbox maxHeight={listHeight()} ref={(element: ScrollBoxRenderable) => (scroll = element)}>
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
                  <text flexGrow={1} fg={fg()} wrapMode="none" overflow="hidden"><b>{option.title}</b></text>
                  <text flexGrow={2} fg={descFg()} wrapMode="none" overflow="hidden">{option.description ?? ""}</text>
                </box>
              )
            }}
          </For>
        </box>
      </scrollbox>
    </box>
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
    <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%" marginBottom={1}>
        <text fg={theme().text}><b>{props.title}</b></text>
        <text fg={theme().textMuted} onMouseUp={() => props.onDone(undefined)}>esc</text>
      </box>
      <box backgroundColor={theme().backgroundPanel} paddingLeft={1} paddingRight={1} marginBottom={1}>
        <text fg={text() ? theme().text : theme().textMuted}>{text() || props.placeholder || ""}</text>
        <text fg={theme().accent}>{"▌"}</text>
      </box>
      <box flexDirection="row" gap={3}>
        <text fg={theme().textMuted}>enter confirm</text>
        <text fg={theme().textMuted}>esc cancel</text>
      </box>
    </box>
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
  return options.map((o) => ({ title: o.title, description: o.description, value: o.value, disabled: o.disabled }))
}
