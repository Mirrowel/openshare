// The shared base every view rides. ONE logic source: the same components
// classic uses (the vendored tool pipeline via VendoredPart, the reasoning
// block, MetaLine, the nav) with per-view SKINS that only arrange and
// restyle them. Skins may override pieces (discouraged but possible);
// they never reimplement data handling. The base lays out prompt / ordered
// entries / response from the shared section model, skin wrappers around
// each element kind.
import { Show, createEffect, createMemo, createSignal, type Component, type JSX } from "solid-js"
import { WindowedEntries, WindowedSections } from "../section-window"
import { dismissSearchKey, searchKeyDismissed, searchOwnsDisclosure } from "../search-state"
import { PromptNav } from "../hover-rail"
import { registerPromptNav } from "../prompt-nav"
import { findParentTurn } from "../parent-link"
import { viewSupportsPaged } from "./registry"
import { ViewProvider, type ViewContextValue } from "./view-context"
import { copySessionMarkdown } from "../copy-markdown"
import { downloadSessionExport } from "../export-session"
import { Markdown } from "@opencode/session-ui/markdown"
import { MetaLine } from "./meta-line"
import { VendoredPart } from "./vendored-part"
import { useSessionSections, type SessionSection, type ToolEntry, type ReasoningEntry, type TextEntry } from "./session-data"
import { SearchControl } from "../search-palette"
import type { ViewProps } from "./registry"
import { pagedFor, type OshSettings } from "../settings"
import { Icon } from "@opencode/ui/icon"
import { Mark } from "@opencode/ui/logo"
import { sessionModelLabel } from "./session-data"

// ---------------------------------------------------------------- skin ----
export type SkinWrappers = {
  TurnWrap?: Component<{ section: SessionSection; index: number; settings: OshSettings; children: JSX.Element }>
  PromptWrap?: Component<{ section: SessionSection; settings: OshSettings; children: JSX.Element }>
  ToolWrap?: Component<{ entry: ToolEntry; index: number; settings: OshSettings; children: JSX.Element }>
  ReasoningWrap?: Component<{ entry: ReasoningEntry; settings: OshSettings; children: JSX.Element }>
  ResponseWrap?: Component<{ text: string; settings: OshSettings; children: JSX.Element }>
  Header?: Component<ViewProps & { model: string; status: string; onBack?: () => void; isSub: boolean }>
  Footer?: Component<ViewProps>
  Nav?: Component<{
    sections: SessionSection[]
    active: number
    onSelect: (i: number) => void
  }>
}

export type Skin = {
  id: string
  /** false when the skin renders the prompt itself (cinema's slugline,
   *  teletype's wire headline): base-view then renders ONLY the meta line
   *  inside PromptWrap - without this the prompt text appears twice
   *  (live-caught on cinema/teletype) */
  promptInBody?: boolean
  wrappers: SkinWrappers
  // content column class (layout identity)
  columnClass?: string
}

const Identity = (props: { children: JSX.Element }) => <>{props.children}</>

function wrappersOf(skin: Skin): Required<SkinWrappers> {
  return {
    TurnWrap: skin.wrappers.TurnWrap ?? Identity,
    PromptWrap: skin.wrappers.PromptWrap ?? Identity,
    ToolWrap: skin.wrappers.ToolWrap ?? Identity,
    ReasoningWrap: skin.wrappers.ReasoningWrap ?? Identity,
    ResponseWrap: skin.wrappers.ResponseWrap ?? Identity,
    Header: skin.wrappers.Header ?? DefaultHeader,
    Footer: skin.wrappers.Footer ?? DefaultFooter,
    Nav: skin.wrappers.Nav,
  }
}

// -------------------------------------------------------------- pieces ----
export function DefaultHeader(props: ViewProps & { model: string; status: string; onBack?: () => void; isSub: boolean }) {
  return (
    <header class="h-9 px-4 flex items-center justify-between self-stretch bg-background-base border-b border-border-weak-base relative z-30">
      <div class="flex items-center gap-2 min-w-0">
        <Show when={props.isSub && props.onBack}>
          <button
            class="flex items-center gap-1 text-12-regular text-text-weaker hover:text-text-base bg-transparent border-none cursor-pointer"
            onClick={() => props.onBack?.()}
          >
            <Icon name="arrow-left" size="small" />
            main
          </button>
        </Show>
        <span class="text-13-medium text-text-strong truncate">{props.source.data().session.find((s: any) => s.id === props.sessionID)?.title ?? "session"}</span>
      </div>
      <div class="flex items-center gap-3">
        <span class="flex items-center gap-1.5 text-12-mono text-text-weaker">
          <Mark class="w-3" />
          <span>v{String(props.source.data().session.find((s: any) => s.id === props.sessionID)?.version ?? "?")}</span>
        </span>
        <Show when={props.model}>
          <span class="text-12-mono text-text-weaker truncate max-w-48">{props.model}</span>
        </Show>
        <span class="text-12-regular text-text-weaker">{props.status}</span>
      </div>
    </header>
  )
}

