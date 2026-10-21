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

import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
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

/** agent-variants' wizardMaxRows superseded (parity check 2026-10-19):
 * config-studio's computeDialogRows is the correct math — the requested
 * percent is capped by a 75%-of-terminal BACKDROP BUDGET (the host dialog
 * sits at terminalHeight/4 from the top, so a dialog taller than ~75%
 * overflows the screen no matter what the percent says). */
function dialogMetrics(api: TuiPluginApi, terminalHeight: number, chromeRows: number, minRows: number) {
  const percent = dialogHeightPercentOf(api)
  const backdropBudget = Math.max(minRows + chromeRows, Math.floor(terminalHeight * 0.75) - 1)
  const available = Math.max(minRows, backdropBudget - chromeRows)
  const requested = Math.max(minRows, Math.floor((terminalHeight * percent) / 100) - chromeRows)
  return { availableRows: available, targetRows: Math.min(requested, available) }
}

function maxRows(api: TuiPluginApi, terminalHeight: number, chromeRows: number, minRows: number) {
  return dialogMetrics(api, terminalHeight, chromeRows, minRows).targetRows
}

/** usable text columns inside a dialog at the current width (frame padding
 * accounted); the estimator and the pre-wrapper both use this so heights
 * match what actually renders. */
export function dialogContentWidth(api: TuiPluginApi) {
  const width = dialogWidthOf(api)
  return (width === "xlarge" ? 116 : width === "large" ? 88 : 60) - 8
}

/** reactive (config-studio's form): width changes apply to the LIVE dialog
 * (the size picker's `w` key resizes as you watch). No medium reset on
 * cleanup — the reset fought other dialogs and the next dialog sets its
 * own size anyway. */
