// The upstream share page ([shareID].tsx), client-only: identical layout
// and rendering stack (SessionTurn / SessionReview / MessageNav over the
// DataProvider fold), with the solid-start/server pieces replaced by the
// local data source (live worker WS or embedded local snapshot).
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
// Viewer settings (cookie, gear panel): theme (system/light/dark +
// mirrobot/midnight/sepia/nord premades), continuous mode (one scroll,
// no per-prompt selector), follow-live scroll (only when already at the
// bottom), text size, default diff style, background-image toggle,
// reasoning expand-all. Header extras: session search (Ctrl+K), copy
// session as markdown, j/k prompt navigation.
import { SessionTimeline } from "@opencode/session-ui/timeline"
import { SessionReview } from "@opencode/session-ui/session-review"
import { DataProvider } from "@opencode/session-ui/context"
import { DialogProvider } from "@opencode/ui/context/dialog"
import { FileComponentProvider } from "@opencode/ui/context/file"
import { WorkerPoolProvider } from "@opencode/ui/context/worker-pool"
import { getWorkerPools } from "@opencode/session-ui/pierre/worker"
import { HoverRail } from "./hover-rail"
import { FileSSR } from "@opencode/session-ui/file-ssr"
import { Logo, Mark } from "@opencode/ui/logo"
import { ProviderIcon } from "@opencode/ui/provider-icon"
import { Tabs } from "@opencode/ui/tabs"
import { DateTime } from "luxon"
import { Title } from "@solidjs/meta"
import { Icon } from "@opencode/ui/icon"
import { createEffect, createMemo, createSignal, ErrorBoundary, For, Match, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useShareSource, type Branding } from "./data-source"
import { SettingsPanel, togglePanel } from "./settings-panel"
import { ReaderView } from "./reader"
import { VirtualTimeline } from "./timeline-v2"
import { createMediaQuery } from "@solid-primitives/media"
import { InfoPanel } from "./views/info-panel"
import { findView, resolveSessionID } from "./views/registry"
import { setVendoredData } from "./views/vendored-part"

// full-page views (everything except classic/reader, which live in the
// standard chrome) render INSTEAD of SessionView
function FullPageView(props: {
  source: ReturnType<typeof useShareSource>
  settings: OshSettings
  updateSettings: (patch: Partial<OshSettings>) => void
  search: string
  onSearch: (v: string) => void
  sub: () => number | undefined
}) {
  const view = createMemo(() => findView(props.settings.view))
  const sessionID = createMemo(() => resolveSessionID(props.source.data(), props.sub()))
  setVendoredData(props.source.data(), {
    sessionHref: (id) => subHref(props.source, id),
    navigateToSession: (id) => {
      const href = subHref(props.source, id)
      if (!href) return
      if (props.source.prefs().openTasksInNewTab !== false) {
        window.open(href, "_blank")
      } else {
        scrollMemory.set(location.pathname, window.scrollY)
        window.history.pushState({}, "", href)
        window.dispatchEvent(new PopStateEvent("popstate"))
      }
    },
  })
  return (
    <>
      <Show when={view()} keyed>
        {(entry) =>
          entry.component({
            get data() {
              return props.source.data()
            },
            get sessionID() {
              return sessionID()
            },
            source: props.source,
            get settings() {
              return props.settings
            },
            updateSettings: props.updateSettings,
            get search() {
              return props.search
            },
            onSearch: props.onSearch,
          })
        }
      </Show>
    </>
  )
}
import { children, sessionStatus, visibleMessages, type ShareData } from "./fold"
import { setSubagentData } from "./subagent-map"
import { applySettings, continuousFor, readSettings, writeSettings, type OshSettings } from "./settings"

// scroll memory for in-page session switching: restore on return
const scrollMemory = new Map<string, number>()

