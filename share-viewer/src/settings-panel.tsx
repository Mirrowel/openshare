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

const [panelOpen, setPanelOpen] = createSignal(false)
// auto-expand picker sub-view inside the settings panel
const [expandPicker, setExpandPicker] = createSignal(false)
export const togglePanel = () => setPanelOpen((v) => !v)
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
  reader: "≡",
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

function SectionLabel(props: { children: string }) {
  return <div class="text-12-medium text-text-weaker tracking-[0.14em] uppercase">{props.children}</div>
}

function Section(props: { label: string; children: JSX.Element; alwaysOpen?: boolean }) {
  const expanded = () => expandedMap()[props.label] ?? !!props.alwaysOpen
  const setExpanded = (v: boolean) => setExpandedMap((m) => ({ ...m, [props.label]: v }))
  return (
    <div class="flex flex-col pt-3 border-t border-border-weak-base first:border-none first:pt-0">
      <Show
        when={props.alwaysOpen}
        fallback={
          <button
            class="flex items-center justify-between w-full py-1 bg-transparent border-none cursor-pointer text-left"
            onClick={() => setExpanded(!expanded())}
          >
            <SectionLabel>{props.label}</SectionLabel>
            <span class="text-icon-weaker-base">
              <Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
            </span>
          </button>
        }
      >
        <SectionLabel>{props.label}</SectionLabel>
      </Show>
      <Show when={expanded()}>
        <div class="flex flex-col gap-2 pt-2">{props.children}</div>
      </Show>
    </div>
  )
}

