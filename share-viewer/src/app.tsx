// Client-only conversation over live or embedded share data.
//
// Identity model (deliberate):
//   left header    — the DEPLOYMENT (brand logo; links to its git if set)
//   right header   — Open(code)Share itself: github mark -> repo (fixed in
//                    source, not configurable; the product promotes itself)
//   version badge  — the TOOL THAT RAN (opencode Mark + version; other
//                    agents get their own mark later)
//   footer         — brand wordmark image or styled text ("Open(code)Share"
//                    by default)
//
import { DataProvider } from "@opencode/session-ui/context"
import { DialogProvider } from "@opencode/ui/context/dialog"
import { FileComponentProvider } from "@opencode/ui/context/file"
import { WorkerPoolProvider } from "@opencode/ui/context/worker-pool"
import { getWorkerPools } from "@opencode/session-ui/pierre/worker"
import { FileSSR } from "@opencode/session-ui/file-ssr"
import { Mark } from "@opencode/ui/logo"
import { ProviderIcon } from "@opencode/ui/provider-icon"
import { DateTime } from "luxon"
import { Title } from "@solidjs/meta"
import { Icon } from "@opencode/ui/icon"
import { createEffect, createMemo, createRenderEffect, createSignal, ErrorBoundary, onCleanup, Show, untrack } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useShareSource, type Branding } from "./data-source"
import { SettingsPanel, togglePanel } from "./settings-panel"
import { TurnNav } from "./turn-nav"
import { VirtualTimeline } from "./timeline-v2"
import { ReaderView } from "./reader"
import { InfoPanel } from "./views/info-panel"
import { findView } from "./views/registry"
import { setVendoredData } from "./views/vendored-part"
import { children, sessionStatus, visibleMessages, type ShareData, type V2Message } from "./fold"
import { setSubagentData } from "./subagent-map"
import { applySettings, readSettings, writeSettings, type OshSettings } from "./settings"

// the product's own repo (fixed in source — the right header always
// promotes Open(code)Share; flip on extraction)
const OPENSHARE_REPO_URL = "https://github.com/Mirrowel/OpenShare"

// Brand-aware mark: configured image or the vendored default
function BrandMark(props: { branding: Branding; class?: string }) {
  return (
    <Show when={props.branding.logoUrl} fallback={null}>
      <img src={props.branding.logoUrl} alt="" class={props.class} />
    </Show>
  )
}

// Page footer: thin rule + brand name + product wordmark (theme tokens so
// it reads on every theme; wordmark image overrides the text)
export function PageFooter(props: { branding: Branding; class?: string }) {
  return (
    <div class={`flex flex-col items-center gap-2 w-full ${props.class ?? ""}`}>
      <div class="w-full max-w-[52rem] border-t border-border-weak-base" />
      <Show
        when={props.branding.wordmarkUrl}
        fallback={
          <div class="text-12-mono text-text-base select-none">
            <Show when={props.branding.name}>
              <span class="text-text-strong">{props.branding.name}</span>
              <span class="text-text-weaker"> · </span>
            </Show>
            <span>Open</span>
            <span class="text-text-weaker">(</span>
            <span>code</span>
            <span class="text-text-weaker">)</span>
            <span>Share</span>
          </div>
        }
      >
        <img src={props.branding.wordmarkUrl} alt="" class="w-58.5 opacity-60" />
      </Show>
    </div>
  )
}

function applyDocumentBranding(b: Branding) {
  const name = b.name || "openshare"
  if (!document.title.includes(" | ")) document.title = `${document.title} | ${name}`
  let icon = document.querySelector<HTMLLinkElement>("link[rel='icon']")
  if (b.faviconUrl) {
    if (!icon) {
      icon = document.createElement("link")
      icon.rel = "icon"
      document.head.appendChild(icon)
    }
    icon.href = b.faviconUrl
  }
  if (b.accent) document.documentElement.style.setProperty("--openshare-accent", b.accent)
}

function NotFound(props: { status: string }) {
  return (
    <div class="min-h-screen w-full bg-background-base text-text-base flex flex-col items-center justify-center gap-4 p-6 text-center">
      <Mark class="w-16 opacity-40" />
      <p class="text-16-medium">{props.status}</p>
      <p class="text-14-regular text-text-weaker">
        openshare — the encrypted artifact in the run summary is the permanent record.
      </p>
    </div>
  )
}

