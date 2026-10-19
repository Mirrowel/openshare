// Host-agnostic TUI API surface for OpenShare. The exact bounded subset of
// the OpenCode v1 `TuiPluginApi` the share flows and settings dialog use;
// a v1 api instance satisfies it structurally, and v2-tui.ts implements it
// over the OpenCode v2 TUI plugin context. Flows never touch anything
// outside this interface — one compiled bundle runs on both hosts.

import type { ClientApi, SessionInfo, SessionOpts } from "./core.js"

export type ShareDialogSelectOption<Value = string> = {
  title: string
  value: Value
  description?: string
  category?: string
  disabled?: boolean
  /** long-form detail shown in the [i] pane (v1 menus; other hosts ignore) */
  help?: string
}

export type ShareHostKeyContext = {
  event?: {
    preventDefault?: () => void
    stopPropagation?: () => void
  }
}

export type ShareHostLayerCommand = {
  name: string
  title?: string
  desc?: string
  slashName?: string
  slashAliases?: string[]
  suggested?: boolean
  hidden?: boolean
  enabled?: boolean | (() => boolean)
  category?: string
  group?: string
  run: (ctx: ShareHostKeyContext) => void | Promise<void>
}

export type ShareHostKeymapLayer = {
  /** v2 adapter only (v2 keymap layers are natively mode-scoped "global").
   * The v1 registration deliberately ignores this: a v1 plugin layer with
   * a declared mode is gated on the mode stack and never reachable. */
  mode?: string
  priority?: number
  commands: readonly ShareHostLayerCommand[]
  bindings: readonly { key: string; cmd: string; desc?: string }[]
}

export type ShareHostApi = {
  /** Host version marker (v2 adapter sets 2; v1 leaves undefined). */
  hostVersion?: 1 | 2
  app?: { version?: string }
  /** Raw SDK client; metadata PATCH/GET go through it. */
  client?: ClientApi
  kv: {
    get<Value = unknown>(key: string, fallback?: Value): Value
    set(key: string, value: unknown): void
  }
  lifecycle: {
    onDispose(fn: () => void): void
  }
  theme: {
    current: {
      success: unknown
      info: unknown
      error: unknown
      warning: unknown
      textMuted: unknown
    }
  }
  ui: {
    toast(input: { variant?: "info" | "success" | "warning" | "error"; title?: string; message: string; duration?: number }): void
    dialog: {
      replace(renderer: unknown, onClose?: () => void): void
      clear(): void
      setSize(size: string): void
    }
    /** Promise menus (the family showMenuOnce pattern). Preferred UI on v1. */
    showMenu<Value = string>(props: { title: string; options: ShareDialogSelectOption<Value>[]; current?: Value; hint?: string }): Promise<Value | undefined>
    showConfirm(props: { title: string; message: string; confirmLabel?: string }): Promise<boolean>
    showAlert(props: { title: string; message: string }): Promise<void>
    showPrompt(props: { title: string; placeholder?: string; value?: string }): Promise<string | undefined>
    /** Height-slider dialog (v1 facade only; feature-detected by settings). */
    showHeightSlider?(current: number): Promise<number | undefined>
    // Callback dialogs (v2 adapter bridge only — host ui.DialogX under
    // plugin dialog.replace receives no keys on opencode 1.19.x).
    DialogSelect<Value = string>(props: {
      title: string
      placeholder?: string
      options: ShareDialogSelectOption<Value>[]
      current?: Value
      flat?: boolean
      onSelect: (option: ShareDialogSelectOption<Value>) => void
    }): unknown
    DialogPrompt(props: {
      title: string
      placeholder?: string
      value?: string
      onConfirm: (value: string) => void
      onCancel?: () => void
    }): unknown
    DialogConfirm(props: {
      title: string
      message: string
      confirmLabel?: string
      onConfirm: () => void
      onCancel?: () => void
    }): unknown
    DialogAlert(props: { title: string; message: string; onConfirm?: () => void }): unknown
  }
  keymap: {
    registerLayer(layer: ShareHostKeymapLayer): () => void
  }
  /** Live session lookup (v1: reactive state store; v2: client GET). */
  sessionInfo(sessionID: string): SessionInfo | undefined
  /** Currently focused/open session id, when the host can tell. */
  currentSessionID?: () => string | undefined
  /** Clipboard write; resolves false when unavailable. */
  clipboard: {
    write(text: string): Promise<boolean>
  }
}

export type { ClientApi, SessionInfo, SessionOpts }