function useDialogSize(api: TuiPluginApi) {
  createEffect(() => {
    try {
      api.ui.dialog.setSize(dialogWidthOf(api))
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

/** Deterministic character-level pre-wrap (parity lesson: opentui's
 * word wrap cannot break unbreakable tokens like a JSON policy blob, so
 * "wrapped" text still escaped the dialog border — live-caught). Both the
 * [i] pane and InfoDialog render THESE lines; the row estimate uses the
 * same output, so heights match what renders. */
export function preWrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    if (raw.length === 0) {
      out.push("")
      continue
    }
    let line = ""
    for (const word of raw.split(" ")) {
      const candidate = line.length === 0 ? word : `${line} ${word}`
      if (candidate.length <= width) {
        line = candidate
        continue
      }
      if (line.length > 0) out.push(line)
      line = ""
      // unbreakable token longer than a line: hard-split it
      let token = word
      while (token.length > width) {
        out.push(token.slice(0, width))
        token = token.slice(width)
      }
      line = token
    }
    if (line.length > 0) out.push(line)
  }
  return out
}

/** config-studio's contentLineAttrs, adapted: headings accent/bold,
 * warnings (error/failed/refused/delete/danger...) red, positives
 * (saved/enrolled/connected...) green, body plain. */
function infoLineAttrs(line: string): { fg: "heading" | "warning" | "positive" | "muted"; bold: boolean } {
  if (line.length === 0) return { fg: "muted", bold: false }
  const heading = !line.startsWith(" ") && (line.endsWith(":") || /^[A-Z][A-Za-z0-9 ._-]+$/.test(line))
  if (/error|failed|refus|invalid|gone|danger|purge|delete/i.test(line)) return { fg: "warning", bold: false }
  if (/saved|enrolled|connected|active|live|success|token saved/i.test(line)) return { fg: "positive", bold: false }
  if (heading) return { fg: "heading", bold: true }
  return { fg: "muted", bold: false }
}

function InfoLines(props: { api: TuiPluginApi; lines: string[] }): JSX.Element {
  const theme = () => props.api.theme.current
  const colorOf = (kind: ReturnType<typeof infoLineAttrs>["fg"]) =>
    kind === "warning" ? theme().error : kind === "positive" ? theme().success : kind === "heading" ? theme().accent : theme().text
  return (
    <box flexDirection="column" gap={0}>
      <For each={props.lines}>
        {(line) => {
          const attrs = infoLineAttrs(line)
          return line.length === 0 ? (
            <text> </text>
          ) : (
            <text fg={colorOf(attrs.fg)} wrapMode="none">{attrs.bold ? <b>{line}</b> : line}</text>
          )
        }}
      </For>
    </box>
  )
}

/** title column cap (family menuTitleWidth, live-caught need: a server URL
 * as a row title stretched the column toward half the dialog — the owner
 * capped it further: full URLs belong in the [i] pane, not the row).
 * Capped + ellipsized. */
function menuTitleWidth(width: DialogWidth, options: readonly { title: string }[]) {
  const longest = Math.max(0, ...options.map((option) => option.title.length)) + 2
  if (width === "xlarge") return Math.min(Math.max(20, longest), 28)
  if (width === "large") return Math.min(Math.max(18, longest), 24)
  return Math.min(Math.max(16, longest), 20)
}

function ellipsize(text: string, width: number) {
  return text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text
}

/** OpenShare visual frame: rounded accent border + accent title row. The
 * logic inside the menus stays the ported family pattern; this wrapper is
 * purely presentation (owner-preferred styling). Natural width — the host
 * dialog panel provides the container; the border hugs the content. */
// Frame note (live-caught): the HOST dialog panel renders plugin content
// with paddingTop=1 (opencode dialog.tsx), so a BORDERED frame always
// showed a dead panel strip above its top border. Borderless family
// shape + a solid accent rule under the title: zero dead space, accent
// identity kept.
function DialogFrame(props: { api: TuiPluginApi; title: string; children: JSX.Element }): JSX.Element {
  const theme = () => props.api.theme.current
  return (
    <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2}>
      <box width="100%" marginBottom={1}>
        <text fg={theme().accent}><b>{props.title}</b></text>
      </box>
      <box width="100%" height={1} backgroundColor={theme().accent} marginBottom={1} />
      {props.children}
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
   * why it matters, full data the row truncates (URLs, ids, statuses).
   * Lines starting with "## " become section headers (paged [i] pane). */
  help?: string
  /** destructive action — title renders red (config-studio port) */
  danger?: boolean
  /** pending/edited state — title renders green (config-studio port) */
  edited?: boolean
  /** non-interactive section separator row (never focusable) */
  divider?: boolean
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
  const hintLines = createMemo(() => (props.hint ? preWrap(props.hint, dialogContentWidth(props.api)) : []))
  const [inspecting, setInspecting] = createSignal(false)
  let listScroll: ScrollBoxRenderable | undefined
  let infoScroll: ScrollBoxRenderable | undefined
  const popMode = props.api.mode.push("openshare.dialog")
  const [selected, setSelected] = createSignal(
    (() => {
      const initial = Math.max(0, props.options.findIndex((option) => option.value === props.current))
      let index = initial
      while (index < props.options.length && props.options[index]?.divider) index++
      return index < props.options.length ? index : initial
    })(),
  )
  const current = createMemo(() => props.options[selected()] ?? props.options[0])
  const move = (delta: number) =>
    setSelected((value) => {
      let next = Math.max(0, Math.min(props.options.length - 1, value + delta))
      while (next >= 0 && next < props.options.length && props.options[next]?.divider) next += delta >= 0 ? 1 : -1
      if (next < 0 || next >= props.options.length || props.options[next]?.divider) return value
      listScroll?.scrollTo(Math.max(0, next - 2))
      return next
    })
  // [i] pane sections: "## Header" lines in help split sections; the pane
  // height comes from the CONTENT (pre-wrapped rows), capped by the same
  // dialog metrics — no longer bound to the spawning menu's list height
  // (live-caught: a 3-row menu gave a 3-row info pane).
  const helpSections = createMemo(() => {
    const raw = current()?.help ?? ""
    const sections: Array<{ title: string; lines: string[] }> = [{ title: "", lines: [] }]
    for (const line of raw.split(/\r?\n/)) {
      const match = /^##\s+(.*)$/.exec(line)
      if (match) sections.push({ title: match[1], lines: [] })
      else sections.at(-1)?.lines.push(line)
    }
    // trim trailing empties of the first (untitled) block; drop empty blocks
    for (const section of sections) {
      while (section.lines.length && section.lines.at(-1) === "") section.lines.pop()
      while (section.lines.length && section.lines[0] === "") section.lines.shift()
    }
    const contentWidth = dialogContentWidth(props.api) - 2
    return sections
      .filter((section, index) => (index === 0 ? section.lines.length > 0 : true))
      .map((section) => ({ title: section.title, lines: preWrap(section.lines.join("\n"), contentWidth) }))
  })
  const infoHeight = createMemo(() =>
    cappedHeight(
      helpSections().reduce((rows, section) => rows + section.lines.length + (section.title ? 2 : 0), 0) + 1,
      maxRows(props.api, dimensions().height, 8, 4),
      4,
    ),
  )
  const [section, setSection] = createSignal(0)
  const jumpSection = (delta: number) => {
    const count = helpSections().length
    if (count <= 1) return
    const next = (section() + delta + count) % count
    setSection(next)
    infoScroll?.scrollTo(0)
  }
  const vertical = (delta: number) => {
    if (inspecting()) infoScroll?.scrollBy(delta)
    else move(delta)
  }
  const page = (delta: number) => {
    if (inspecting()) infoScroll?.scrollBy(delta * Math.max(1, (infoScroll?.height ?? infoHeight()) - 1))
  }
  const choose = () => {
    const option = current()
    if (!option || option.disabled || option.divider) return
    props.onDone(option.value)
  }
  const inspect = () => {
    const option = current()
    if (!option || !option.help) return
    setInspecting(true)
    setSection(0)
    infoScroll?.scrollTo(0)
  }
  const commandPrefix = `openshare.menu.${Math.random().toString(36).slice(2)}`
  const sectionJumpBindings = () =>
    helpSections().length > 1
      ? [
          { key: "p", cmd: `${commandPrefix}.prevSection`, desc: "Previous section" },
          { key: "n", cmd: `${commandPrefix}.nextSection`, desc: "Next section" },
          ...helpSections()
            .slice(0, 9)
            .map((_, index) => ({ key: String(index + 1), cmd: `${commandPrefix}.jump${index + 1}`, desc: `Section ${index + 1}` })),
        ]
      : []
  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands: [
      { name: `${commandPrefix}.up`, title: "Previous item", run: (ctx: KeyContext) => { blockKey(ctx); vertical(-1) } },
      { name: `${commandPrefix}.down`, title: "Next item", run: (ctx: KeyContext) => { blockKey(ctx); vertical(1) } },
      { name: `${commandPrefix}.pageUp`, title: "Page up", run: (ctx: KeyContext) => { blockKey(ctx); page(-1) } },
      { name: `${commandPrefix}.pageDown`, title: "Page down", run: (ctx: KeyContext) => { blockKey(ctx); page(1) } },
      { name: `${commandPrefix}.home`, title: "Top", run: (ctx: KeyContext) => { blockKey(ctx); if (inspecting()) infoScroll?.scrollTo(0) } },
      { name: `${commandPrefix}.end`, title: "Bottom", run: (ctx: KeyContext) => { blockKey(ctx); if (inspecting()) infoScroll?.scrollTo(infoScroll.scrollHeight) } },
      { name: `${commandPrefix}.select`, title: "Select item", run: (ctx: KeyContext) => { blockKey(ctx); if (inspecting()) setInspecting(false); else choose() } },
      { name: `${commandPrefix}.inspect`, title: "Option info", run: (ctx: KeyContext) => { blockKey(ctx); if (!inspecting()) inspect() } },
      { name: `${commandPrefix}.back`, title: "Back", run: (ctx: KeyContext) => { blockKey(ctx); if (inspecting()) setInspecting(false); else props.onDone(undefined) } },
      { name: `${commandPrefix}.prevSection`, title: "Previous section", run: (ctx: KeyContext) => { blockKey(ctx); jumpSection(-1) } },
      { name: `${commandPrefix}.nextSection`, title: "Next section", run: (ctx: KeyContext) => { blockKey(ctx); jumpSection(1) } },
      ...helpSections()
        .slice(0, 9)
        .map((_, index) => ({
          name: `${commandPrefix}.jump${index + 1}`,
          title: `Section ${index + 1}`,
          run: (ctx: KeyContext) => {
            blockKey(ctx)
            setSection(index)
            infoScroll?.scrollTo(0)
          },
        })),
      { name: `${commandPrefix}.shield`, title: "Block background input", run: blockKey },
    ],
    bindings: [
      { key: "up", cmd: `${commandPrefix}.up`, desc: "Previous item" },
      { key: "ctrl+p", cmd: `${commandPrefix}.up`, desc: "Previous item" },
      { key: "down", cmd: `${commandPrefix}.down`, desc: "Next item" },
      { key: "ctrl+n", cmd: `${commandPrefix}.down`, desc: "Next item" },
      { key: "pageup", cmd: `${commandPrefix}.pageUp`, desc: "Page up" },
      { key: "ctrl+b", cmd: `${commandPrefix}.pageUp`, desc: "Page up" },
      { key: "pagedown", cmd: `${commandPrefix}.pageDown`, desc: "Page down" },
      { key: "ctrl+f", cmd: `${commandPrefix}.pageDown`, desc: "Page down" },
      { key: "home", cmd: `${commandPrefix}.home`, desc: "Top" },
      { key: "end", cmd: `${commandPrefix}.end`, desc: "Bottom" },
      { key: "enter", cmd: `${commandPrefix}.select`, desc: "Select item" },
      { key: "i", cmd: `${commandPrefix}.inspect`, desc: "Option info" },
      { key: "escape", cmd: `${commandPrefix}.back`, desc: "Back" },
      ...sectionJumpBindings(),
      ...shieldBindings(`${commandPrefix}.shield`, ["i", ...sectionJumpBindings().map((binding) => binding.key)]),
    ],
  })
  onCleanup(() => {
    unregister()
    popMode()
  })

  return (
    <DialogFrame api={props.api} title={props.title}>
      <Show when={hintLines().length > 0}>
        <box flexDirection="column" marginBottom={1} paddingLeft={1} paddingRight={1}>
          <InfoLines api={props.api} lines={hintLines()} />
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
                  const fg = createMemo(() =>
                    active()
                      ? theme().background
                      : option.divider
                        ? theme().textMuted
                        : option.disabled
                          ? theme().textMuted
                          : option.danger
                            ? theme().error
                            : option.edited
                              ? theme().success
                              : theme().text,
                  )
                  const descFg = createMemo(() => (active() ? theme().background : theme().textMuted))
                  if (option.divider) {
                    return (
                      <box paddingLeft={1} paddingRight={1} marginTop={1} marginBottom={1}>
                        <text fg={theme().textMuted}>{"─".repeat(Math.max(8, dialogContentWidth(props.api) - 4))}</text>
                      </box>
                    )
                  }
                  return (
                    <box
                      flexDirection="row"
                      width="100%"
                      gap={1}
                      paddingLeft={1}
                      paddingRight={1}
                      backgroundColor={active() ? theme().primary : theme().backgroundPanel}
                      onMouseOver={() => {
                        if (!option.divider) setSelected(index())
                      }}
                      onMouseUp={() => {
                        if (!option.disabled && !option.divider) props.onDone(option.value)
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
          <scrollbox maxHeight={infoHeight()} ref={(element: ScrollBoxRenderable) => (infoScroll = element)}>
            <box flexDirection="column" paddingLeft={1} paddingRight={1}>
              <For each={helpSections()}>
                {(sectionData, index) => (
                  <>
                    <Show when={sectionData.title}>
                      <box marginTop={index() > 0 ? 1 : 0} marginBottom={1}>
                        <text fg={theme().accent}><b>{`── ${sectionData.title} `}{"─".repeat(Math.max(0, Math.min(40, 40 - sectionData.title.length)))}</b></text>
                      </box>
                    </Show>
                    <InfoLines api={props.api} lines={sectionData.lines} />
                  </>
                )}
              </For>
            </box>
          </scrollbox>
          <Show when={helpSections().length > 1}>
            <box paddingLeft={1} marginTop={1}>
              <text fg={theme().textMuted}>{`section ${section() + 1}/${helpSections().length} · p/n move · 1-${Math.min(9, helpSections().length)} jump`}</text>
            </box>
          </Show>
        </box>
      </Show>
      <KeyLegend
        api={props.api}
        keys={
          inspecting()
            ? helpSections().length > 1
              ? [["↑↓", "scroll"], ["p/n", "section"], ["⏎", "back"], ["esc", "back"]]
              : [["↑↓", "scroll"], ["⏎", "back"], ["esc", "back"]]
            : hasHelp()
              ? [["↑↓", "move"], ["⏎", "select"], ["i", "info"], ["esc", "back"]]
              : [["↑↓", "move"], ["⏎", "select"], ["esc", "back"]]
        }
        onBack={() => {
          if (inspecting()) setInspecting(false)
          else props.onDone(undefined)
        }}
      />
    </DialogFrame>
  )
}

/** Guard against stacked plugin dialogs. `dialog.replace` is documented as
 * an atomic swap, but on some host builds a second replace while a dialog is
 * still pending leaves BOTH renderers mounted - the reader sees two menus
 * with two highlighted rows and keys go to a stale layer ("/share does
 * nothing"). Cancelling the pending dialog and clearing before the next
 * replace keeps exactly one dialog alive. The normal single-dialog path is
 * untouched, so the esc-to-parent flicker fix stays intact. */
let pendingDialog: (() => void) | undefined
function claimDialog(api: TuiPluginApi): () => void {
  if (pendingDialog) {
    try {
      pendingDialog()
    } catch {}
    try {
      api.ui.dialog.clear()
    } catch {}
  }
  let released = false
  const release = () => {
    if (released) return
    released = true
    if (pendingDialog === release) pendingDialog = undefined
  }
  pendingDialog = release
  return release
}
/** showMenuOnce, family discipline with the flicker fix (2026-10-19):
 * done() does NOT clear the host stack — the next dialog's replace() is an
 * atomic swap, so clearing first paints one empty frame (the esc-to-parent
 * flicker, live-caught). Chain ends clear explicitly (command exits,
 * settings exit). */
export function showMenuOnce<Value>(api: TuiPluginApi, props: { title: string; options: MenuOption<Value>[]; current?: Value; hint?: string }): Promise<Value | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const release = claimDialog(api)
    const done = (value: Value | undefined, _clear = false) => {
      if (settled) return
      settled = true
      release()
      dbgLog(`menu(${props.title}) -> ${value === undefined ? "cancel" : String(value)}`)
      resolve(value)
    }
    dbgLog(`menu(${props.title}) OPEN (${props.options.length} options)`)
    api.ui.dialog.replace(
      () => <MenuDialog api={api} title={props.title} options={props.options} current={props.current} hint={props.hint} onDone={done} />,
      () => done(undefined),
    )
  })
}