const STATUS_DOT: Record<string, string> = {
  live: "#22c55e",
  completed: "#3b82f6",
  error: "#ef4444",
  interrupted: "#eab308",
  gone: "#6b7280",
  cached: "#8b5cf6",
  waiting: "#eab308",
  "login required": "#eab308",
}

function StatusLine(props: { status: string }) {
  return (
    <div class="flex items-center gap-1.5 text-12-mono text-text-weak whitespace-nowrap">
      <span
        classList={{ "status-dot": props.status === "live", "inline-block": true, "size-1.5": true, "rounded-full": true, "shrink-0": true }}
        style={props.status === "live" ? undefined : { "background-color": STATUS_DOT[props.status] ?? "#6b7280" }}
      />
      <span>{props.status}</span>
      <Show when={props.status === "live"}>
        <span class="animate-pulse">·</span>
      </Show>
    </div>
  )
}

// A subagent page or the main session — same rendering, bound to one session.
// NOTE: created ONCE by App (never inside a reactive expression that re-runs
// on data/settings changes — a re-created subtree remounts the settings
// panel and resets its open state, live-caught).
function SessionView(props: {
  data: ShareData
  source: ReturnType<typeof useShareSource>
  settings: OshSettings
  updateSettings: (patch: Partial<OshSettings>) => void
  search: string
  onSearch: (v: string) => void
  sub: () => number | undefined
}) {
  // resolve which session this page renders (main or subagent /N)
  createEffect(() => setSubagentData(props.data))

  const target = createMemo(() => {
    const data = props.data
    const subs = children(data)
    const n = props.sub()
    if (n == null) return { sessionID: data.sessionID, isSub: false }
    const hit = subs.find((s) => s.index === n)
    return hit
      ? { sessionID: hit.sessionID, isSub: true }
      : { sessionID: data.sessionID, isSub: false }
  })
  const match = createMemo(() => {
    const idx = props.data.session.findIndex((s: any) => s.id === target().sessionID)
    return { found: idx >= 0, index: idx }
  })
  if (!match().found) return <NotFound status="session data not synced yet" />
  const sessionID = () => target().sessionID
  const isSub = () => target().isSub
  const parentTurn = createMemo(() => {
    if (!isSub()) return
    let prompt: V2Message | undefined
    for (const message of visibleMessages(props.data, props.data.sessionID)) {
      if (message.type === "user") prompt = message
      for (const part of message.content ?? []) {
        if (part.type !== "tool") continue
        const child = part.state?.metadata?.sessionID ?? part.state?.metadata?.sessionId ?? part.metadata?.sessionID
        if (child === sessionID()) return prompt
      }
    }
  })
  const sessionHref = (id: string) => id === props.data.sessionID ? `/s/${props.source.shareID}${location.search}` : subHref(props.source, id)
  const parentLink = createMemo(() => isSub() ? {
    label: parentTurn()?.text ?? props.data.session.find((session) => session.id === props.data.sessionID)?.title ?? "Parent session",
    href: sessionHref(props.data.sessionID) + (parentTurn() ? `#${encodeURIComponent(parentTurn().id)}` : ""),
  } : undefined)
  const info = createMemo(() => props.data.session[match().index])
  const navigateToSession = (id: string) => {
    const href = subHref(props.source, id)
    if (!href) return
    if (props.source.prefs().openTasksInNewTab !== false) {
      window.open(href, "_blank")
    } else {
      window.history.pushState({}, "", href)
      window.dispatchEvent(new PopStateEvent("popstate"))
    }
  }
  createRenderEffect(() => setVendoredData(props.data, {
    sessionHref: (id) => subHref(props.source, id),
    navigateToSession,
  }))

  return (
    <>
      <Show when={info().title}>
        <Title>{info().title} | {props.source.branding().name || "openshare"}</Title>
      </Show>
      <WorkerPoolProvider pools={getWorkerPools()}>
        <FileComponentProvider component={FileSSR}>
          <DialogProvider>
          <DataProvider
            data={{
              // wire data cast to the v2 summaries — the fold guarantees
              // the fields the renderers actually read
              session: props.data.session as any,
              session_status: Object.fromEntries(props.data.session.map((s) => [s.id, sessionStatus(props.source.status())])),
              session_diff: props.data.session_diff as any,
              provider: props.data.provider,
            }}
            directory={info().directory}
            sessionID={sessionID()}
            onSessionHref={(id) => subHref(props.source, id)}
            onNavigateToSession={navigateToSession}
          >
            <Show when={findView(props.settings.view)} keyed fallback={untrack(() => {
              const [messageId, setMessageId] = createSignal<string>()
              const [focused, setFocused] = createSignal(false)
              const [relativeDate, setRelativeDate] = createSignal(false)
              const [turnsCollapsed, setTurnsCollapsed] = createSignal(false)
              let pendingMessageID = decodeURIComponent(location.hash.slice(1)) || undefined
              let timeline: { scrollToMessage: (id: string) => void } | undefined
              const messages = createMemo(() => visibleMessages(props.data, sessionID()))
              const userTurns = createMemo(() => messages().filter((m: any) => m?.type === "user"))
              const sessionToolNames = createMemo(() => [...new Set(messages().flatMap((message) =>
                (message.content ?? []).filter((part) => part.type === "tool").map((part) => part.name),
              ))])
              const autoExpandOpen = (tool: { name: string }) => props.settings.autoExpand.includes(tool.name)
              const firstUserMessage = createMemo(() => userTurns().at(0))
              const activeMessage = createMemo(() => userTurns().find((m: any) => m.id === messageId()) ?? firstUserMessage())
              const activeIndex = () => userTurns().findIndex((m) => m.id === activeMessage()?.id)
              function setActiveMessage(message: any) {
                if (!message) return
                setMessageId(message.id)
                if (!focused()) timeline?.scrollToMessage(message.id)
              }
              function focusMessage(message: any) {
                setMessageId(message.id)
                setFocused(true)
              }
              function navigateSession(id: string, messageID?: string) {
                if (id === sessionID()) {
                  if (messageID) setActiveMessage(userTurns().find((message) => message.id === messageID))
                  return
                }
                const href = sessionHref(id)
                if (!href) return
                pendingMessageID = messageID
                window.history.pushState({}, "", href + (messageID ? `#${encodeURIComponent(messageID)}` : ""))
                window.dispatchEvent(new PopStateEvent("popstate"))
              }
              const onTurnKey = (e: KeyboardEvent) => {
                if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable='true'], [role='menu']")) return
                if (e.ctrlKey || e.metaKey || e.altKey) return
                if (e.key === "Escape") setFocused(false)
                if (e.key !== "j" && e.key !== "k") return
                e.preventDefault()
                const next = activeIndex() + (e.key === "j" ? 1 : -1)
                setActiveMessage(userTurns()[next])
              }
              window.addEventListener("keydown", onTurnKey)
              onCleanup(() => window.removeEventListener("keydown", onTurnKey))
              createEffect(() => {
                sessionID()
                setMessageId(undefined)
                setFocused(false)
              })
              // the model of the ACTIVE turn: user metadata first (stamped
              // at ingestion), else the following assistant's model
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
              const model = createMemo(() =>
                props.data.model[sessionID()]?.find((m: any) => m.id === modelID()),
              )
              const modelDisplay = createMemo(() => {
                const name = (model() as any)?.name
                if (name === "") return undefined // sender chose to hide
                return name ?? modelID()
              })
              const diffs = createMemo(() => props.data.session_diff[sessionID()] ?? [])
              // Grouping is PER RESPONSE (one assistant message = one
              // response) and never merges thinking: each reasoning part is
              // its own "Thought" row. OFF = every tool call its own row.
              // Always passed so ungrouped rows keep content spacing.
              const timelineDetail = createMemo(() => {
                const grouped = props.settings.toolGrouping !== false
                // v1 scope = only reads/searches collapse; everything else
                // keeps its own row with its own output
                const context = props.settings.toolGroupingScope !== "all"
                const details = "collapsed"
                return {
                  shell: { placement: grouped && !context ? "grouped" : "separate", details },
                  edit: { placement: grouped && !context ? "grouped" : "separate", details },
                  thinking: { placement: "separate", details: props.settings.reasoningOpen ? "expanded" : "collapsed" },
                  subagents: { placement: grouped && !context ? "grouped" : "separate" },
                  notices: { placement: "separate" },
                  tools: { placement: grouped ? "grouped" : "separate", ...(grouped && context ? { only: ["read", "glob", "grep", "list"] } : {}) },
                } as any
              })
              // the v2 timeline document: full session (continuous mode)
              const document = createMemo(() => ({
                sessionID: sessionID(),
                messages: messages() as any,
                status: sessionStatus(props.source.status()),
                diffs: diffs() as any,
              }))
              // A focused turn includes every response up to the next prompt.
              const pagedDocument = createMemo(() => {
                const all = messages()
                const idx = all.findIndex((m) => m.id === activeMessage()?.id)
                if (idx < 0) return { ...document(), messages: [] as any[] }
                let end = all.length
                for (let i = idx + 1; i < all.length; i++) {
                  if ((all[i] as any)?.type === "user") {
                    end = i
                    break
                  }
                }
                return { ...document(), messages: all.slice(idx, end), status: end === all.length ? document().status : { type: "idle" as const } }
              })

              // display title: opencode creates child titles as
              // "description (@agent subagent)" - the suffix carries the
              // agent variant which can change mid-session, so it never
              // belongs in the header. Subagent pages get a plain
              // "subagent" label instead (owner directive); the title
              // itself is live from the folded data, so renames propagate.
              const stripSubagentSuffix = (raw: string) => raw.replace(/\s*\(@[^)]*\s*subagent\)\s*$/i, "")
              const displayTitle = () => stripSubagentSuffix(info().title ?? "")
              const title = () => (
                <div class="flex flex-col gap-4">
                  <div class="flex flex-wrap items-start justify-between gap-3">
                    <div class="flex flex-col gap-2 sm:flex-row sm:gap-4 sm:items-center sm:min-h-8 justify-start min-w-0">
                      <div class="pl-[2.5px] pr-2 flex items-center gap-1.75 bg-surface-strong shadow-xs-border-base w-fit">
                        <Mark class="shrink-0 w-3 my-0.5" />
                        <div class="text-12-mono text-text-base">v{String(info().version ?? "")}</div>
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
                          <time dateTime={DateTime.fromMillis(info().time.created).toISO()}>
                            {relativeDate()
                              ? DateTime.fromMillis(info().time.created).toRelative({ locale: "en" })
                              : DateTime.fromMillis(info().time.created).toFormat("dd MMM yyyy, HH:mm")}
                          </time>
                        </button>
                      </div>
                    </div>
                    <Show when={isSub()}>
                      <div class="ml-auto flex items-center gap-3 text-12-regular text-text-weaker">
                        <span>Subagent</span>
                        <a
                          href={parentLink()?.href}
                          class="osh-turn-button no-underline text-text-base"
                          onClick={(event) => {
                            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                            event.preventDefault()
                            navigateSession(props.data.sessionID, parentTurn()?.id)
                          }}
                        >
                          <Icon name="arrow-left" size="small" />
                          Back to parent
                        </a>
                      </div>
                    </Show>
                  </div>
                  <div class="text-left text-16-medium text-text-strong">{displayTitle()}</div>
                </div>
              )

              // settings-filtered search: user-turn text (v2 messages carry
              // it inline)
              const filtered = createMemo(() => {
                const q = props.search.trim().toLowerCase()
                if (!q) return userTurns()
                return userTurns().filter((m: any) => typeof m?.text === "string" && m.text.toLowerCase().includes(q))
              })
              const responsePreview = (messageID: string) => {
                const all = messages()
                const index = all.findIndex((message) => message.id === messageID)
                for (let i = index + 1; i < all.length && all[i].type !== "user"; i++) {
                  if (all[i].type !== "assistant") continue
                  for (const part of all[i].content ?? []) {
                    if (part.type === "text" && part.text?.trim()) return part.text.trim().slice(0, 240)
                  }
                }
                return ""
              }
              const reasoningMode = () => (props.settings.reasoningOpen ? "full" : "compact")
              const Transcript = (p: { sid: string; focusID?: string }) => (
                <ReaderView active={props.settings.view === "reader"}>
                <VirtualTimeline
                  doc={(p.focusID ? pagedDocument() : document()) as any}
                  sessionKey={props.source.shareID + ":" + p.sid + (p.focusID ? ":focus:" + p.focusID : ":conversation")}
                  reasoningMode={reasoningMode() as any}
                  shellToolDefaultOpen={false}
                  editToolDefaultOpen={false}
                  toolDefaultOpen={autoExpandOpen}
                  timelineDetail={timelineDetail() as any}
                  followLive={props.settings.followLive && (!focused() || !!p.focusID)}
                  onReady={(controls) => {
                    if (!p.focusID) timeline = controls
                    if (pendingMessageID && userTurns().some((message) => message.id === pendingMessageID)) {
                      const id = pendingMessageID
                      pendingMessageID = undefined
                      setMessageId(id)
                      controls.scrollToMessage(id)
                    }
                  }}
                  onActiveMessageChange={p.focusID ? undefined : setMessageId}
                  header={<div class="px-4 py-6 sm:px-6">{title()}</div>}
                  footer={<div class="px-4 pt-8 pb-8 sm:px-6"><PageFooter branding={props.source.branding()} /></div>}
                  class={(props.settings.centerContent ? "max-w-[52rem] mx-auto " : "") + "grow min-h-0 w-full"}
                />
                </ReaderView>
              )
              const turns = () => (
                <Show when={sessionID()} keyed>
                {(sid) => (
                <div class="flex flex-col md:flex-row h-full min-h-0 min-w-0">
                  <TurnNav
                    messages={userTurns()}
                    filtered={filtered()}
                    current={activeMessage()?.id}
                    focused={focused()}
                    onSelect={setActiveMessage}
                    onFocus={focusMessage}
                    parent={parentLink()}
                    onParent={() => navigateSession(props.data.sessionID, parentTurn()?.id)}
                    collapsed={turnsCollapsed()}
                    onToggle={() => setTurnsCollapsed((value) => !value)}
                    getPreview={responsePreview}
                  />
                  <div class="relative flex flex-col flex-1 min-w-0 min-h-0">
                    <div class="flex flex-1 min-h-0" style={{ visibility: focused() ? "hidden" : undefined }} inert={focused()}>
                      <Transcript sid={sid} />
                    </div>
                    <Show when={focused() ? activeMessage()?.id : undefined} keyed>
                      {(id) => (
                      <div class="absolute inset-0 flex flex-col bg-background-stronger">
                      <div class="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-b border-border-weak-base text-12-regular text-text-base">
                        <button class="osh-turn-button" onClick={() => setFocused(false)}>Back to conversation</button>
                        <div class="flex items-center gap-2">
                          <button class="osh-turn-button" aria-label="Previous turn" disabled={activeIndex() <= 0} onClick={() => setActiveMessage(userTurns()[activeIndex() - 1])}><Icon name="chevron-left" size="small" /></button>
                          <span>Turn {activeIndex() + 1} of {userTurns().length}</span>
                          <button class="osh-turn-button" aria-label="Next turn" disabled={activeIndex() >= userTurns().length - 1} onClick={() => setActiveMessage(userTurns()[activeIndex() + 1])}><Icon name="chevron-right" size="small" /></button>
                        </div>
                      </div>
                      <Transcript sid={sid} focusID={id} />
                      </div>
                      )}
                    </Show>
                  </div>
                </div>
                )}
                </Show>
              )

              return (
                <div class="relative bg-background-stronger w-screen h-screen overflow-hidden flex flex-col">
                  <Show when={props.source.branding().backgroundUrl && props.settings.backgroundOn}>
                    <div class="osh-bg" style={{ "background-image": `url(${props.source.branding().backgroundUrl})` }} />
                  </Show>
                  <header class="h-7 px-4 flex items-center justify-between self-stretch bg-background-base border-b border-border-weak-base relative z-30">
                    <Show when={props.source.branding().logoUrl}>
                    <Show
                      when={props.source.branding().linkUrl}
                      fallback={
                        <span class="p-0.5 flex items-center rounded-md border border-border-weak-base bg-background-base">
                          <BrandMark branding={props.source.branding()} class="h-5 rounded" />
                        </span>
                      }
                    >
                      {(href) => (
                        <a href={href()} target="_blank" rel="noreferrer" class="p-0.5 flex items-center rounded-md border border-border-weak-base bg-background-base hover:border-border-strong-base" title={props.source.branding().name || ""}>
                          <BrandMark branding={props.source.branding()} class="h-5 rounded" />
                        </a>
                      )}
                    </Show>
                    </Show>
                    <StatusLine status={props.source.status()} />
                    <div class="flex items-center gap-2.5">
                      <button
                        class="text-icon-weaker-base hover:text-icon-strong-base cursor-pointer bg-transparent border-none p-0"
                        title="copy session as markdown"
                        onClick={() => copySessionMarkdown(props.data, sessionID())}
                      >
                        <Icon name="copy" size="small" />
                      </button>
                      <a href={OPENSHARE_REPO_URL} target="_blank" rel="noreferrer" class="text-icon-weaker-base hover:text-icon-strong-base cursor-pointer" title="Open(code)Share">
                        <Icon name="github" size="small" />
                      </a>
                      <SettingsPanel
                        settings={props.settings}
                        update={props.updateSettings}
                        branding={props.source.branding()}
                        search={props.search}
                        onSearch={props.onSearch}
                        sessionTools={sessionToolNames()}
                      />
                    </div>
                  </header>
                  <div class="osh-content select-text flex flex-col flex-1 min-h-0 relative z-10">{turns()}</div>
                </div>
              )
            })}>
              {(entry) => <Dynamic component={entry.component}
                data={props.data}
                sessionID={sessionID()}
                source={props.source}
                settings={props.settings}
                updateSettings={props.updateSettings}
                search={props.search}
                onSearch={props.onSearch}
              />}
            </Show>
          </DataProvider>
          </DialogProvider>
        </FileComponentProvider>
      </WorkerPoolProvider>
    </>
  )
}