function Segmented<T extends string>(props: {
  value: T
  options: { id: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div class="flex p-0.5 rounded-lg border border-border-weak-base bg-background-stronger" role="radiogroup">
      <For each={props.options}>
        {(o) => (
          <button
            role="radio"
            aria-checked={props.value === o.id}
            classList={{
              "flex-1 py-1 text-12-regular rounded-md border-none cursor-pointer transition-colors duration-150 outline-none": true,
              "bg-surface-base-interactive-active text-text-strong": props.value === o.id,
              "bg-transparent text-text-weaker hover:text-text-base": props.value !== o.id,
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

function Switch(props: { on: boolean; label: string; hint?: string; onChange: () => void }) {
  return (
    <button
      class="flex items-center justify-between gap-3 w-full py-1 bg-transparent border-none cursor-pointer text-left group"
      role="switch"
      aria-checked={props.on}
      onClick={props.onChange}
    >
      <span class="flex flex-col gap-0.5 min-w-0">
        <span class="text-12-regular text-text-base group-hover:text-text-strong transition-colors duration-150">
          {props.label}
        </span>
        <Show when={props.hint}>
          <span class="text-12-regular text-text-weaker">{props.hint}</span>
        </Show>
      </span>
      <span
        classList={{
          "relative shrink-0 w-8 h-4.5 rounded-full transition-colors duration-200": true,
          "bg-icon-strong-base": props.on,
          "bg-border-strong-base": !props.on,
        }}
      >
        <span
          classList={{
            "absolute top-0.5 size-3.5 rounded-full bg-background-base shadow-sm transition-transform duration-200": true,
            "translate-x-0.5": !props.on,
            "translate-x-4": props.on,
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
  return (
    <div class="flex flex-col gap-1">
      <Section label="view">
        <div class="grid grid-cols-2 gap-1.5">
          <For each={VIEW_OPTIONS}>
            {(v) => (
              <button
                title={v.label}
                class="flex items-center gap-2 px-2 py-1.5 rounded-lg border cursor-pointer transition-colors duration-150"
                classList={{
                  "border-icon-strong-base bg-surface-base": props.settings.view === v.id,
                  "border-border-weak-base hover:border-border-strong-base bg-transparent": props.settings.view !== v.id,
                }}
                onClick={() => props.update({ view: v.id })}
              >
                <span class="text-12-mono text-text-weaker w-4 text-center shrink-0">
                  {VIEW_MARKS[v.id] ?? v.label[0]}
                </span>
                <span class="text-12-regular text-text-base truncate">{v.label}</span>
              </button>
            )}
          </For>
        </div>
      </Section>

      <Section label="theme">
        <div class="grid grid-cols-2 gap-1.5">
          <For each={THEMES}>
            {(t) => (
              <button
                class="flex items-center gap-2 px-2 py-1.5 rounded-lg border cursor-pointer transition-colors duration-150"
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

      <Section label="interface scale" alwaysOpen>
        <Segmented
          value={props.settings.textSize}
          options={[
            { id: "compact" as const, label: "compact" },
            { id: "normal" as const, label: "normal" },
            { id: "roomy" as const, label: "roomy" },
          ]}
          onChange={(textSize) => props.update({ textSize })}
        />
      </Section>

      <Section label="reading text" alwaysOpen>
        <Segmented
          value={props.settings.readText}
          options={[
            { id: "compact" as const, label: "compact" },
            { id: "normal" as const, label: "normal" },
            { id: "large" as const, label: "large" },
          ]}
          onChange={(readText) => props.update({ readText })}
        />
      </Section>

      <Section label="behavior">
        <div class="flex flex-col">
          <Show when={viewSupportsPaged(props.settings.view)}>
            <Switch
              label="Paged mode"
              hint="one prompt at a time, the rail switcher pages (per view; off = one continuous scroll)"
              on={pagedFor(props.settings, props.settings.view)}
              onChange={() =>
                props.update(
                  setPagedFor(props.settings, props.settings.view, !pagedFor(props.settings, props.settings.view)),
                )
              }
            />
          </Show>
          <Switch
            label="Prompt rail"
            hint="the fast-skip pill beside the transcript in scroll mode (paged mode always shows it - it is the pager)"
            on={props.settings.showRail !== false}
            onChange={() => props.update({ showRail: props.settings.showRail === false })}
          />
          <Switch
            label="Center content"
            on={props.settings.centerContent}
            onChange={() => props.update({ centerContent: !props.settings.centerContent })}
          />
          <Switch
            label="Follow live"
            hint="keep the newest content visible while you are at the bottom"
            on={props.settings.followLive}
            onChange={() => props.update({ followLive: !props.settings.followLive })}
          />
          <Switch
            label="Expanded reasoning"
            on={props.settings.reasoningOpen}
            onChange={() => props.update({ reasoningOpen: !props.settings.reasoningOpen })}
          />
          <Switch
            label="Tool call info"
            hint="invocation titles and queries"
            on={props.settings.toolInfo}
            onChange={() => props.update({ toolInfo: !props.settings.toolInfo })}
          />
          {/* auto-expand: WHICH tool bodies open on render. Checkbox list
              (known tools + anything this session used), cookie-persisted
              so every share picks it up. Default: none */}
          <div class="pl-3 pb-1.5">
            <button
              type="button"
              class="w-full flex items-center justify-between text-left text-12-regular text-text-base py-1 hover:text-text-strong"
              onClick={() => setExpandPicker(!expandPicker())}
            >
              <span>Auto-expand tools</span>
              <span class="text-text-weaker">{props.settings.autoExpand.length ? `${props.settings.autoExpand.length} on` : "none"} {expandPicker() ? "▾" : "▸"}</span>
            </button>
            <Show when={expandPicker()}>
              <div class="flex flex-col gap-0.5 pt-1 max-h-56 overflow-y-auto" data-osh-panel-scroll>
                <For each={autoExpandChoices()}>
                  {(name) => {
                    const on = () => props.settings.autoExpand.includes(name)
                    return (
                      <label class="flex items-center gap-2 text-12-regular text-text-base cursor-pointer py-0.5">
                        <input
                          type="checkbox"
                          checked={on()}
                          onChange={() => {
                            const next = on()
                              ? props.settings.autoExpand.filter((t) => t !== name)
                              : [...props.settings.autoExpand, name]
                            props.update({ autoExpand: next })
                          }}
                        />
                        <span classList={{ "text-text-weaker": !on() }}>{name}</span>
                      </label>
                    )
                  }}
                </For>
              </div>
            </Show>
          </div>
          {/* long lines in tool outputs: wrap, or scroll horizontally
              (hidden scrollbar) - the output width is hard-capped either
              way; this only picks the overflow behavior */}
          <div class="pl-3 pb-1.5">
            <div class="text-12-regular text-text-weaker pb-1">Long lines in outputs</div>
            <Segmented
              value={props.settings.outputOverflow}
              options={[
                { id: "scroll" as const, label: "scroll" },
                { id: "wrap" as const, label: "wrap" },
              ]}
              onChange={(outputOverflow) => props.update({ outputOverflow })}
            />
          </div>
          {/* diff layout: auto (split when it fits), or forced - forced
              split still requires the width; the per-card U/A/S toggle in
              edit headers writes the same setting */}
          <div class="pl-3 pb-1.5">
            <div class="text-12-regular text-text-weaker pb-1">Diff layout</div>
            <Segmented
              value={props.settings.diffMode}
              options={[
                { id: "auto" as const, label: "auto" },
                { id: "split" as const, label: "split" },
                { id: "unified" as const, label: "unified" },
              ]}
              onChange={(diffMode) => {
                props.update({ diffMode })
                setDiffMode(diffMode)
              }}
            />
          </div>
          {/* grouping only applies to the classic timeline; views have
              their own composition */}
          <Show when={props.settings.view === "classic"}>
            <Switch
              label="Group tool calls"
              hint="collapse a response's tool calls into summary rows"
              on={props.settings.toolGrouping}
              onChange={() => props.update({ toolGrouping: !props.settings.toolGrouping })}
            />
            <Show when={props.settings.toolGrouping}>
              <div class="pl-3 pb-1.5">
                <div class="text-12-regular text-text-weaker pb-1">Group</div>
                <Segmented
                  value={props.settings.toolGroupingScope}
                  options={[
                    { id: "context" as const, label: "reads & searches" },
                    { id: "all" as const, label: "all calls" },
                  ]}
                  onChange={(toolGroupingScope) => props.update({ toolGroupingScope })}
                />
                <div class="text-11-regular text-text-weaker pt-1">
                  reads &amp; searches matches the original scope: shell, edits and agents stay their own rows
                </div>
              </div>
            </Show>
          </Show>
          {/* grove owns its own composition: reasoning sits with the tools
              on the left by default; this flips it to the reading column */}
          <Show when={props.settings.view === "grove"}>
            <div class="pl-3 pb-1.5">
              <div class="text-12-regular text-text-weaker pb-1">Thinking</div>
              <Segmented
                value={props.settings.groveThinking}
                options={[
                  { id: "left" as const, label: "left, with tools" },
                  { id: "right" as const, label: "right, with prompts" },
                ]}
                onChange={(groveThinking) => props.update({ groveThinking })}
              />
            </div>
          </Show>
          <Show when={props.branding.backgroundUrl}>
            <Switch
              label="Background image"
              on={props.settings.backgroundOn}
              onChange={() => props.update({ backgroundOn: !props.settings.backgroundOn })}
            />
          </Show>
        </div>
      </Section>

      <Section label="search" alwaysOpen>
        <div class="relative">
          <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-icon-weaker-base pointer-events-none">
            <Icon name="magnifying-glass" size="small" />
          </span>
          <input
            class="w-full box-border pl-8 pr-2.5 py-1.5 rounded-lg border border-border-weak-base bg-background-stronger text-text-base text-12-regular outline-none focus:border-icon-strong-base transition-colors duration-150"
            placeholder="filter prompts (Ctrl+K)"
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
      gearClass="osh-gear-settings p-1 rounded text-icon-weaker-base hover:text-icon-strong-base bg-transparent border-none cursor-pointer"
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
        <div data-osh-panel-scroll class="absolute top-8 right-0 z-[70] w-72 max-h-[calc(100vh-6rem)] overflow-y-auto p-4 rounded-xl border border-border-weak-base bg-background-base shadow-xl"
          onScroll={saveSettingsScroll as any}
          ref={restoreSettingsScroll}
          onClick={(e) => e.stopPropagation()}
        >
          <div class="flex items-center justify-between pb-1">
            <div class="text-14-medium text-text-strong">Settings</div>
            <button
              class="text-icon-weaker-base hover:text-icon-strong-base bg-transparent border-none cursor-pointer p-1 rounded hover:bg-surface-base"
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
