/** @jsxImportSource @opentui/solid */

// OpenShare interactive dialogs for the v1 TUI — CUSTOM components with
// their own priority-10000 keymap layers, mode push, and input shielding
// (the proven family pattern from config-studio's MenuDialog).
//
// WHY (live-caught 2026-10-19, reproduced in a pty on opencode 1.19.3):
// the host's ui.DialogConfirm/DialogPrompt/DialogSelect components opened
// by a PLUGIN via dialog.replace() render but no longer receive keys on
// 1.19.x — Enter/Escape/click do nothing (the owner's consent dialog was
// uncancellable). Host-internal dialogs still work; plugin-hosted ones do
// not. Until that is fixed upstream, OpenShare owns its dialog input:
// every dialog registers a temporary key layer that captures
// enter/escape/arrows + all printable keys (shield), pushes a mode, and
// pops everything on cleanup.
//
// All dialogs log their lifecycle to the crash-hunt debug log (%TEMP%/
// openshare-tui-debug.log) while instrumentation is active.

import { createSignal, onCleanup } from "solid-js"
import type { JSX } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { ShareDialogSelectOption } from "./tui-host.js"
import { dbgLog } from "./sidebar.js"

/** clear() can throw on an empty dialog stack (1.19.x) — never fatal. */
function safeClear(api: TuiPluginApi) {
  try {
    api.ui.dialog.clear()
  } catch {}
}

type KeyContext = { event?: { preventDefault?: () => void; stopPropagation?: () => void } }

const blockKey = (ctx: KeyContext | undefined) => {
  ctx?.event?.preventDefault?.()
  ctx?.event?.stopPropagation?.()
}

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
  "up",
  "down",
]

type LayerSpec = {
  commands: Array<{ name: string; title: string; run: (ctx: KeyContext) => void }>
  bindings: Array<{ key: string; cmd: string; desc?: string }>
}

/** Registers a dialog's key layer (priority 10000) + a pushed mode.
 * Returns dispose() — idempotent, ALSO called manually on settle because
 * dialog.clear() does not reliably dispose the render root on 1.19.x (the
 * shield layer would leak and eat every keystroke afterwards). */
function useDialogKeys(api: TuiPluginApi, prefix: string, spec: LayerSpec): () => void {
  const popMode = api.mode.push(`openshare.${prefix}`)
  const unregister = api.keymap.registerLayer({
    priority: 10000,
    commands: spec.commands,
    bindings: spec.bindings,
  } as never)
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    try {
      unregister()
    } catch {}
    try {
      popMode()
    } catch {}
  }
  onCleanup(dispose)
  return dispose
}

function DialogFrame(props: { theme: () => Record<string, unknown>; title: string; children: JSX.Element }): JSX.Element {
  const t = props.theme
  // Natural sizing: no fixed width — the host dialog backdrop centers the
  // box and content defines extent (live-caught: width=64 left the border
  // extending past the menu body on the right).
  return (
    <box
      borderStyle="rounded"
      borderColor={t().accent as never}
      flexDirection="column"
      paddingTop={0}
      paddingBottom={1}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={t().accent as never}>
        <b>{props.title}</b>
      </text>
      <box flexDirection="column" paddingTop={1} paddingBottom={0}>
        {props.children}
      </box>
    </box>
  )
}

// --- confirm -----------------------------------------------------------------

export function ConfirmDialog(props: {
  api: TuiPluginApi
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel?: () => void
}): JSX.Element {
  const theme = () => props.api.theme.current as unknown as Record<string, unknown>
  const [focus, setFocus] = createSignal(0) // 0 = confirm, 1 = cancel
  const confirm = props.confirmLabel ?? "Confirm"
  let settled = false
  const done = (which: "confirm" | "cancel") => {
    if (settled) return
    settled = true
    dbgLog(`dialog.confirm(${props.title}) -> ${which}`)
    disposeKeys()
    safeClear(props.api)
    if (which === "confirm") props.onConfirm()
    else props.onCancel?.()
  }
  const prefix = `openshare.confirm.${Math.random().toString(36).slice(2)}`
  const disposeKeys = useDialogKeys(props.api, "confirm", {
    commands: [
      { name: `${prefix}.enter`, title: "Activate button", run: (ctx) => { blockKey(ctx); done(focus() === 0 ? "confirm" : "cancel") } },
      { name: `${prefix}.left`, title: "Previous button", run: (ctx) => { blockKey(ctx); setFocus((v) => (v === 0 ? 1 : 0)) } },
      { name: `${prefix}.right`, title: "Next button", run: (ctx) => { blockKey(ctx); setFocus((v) => (v === 0 ? 1 : 0)) } },
      { name: `${prefix}.back`, title: "Cancel", run: (ctx) => { blockKey(ctx); done("cancel") } },
      { name: `${prefix}.shield`, title: "Block background input", run: blockKey },
    ],
    bindings: [
      { key: "enter", cmd: `${prefix}.enter` },
      { key: "tab", cmd: `${prefix}.right` },
      { key: "left", cmd: `${prefix}.left` },
      { key: "right", cmd: `${prefix}.right` },
      { key: "escape", cmd: `${prefix}.back` },
      ...SHIELDED_KEYS.filter((k) => k !== "tab" && k !== "left" && k !== "right").map((key) => ({ key, cmd: `${prefix}.shield` })),
    ],
  })
  dbgLog(`dialog.confirm(${props.title}) OPEN`)
  return (
    <DialogFrame theme={theme} title={props.title}>
      <text fg={(() => { const t = theme(); return t.text as never })()}>{props.message}</text>
      <box flexDirection="row" gap={2} paddingTop={1}>
        <box backgroundColor={focus() === 0 ? (theme().accent as never) : undefined} paddingLeft={1} paddingRight={1}>
          <text fg={(() => { const t = theme(); return t.text as never })()}>{confirm}</text>
        </box>
        <box backgroundColor={focus() === 1 ? (theme().accent as never) : undefined} paddingLeft={1} paddingRight={1}>
          <text fg={(() => { const t = theme(); return t.text as never })()}>Cancel</text>
        </box>
      </box>
    </DialogFrame>
  )
}