// --- InfoDialog (config-studio port): a real message body ----------------------
// Content-derived height, pre-wrapped (char-level — word wrap cannot break
// JSON blobs), semantically styled lines, page/home/end keys, and an action
// footer with buttons + key shortcuts. Replaces the hint-as-message menus
// for confirm/alert (whose single overflow-hidden line clipped destructive
// prompts mid-URL — live-caught).

export type DialogAction = { title: string; value: string; key?: string; danger?: boolean }

export function showInfoDialog(api: TuiPluginApi, props: { title: string; message: string; actions?: DialogAction[] }): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const release = claimDialog(api)
    const done = (value: string | undefined) => {
      if (settled) return
      settled = true
      release()
      resolve(value)
    }
    api.ui.dialog.replace(
      () => <InfoDialog api={api} title={props.title} message={props.message} actions={props.actions} onDone={done} />,
      () => done(undefined),
    )
  })
}

function InfoDialog(props: { api: TuiPluginApi; title: string; message: string; actions?: DialogAction[]; onDone: (value: string | undefined) => void }): JSX.Element {
  const theme = () => props.api.theme.current
  useDialogSize(props.api)
  useHidePromptCursor(props.api)
  const dimensions = useTerminalDimensions()
  const lines = createMemo(() => preWrap(props.message, dialogContentWidth(props.api)))
  const bodyHeight = createMemo(() => cappedHeight(lines().length + 1, maxRows(props.api, dimensions().height, 8, 4), 4))
  let scroll: ScrollBoxRenderable | undefined
  const page = () => Math.max(1, (scroll?.height ?? bodyHeight()) - 1)
  const popMode = props.api.mode.push("openshare.dialog")
  const commandPrefix = `openshare.info.${Math.random().toString(36).slice(2)}`
  const okValue = "__ok"
  const actions = createMemo(() => {
    const list = props.actions?.length ? props.actions : [{ title: "ok", value: okValue, danger: false }]
    return list.map((action, index) => ({ ...action, key: action.key ?? (index === 0 ? "enter" : undefined) }))
  })
  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands: [
      { name: `${commandPrefix}.close`, title: "Close", run: (ctx: KeyContext) => { blockKey(ctx); props.onDone(actions().find((a) => a.key === "enter")?.value ?? okValue) } },
      { name: `${commandPrefix}.back`, title: "Back", run: (ctx: KeyContext) => { blockKey(ctx); props.onDone(undefined) } },
      { name: `${commandPrefix}.up`, title: "Scroll up", run: (ctx: KeyContext) => { blockKey(ctx); scroll?.scrollBy(-1) } },
      { name: `${commandPrefix}.down`, title: "Scroll down", run: (ctx: KeyContext) => { blockKey(ctx); scroll?.scrollBy(1) } },
      { name: `${commandPrefix}.pageUp`, title: "Page up", run: (ctx: KeyContext) => { blockKey(ctx); scroll?.scrollBy(-page()) } },
      { name: `${commandPrefix}.pageDown`, title: "Page down", run: (ctx: KeyContext) => { blockKey(ctx); scroll?.scrollBy(page()) } },
      { name: `${commandPrefix}.home`, title: "Scroll top", run: (ctx: KeyContext) => { blockKey(ctx); scroll?.scrollTo(0) } },
      { name: `${commandPrefix}.end`, title: "Scroll bottom", run: (ctx: KeyContext) => { blockKey(ctx); scroll?.scrollTo(scroll.scrollHeight) } },
      { name: `${commandPrefix}.shield`, title: "Block background input", run: blockKey },
      ...actions()
        .filter((action) => action.key && action.key !== "enter")
        .map((action) => ({
          name: `${commandPrefix}.act_${action.value}`,
          title: action.title,
          run: (ctx: KeyContext) => {
            blockKey(ctx)
            props.onDone(action.value)
          },
        })),
    ],
    bindings: [
      { key: "enter", cmd: `${commandPrefix}.close`, desc: "Close" },
      { key: "escape", cmd: `${commandPrefix}.back`, desc: "Back" },
      { key: "up", cmd: `${commandPrefix}.up`, desc: "Scroll up" },
      { key: "ctrl+p", cmd: `${commandPrefix}.up`, desc: "Scroll up" },
      { key: "down", cmd: `${commandPrefix}.down`, desc: "Scroll down" },
      { key: "ctrl+n", cmd: `${commandPrefix}.down`, desc: "Scroll down" },
      { key: "pageup", cmd: `${commandPrefix}.pageUp`, desc: "Page up" },
      { key: "ctrl+b", cmd: `${commandPrefix}.pageUp`, desc: "Page up" },
      { key: "pagedown", cmd: `${commandPrefix}.pageDown`, desc: "Page down" },
      { key: "ctrl+f", cmd: `${commandPrefix}.pageDown`, desc: "Page down" },
      { key: "home", cmd: `${commandPrefix}.home`, desc: "Scroll top" },
      { key: "end", cmd: `${commandPrefix}.end`, desc: "Scroll bottom" },
      ...actions()
        .filter((action) => action.key && action.key !== "enter")
        .map((action) => ({ key: action.key as string, cmd: `${commandPrefix}.act_${action.value}`, desc: action.title })),
      ...shieldBindings(`${commandPrefix}.shield`, ["home", "end", ...actions().filter((a) => a.key && a.key !== "enter").map((a) => a.key as string)]),
    ],
  })
  onCleanup(() => {
    unregister()
    popMode()
  })

  return (
    <DialogFrame api={props.api} title={props.title}>
      <scrollbox maxHeight={bodyHeight()} ref={(element: ScrollBoxRenderable) => (scroll = element)}>
        <box flexDirection="column" paddingLeft={1} paddingRight={1}>
          <InfoLines api={props.api} lines={lines()} />
        </box>
      </scrollbox>
      <box flexDirection="row" justifyContent="space-between" width="100%" paddingTop={1}>
        <box flexDirection="row" gap={1}>
          <For each={actions().filter((action) => action.key && action.key !== "enter")}>
            {(action) => (
              <text fg={action.danger ? theme().error : theme().textMuted}>{`${action.key}: ${action.title}`}</text>
            )}
          </For>
        </box>
        <box flexDirection="row" gap={1}>
          <For each={actions()}>
            {(action) => (
              <box paddingLeft={2} paddingRight={2} backgroundColor={action.danger ? theme().error : theme().primary} onMouseUp={() => props.onDone(action.value)}>
                <text fg={theme().background}><b>{action.title}</b></text>
              </box>
            )}
          </For>
        </box>
      </box>
    </DialogFrame>
  )
}

