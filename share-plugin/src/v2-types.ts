/**
 * Minimal structural types for the OpenCode v2 TUI plugin context subset
 * used by this plugin. Hand-written on purpose (same policy as the server
 * side and the family plugins): the v2 SDK is still beta and a v2 plugin
 * module must not import the plugin SDK at runtime anyway. Keep in sync
 * with the beta repo (packages/plugin/src/tui) when the API settles.
 */

export type V2TuiKeyEvent = {
  preventDefault?(): void
  stopPropagation?(): void
  [key: string]: unknown
}

export type V2KeymapCommand = {
  id?: string
  title?: string
  description?: string
  group?: string
  enabled?: boolean | (() => boolean)
  bind?: false | string
  palette?: true
  slash?: { name: string; aliases?: string[]; arguments?: true }
  suggested?: boolean | (() => boolean)
  run: (input?: string, event?: V2TuiKeyEvent) => void | false | Promise<void>
}

export type V2KeymapLayer = {
  mode?: string
  enabled?: boolean | (() => boolean)
  priority?: number
  commands?: readonly V2KeymapCommand[]
  bindings?: readonly string[]
}

export type V2DialogSelectOption<Value> = {
  title: string
  value: Value
  description?: string
  category?: string
  disabled?: boolean
}

export type V2LocationRef = { directory: string; workspaceID?: string }

export type V2TuiContext = {
  options: Readonly<Record<string, unknown>>
  location?: unknown
  app: { version?: string; channel?: string }
  renderer: { root?: unknown }
  client: any
  keymap: {
    layer(input: () => V2KeymapLayer): void
    mode: { current(): string; push(mode: string): () => void }
  }
  storage: {
    store<Value extends object>(
      key: string,
      options: { initial: Value },
    ): readonly [Value, (mutation: (draft: Value) => void) => Promise<void>]
  }
  theme: V2ResolvedTheme
  themeMode: "dark" | "light"
  ui: {
    dialog: {
      show(render: () => unknown, onClose?: () => void): void
      set(options: { size?: string; centered?: boolean }): void
      clear(): void
      alert(options: { title: string; message: string }): Promise<void>
      confirm(options: {
        title: string
        message: string
        label?: { confirm?: string; cancel?: string }
      }): Promise<boolean | undefined>
      prompt(options: { title: string; description?: string; placeholder?: string; value?: string }): Promise<string | undefined>
      select<Value>(options: {
        title: string
        placeholder?: string
        current?: Value
        options: readonly V2DialogSelectOption<Value>[]
      }): Promise<Value | undefined>
    }
    toast: { show(options: { title?: string; message: string; variant?: string; duration?: number }): void }
  }
}

export type V2ResolvedTheme = {
  text: {
    default: unknown
    subdued: unknown
    feedback: Record<string, { default: unknown }>
    action: Record<string, Record<string, unknown>>
  }
  background: {
    default: unknown
    surface: { offset: unknown; overlay: unknown }
  }
  hue: Record<string, Record<string | number, unknown>>
  categorical?: ReadonlyArray<unknown>
}

export type V2TuiSetup = (context: V2TuiContext) => Promise<(() => void) | void> | (() => void) | void