function subHref(source: ReturnType<typeof useShareSource>, childSessionID: string): string | undefined {
  const d = source.data()
  if (!d) return undefined
  const subs = children(d)
  const hit = subs.find((s) => s.sessionID === childSessionID)
  return hit ? `/s/${source.shareID}/${hit.index}${location.search}` : undefined
}

// serialize the visible session to markdown (clipboard)
async function copySessionMarkdown(data: ShareData, sessionID: string) {
  const info = data.session.find((s: any) => s.id === sessionID) as any
  const modelLabel = data.model[sessionID]?.[0]?.name ?? data.model[sessionID]?.[0]?.id ?? ""
  const parts: string[] = [
    `# ${info?.title ?? sessionID}`,
    "",
    `_model: ${modelLabel || "?"} · v${info?.version ?? "?"} · ${info?.directory ?? ""}_`,
    "",
  ]
  const toolOutputText = (state: any): string => {
    // our v1 normalization emits content[]; v2 hosts may emit output
    for (const key of ["content", "output"]) {
      const v = state?.[key]
      if (typeof v === "string") return v
      if (Array.isArray(v)) {
        const text = v.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("")
        if (text) return text
      }
    }
    return ""
  }
  for (const m of visibleMessages(data, sessionID)) {
    const msg = m as any
    if (msg?.type === "user") {
      if (msg.text) parts.push("## user", "", msg.text, "")
      continue
    }
    if (msg?.type === "compaction") {
      parts.push("> _compaction — session summarized_", "", String(msg.summary ?? ""), "")
      continue
    }
    if (msg?.type !== "assistant") continue
    parts.push("## assistant", "")
    for (const c of msg.content ?? []) {
      if (c?.type === "text" && c.text) parts.push(c.text, "")
      else if (c?.type === "reasoning" && c.text) parts.push("<details><summary>thinking</summary>", "", c.text, "", "</details>", "")
      else if (c?.type === "tool") {
        const st = c.state ?? {}
        const input = st.input ?? {}
        const inv =
          [input.query, input.command, input.prompt, input.pattern, input.path, input.description]
            .find((v: unknown) => typeof v === "string" && v.trim()) ??
          (c.name === "subagent" && Array.isArray(input.prompts) ? String(input.prompts[0] ?? "") : "")
        let out = toolOutputText(st)
        if (c.name === "subagent") out = ""
        if (out.length > 600) out = out.slice(0, 600) + "—"
        parts.push(`> _tool: ${c.name ?? "tool"}${inv ? ` — ${String(inv).slice(0, 120)}` : ""}_`, "")
        if (out) parts.push("> ```", out.split("\n").map((l: string) => "> " + l).join("\n"), "> ```", "")
      }
    }
  }
  await navigator.clipboard.writeText(parts.join("\n"))
}