// --- confirm / alert on the InfoDialog body -------------------------------------

export function showConfirmMenu(api: TuiPluginApi, props: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return showInfoDialog(api, {
    title: props.title,
    message: props.message,
    actions: [
      { title: props.confirmLabel ?? "Confirm", value: "yes", danger: props.danger },
      { title: "Cancel", value: "no" },
    ],
  }).then((value) => value === "yes")
}

export function showAlertMenu(api: TuiPluginApi, props: { title: string; message: string }): Promise<void> {
  return showInfoDialog(api, { title: props.title, message: props.message }).then(() => undefined)
}

// --- prompt (text entry — the one custom piece) -------------------------------

// Full printable ASCII (parity fix, live-caught class: the lowercase-only
// set made uppercase CREATE_TOKENs and codes UNTYPEABLE). Space is bound
// separately below; escape is the back binding, so it's excluded.
const PROMPT_CHARS = [
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ..."0123456789",
  ..."!@#$%^&*()-_=+[]{};:'\",.<>/?\\|`~",
  ..."://.-_?&=%~+#@",
]
  .join("")
  .split("")
  .filter((ch, index, all) => ch !== " " && all.indexOf(ch) === index)
  .join("")

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
    const release = claimDialog(api)
    const done = (value: string | undefined, _clear = false) => {
      if (settled) return
      settled = true
      release()
      dbgLog(`prompt(${props.title}) -> ${value === undefined ? "cancel" : `len=${value.length}`}`)
      resolve(value)
    }
    dbgLog(`prompt(${props.title}) OPEN`)
    api.ui.dialog.replace(
      () => <PromptDialog api={api} title={props.title} placeholder={props.placeholder} value={props.value} onDone={done} />,
      () => done(undefined),
    )
  })
}