const iife = <T,>(fn: () => T): T => fn()

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
              <span class="text-text-weaker"> ┬╖ </span>
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
        <span class="animate-pulse">┬╖</span>
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
  const backHref = () => (target().isSub ? `/s/${props.source.shareID}` : undefined)
  const info = createMemo(() => props.data.session[match().index])

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
            onNavigateToSession={(id) => {
              const href = subHref(props.source, id)
              if (!href) return
              if (props.source.prefs().openTasksInNewTab !== false) {
                window.open(href, "_blank")
              } else {
                scrollMemory.set(location.pathname, window.scrollY)
                window.history.pushState({}, "", href)
                window.dispatchEvent(new PopStateEvent("popstate"))
              }
            }}
          >
            {iife(() => {
              const [store, setStore] = createStore({ messageId: undefined as string | undefined })
              const [diffStyle, setDiffStyle] = createSignal<"unified" | "split">(
    props.settings.diffMode === "split" ? "split" : "unified",
  )
              const messages = createMemo(() => visibleMessages(props.data, sessionID()))
              const userTurns = createMemo(() => messages().filter((m: any) => m?.type === "user"))
              // every tool name this share actually used (the auto-expand
              // picker appends them to the known vocabulary: mcp, ctx_*,
              // custom tools)
              const sessionToolNames = createMemo(() => [
                ...new Set(
                  messages().flatMap((m: any) =>
                    (m?.content ?? []).flatMap((c: any) => (c?.type === "tool" && typeof c.name === "string" ? [c.name] : [])),
                  ),
                ),
              ])
              // the auto-expand checkbox list drives default-open per tool
              // name (renderer input; consulted before the categories)
              const autoExpandOpen = (tool: { name: string }) => props.settings.autoExpand.includes(tool.name)
              const firstUserMessage = createMemo(() => userTurns().at(0))
              const activeMessage = createMemo(() => userTurns().find((m: any) => m.id === store.messageId) ?? firstUserMessage())
              function setActiveMessage(message: any) {
                setStore("messageId", message ? message.id : undefined)
              }
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
                // per-tool auto-expand drives everything (renderer's
                // toolDefaultOpen, consulted before categories); category
                // details stay collapsed so unlisted tools never open
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
              // review panel: files default-OPEN (v1 behavior), user-controlled after
              const [reviewOpen, setReviewOpen] = createSignal<string[]>(diffs().map((d: any) => String(d.file ?? "")))

              // the v2 timeline document: full session (continuous mode)
              const document = createMemo(() => ({
                sessionID: sessionID(),
                messages: messages() as any,
                status: sessionStatus(props.source.status()),
                diffs: diffs() as any,
              }))
              // paged (classic) mode: one turn — the active user message
              // through just before the next user message
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
                return { ...document(), messages: all.slice(idx, end) }
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
                  <div class="flex flex-col gap-2 sm:flex-row sm:gap-4 sm:items-center sm:h-8 justify-start self-stretch">
                    <Show when={isSub()}>
                      <Show when={backHref()} keyed>
                        {(href) => (
                          <a
                            href={href}
                            class="pl-[2.5px] pr-2 flex items-center gap-1.5 bg-surface-strong shadow-xs-border-base w-fit text-12-mono text-text-base no-underline"
                            onclick={() => scrollMemory.set(location.pathname, window.scrollY)}
                          >
                            ← main
                          </a>
                        )}
                      </Show>
                    </Show>
                    <Show when={isSub()}>
                      <span class="pl-[2.5px] pr-2 flex items-center bg-surface-strong shadow-xs-border-base w-fit text-12-mono text-text-base">
                        subagent
                      </span>
                    </Show>
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
                      <div class="text-12-regular text-text-weaker">
                        {DateTime.fromMillis(info().time.created).toFormat("dd MMM yyyy, HH:mm")}
                      </div>
                    </div>
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
              const searching = createMemo(() => props.search.trim().length > 0)
              const reasoningMode = () => (props.settings.reasoningOpen ? "full" : "compact")
              const timelineDoc = () => (searching() ? { ...document(), messages: messages().filter((m) => (m?.type === "user" ? filtered().some((u) => u.id === m.id) : true)) } : document())

              // mobile (narrow) layout: paged timeline under the title.
              // Virtualized like every path — rows outside the viewport
              // never enter the DOM. GATED on a real media query: a
              // CSS-hidden duplicate still mounts its own virtualizer and
              // disclosure store, and rows in the hidden copy swallow
              // DOM-first queries (live-caught: 6 instances, dead toggles
              // in automated probes).
              const narrow = createMediaQuery("(max-width: 767px)")
              const turns = () => (
                <Show when={narrow()}>
                <VirtualTimeline
                  doc={pagedDocument() as any}
                  sessionKey={props.source.shareID + ":" + sessionID() + ":paged-m:" + (activeMessage()?.id ?? "")}
                  reasoningMode={reasoningMode() as any}
                  shellToolDefaultOpen={false}
                  editToolDefaultOpen={false}
                  toolDefaultOpen={autoExpandOpen}

                  timelineDetail={timelineDetail() as any}
                  anchor="start"
                  header={<div class="px-4 py-6">{title()}</div>}
                  footer={
                    <div class="px-4 pt-20 pb-8">
                      <PageFooter branding={props.source.branding()} />
                    </div>
                  }
                  class="h-full"
                />
                </Show>
              )

              const wide = createMemo(() => diffs().length === 0)

              return (
                <div class="relative bg-background-stronger w-screen h-screen overflow-hidden flex flex-col">
                  <Show when={props.source.branding().backgroundUrl && props.settings.backgroundOn}>
                    <div class="osh-bg" style={{ "background-image": `url(${props.source.branding().backgroundUrl})` }} />
                  </Show>
                  <header class="h-7 px-4 flex items-center justify-between self-stretch bg-background-base border-b border-border-weak-base relative z-30">
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
                  <div class="osh-content select-text flex flex-col flex-1 min-h-0 relative z-10">
                    <Show when={props.settings.view !== "reader"}>
                    <div
                      classList={{
                        "hidden w-full flex-1 min-h-0": true,
                        "md:flex": wide(),
                        "lg:flex": !wide(),
                      }}
                    >
                      <div classList={{ "@container relative flex min-h-0 flex-1 basis-3/5 min-w-0": true }}>
                        <div class="flex items-start justify-start h-full min-h-0 w-full">
                          <Show when={!continuousFor(props.settings, "classic") && userTurns().length > 1}>
                            {/* paged prompt switcher: the shared FLOATING
                                rail (fixed to the viewport, proximity
                                reveal) instead of the persistent
                                MessageNav column that ate width */}
                            <HoverRail
                              count={userTurns().length}
                              active={userTurns().findIndex((m: any) => m.id === activeMessage()?.id)}
                              label={(i) => {
                                const t = userTurns()[i]?.text
                                return typeof t === "string" ? t.trim().split("\n")[0] : undefined
                              }}
                              onSelect={(i) => setActiveMessage(userTurns()[i])}
                            />
                          </Show>
                          <Show
                            when={continuousFor(props.settings, "classic")}
                            fallback={
                              // paged: ONE turn, windowed row-by-row through the
                              // same virtualizer as continuous (a giant turn
                              // never renders whole). Header/footer live INSIDE
                              // the scroll flow: the title scrolls away with the
                              // transcript and the footer is the last thing in
                              // the session, never pinned or clipped
                              <VirtualTimeline
                                doc={pagedDocument() as any}
                                sessionKey={props.source.shareID + ":" + sessionID() + ":paged:" + (activeMessage()?.id ?? "")}
                                reasoningMode={reasoningMode() as any}
                                shellToolDefaultOpen={false}
                  editToolDefaultOpen={false}
                  toolDefaultOpen={autoExpandOpen}
              
                                timelineDetail={timelineDetail() as any}
                                anchor="start"
                                header={<div class="px-6 pt-6">{title()}</div>}
                                footer={
                                  <div class="px-6 pt-8 pb-8">
                                    <PageFooter branding={props.source.branding()} class="px-6" />
                                  </div>
                                }
                                class={(props.settings.centerContent ? "max-w-[52rem] mx-auto " : "") + "grow h-full min-h-0"}
                              />
                            }
                          >
                            <div class={(props.settings.centerContent ? "grow max-w-[52rem] mx-auto " : "grow ") + "h-full min-h-0 flex flex-col"}>
                              <VirtualTimeline
                                doc={timelineDoc() as any}
                                sessionKey={props.source.shareID + ":" + sessionID()}
                                reasoningMode={reasoningMode() as any}
                                shellToolDefaultOpen={false}
                  editToolDefaultOpen={false}
                  toolDefaultOpen={autoExpandOpen}
              
                                timelineDetail={timelineDetail() as any}
                                header={<div class="px-6 pt-6">{title()}</div>}
                                footer={
                                  <div class="px-6 pt-8 pb-8">
                                    <Show when={searching() && filtered().length === 0}>
                                      <div class="text-12-regular text-text-weaker">no prompts match.</div>
                                    </Show>
                                    <PageFooter branding={props.source.branding()} />
                                  </div>
                                }
                                class="grow min-h-0 w-full"
                              />
                            </div>
                          </Show>
                        </div>
                      </div>
                      <Show when={diffs().length > 0}>
                        <div class="@container relative pt-6 flex-1 basis-2/5 min-w-0 min-h-0 border-l border-border-weak-base">
                          <SessionReview
                            diffs={diffs() as any}
                            open={reviewOpen()}
                            onOpenChange={setReviewOpen}
                            diffStyle={diffStyle()}
                            onDiffStyleChange={setDiffStyle}
                            classes={{ root: "pb-20", header: "px-6", container: "px-6" }}
                          />
                        </div>
                      </Show>
                    </div>
                    <Switch>
                      <Match when={diffs().length > 0}>
                        <Tabs classList={{ "md:hidden": wide(), "lg:hidden": !wide() }}>
                          <Tabs.List>
                            <Tabs.Trigger value="session" class="w-1/2" classes={{ button: "w-full" }}>
                              Session
                            </Tabs.Trigger>
                            <Tabs.Trigger value="review" class="w-1/2 !border-r-0" classes={{ button: "w-full" }}>
                              {diffs().length} Files Changed
                            </Tabs.Trigger>
                          </Tabs.List>
                          <Tabs.Content value="session" class="!overflow-hidden">
                            {turns()}
                          </Tabs.Content>
                          <Tabs.Content value="review" class="!overflow-hidden hidden data-[selected]:block">
                            <div data-transcript-scroll class="relative h-full pt-8 overflow-y-auto no-scrollbar">
                              <SessionReview
                                diffs={diffs() as any}
                                open={reviewOpen()}
                                onOpenChange={setReviewOpen}
                                diffStyle={diffStyle()}
                                onDiffStyleChange={setDiffStyle}
                                classes={{ root: "pb-20", header: "px-4", container: "px-4" }}
                              />
                            </div>
                          </Tabs.Content>
                        </Tabs>
                      </Match>
                      <Match when={true}>
                        <div classList={{ "!overflow-hidden": true, "md:hidden": wide(), "lg:hidden": !wide() }}>
                          {turns()}
                        </div>
                      </Match>
                     </Switch>
                    </Show>
                    <Show when={props.settings.view === "reader"}>
                      <ReaderView
                        data={props.data}
                        sessionID={sessionID()}
                        source={props.source}
                        settings={props.settings}
                        updateSettings={props.updateSettings}
                        search={props.search}
                        onSearch={props.onSearch}
                      />
                    </Show>
                  </div>
                </div>
              )
            })}
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
  return hit ? `/s/${source.shareID}/${hit.index}` : undefined
}