export function App() {
  const source = useShareSource()
  const [sub, setSub] = createSignal<number | undefined>(source.sub)
  const [settings, setSettings] = createSignal<OshSettings>(readSettings())
  const [search, setSearch] = createSignal("")

  const updateSettings = (patch: Partial<OshSettings>) => {
    // Grouping and disclosure settings can reflow the virtualized rows.
    const offsets = [...document.querySelectorAll<HTMLElement>("[data-transcript-scroll]")]
      .map((element) => [element, element.scrollTop] as const)
    const restore = () => {
      for (const [element, offset] of offsets) {
        if (element.isConnected) element.scrollTop = offset
      }
    }
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      writeSettings(next)
      applySettings(next)
      // reasoning toggle: the timeline re-renders from reasoningMode
      return next
    })
    requestAnimationFrame(() => {
      restore()
      requestAnimationFrame(restore)
      setTimeout(restore, 120)
    })
  }

  // in-page navigation (popstate) re-parses the sub segment
  window.addEventListener("popstate", () => {
    const parts = location.pathname.split("/").filter(Boolean)
    const i = parts.indexOf("s")
    const n = i >= 0 && parts[i + 2] && /^\d+$/.test(parts[i + 2]) ? Number(parts[i + 2]) : undefined
    setSub(n)
  })

  // Ctrl+K opens the panel and focuses search
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault()
      togglePanel()
      setTimeout(() => document.querySelector<HTMLInputElement>("input[placeholder^='filter']")?.focus(), 60)
    }
  })

  createEffect(() => {
    applyDocumentBranding(source.branding())
  })

  return (
    <Show when={!source.needsAuth()} fallback={<LoginCard source={source} />}>
      <ErrorBoundary
        fallback={(error) => {
          console.error(error)
          const details = error instanceof Error ? (error.stack ?? error.message) : String(error)
          return (
            <div class="min-h-screen w-full bg-background-base text-text-base flex flex-col items-center justify-center gap-4 p-6 text-center">
              <p class="text-16-medium">Unable to render this share.</p>
              <p class="text-14-regular text-text-weaker">Check the console for more details.</p>
              <pre class="text-12-mono text-left whitespace-pre-wrap break-words w-full max-w-200 bg-background-stronger rounded-md p-4">
                {details}
              </pre>
            </div>
          )
        }}
      >
        <Show when={source.ready()} fallback={<NotFound status={source.status()} />}>
          <SessionView
            data={source.data()!}
            source={source}
            settings={settings()}
            updateSettings={updateSettings}
            search={search()}
            onSearch={setSearch}
            sub={sub}
          />
        </Show>
      </ErrorBoundary>
      <Show when={source.data()}>{(data) => <InfoPanel data={data()} sessionID={children(data()).find((s) => s.index === sub())?.sessionID ?? data().sessionID} source={source} />}</Show>
    </Show>
  )
}