export function DefaultFooter(props: ViewProps) {
  return (
    <div class="px-6 py-6 text-center text-12-mono text-text-weaker select-none">
      {(props.source.branding().name ? props.source.branding().name + " · " : "") + "Open(code)Share"}
    </div>
  )
}

export function ReasoningBlock(props: { text: string; settings: OshSettings; partId?: string }) {
  const searchOpen = () =>
    !!props.partId && searchOwnsDisclosure(props.partId) && !searchKeyDismissed(props.partId)
  return (
    <details
      class="reasoning-collapse group"
      data-timeline-part-id={props.partId}
      open={props.settings.reasoningOpen || searchOpen() || undefined}
      onToggle={(e) => {
        // a manual collapse/expand during a search sticks for that search
        if (props.partId && searchOwnsDisclosure(props.partId)) dismissSearchKey(props.partId, e.currentTarget.open)
      }}
    >
      <summary class="flex items-center gap-2 cursor-pointer list-none select-none py-1">
        <span class="flex items-center gap-1.5 text-12-medium text-text-weaker group-hover:text-text-base transition-colors duration-150">
          <Icon name="brain" size="small" />
          thinking
        </span>
      </summary>
      <div class="ml-1 border-l-2 border-border-weak-base pl-3 my-1 text-13-regular text-text-weaker">
        <Markdown text={props.text} />
      </div>
    </details>
  )
}

