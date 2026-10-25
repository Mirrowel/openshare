// The conversation view — the second CORE view, ported from the
// conversation-view PR (OpeOginni). Verbatim in layout and behavior: the
// TurnNav sidebar is always present (collapsing to its own 40px tick
// rail), plain click scrolls to the turn (smooth per setting), ··· /
// focus opens the single-turn overlay over the still-mounted transcript,
// and subagent pages carry the right-side "Back to parent" that returns
// to the exact spawning turn. Plumbing rides the shared seams
// (VirtualTimeline, fold, settings, prompt-nav, parent-link) - the
// view's visual identity is his to edit.
//
// Registered continuous-only (paged: false): focus mode is this view's
// way to read one turn.
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { ProviderIcon } from "@opencode/ui/provider-icon"
import { Mark } from "@opencode/ui/logo"
import { DateTime } from "luxon"
import { visibleMessages, sessionStatus } from "../fold"
import { VirtualTimeline } from "../timeline-v2"
import { registerPromptNav } from "../prompt-nav"
import { findParentTurn } from "../parent-link"
import { TurnNav } from "./conversation-nav"
import { AppHeader } from "./conversation-header"
import type { ViewProps } from "./registry"

export function ConversationView(props: ViewProps) {
  const [messageId, setMessageId] = createSignal<string>()
  const [focused, setFocused] = createSignal(false)
  const [relativeDate, setRelativeDate] = createSignal(false)
  const [turnsCollapsed, setTurnsCollapsed] = createSignal(false)
  let timeline: { scrollToMessage: (id: string, behavior?: ScrollBehavior) => void } | undefined

  const info = createMemo(() => (props.data.session as any[]).find((s) => s.id === props.sessionID))
  const messages = createMemo(() => visibleMessages(props.data, props.sessionID))
  const userTurns = createMemo(() => messages().filter((m: any) => m?.type === "user"))
  const autoExpandOpen = (tool: { name: string }) => props.settings.autoExpand.includes(tool.name)
  const firstUserMessage = createMemo(() => userTurns().at(0))
  const activeMessage = createMemo(() => userTurns().find((m: any) => m.id === messageId()) ?? firstUserMessage())
  const activeIndex = () => userTurns().findIndex((m) => m.id === activeMessage()?.id)

  function setActiveMessage(message: any, behavior?: ScrollBehavior) {
    if (!message) return
    setMessageId(message.id)
    if (!focused()) timeline?.scrollToMessage(message.id, behavior)
  }
  function focusMessage(message: any) {
    setMessageId(message.id)
    setFocused(true)
  }
  // plain click always scrolls (the default reading mode); ··· focuses
  function selectMessage(message: any) {
    setActiveMessage(message, props.settings.smoothScroll ? "smooth" : "auto")
  }

  registerPromptNav({
    next: () => { const m = userTurns()[activeIndex() + 1]; if (m) selectMessage(m) },
    prev: () => { const m = userTurns()[activeIndex() - 1]; if (m) selectMessage(m) },
  })

  // Esc exits focus
  const onFocusKey = (e: KeyboardEvent) => { if (e.key === "Escape" && focused()) setFocused(false) }
  window.addEventListener("keydown", onFocusKey)
  onCleanup(() => window.removeEventListener("keydown", onFocusKey))

  // the parent turn that spawned this child (subagent pages)
  const parentTurn = () => findParentTurn(props.data, props.sessionID, info()?.parentID)
  const goParent = () => {
    const t = parentTurn()
    const share = props.source.shareID
    // parent session page: drop the /N sub segment, keep the turn anchor
    window.history.pushState({}, "", `/s/${share}${t ? `#${t.userID}` : ""}`)
    window.dispatchEvent(new PopStateEvent("popstate"))
  }
  // arriving with #<messageID> jumps to that turn
  createEffect(() => {
    props.sessionID
    const id = decodeURIComponent(location.hash.slice(1))
    if (id && userTurns().some((m: any) => m.id === id)) queueMicrotask(() => timeline?.scrollToMessage(id))
  })

  // the model of the ACTIVE turn: user metadata first (stamped at
  // ingestion), else the following assistant's model
  const provider = createMemo(() => {
    const meta = (activeMessage() as any)?.metadata?.model
    if (meta?.providerID) return meta.providerID as string
    const all = messages()
    const idx = all.findIndex((m) => m.id === activeMessage()?.id)
    for (let i = idx; i < all.length; i++) if ((all[i] as any)?.model?.providerID) return (all[i] as any).model.providerID
    return undefined
  })
  const modelID = createMemo(() => {
    const meta = (activeMessage() as any)?.metadata?.model
    if (meta?.id) return meta.id as string
    const all = messages()
    const idx = all.findIndex((m) => m.id === activeMessage()?.id)
    for (let i = idx; i < all.length; i++) if ((all[i] as any)?.model?.id) return (all[i] as any).model.id
    return undefined
  })
  const model = createMemo(() => props.data.model[props.sessionID]?.find((m: any) => m.id === modelID()))
  const modelDisplay = createMemo(() => {
    const name = (model() as any)?.name
    if (name === "") return undefined
    return name ?? modelID()
  })

  const filtered = createMemo(() => {
    const q = props.search.trim().toLowerCase()
    if (!q) return userTurns()
    return userTurns().filter((m: any) => {
      if (typeof m?.text === "string" && m.text.toLowerCase().includes(q)) return true
      const all = messages()
      const start = all.findIndex((x: any) => x.id === m.id)
      if (start < 0) return false
      for (let i = start + 1; i < all.length; i++) {
        const msg: any = all[i]
        if (msg?.type === "user") break
        if (msg?.type === "assistant") {
          for (const c of msg?.content ?? []) {
            const text = c?.type === "text" || c?.type === "reasoning" ? c.text : c?.type === "tool" ? `${c.name}` : ""
            if (typeof text === "string" && text.toLowerCase().includes(q)) return true
          }
        }
      }
      return false
    })
  })
  const responsePreview = (messageID: string) => {
    const all = messages()
    const index = all.findIndex((message) => message.id === messageID)
    for (let i = index + 1; i < all.length && (all[i] as any)?.type !== "user"; i++) {
      if ((all[i] as any)?.type !== "assistant") continue
      for (const part of (all[i] as any).content ?? []) {
        if (part.type === "text" && part.text?.trim()) return part.text.trim().slice(0, 240)
      }
    }
    return ""
  }

  const timelineDetail = createMemo(() => {
    const grouped = props.settings.toolGrouping !== false
    const context = props.settings.toolGroupingScope !== "all"
    const details = "collapsed" as const
    return {
      shell: { placement: grouped && !context ? "grouped" : "separate", details },
      edit: { placement: grouped && !context ? "grouped" : "separate", details },
      thinking: { placement: "separate", details: props.settings.reasoningOpen ? "expanded" : "collapsed" },
      subagents: { placement: grouped && !context ? "grouped" : "separate" },
      notices: { placement: "separate" },
      tools: { placement: grouped ? "grouped" : "separate", ...(grouped && context ? { only: ["read", "glob", "grep", "list"] } : {}) },
    } as any
  })

  const document = createMemo(() => ({
    sessionID: props.sessionID,
    messages: messages() as any,
    status: sessionStatus(props.source.status()),
    diffs: [],
  }))
  // A focused turn includes every response up to the next prompt.
  const pagedDocument = createMemo(() => {
    const all = messages()
    const idx = all.findIndex((m) => m.id === activeMessage()?.id)
    if (idx < 0) return { ...document(), messages: [] as any[] }
    let end = all.length
    for (let i = idx + 1; i < all.length; i++) {
      if ((all[i] as any)?.type === "user") { end = i; break }
    }
    return { ...document(), messages: all.slice(idx, end) }
  })

  const stripSubagentSuffix = (raw: string) => raw.replace(/\s*\(@[^)]*\s*subagent\)\s*$/i, "")
  const displayTitle = () => stripSubagentSuffix(info()?.title ?? "")

  const reasoningMode = () => (props.settings.reasoningOpen ? "full" : "compact")
  const Transcript = (p: { focusID?: string }) => (
    <VirtualTimeline
      doc={(p.focusID ? pagedDocument() : document()) as any}
      sessionKey={props.source.shareID + ":" + props.sessionID + (p.focusID ? ":focus:" + p.focusID : ":conversation")}
      reasoningMode={reasoningMode() as any}
      shellToolDefaultOpen={false}
      editToolDefaultOpen={false}
      toolDefaultOpen={autoExpandOpen}
      timelineDetail={timelineDetail() as any}
      followLive={props.settings.followLive && (!focused() || !!p.focusID)}
      onReady={(controls) => {
        if (!p.focusID) timeline = controls as any
      }}
      onActiveMessageChange={p.focusID ? undefined : setMessageId}
      header={
        <div class="px-4 py-4 sm:px-6">
          <div class="flex flex-col gap-3">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="flex flex-col gap-2 sm:flex-row sm:gap-4 sm:items-center sm:min-h-8 justify-start min-w-0">
                <div class="pl-[2.5px] pr-2 flex items-center gap-1.75 bg-surface-strong shadow-xs-border-base w-fit">
                  <Mark class="shrink-0 w-3 my-0.5" />
                  <div class="text-12-mono text-text-base">v{String(info()?.version ?? "")}</div>
                </div>
                <div class="flex gap-4 items-center">
                  <div class="flex gap-2 items-center">
                    <Show when={provider()}>
                      <ProviderIcon id={provider()!} class="size-3.5 shrink-0 text-icon-strong-base" />
                    </Show>
                    <div class="text-12-regular text-text-base">{modelDisplay()}</div>
                  </div>
                  <button
                    class="text-12-regular text-text-weaker hover:text-text-base bg-transparent border-none p-0 cursor-pointer"
                    title={relativeDate() ? "Show exact date" : "Show relative time"}
                    aria-pressed={relativeDate()}
                    onClick={() => setRelativeDate((value) => !value)}
                  >
                    <time dateTime={DateTime.fromMillis(info()?.time?.created ?? 0).toISO() ?? undefined}>
                      {relativeDate()
                        ? DateTime.fromMillis(info()?.time?.created ?? 0).toRelative({ locale: "en" })
                        : DateTime.fromMillis(info()?.time?.created ?? 0).toFormat("dd MMM yyyy, HH:mm")}
                    </time>
                  </button>
                </div>
              </div>
              {/* subagent pages: back to the spawning parent turn, on the
                  right (the conversation view's signature placement) */}
              <Show when={parentTurn()}>
                <button
                  class="self-center inline-flex items-center gap-1 h-6 px-1.5 rounded-md text-12-regular text-text-weak hover:text-text-strong hover:bg-surface-base no-underline bg-transparent border-none cursor-pointer transition-colors duration-150"
                  title={`back to parent: ${parentTurn()!.label}`}
                  onClick={goParent}
                >
                  <Icon name="arrow-left" size="small" />
                  Back to parent
                </button>
              </Show>
            </div>
            <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <div class="text-left text-16-medium text-text-strong">{displayTitle()}</div>
              <Show when={info()?.parentID}>
                <span class="text-12-regular text-text-weaker">subagent</span>
              </Show>
            </div>
          </div>
        </div>
      }
      footer={<div class="px-4 pt-6 pb-6 sm:px-6 text-center text-12-mono text-text-weaker select-none">{(props.source.branding().name ? props.source.branding().name + " · " : "") + "Open(code)Share"}</div>}
      class={(props.settings.centerContent ? "max-w-[52rem] mx-auto " : "") + "grow min-h-0 w-full"}
    />
  )

  return (
    // his app shell, verbatim: the view owns its header (AppHeader) and
    // bounds itself to the viewport - the views branch mounts bare, so
    // relying on parent heights leaves the transcript unbounded
    <div class="relative w-screen h-screen overflow-hidden flex flex-col">
      <AppHeader
        data={props.data}
        sessionID={props.sessionID}
        source={props.source}
        settings={props.settings}
        updateSettings={props.updateSettings}
        search={props.search}
        onSearch={props.onSearch}
      />
      <div class="flex flex-col md:flex-row flex-1 min-h-0 min-w-0">
      <TurnNav
        messages={userTurns()}
        filtered={filtered()}
        current={activeMessage()?.id}
        focused={focused()}
        onSelect={selectMessage}
        onFocus={focusMessage}
        parent={parentTurn() ? { label: parentTurn()!.label, href: `/s/${props.source.shareID}` } : undefined}
        onParent={goParent}
        collapsed={turnsCollapsed()}
        onToggle={() => setTurnsCollapsed((value) => !value)}
        getPreview={responsePreview}
      />
      <div class="relative flex flex-col flex-1 min-w-0 min-h-0">
        <div class="flex flex-1 min-h-0" style={focused() ? { visibility: "hidden" } : undefined}>
          <Transcript />
        </div>
        <Show when={focused() ? activeMessage()?.id : undefined} keyed>
          {(id) => (
            <div class="absolute inset-0 flex flex-col bg-background-stronger">
              <div class="flex flex-wrap items-center justify-between gap-2 px-3 py-1 border-b border-border-weak-base text-12-regular text-text-base">
                <button class="osh-turn-button" onClick={() => setFocused(false)}>Back to conversation</button>
                <div class="flex items-center gap-2">
                  <button class="osh-turn-button" aria-label="Previous turn" disabled={activeIndex() <= 0} onClick={() => focusMessage(userTurns()[activeIndex() - 1])}><Icon name="chevron-left" size="small" /></button>
                  <span>Turn {activeIndex() + 1} of {userTurns().length}</span>
                  <button class="osh-turn-button" aria-label="Next turn" disabled={activeIndex() >= userTurns().length - 1} onClick={() => focusMessage(userTurns()[activeIndex() + 1])}><Icon name="chevron-right" size="small" /></button>
                </div>
              </div>
              <Transcript focusID={id} />
            </div>
          )}
        </Show>
      </div>
      </div>
    </div>
  )
}