/** host-facade adapter: ShareDialogSelectOption (flows) -> MenuOption */
export function toMenuOptions<Value>(options: ShareDialogSelectOption<Value>[]): MenuOption<Value>[] {
  return options.map((o) => ({ title: o.title, description: o.description, value: o.value, disabled: o.disabled, help: o.help, danger: o.danger, edited: o.edited, divider: o.divider }))
}

// --- combined size picker (config-studio SizeSliderDialog port) ----------------
// One dialog for BOTH dimensions: `w` cycles the width LIVE (reactive
// setSize resizes this very dialog), the slider sets height percent,
// presets 1-4, `c` custom, and a live mini preview shows the real capped
// height the menus will get — not the raw percent math.

export type SizePickerResult = { width: DialogWidth; heightPercent: number }

export function showSizePickerOnce(api: TuiPluginApi, current: SizePickerResult): Promise<SizePickerResult | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const release = claimDialog(api)
    const done = (value: SizePickerResult | undefined) => {
      if (settled) return
      settled = true
      release()
      resolve(value)
    }
    api.ui.dialog.replace(
      () => <SizePickerDialog api={api} current={current} onDone={done} />,
      () => done(undefined),
    )
  })
}

function SizePickerDialog(props: { api: TuiPluginApi; current: SizePickerResult; onDone: (value: SizePickerResult | undefined) => void }): JSX.Element {
  const theme = () => props.api.theme.current
  useDialogSize(props.api)
  useHidePromptCursor(props.api)
  const dimensions = useTerminalDimensions()
  const [height, setHeight] = createSignal(clampHeightPercent(props.current.heightPercent))
  const popMode = props.api.mode.push("openshare.dialog")
  const commandPrefix = `openshare.size.${Math.random().toString(36).slice(2)}`
  const cycleWidth = () => {
    const next = kvWidthOf(props.api.kv) === "medium" ? "large" : kvWidthOf(props.api.kv) === "large" ? "xlarge" : "medium"
    props.api.kv.set(UI_WIDTH_KV, next)
  }
  const setPreset = (label: string) => {
    const preset = HEIGHT_PRESETS.find((p) => p.label === label)
    if (preset) setHeight(preset.value)
  }
  const move = (delta: number) => setHeight((current) => clampHeightPercent(current + delta))
  const save = () => {
    props.api.kv.set(UI_HEIGHT_PERCENT_KV, height())
    props.onDone({ width: kvWidthOf(props.api.kv), heightPercent: height() })
  }
  const sliderWidth = () => (kvWidthOf(props.api.kv) === "xlarge" ? 64 : kvWidthOf(props.api.kv) === "large" ? 48 : 34)
  const sliderCells = createMemo(() => {
    const width = sliderWidth()
    const selected = Math.round(((height() - HEIGHT_PERCENT_MIN) / (HEIGHT_PERCENT_MAX - HEIGHT_PERCENT_MIN)) * (width - 1))
    const presetPositions = new Map(HEIGHT_PRESETS.map((preset) => [Math.round(((preset.value - HEIGHT_PERCENT_MIN) / (HEIGHT_PERCENT_MAX - HEIGHT_PERCENT_MIN)) * (width - 1)), preset.label]))
    return Array.from({ length: width }, (_, index) => {
      const isCurrent = index === selected
      const preset = presetPositions.get(index)
      return {
        char: isCurrent ? "●" : preset ? "│" : index < selected ? "━" : "─",
        color: isCurrent ? theme().primary : preset ? theme().accent : index < selected ? theme().success : theme().textMuted,
      }
    })
  })
  /** live mini preview (config-studio): a mock dialog box scaled to the
   * current settings, using the SAME metrics as real dialogs so it shows
   * the true capped height and flags when the request is capped. */
  const preview = createMemo(() => {
    const widthColumns = kvWidthOf(props.api.kv) === "xlarge" ? 116 : kvWidthOf(props.api.kv) === "large" ? 88 : 60
    const previewWidth = Math.max(10, Math.min(sliderWidth() + 4, 72))
    const scale = previewWidth / widthColumns
    const metrics = dialogMetrics(props.api, dimensions().height, 6, 4)
    const effective = metrics.targetRows
    const requested = Math.floor((dimensions().height * Math.min(100, Math.max(25, height()))) / 100)
    const rows = Math.max(4, Math.round(effective * scale))
    const fill = (text: string, width: number) => {
      const inner = width - 2
      const slice = text.length > inner ? text.slice(0, inner - 1) + "…" : text
      return `│${slice}${" ".repeat(Math.max(0, inner - slice.length))}│`
    }
    const lines: string[] = []
    lines.push(`┌${"─".repeat(previewWidth - 2)}┐`)
    lines.push(fill(`OpenShare (preview)${effective < requested ? " [capped]" : ""}`, previewWidth))
    for (let index = 0; index < rows - 3; index++) lines.push(fill("", previewWidth))
    lines.push(`└${"─".repeat(previewWidth - 2)}┘`)
    return lines
  })
  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands: [
      { name: `${commandPrefix}.width`, title: "Cycle width", run: (ctx: KeyContext) => { blockKey(ctx); cycleWidth() } },
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
      { name: `${commandPrefix}.custom`, title: "Custom percent", run: (ctx: KeyContext) => { blockKey(ctx); props.onDone({ width: kvWidthOf(props.api.kv), heightPercent: -1 }) } },
      { name: `${commandPrefix}.save`, title: "Save", run: (ctx: KeyContext) => { blockKey(ctx); save() } },
      { name: `${commandPrefix}.back`, title: "Back", run: (ctx: KeyContext) => { blockKey(ctx); props.onDone(undefined) } },
      { name: `${commandPrefix}.shield`, title: "Block background input", run: blockKey },
    ],
    bindings: [
      { key: "w", cmd: `${commandPrefix}.width`, desc: "Cycle width" },
      { key: "left", cmd: `${commandPrefix}.left`, desc: "Lower height" },
      { key: "right", cmd: `${commandPrefix}.right`, desc: "Raise height" },
      { key: "down", cmd: `${commandPrefix}.down`, desc: "Lower height faster" },
      { key: "up", cmd: `${commandPrefix}.up`, desc: "Raise height faster" },
      ...HEIGHT_PRESETS.map((preset) => ({ key: preset.key, cmd: `${commandPrefix}.preset_${preset.label}`, desc: `${preset.label} preset` })),
      { key: "c", cmd: `${commandPrefix}.custom`, desc: "Custom percent" },
      { key: "enter", cmd: `${commandPrefix}.save`, desc: "Save" },
      { key: "escape", cmd: `${commandPrefix}.back`, desc: "Back" },
      ...shieldBindings(`${commandPrefix}.shield`, ["w", "c", ...HEIGHT_PRESETS.map((preset) => preset.key)]),
    ],
  })
  onCleanup(() => {
    unregister()
    popMode()
  })

  return (
    <DialogFrame api={props.api} title="Menu size">
      <box flexDirection="row" justifyContent="space-between" width="100%" marginBottom={1} paddingLeft={1} paddingRight={1}>
        <text fg={theme().textMuted}>width (w): {kvWidthOf(props.api.kv)} ({kvWidthOf(props.api.kv) === "xlarge" ? 116 : kvWidthOf(props.api.kv) === "large" ? 88 : 60} cols)</text>
        <text fg={theme().accent}><b>{height()}%</b></text>
      </box>
      <box flexDirection="row" width="100%" marginBottom={1} paddingLeft={1} paddingRight={1}>
        <text fg={theme().textMuted}>{HEIGHT_PERCENT_MIN}% </text>
        <For each={sliderCells()}>{(cell) => <text fg={cell.color}>{cell.char}</text>}</For>
        <text fg={theme().textMuted}> {HEIGHT_PERCENT_MAX}%</text>
      </box>
      <box flexDirection="column" gap={0} marginBottom={1} paddingLeft={1} paddingRight={1}>
        <For each={HEIGHT_PRESETS}>
          {(preset) => (
            <text fg={height() === preset.value ? theme().accent : theme().textMuted}>
              {preset.key} {preset.label}: {preset.value}%{height() === preset.value ? "  ● current" : ""}
            </text>
          )}
        </For>
      </box>
      <box flexDirection="column" paddingLeft={1} paddingRight={1} marginBottom={1}>
        <For each={preview()}>{(line) => <text fg={theme().textMuted}>{line}</text>}</For>
      </box>
      <KeyLegend
        api={props.api}
        keys={[["w", "width"], ["←→", "±1%"], ["↑↓", "±5%"], ["c", "custom"], ["⏎", "save"], ["esc", "back"]]}
        onBack={() => props.onDone(undefined)}
      />
    </DialogFrame>
  )
}