// serialize the visible session to markdown (clipboard)
async function copySessionMarkdown(data: ShareData, sessionID: string) {
  const info = data.session.find((s: any) => s.id === sessionID) as any
  const modelLabel = data.model[sessionID]?.[0]?.name ?? data.model[sessionID]?.[0]?.id ?? ""
  const parts: string[] = [
    `# ${info?.title ?? sessionID}`,
    "",
    `_model: ${modelLabel || "?"} ┬╖ v${info?.version ?? "?"} ┬╖ ${info?.directory ?? ""}_`,
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


// minimal render path (?oshMinimal=1): providers + SessionTimeline only,
// same live data source — bisects the v2 wiring from the full chrome
function MinimalTimeline(props: { source: ReturnType<typeof useShareSource> }) {
  const d = props.source.data()
  if (!d) return <NotFound status="no data" />
  const sid = d.sessionID
  const info = d.session.find((s) => s.id === sid)
  return (
    <WorkerPoolProvider pools={getWorkerPools()}>
      <FileComponentProvider component={FileSSR}>
        <DialogProvider>
          <DataProvider
            data={{
              session: d.session as any,
              session_status: Object.fromEntries(d.session.map((s) => [s.id, sessionStatus(props.source.status())])),
              session_diff: d.session_diff as any,
              provider: d.provider,
            }}
            directory={info?.directory}
            sessionID={sid}
          >
            <Show when={new URLSearchParams(location.search).get("oshVirtual") === "1"} fallback={
              <SessionTimeline
                document={{
                  sessionID: sid,
                  messages: visibleMessages(d, sid) as any,
                  status: sessionStatus(props.source.status()),
                  diffs: (d.session_diff[sid] ?? []) as any,
                }}
                reasoningMode="compact"
              />
            }>
              <VirtualTimeline
                doc={{ sessionID: sid, messages: visibleMessages(d, sid) as any, status: sessionStatus(props.source.status()), diffs: (d.session_diff[sid] ?? []) as any }}
                sessionKey={"minimal:" + sid}
                class="h-screen w-full"
              />
            </Show>
          </DataProvider>
        </DialogProvider>
      </FileComponentProvider>
    </WorkerPoolProvider>
  )
}

export function App() {
  const source = useShareSource()
  const [sub, setSub] = createSignal<number | undefined>(source.sub)
  const [settings, setSettings] = createSignal<OshSettings>(readSettings())
  const [search, setSearch] = createSignal("")

  // the reader's transcript offset, tracked from real scroll events so a
  // settings-driven reflow can put them back exactly where they were
  let lastTranscriptOffset: number | undefined
  let lastPanelOffset: number | undefined
  const trackTranscriptScroll = (event: Event) => {
    const el = event.target
    if (!(el instanceof HTMLElement)) return
    if (el.dataset.transcriptScroll !== undefined) lastTranscriptOffset = el.scrollTop
    else if (el.dataset.oshPanelScroll !== undefined) lastPanelOffset = el.scrollTop
  }
  document.addEventListener("scroll", trackTranscriptScroll, true)

  const updateSettings = (patch: Partial<OshSettings>) => {
    // Settings can reflow the transcript (grouping, details, view): classic
    // reset to the top and continuous clamped to the end when the rows were
    // rebuilt (probed on the live build). Remember the offsets from real
    // scroll events and reapply them to whatever scroller exists afterwards -
    // by selector, because the element itself can be replaced. The settings
    // panel itself resets too (toggling reflows its section list) - restore
    // its scroll as well.
    const restore = () => {
      const el = document.querySelector<HTMLElement>("[data-transcript-scroll]")
      if (el && lastTranscriptOffset != null) el.scrollTop = lastTranscriptOffset
      const panel = document.querySelector<HTMLElement>("[data-osh-panel-scroll]")
      if (panel && lastPanelOffset != null) panel.scrollTop = lastPanelOffset
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

  // follow-live: keep the newest content visible, only when already at
  // bottom (evaluated at fire time - a fresh load starts at the top and
  // must never jump down)
  createEffect(() => {
    const rev = source.rev()
    const s = settings()
    if (!s.followLive || source.status() !== "live") return
    const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80
    if (!atBottom) return
    requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight }))
  })

  // SMART-SYNC scroll continuity: a real data update (rev bump) rebuilds
  // the projection; even with in-place row updates the page height can
  // shift under the reader mid-rebuild and the browser clamps scroll
  // toward the top (live-caught as "pushed to the top when it finished").
  // Same capture/reapply as settings changes, driven by data instead:
  // restore the transcript offset AND the window position unless the
  // reader is following live at the bottom (the effect above owns that).
  createEffect(() => {
    source.rev()
    const restore = () => {
      const el = document.querySelector<HTMLElement>("[data-transcript-scroll]")
      if (el && lastTranscriptOffset != null) el.scrollTop = lastTranscriptOffset
    }
    requestAnimationFrame(() => {
      restore()
      requestAnimationFrame(restore)
      setTimeout(restore, 120)
    })
  })

  // in-page navigation (popstate) re-parses the sub segment
  window.addEventListener("popstate", () => {
    const parts = location.pathname.split("/").filter(Boolean)
    const i = parts.indexOf("s")
    const n = i >= 0 && parts[i + 2] && /^\d+$/.test(parts[i + 2]) ? Number(parts[i + 2]) : undefined
    setSub(n)
    requestAnimationFrame(() => {
      const saved = scrollMemory.get(location.pathname)
      if (saved != null) window.scrollTo(0, saved)
    })
  })

  // j/k keyboard navigation between prompts
  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
    if (e.key !== "j" && e.key !== "k") return
    const d = source.data()
    if (!d) return
    const sessionID = sub == null || sub() == null ? d.sessionID : undefined
    const sid = sessionID ?? d.sessionID
    const msgs = visibleMessages(d, sid).filter((m) => (m as any)?.type === "user")
    const current = msgs.findIndex((m) => location.hash.includes(m.id))
    const next = e.key === "j" ? Math.min(current + 1, msgs.length - 1) : Math.max(current - 1, 0)
    msgs[next]?.id && document.querySelector(`[data-message-id="${msgs[next].id}"]`)?.scrollIntoView({ behavior: "smooth" })
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
      <Show when={new URLSearchParams(location.search).get("oshMinimal") === "1"}>
        <MinimalTimeline source={source} />
      </Show>
      <Show when={new URLSearchParams(location.search).get("oshMinimal") !== "1"}>
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
          <WorkerPoolProvider pools={getWorkerPools()}>
            <FileComponentProvider component={FileSSR}>
              <DialogProvider>
                <DataProvider
                  data={{
                    session: (source.data()?.session ?? []) as any,
                    session_status: Object.fromEntries((source.data()?.session ?? []).map((s) => [s.id, sessionStatus(source.status())])),
                    session_diff: (source.data()?.session_diff ?? {}) as any,
                    provider: (source.data()?.provider ?? { all: {}, default: {}, connected: {} }) as any,
                  }}
                  sessionID={source.data()?.sessionID ?? ""}
                  directory={source.data()?.session?.find((s: any) => s.id === source.data()?.sessionID)?.directory ?? ""}
                  onSessionHref={(id) => subHref(source, id)}
                  onNavigateToSession={(id) => {
                    const href = subHref(source, id)
                    if (!href) return
                    if (source.prefs().openTasksInNewTab !== false) window.open(href, "_blank")
                    else {
                      scrollMemory.set(location.pathname, window.scrollY)
                      window.history.pushState({}, "", href)
                      window.dispatchEvent(new PopStateEvent("popstate"))
                    }
                  }}
                >
                  <FullPageView source={source} settings={settings()} updateSettings={updateSettings} search={search()} onSearch={setSearch} sub={sub} />
                </DataProvider>
              </DialogProvider>
            </FileComponentProvider>
          </WorkerPoolProvider>
          <Show when={settings().view === "classic" || settings().view === "reader"}>
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
        </Show>
      </ErrorBoundary>
      <InfoPanel data={source.data()} sessionID={source.data().sessionID} source={source} />
      </Show>
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
