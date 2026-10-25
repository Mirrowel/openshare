// The settings panel. Product register: earned familiarity, restrained
// color, one control vocabulary. The CONTENT (SettingsBody) is separate
// from the classic chrome's gear+popover (SettingsPanel) so views can
// embed it inside their own drawers and overlays without inheriting
// popover positioning. Sections are collapsible, collapsed by default
// except single-control ones. The open state lives at module level: a
// settings change can rebuild the header subtree (live-caught) and the
// panel must persist through it.
import { createSignal, For, Show } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import type { JSX } from "solid-js"
import { pagedFor, setPagedFor, type OshSettings } from "./settings"
import { setDiffMode } from "./settings"
import { viewSupportsPaged } from "./views/registry"
import type { Branding } from "./data-source"
import { VIEW_OPTIONS } from "./views/registry"
import { closeInfoPanel } from "./views/info-panel"

const [panelOpen, setPanelOpen] = createSignal(false)
// auto-expand picker sub-view inside the settings panel
const [expandPicker, setExpandPicker] = createSignal(false)
export const togglePanel = () => {
  closeInfoPanel()
  setPanelOpen((v) => !v)
}
export const closePanel = () => setPanelOpen(false)

// section expansion persists across panel remounts (a settings change can
// rebuild the whole subtree - live-caught - and sections must not reset)
const [expandedMap, setExpandedMap] = createSignal<Record<string, boolean>>({})

// panel scroll position persists across the same rebuilds
let settingsScroll = 0
export const saveSettingsScroll = (el: HTMLDivElement) => {
  settingsScroll = el.scrollTop
}
export const restoreSettingsScroll = (el: HTMLDivElement) => {
  queueMicrotask(() => {
    if (el && settingsScroll) el.scrollTop = settingsScroll
  })
}

const THEMES: { id: OshSettings["theme"]; label: string; bg: string; fg: string }[] = [
  { id: "system", label: "system", bg: "#17181c", fg: "#d8dbe0" },
  { id: "light", label: "light", bg: "#fafafa", fg: "#171717" },
  { id: "dark", label: "dark", bg: "#101010", fg: "#e6e6e6" },
  { id: "mirrobot", label: "mirrobot", bg: "#16130f", fg: "#f2ead8" },
  { id: "midnight", label: "midnight", bg: "#0b0e14", fg: "#8fa3d0" },
  { id: "sepia", label: "sepia", bg: "#f4ecd8", fg: "#8a6d3b" },
  { id: "nord", label: "nord", bg: "#2e3440", fg: "#88c0d0" },
]

// a visual signature per view for the selector grid
const VIEW_MARKS: Record<string, string> = {
  classic: "▣",
  terminal: "❯",
  casefile: "◫",
  blueprint: "⊞",
  cinema: "⬒",
  timeline: "⋮",
  letterpress: "A",
  atlas: "△",
  teletype: "≣",
  grove: "❧",
}

function Section(props: { label: string; children: JSX.Element; alwaysOpen?: boolean }) {
  const expanded = () => expandedMap()[props.label] ?? !!props.alwaysOpen
  const setExpanded = (v: boolean) => setExpandedMap((m) => ({ ...m, [props.label]: v }))
  return (
    <div class="flex flex-col pt-1 border-t border-border-weak-base first:border-none first:pt-0">
      <Show
        when={props.alwaysOpen}
        fallback={
          <button
            class="flex items-center justify-between w-full h-7 bg-transparent border-none cursor-pointer text-left text-12-medium text-text-base hover:text-text-strong"
            aria-expanded={expanded()}
            onClick={() => setExpanded(!expanded())}
          >
            {props.label}
            <span class="text-icon-base">
              <Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
            </span>
          </button>
        }
      >
        <div class="flex items-center h-7 text-12-medium text-text-base">{props.label}</div>
      </Show>
      <Show when={expanded()}>
        <div class="flex flex-col gap-0.5 pb-1.5">{props.children}</div>
      </Show>
    </div>
  )
}

/** label left, control right: the one row every behavior setting uses */
function Row(props: { label: string; title?: string; children: JSX.Element }) {
  return (
    <div class="flex items-center justify-between gap-3 min-h-7" title={props.title}>
      <span class="text-12-regular text-text-base">{props.label}</span>
      {props.children}
    </div>
  )
}