function LoginCard(props: { source: ReturnType<typeof useShareSource> }) {
  const [login, setLogin] = createSignal("")
  const [password, setPassword] = createSignal("")
  const b = () => props.source.branding()
  createEffect(() => {
    applyDocumentBranding(b())
  })
  const state = () => props.source.authState()
  const countdown = () => {
    const ms = state().retryAfterMs ?? 0
    if (ms <= 0) return undefined
    const s = Math.ceil(ms / 1000)
    return s > 90 ? `${Math.ceil(s / 60)} min` : `${s}s`
  }
  return (
    <div class="min-h-screen w-full bg-background-base text-text-base flex flex-col items-center justify-center gap-6 p-6">
      <Show when={b().logoUrl} fallback={<Mark class="w-12 opacity-90" />}>
        <img src={b().logoUrl} alt="" class="w-10 rounded-lg" />
      </Show>
      <div class="flex flex-col gap-3 w-full max-w-72">
        <div class="text-16-medium text-center">{b().name || "openshare"}</div>
        <div class="text-12-regular text-text-weaker text-center -mt-2">re:share — this session is protected</div>
        <input
          class="openshare-input"
          placeholder="login"
          autocomplete="username"
          value={login()}
          onInput={(e) => setLogin(e.currentTarget.value)}
        />
        <input
          class="openshare-input"
          type="password"
          placeholder="password"
          autocomplete="current-password"
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") props.source.auth(login(), password())
          }}
        />
        <Show when={state().message}>
          <div class="text-12-regular text-red-500 text-center">
            {state().message}{countdown() ? ` — retry in ${countdown()}` : ""}
          </div>
        </Show>
        <button
          class="openshare-button"
          disabled={state().busy || !!countdown()}
          onClick={() => props.source.auth(login(), password())}
        >
          {state().busy ? "checking—" : "view session"}
        </button>
      </div>
    </div>
  )
}