// ---------------------------------------------------------------- base ----
export function BaseSessionView(props: ViewProps & { skin: Skin; navMinTurns?: number }) {
  const w = wrappersOf(props.skin)
  const sections = useSessionSections(props.data, props.sessionID)
  const [active, setActive] = createSignal(0)
  const info = () => (props.data.session as any[]).find((s) => s.id === props.sessionID)
  const model = () => sessionModelLabel(props.data, props.sessionID)
  const continuous = () => !pagedFor(props.settings, props.skin.id, viewSupportsPaged(props.skin.id))
  const cachePrefix = props.source.shareID + ":" + props.sessionID
  // one jump path for prompt nav and search: a mounted section scrolls
  // exactly, a far one is revealed by the section window (estimate then
  // align), and paged mode switches the active turn instead
  const [revealReq, setRevealReq] = createSignal<{ id: string; n: number }>()
  let revealN = 0
  const jumpToSection = (id: string) => {
    if (!continuous()) {
      const i = visible().findIndex((s) => s.id === id)
      if (i >= 0) setActive(i)
      return
    }
    const sc = scroller as unknown as HTMLDivElement | undefined
    const el = sc?.querySelector(`[data-section-key="${CSS.escape(`${cachePrefix}:${id}`)}"]`)
    if (el) {
      el.scrollIntoView({ behavior: props.settings.smoothScroll === "instant" ? "auto" : "smooth", block: "start" })
      return
    }
    setRevealReq({ id, n: ++revealN })
  }

  // search filter
  const q = () => props.search.trim().toLowerCase()
  const visible = createMemo(() => {
    if (!q()) return sections()
    return sections().filter(
      (s) => s.prompt.toLowerCase().includes(q()) || s.response.toLowerCase().includes(q()),
    )
  })

  // follow-live (bottom-anchored only)
  let scroller!: HTMLDivElement
  createEffect(() => {
    void props.source.rev()
    if (!props.settings.followLive || props.source.status() !== "live") return
    const el = scroller
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (atBottom) requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight }))
  })

  const back = () => {
    // turn-anchored return: land on the parent turn that spawned this
    // child, not the session top (the plugin's metadata.sessionID stamp
    // resolves it; client-side by construction)
    const turn = parentTurn()
    const hash = turn ? `#${turn.userID}` : ""
    window.history.pushState({}, "", `/s/${props.source.shareID}${hash}`)
    window.dispatchEvent(new PopStateEvent("popstate"))
  }
  const parentTurn = () => findParentTurn(props.data, props.sessionID, info()?.parentID)
  // skins' prompt-nav: paged steps the active section, continuous smooth-
  // scrolls to the section (j/k and [ ] both dispatch here)
  registerPromptNav({
    next: () => {
      const i = Math.min((active() ?? 0) + 1, visible().length - 1)
      if (continuous()) {
        const sc = scroller as unknown as HTMLDivElement | undefined
        const el = sc?.querySelector(`[data-section-key="${CSS.escape(`${cachePrefix}:${visible()[i]?.id}`)}"]`)
        el?.scrollIntoView({ behavior: props.settings.smoothScroll === "instant" ? "auto" : "smooth", block: "start" })
      } else if (i !== active()) setActive(i)
    },
    prev: () => {
      const i = Math.max((active() ?? 0) - 1, 0)
      if (continuous()) {
        const sc = scroller as unknown as HTMLDivElement | undefined
        const el = sc?.querySelector(`[data-section-key="${CSS.escape(`${cachePrefix}:${visible()[i]?.id}`)}"]`)
        el?.scrollIntoView({ behavior: props.settings.smoothScroll === "instant" ? "auto" : "smooth", block: "start" })
      } else if (i !== active()) setActive(i)
    },
  })
  const isSub = () => {
    // a child session carries parentID in the data (true on in-page
    // navigation the moment a subagent opens, not only on fresh URL loads)
    if (info()?.parentID) return true
    const parts = location.pathname.split("/").filter(Boolean)
    const i = parts.indexOf("s")
    return i >= 0 && !!parts[i + 2] && /^\d+$/.test(parts[i + 2])
  }

  const TurnBody = (p: { section: SessionSection; index: number }) => (
    <w.TurnWrap section={p.section} index={p.index} settings={props.settings}>
      <w.PromptWrap section={p.section} settings={props.settings}>
        <div class="py-2" classList={{ "osh-flat-prompt": props.settings.promptStyle === "flat" }}>
          <Show when={props.skin.promptInBody !== false}>
            <p class="text-14-medium text-text-strong whitespace-pre-wrap break-words">{p.section.prompt}</p>
          </Show>
          <MetaLine section={p.section} data={props.data} />
        </div>
      </w.PromptWrap>
      {/* entry rhythm: tool-to-tool hugs (4px); the section list carries the
          break between prompts. Grove turns this wrapper into
          `display: contents` so its 2-column grid takes over. */}
      <div class="osh-entries flex flex-col gap-1 pt-1">
        <WindowedEntries
          sectionId={p.section.id}
          cachePrefix={cachePrefix}
          entries={p.section.ordered}
          render={(e, index) => (
            <Show
              when={e.kind !== "reasoning"}
              fallback={
                <w.ReasoningWrap entry={e as ReasoningEntry} settings={props.settings}>
                  <ReasoningBlock
                    text={(e as ReasoningEntry).text}
                    settings={props.settings}
                    partId={
                      (e as ReasoningEntry).messageID != null && (e as ReasoningEntry).ordinal != null
                        ? `${(e as ReasoningEntry).messageID}:reasoning:${(e as ReasoningEntry).ordinal}`
                        : ((e as ReasoningEntry).part as any)?.id
                    }
                  />
                </w.ReasoningWrap>
              }
            >
              <Show
                when={e.kind !== "text"}
                fallback={
                  <w.ResponseWrap text={(e as TextEntry).text} settings={props.settings}>
                    <div class="text-14-regular text-text-base osh-content">
                      <Markdown text={(e as TextEntry).text} />
                    </div>
                  </w.ResponseWrap>
                }
              >
                <w.ToolWrap entry={e as ToolEntry} index={p.section.ordered.slice(0, p.section.ordered.indexOf(e)).filter((x) => x.kind === "tool").length} settings={props.settings}>
                  <VendoredPart entry={e as ToolEntry} settings={props.settings} />
                </w.ToolWrap>
              </Show>
            </Show>
          )}
        />
      </div>
    </w.TurnWrap>
  )

  // the ViewContext (views-SDK phase 1): every skin surface reads useView()
  // instead of duplicating lookups/derivations. One value, provided once.
  const ctxValue: ViewContextValue = {
    skin: props.skin,
    data: props.data,
    sessionID: props.sessionID,
    source: props.source,
    settings: props.settings,
    updateSettings: props.updateSettings,
    search: props.search,
    onSearch: props.onSearch,
    sections: () => sections(),
    visible: () => visible(),
    query: () => q(),
    continuous: () => continuous(),
    active: () => active(),
    setActive: (i: number) => setActive(i),
    info: () => info(),
    version: () => info()?.version as string | number | undefined,
    model: () => model(),
    status: () => props.source.status(),
    back: () => back(),
    copyMarkdown: () => copySessionMarkdown(props.data, props.sessionID),
    exportSession: () => downloadSessionExport(props.data as never, props.sessionID, info()?.title),
    isSub: () => isSub(),
    cachePrefix,
  }

  return (
    <ViewProvider value={ctxValue}>
      <div data-view={props.skin.id} class="flex flex-col h-screen w-full bg-background-base text-text-base">
        <w.Header
          {...props}
          model={model()}
          status={props.source.status()}
          onBack={back}
          isSub={isSub()}
          searchControl={
            <SearchControl sections={sections} onJump={jumpToSection} />
          }
        />
      <div class="flex flex-col flex-1 min-h-0">
          {/* the narrow bar's slot: column flow above the row (the row is
              a stretch row for the sidebar variant - an in-flow bar there
              stretches to full height) */}
          <Show when={visible().length >= (props.navMinTurns ?? 2)}>
            <PromptNav
              only="narrow"
              count={visible().length}
              active={continuous() ? undefined : active()}
              title={props.skin.id}
              variant={props.settings.promptNav}
              onSetVariant={(promptNav) => props.updateSettings({ promptNav })}
              parentLink={parentTurn() ? { label: parentTurn()!.label, onParent: back } : undefined}
              label={(i) => {
                const p = visible()[i]?.prompt
                return typeof p === "string" ? p.trim().split("\n")[0] : undefined
              }}
              onSelect={(i) => {
                const id = visible()[i]?.id
                if (!id) return
                setActive(i)
                jumpToSection(id)
              }}
            />
          </Show>
        <div class="flex flex-1 min-h-0">
          {/* PromptNav: ALWAYS present with >1 prompt - the sidebar column
              or the floating pill, never neither (the pill is not
              removable). Rendered INSIDE the flex row so the sidebar
              variant sits beside the scroller; the pill variant is fixed
              and ignores flow. children MUST be undefined for Nav-less
              skins (a <Show> element is always truthy - the empty-popover
              bug, live-caught twice). */}
          <Show when={visible().length >= (props.navMinTurns ?? 2)}>
            <PromptNav
              only="desktop"
              count={visible().length}
              active={continuous() ? undefined : active()}
              title={props.skin.id}
              variant={props.settings.promptNav}
              pillGhost={props.settings.pillGhost}
              onSetPillGhost={(pillGhost) => props.updateSettings({ pillGhost })}
              onSetVariant={(promptNav) => props.updateSettings({ promptNav })}
              width={props.settings.turnNavWidth}
              onResize={(turnNavWidth) => props.updateSettings({ turnNavWidth })}
              previewLines={{ prompt: props.settings.previewPromptLines ?? 2, response: props.settings.previewResponseLines ?? 4 }}
              onSetPreviewLines={({ prompt: previewPromptLines, response: previewResponseLines }) => props.updateSettings({ previewPromptLines, previewResponseLines })}
              parentLink={parentTurn() ? { label: parentTurn()!.label, onParent: back } : undefined}
              label={(i) => {
                const p = visible()[i]?.prompt
                return typeof p === "string" ? p.trim().split("\n")[0] : undefined
              }}
              preview={(i) => visible()[i]?.response || undefined}
              onSelect={(i) => {
                const id = visible()[i]?.id
                if (!id) return
                setActive(i)
                jumpToSection(id)
              }}
            >
              {w.Nav ? (() => {
                const NavSkin = w.Nav!
                return (
                  <NavSkin
                    sections={visible()}
                    active={active()}
                    // a bespoke Nav selects a turn; in continuous mode that
                    // must also scroll to it (via the section-window reveal
                    // for far turns), same as the shared list
                    onSelect={(i: number) => {
                      setActive(i)
                      const id = visible()[i]?.id
                      if (id) jumpToSection(id)
                    }}
                  />
                )
              })() : undefined}
            </PromptNav>
          </Show>
          <div ref={scroller} data-transcript-scroll class="relative flex-1 min-w-0 overflow-y-auto">
            <WindowedSections
              sections={visible()}
              scroller={() => scroller}
              cachePrefix={cachePrefix}
              reveal={() => revealReq()}
              class={props.skin.columnClass ?? "max-w-3xl mx-auto osh-indent px-6 py-6 flex flex-col gap-8"}
              render={(s, i) => (
                <Show when={continuous()} fallback={<Show when={active() === i}><TurnBody section={s} index={i} /></Show>}>
                  <TurnBody section={s} index={i} />
                </Show>
              )}
            />
            <Show when={visible().length === 0}>
              <div class="text-13-regular text-text-weaker py-10 text-center">no prompts match the search</div>
            </Show>
          </div>
        </div>
        </div>
        <w.Footer {...props} />
      </div>
    </ViewProvider>
  )
}