// --- select ------------------------------------------------------------------

export function SelectDialog(props: {
  api: TuiPluginApi
  title: string
  placeholder?: string
  options: ShareDialogSelectOption[]
  current?: string
  onSelect: (option: ShareDialogSelectOption) => void
  onCancel?: () => void
}): JSX.Element {
  dbgLog(`SelectDialog: component body START (title=${props.title})`)
  const theme = () => props.api.theme.current as unknown as Record<string, unknown>
  const startAt = Math.max(0, props.options.findIndex((o) => o.value === props.current))
  const [index, setIndex] = createSignal(startAt)
  // simple windowed scroll: show at most 12 rows around the selection
  const WINDOW = 12
  let settled = false
  const choose = () => {
    const option = props.options[index()]
    if (!option || option.disabled) return
    if (settled) return
    settled = true
    dbgLog(`dialog.select(${props.title}) -> ${JSON.stringify(option.value)}`)
    disposeKeys()
    safeClear(props.api)
    props.onSelect(option)
  }
  const cancel = () => {
    if (settled) return
    settled = true
    dbgLog(`dialog.select(${props.title}) -> cancel`)
    disposeKeys()
    safeClear(props.api)
    props.onCancel?.()
  }
  const move = (delta: number) =>
    setIndex((v) => {
      let next = v + delta
      if (next < 0) next = 0
      if (next > props.options.length - 1) next = props.options.length - 1
      return next
    })
  const prefix = `openshare.select.${Math.random().toString(36).slice(2)}`
  const disposeKeys = useDialogKeys(props.api, "select", {
    commands: [
      { name: `${prefix}.up`, title: "Previous item", run: (ctx) => { blockKey(ctx); move(-1) } },
      { name: `${prefix}.down`, title: "Next item", run: (ctx) => { blockKey(ctx); move(1) } },
      { name: `${prefix}.choose`, title: "Select item", run: (ctx) => { blockKey(ctx); choose() } },
      { name: `${prefix}.back`, title: "Cancel", run: (ctx) => { blockKey(ctx); cancel() } },
      { name: `${prefix}.shield`, title: "Block background input", run: blockKey },
    ],
    bindings: [
      { key: "up", cmd: `${prefix}.up` },
      { key: "ctrl+p", cmd: `${prefix}.up` },
      { key: "down", cmd: `${prefix}.down` },
      { key: "ctrl+n", cmd: `${prefix}.down` },
      { key: "enter", cmd: `${prefix}.choose` },
      { key: "escape", cmd: `${prefix}.back` },
      ...SHIELDED_KEYS.filter((k) => k !== "up" && k !== "down").map((key) => ({ key, cmd: `${prefix}.shield` })),
    ],
  })
  dbgLog(`dialog.select(${props.title}) OPEN (${props.options.length} options)`)
  const from = () => Math.max(0, Math.min(index() - WINDOW + 1, props.options.length - WINDOW))
  const visible = () => props.options.slice(from(), from() + WINDOW)
  return (
    <DialogFrame theme={theme} title={props.title}>
      {props.placeholder ? (
        <text fg={theme().secondary as never}>{props.placeholder}</text>
      ) : null}
      <box flexDirection="column">
        {visible().map((option, i) => {
          const realIndex = () => from() + i
          const selected = () => realIndex() === index()
          return (
            <box
              flexDirection="row"
              backgroundColor={selected() ? (theme().accent as never) : undefined}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={selected() ? (theme().text as never) : option.disabled ? (theme().secondary as never) : (theme().text as never)}>
                {selected() ? "❯ " : "  "}
                {option.title}
                {option.description ? `  — ${option.description}` : ""}
              </text>
            </box>
          )
        })}
      </box>
      <text fg={theme().secondary as never}>↑↓ move · enter select · esc cancel</text>
    </DialogFrame>
  )
}