function Segmented<T extends string>(props: {
  value: T
  options: { id: T; label: string; title?: string }[]
  onChange: (v: T) => void
  /** hug the options (inside a Row) instead of filling the width */
  inline?: boolean
}) {
  return (
    <div
      class="p-0.5 rounded-md border border-border-weak-base bg-background-stronger"
      classList={{ "inline-flex shrink-0": props.inline, flex: !props.inline }}
      role="radiogroup"
    >
      <For each={props.options}>
        {(o) => (
          <button
            role="radio"
            aria-checked={props.value === o.id}
            title={o.title}
            classList={{
              "h-5 text-12-regular rounded-[4px] border-none cursor-pointer transition-colors duration-150 outline-none": true,
              "px-2": !!props.inline,
              "flex-1": !props.inline,
              "bg-surface-base-interactive-active text-text-strong": props.value === o.id,
              "bg-transparent text-text-weak hover:text-text-strong": props.value !== o.id,
            }}
            onClick={() => props.onChange(o.id)}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  )
}

// NOT named Switch: Solid's compiler treats a <Switch> tag as its own
// control-flow component, so a local one crashes ("switchFunc is not a
// function") the moment the behavior section renders
function Toggle(props: { on: boolean; label: string; title?: string; onChange: () => void }) {
  return (
    <button
      class="flex items-center justify-between gap-3 w-full min-h-7 bg-transparent border-none cursor-pointer text-left group"
      role="switch"
      aria-checked={props.on}
      title={props.title}
      onClick={props.onChange}
    >
      <span class="text-12-regular text-text-base group-hover:text-text-strong transition-colors duration-150">
        {props.label}
      </span>
      <span
        classList={{
          "relative shrink-0 w-7 h-4 rounded-full transition-colors duration-200": true,
          "bg-icon-strong-base": props.on,
          "bg-border-strong-base": !props.on,
        }}
      >
        <span
          classList={{
            "absolute top-0.5 size-3 rounded-full bg-background-base transition-transform duration-200": true,
            "translate-x-0.5": !props.on,
            "translate-x-3.5": props.on,
          }}
        />
      </span>
    </button>
  )
}

// The panel content, embeddable anywhere. No positioning of its own.
export function SettingsBody(props: {
  settings: OshSettings
  update: (patch: Partial<OshSettings>) => void
  branding: Branding
  search: string
  onSearch: (v: string) => void
  /** tool names seen in THIS share (appends to the known list in the
   *  auto-expand picker) */
  sessionTools?: string[]
}) {
  // known tool vocabulary: the canonical host tools we render + any tool
  // this session used (mcp, ctx_*, custom) - deduped, sorted
  const autoExpandChoices = () => {
    const known = ["bash", "shell", "read", "write", "edit", "patch", "grep", "glob", "list", "task", "todowrite", "webfetch", "websearch"]
    return [...new Set([...known, ...(props.sessionTools ?? [])])].sort()
  }
  const skin = () => props.settings.view !== "classic"
  const shared = () => !skin()
  return (
    <div class="flex flex-col gap-1">
      <Section label="View">
        <div class="grid grid-cols-2 gap-1">
          <For each={VIEW_OPTIONS}>
            {(v) => (
              <button
                title={v.label}
                class="flex items-center gap-2 px-2 h-7 rounded-md border cursor-pointer transition-colors duration-150"
                classList={{
                  "border-icon-strong-base bg-surface-base": props.settings.view === v.id,
                  "border-border-weak-base hover:border-border-strong-base bg-transparent": props.settings.view !== v.id,
                }}
                onClick={() => props.update({ view: v.id })}
              >
                <span class="text-12-mono text-text-weak w-4 text-center shrink-0">
                  {VIEW_MARKS[v.id] ?? v.label[0]}
                </span>
                <span class="text-12-regular text-text-base truncate">{v.label}</span>
              </button>
            )}
          </For>
        </div>
      </Section>

      <Section label="Theme">
        <div class="grid grid-cols-2 gap-1">
          <For each={THEMES}>
            {(t) => (
              <button
                class="flex items-center gap-2 px-2 h-7 rounded-md border cursor-pointer transition-colors duration-150"
                classList={{
                  "border-icon-strong-base bg-surface-base": props.settings.theme === t.id,
                  "border-border-weak-base hover:border-border-strong-base bg-transparent": props.settings.theme !== t.id,
                }}
                onClick={() => props.update({ theme: t.id })}
              >
                <span class="relative size-4 rounded-full border border-border-weak-base shrink-0" style={{ background: t.bg }}>
                  <span class="absolute bottom-0.5 right-0.5 size-1.5 rounded-full" style={{ background: t.fg }} />
                </span>
                <span class="text-12-regular text-text-base">{t.label}</span>
              </button>
            )}
          </For>
        </div>
      </Section>

      <Section label="Text size" alwaysOpen>
        <Row label="Interface">
          <Segmented
            inline
            value={props.settings.textSize}
            options={[
              { id: "compact" as const, label: "S", title: "Compact" },
              { id: "normal" as const, label: "M", title: "Normal" },
              { id: "roomy" as const, label: "L", title: "Roomy" },
            ]}
            onChange={(textSize) => props.update({ textSize })}
          />
        </Row>
        <Row label="Reading">
          <Segmented
            inline
            value={props.settings.readText}
            options={[
              { id: "compact" as const, label: "S", title: "Compact" },
              { id: "normal" as const, label: "M", title: "Normal" },
              { id: "large" as const, label: "L", title: "Large" },
            ]}
            onChange={(readText) => props.update({ readText })}
          />
        </Row>
      </Section>

      <Section label="Behavior">
        <Show when={skin() && viewSupportsPaged(props.settings.view)}>
          <Toggle
            label="Paged mode"
            title="One prompt at a time; the rail pages between them"
            on={pagedFor(props.settings, props.settings.view)}
            onChange={() =>
              props.update(setPagedFor(props.settings, props.settings.view, !pagedFor(props.settings, props.settings.view)))
            }
          />
        </Show>
        <Show when={skin()}>
          <Toggle
            label="Prompt rail"
            title="Quick-jump pill beside the transcript (always on in paged mode)"
            on={props.settings.showRail !== false}
            onChange={() => props.update({ showRail: props.settings.showRail === false })}
          />
        </Show>
        <Toggle
          label="Center content"
          on={props.settings.centerContent}
          onChange={() => props.update({ centerContent: !props.settings.centerContent })}
        />
        <Toggle
          label="Follow live"
          title="Keep the newest content visible while you are at the bottom"
          on={props.settings.followLive}
          onChange={() => props.update({ followLive: !props.settings.followLive })}
        />
        <Toggle
          label="Expand reasoning"
          on={props.settings.reasoningOpen}
          onChange={() => props.update({ reasoningOpen: !props.settings.reasoningOpen })}
        />
        <Toggle
          label="Tool call details"
          title="Show invocation titles and queries"
          on={props.settings.toolInfo}
          onChange={() => props.update({ toolInfo: !props.settings.toolInfo })}
        />
        <Show when={shared()}>
          <Toggle
            label="Group tool calls"
            title="Collapse a response's tool calls into summary rows"
            on={props.settings.toolGrouping}
            onChange={() => props.update({ toolGrouping: !props.settings.toolGrouping })}
          />
          <Show when={props.settings.toolGrouping}>
            <Row label="Group">
              <Segmented
                inline
                value={props.settings.toolGroupingScope}
                options={[
                  { id: "context" as const, label: "Reads", title: "Reads and searches only; shell, edits and agents stay their own rows" },
                  { id: "all" as const, label: "All", title: "Every tool call" },
                ]}
                onChange={(toolGroupingScope) => props.update({ toolGroupingScope })}
              />
            </Row>
          </Show>
        </Show>
        <Show when={props.settings.view === "grove"}>
          <Row label="Thinking">
            <Segmented
              inline
              value={props.settings.groveThinking}
              options={[
                { id: "left" as const, label: "Left", title: "With the tools" },
                { id: "right" as const, label: "Right", title: "With the prompts" },
              ]}
              onChange={(groveThinking) => props.update({ groveThinking })}
            />
          </Row>
        </Show>
        <Show when={shared()}>
          <Row label="Prompts">
            <Segmented
              inline
              value={props.settings.promptStyle}
              options={[
                { id: "bubble" as const, label: "Bubble" },
                { id: "flat" as const, label: "Flat" },
              ]}
              onChange={(promptStyle) => props.update({ promptStyle })}
            />
          </Row>
        </Show>
        <Row label="Diff layout">
          <Segmented
            inline
            value={props.settings.diffMode}
            options={[
              { id: "auto" as const, label: "Auto", title: "Split when it fits" },
              { id: "split" as const, label: "Split" },
              { id: "unified" as const, label: "Unified" },
            ]}
            onChange={(diffMode) => {
              props.update({ diffMode })
              setDiffMode(diffMode)
            }}
          />
        </Row>
        <Row label="Long lines">
          <Segmented
            inline
            value={props.settings.outputOverflow}
            options={[
              { id: "scroll" as const, label: "Scroll" },
              { id: "wrap" as const, label: "Wrap" },
            ]}
            onChange={(outputOverflow) => props.update({ outputOverflow })}
          />
        </Row>
        {/* auto-expand: WHICH tool bodies open on render (known tools + any
            this session used), cookie-persisted so every share picks it up */}
        <button
          type="button"
          class="flex items-center justify-between gap-3 w-full min-h-7 bg-transparent border-none cursor-pointer text-left group"
          aria-expanded={expandPicker()}
          onClick={() => setExpandPicker(!expandPicker())}
        >
          <span class="text-12-regular text-text-base group-hover:text-text-strong transition-colors duration-150">
            Auto-expand tools
          </span>
          <span class="flex items-center gap-1 text-12-regular text-text-weak">
            {props.settings.autoExpand.length ? props.settings.autoExpand.length : "None"}
            <Icon name={expandPicker() ? "chevron-down" : "chevron-right"} size="small" />
          </span>
        </button>
        <Show when={expandPicker()}>
          <div class="flex flex-col max-h-48 overflow-y-auto pl-1" data-osh-panel-scroll>
            <For each={autoExpandChoices()}>
              {(name) => {
                const on = () => props.settings.autoExpand.includes(name)
                return (
                  <label class="flex items-center gap-2 h-6 text-12-regular cursor-pointer">
                    <input
                      type="checkbox"
                      class="size-3.5 accent-icon-strong-base"
                      checked={on()}
                      onChange={() => {
                        const next = on()
                          ? props.settings.autoExpand.filter((t) => t !== name)
                          : [...props.settings.autoExpand, name]
                        props.update({ autoExpand: next })
                      }}
                    />
                    <span classList={{ "text-text-weak": !on(), "text-text-base": on() }}>{name}</span>
                  </label>
                )
              }}
            </For>
          </div>
        </Show>
        <Show when={props.branding.backgroundUrl}>
          <Toggle
            label="Background image"
            on={props.settings.backgroundOn}
            onChange={() => props.update({ backgroundOn: !props.settings.backgroundOn })}
          />
        </Show>
      </Section>

      <Section label="Search" alwaysOpen>
        <div class="relative">
          <span class="absolute left-2 top-1/2 -translate-y-1/2 text-icon-base pointer-events-none">
            <Icon name="magnifying-glass" size="small" />
          </span>
          <input
            class="w-full box-border h-7 pl-8 pr-2 rounded-md border border-border-weak-base bg-background-stronger text-text-base text-12-regular outline-none focus:border-icon-strong-base transition-colors duration-150"
            placeholder="Filter prompts"
            data-osh-search
            value={props.search}
            onInput={(e) => props.onSearch(e.currentTarget.value)}
          />
        </div>
      </Section>
    </div>
  )
}

// Classic chrome: gear + popover wrapping the shared body.
export function SettingsPanel(props: {
  settings: OshSettings
  update: (patch: Partial<OshSettings>) => void
  branding: Branding
  search: string
  onSearch: (v: string) => void
  sessionTools?: string[]
}) {
  return (
    <SkinSettingsPopover
      settings={props.settings}
      update={props.update}
      branding={props.branding}
      search={props.search}
      onSearch={props.onSearch}
      sessionTools={props.sessionTools}
      gearClass="osh-gear-settings size-6 flex items-center justify-center rounded-md text-icon-base hover:bg-surface-base hover:text-icon-strong-base bg-transparent border-none cursor-pointer"
      gearTitle="settings"
      gearSize="small"
    />
  )
}

/** The ONE skin settings surface (owner directive: no bespoke centered
 *  modals): a gear button + an ANCHORED popover under it (top-8 right-0,
 *  opaque, scroll-preserving). letterpress/terminal/cinema each shipped a
 *  centered fixed modal - "settings show up in the middle of the page"
 *  (live-caught); every skin now uses this instead. */
export function SkinSettingsPopover(props: {
  settings: OshSettings
  update: (patch: Partial<OshSettings>) => void
  branding: Branding
  search: string
  onSearch: (v: string) => void
  sessionTools?: string[]
  gearClass?: string
  gearTitle?: string
  gearSize?: "small" | "normal"
  gearLabel?: string
}) {
  return (
    <div class="relative flex items-center">
      <button
        class={props.gearClass ?? "flex items-center gap-1.5 bg-transparent border-none cursor-pointer text-12-regular text-text-weaker hover:text-text-base transition-colors duration-150"}
        title={props.gearTitle ?? "settings"}
        onClick={togglePanel}
      >
        <Show when={props.gearLabel}>
          <span class="hidden sm:inline">{props.gearLabel}</span>
        </Show>
        <Icon name="settings-gear" size={props.gearSize ?? "small"} />
      </button>
      <Show when={panelOpen()}>
        <div data-osh-panel-scroll class="absolute top-8 right-0 z-[70] w-64 max-h-[calc(100vh-6rem)] overflow-y-auto p-3 rounded-lg border border-border-weak-base bg-background-base shadow-lg"
          onScroll={saveSettingsScroll as any}
          ref={restoreSettingsScroll}
          onClick={(e) => e.stopPropagation()}
        >
          <div class="flex items-center justify-between pb-2">
            <div class="text-14-medium text-text-strong">Settings</div>
            <button
              class="text-icon-base hover:text-icon-strong-base bg-transparent border-none cursor-pointer size-6 flex items-center justify-center rounded-md hover:bg-surface-base"
              onClick={closePanel}
            >
              <Icon name="close-small" size="small" />
            </button>
          </div>
          <SettingsBody
            settings={props.settings}
            update={props.update}
            branding={props.branding}
            search={props.search}
            onSearch={props.onSearch}
            sessionTools={props.sessionTools}
          />
        </div>
      </Show>
    </div>
  )
}