// --- alert -------------------------------------------------------------------

export function AlertDialog(props: { api: TuiPluginApi; title: string; message: string; onConfirm?: () => void }): JSX.Element {
  const theme = () => props.api.theme.current as unknown as Record<string, unknown>
  let settled = false
  const done = () => {
    if (settled) return
    settled = true
    dbgLog(`dialog.alert(${props.title}) -> ok`)
    disposeKeys()
    safeClear(props.api)
    props.onConfirm?.()
  }
  const prefix = `openshare.alert.${Math.random().toString(36).slice(2)}`
  const disposeKeys = useDialogKeys(props.api, "alert", {
    commands: [
      { name: `${prefix}.ok`, title: "OK", run: (ctx) => { blockKey(ctx); done() } },
      { name: `${prefix}.shield`, title: "Block background input", run: blockKey },
    ],
    bindings: [
      { key: "enter", cmd: `${prefix}.ok` },
      { key: "escape", cmd: `${prefix}.ok` },
      { key: "space", cmd: `${prefix}.ok` },
      ...SHIELDED_KEYS.map((key) => ({ key, cmd: `${prefix}.shield` })),
    ],
  })
  dbgLog(`dialog.alert(${props.title}) OPEN`)
  const ta = theme()
  return (
    <DialogFrame theme={theme} title={props.title}>
      <text fg={ta.text as never}>{props.message}</text>
      <box paddingTop={1}>
        <box backgroundColor={theme().accent as never} paddingLeft={1} paddingRight={1}>
          <text fg={ta.text as never}>OK (enter)</text>
        </box>
      </box>
    </DialogFrame>
  )
}

// --- prompt (single-line text: type / backspace / enter / esc) ---------------

const PROMPT_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789 ://.-_?&=%~+#@"

export function PromptDialog(props: {
  api: TuiPluginApi
  title: string
  placeholder?: string
  value?: string
  onConfirm: (value: string) => void
  onCancel?: () => void
}): JSX.Element {
  const theme = () => props.api.theme.current as unknown as Record<string, unknown>
  const [text, setText] = createSignal(props.value ?? "")
  let settled = false
  const confirm = () => {
    if (settled) return
    settled = true
    dbgLog(`dialog.prompt(${props.title}) -> len=${text().length}`)
    disposeKeys()
    safeClear(props.api)
    props.onConfirm(text())
  }
  const cancel = () => {
    if (settled) return
    settled = true
    dbgLog(`dialog.prompt(${props.title}) -> cancel`)
    disposeKeys()
    safeClear(props.api)
    props.onCancel?.()
  }
  const prefix = `openshare.prompt.${Math.random().toString(36).slice(2)}`
  const commands: Array<{ name: string; title: string; run: (ctx: KeyContext) => void }> = [
    { name: `${prefix}.ok`, title: "Confirm", run: (ctx) => { blockKey(ctx); confirm() } },
    { name: `${prefix}.back`, title: "Cancel", run: (ctx) => { blockKey(ctx); cancel() } },
    { name: `${prefix}.del`, title: "Backspace", run: (ctx) => { blockKey(ctx); setText((v) => v.slice(0, -1)) } },
    { name: `${prefix}.space`, title: "Space", run: (ctx) => { blockKey(ctx); setText((v) => v + " ") } },
    { name: `${prefix}.shield`, title: "Block background input", run: blockKey },
  ]
  const bindings: Array<{ key: string; cmd: string }> = [
    { key: "enter", cmd: `${prefix}.ok` },
    { key: "escape", cmd: `${prefix}.back` },
    { key: "backspace", cmd: `${prefix}.del` },
    { key: "space", cmd: `${prefix}.space` },
  ]
  for (const ch of PROMPT_CHARS) {
    if (ch === " ") continue
    const name = `type_${ch.codePointAt(0)}`
    commands.push({ name: `${prefix}.${name}`, title: `Type ${ch}`, run: (ctx) => { blockKey(ctx); setText((v) => v + ch) } })
    bindings.push({ key: ch, cmd: `${prefix}.${name}` })
  }
  const disposeKeys = useDialogKeys(props.api, "prompt", { commands, bindings })
  dbgLog(`dialog.prompt(${props.title}) OPEN`)
  const t = theme()
  return (
    <DialogFrame theme={theme} title={props.title}>
      <box backgroundColor={theme().secondary as never} paddingLeft={1} paddingRight={1}>
        <text fg={t.text as never}>{text() || props.placeholder || ""}</text>
        <text fg={t.accent as never}>{"▌"}</text>
      </box>
      <text fg={t.secondary as never}>enter confirm · esc cancel</text>
    </DialogFrame>
  )
}
