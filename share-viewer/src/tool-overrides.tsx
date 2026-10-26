// Viewer-side tool renderers. Registered AFTER the vendored kit's module
// has run, so ToolRegistry.render(name) resolves to ours (last write wins).
//
// Why these exist: the v2 kit is built for the app, where a file read is
// served by the host API on demand. A share is a static snapshot, so the
// kit's `read` renders images only and text output never appears; its
// `edit`/`write` wrap the diff in an always-open shell with the file
// annotation inside, which put the header under the diff and made the
// collapsed state a full-width band.
//
// Shape follows the v1 viewer: one compact row (icon + label + path +
// change counts), collapsible, content below it, output in a
// preformatted surface block instead of markdown paragraphs.
import { createEffect, createMemo, createSignal, onCleanup, For, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { BasicTool } from "@opencode/session-ui/basic-tool"
import { useData } from "@opencode/session-ui/context"
import { useFileComponent } from "@opencode/ui/context"
import { resolveFileDiff } from "@opencode/session-ui/session-diff"
import { ToolRegistry, type ToolProps } from "@opencode/session-ui/tools/tool-renderer"
import { diffModeSignal, setDiffMode, overflowSignal, setOutputOverflow, fileOverflowSignal, setFileOverflow } from "./settings"

/** Per-card overflow toggle (owner directive): on the EXPANDED card body -
 *  never the collapsed trigger row. Wraps vs hidden-scrollbar scroll for
 *  long lines. FILE cards carry a tool prop and write their own tool's
 *  entry (read/write/edit can differ); other surfaces write the global. */
function OverflowToggle(props: { tool?: "read" | "write" | "edit" }) {
  const wrapping = () => (props.tool ? (fileOverflowSignal()[props.tool] ?? "wrap") === "wrap" : overflowSignal() === "wrap")
  return (
    <button
      type="button"
      data-slot="osh-overflow-toggle"
      title={wrapping() ? "wrap: on (click to scroll instead)" : "wrap: off (click to wrap instead)"}
      onClick={(e) => {
        e.stopPropagation()
        if (props.tool) setFileOverflow(props.tool, wrapping() ? "scroll" : "wrap")
        else setOutputOverflow(wrapping() ? "scroll" : "wrap")
      }}
    >
      {wrapping() ? "⏎" : "→"}
    </button>
  )
}

const str = (value: unknown) => (typeof value === "string" ? value : "")
const basename = (path: string) => path.split(/[/\\]/).filter(Boolean).at(-1) ?? path
/** a display path: relativized against the session directory when under
 *  it, else the last two segments (live-caught: full absolute paths
 *  stretched rows even for same-folder searches). The session directory
 *  comes from the DataProvider - set by app.tsx from the session item. */
function displayPath(path: string): string {
  let directory: string | undefined
  try {
    directory = (useData() as any)?.directory
  } catch {
    directory = undefined
  }
  if (!path) return ""
  if (!directory || directory === "/" || directory === "\\") return path
  const sep = directory.includes("\\") ? "\\" : "/"
  const prefix = directory.endsWith(sep) ? directory : directory + sep
  if (path.startsWith(prefix)) return "." + sep + path.slice(directory.length)
  if (path === directory) return "."
  const segs = path.split(/[/\\]/).filter(Boolean)
  return segs.length > 2 ? "..." + sep + segs.slice(-2).join(sep) : path
}
const dirname = (path: string) => {
  const clean = path.split(/[/\\]/).filter(Boolean)
  return clean.slice(0, -1).join("/")
}
/** the header's directory display: session-relative inside the session
 * dir, last-two-segments outside, separators normalized to "/" */
function displayPathDir(path: string): string {
  let directory: string | undefined
  try {
    directory = (useData() as any)?.directory
  } catch {
    directory = undefined
  }
  const norm = (p: string) => p.replace(/\\/g, "/")
  const dir = dirname(path)
  if (!dir) return ""
  if (!directory || directory === "/" || directory === "\\") return norm(dir)
  const base = norm(directory).replace(/\/+$/, "")
  const nd = norm(dir)
  if (nd === base) return "."
  if (nd.startsWith(base + "/")) return nd.slice(base.length + 1)
  const segs = nd.split("/").filter(Boolean)
  return segs.length > 2 ? "…" + segs.slice(-2).join("/") : norm(dir)
}
const countLines = (text: string) => (text ? text.replace(/\n$/, "").split("\n").length : 0)

/** v1 read rows said which slice of the file they took ("from 284"). */
function readRange(props: ToolProps, lines: number): string {
  const input = props.input as any
  const offset = typeof input.offset === "number" ? input.offset : undefined
  const from = typeof offset === "number" ? offset + 1 : undefined
  return from ? `${lines} lines from ${from}` : `${lines} lines`
}

/** first line number for the read gutter (offset is 0-based) */
function readStart(props: ToolProps): number {
  const offset = (props.input as any).offset
  return typeof offset === "number" && offset >= 0 ? offset + 1 : 1
}

function counts(props: ToolProps) {
  const files = (props.metadata as any)?.files
  if (Array.isArray(files)) {
    const adds = files.reduce((n: number, f: any) => n + (Number(f?.additions) || 0), 0)
    const dels = files.reduce((n: number, f: any) => n + (Number(f?.deletions) || 0), 0)
    if (adds || dels) return { adds, dels }
  }
  return undefined
}

function ChangeCounts(props: { adds: number; dels: number }) {
  return (
    <span class="font-mono text-12-regular whitespace-nowrap">
      <span style={{ color: "var(--syntax-diff-add)" }}>+{props.adds}</span>{" "}
      <span style={{ color: "var(--syntax-diff-delete)" }}>−{props.dels}</span>
    </span>
  )
}



/** File-card sizing (owner round 2026-10-25): one fixed card width for the
 * whole file family — read, write and unified edit all render at
 * `--osh-card` (30rem); a split diff renders at exactly 2x that, so the
 * first column NEVER changes size when toggling U/S — split only adds the
 * second pane. Widths live in CSS (app.css); JS keeps a single shared
 * measurement of the transcript column for the auto split decision and
 * the "forced split but no room" indicator. The old per-card measurement
 * machinery (spring re-checks, per-card ResizeObservers, mono-char canvas
 * math) is gone: card width is stable by construction, so the class of
 * hug-poisons-measurement bugs (a 264px collapsed scroller refusing the
 * split forever) cannot exist. */
const [colWidth, setColWidth] = createSignal(0)
let colEl: HTMLElement | undefined
let colRO: ResizeObserver | undefined
function trackColumn(el: HTMLElement) {
  const host =
    el.closest<HTMLElement>("[data-transcript-content]") ??
    el.closest<HTMLElement>("[data-transcript-scroll]") ??
    el
  if (host === colEl) {
    if (colRO) setColWidth(host.clientWidth)
    return
  }
  colEl = host
  colRO?.disconnect()
  colRO = new ResizeObserver(() => setColWidth(host.clientWidth))
  colRO.observe(host)
  setColWidth(host.clientWidth)
}
const CARD_W = 480 // px — mirrors --osh-card: 30rem in app.css
const splitFits = () => colWidth() >= CARD_W * 2 + 24

/** effective diff layout: forced unified stays unified; forced split needs
 * the room (falls back unified with the starved indicator); auto splits
 * exactly when the column fits two cards side by side */
function effectiveDiffMode(): () => "split" | "unified" {
  return createMemo<"split" | "unified">(() => {
    const m = diffModeSignal()
    if (m === "unified") return "unified"
    return splitFits() ? "split" : "unified"
  })
}

/** One header for every file tool: label, directory, filename, meta.
 * The directory is session-relative (like the v1 viewer): inside the
 * session dir it shows the sub-path only; the full path appears only
 * for files outside it. Live-caught: the raw absolute dirname stretched
 * rows even for same-folder files. */
function FileHeader(props: { label: string; path: string; meta?: JSX.Element }) {
  const dir = createMemo(() => {
    const shown = displayPathDir(props.path)
    return shown
  })
  return (
    <div data-slot="basic-tool-tool-info-structured">
      <div data-slot="basic-tool-tool-info-main">
        <span data-slot="basic-tool-tool-title">{props.label}</span>
        <Show when={dir()}>
          <span data-slot="osh-tool-dir">{dir()}/</span>
        </Show>
        <span data-slot="osh-tool-file">{basename(props.path)}</span>
        {props.meta}
      </div>
    </div>
  )
}

/** The expanded body's title bar - icon-badge, file name, muted directory.
 * Duplicates the header row on purpose: when a long transcript scrolls the
 * row away, the card still says what you are reading. */
function FileTitle(props: { path: string }) {
  const name = basename(props.path)
  const ext = name.includes(".") ? name.split(".").at(-1)!.slice(0, 4) : "file"
  return (
    <div data-slot="osh-file-title">
      <span class="osh-file-icon osh-file-ext">{ext}</span>
      <span class="osh-file-name">{name}</span>
      <Show when={dirname(props.path)}>
        <span class="osh-file-dir">{dirname(props.path).split("/").at(-1)}</span>
      </Show>
    </div>
  )
}

/** Failed tools must say why - several kit rows drop state.error. */
function errorText(props: ToolProps): string {
  const explicit = str((props as any).error)
  if (explicit) return explicit
  return props.status === "error" ? str(props.output) : ""
}

// ---------------------------------------------------------------------------
// FileCard: THE file surface for read/write/edit — one element, one
// highlighting engine (pierre worker pool through the kit File), per owner
// directive. read/write render text mode (read renumbers its gutter from
// the plugin-stamped metadata.lineStart); edit renders the HOST's native
// patch (real line numbers + context lines, exactly like opencode's own
// diff view), falling back to before/after reconstruction for old shares.
// ---------------------------------------------------------------------------

/** Renumber pierre's gutter so a read slice continues from the real file
 * line: pierre numbers from 1; gutter cells are
 * `div[data-column-number] > span[data-line-number-content]` (verified in
 * pierre's createGutterItem). Runs after every render pass (MutationObserver
 * on the wrapper) so virtualized re-renders stay correct. Text mode only -
 * diffs carry real numbers in their hunks already. */
function GutterOffset(props: { start: number; children: JSX.Element }) {
  let root: HTMLDivElement | undefined
  const renumber = () => {
    if (!root || props.start <= 1) return
    const shift = props.start - 1
    for (const cell of root.querySelectorAll("[data-column-number]")) {
      const raw = cell.getAttribute("data-column-number")
      const n = raw == null ? NaN : Number(raw)
      if (!Number.isFinite(n)) continue
      // idempotent: recompute from the 0-based line index pierre stamps
      const idx = Number(cell.getAttribute("data-line-index") ?? "0")
      const next = (Number.isFinite(idx) ? idx : n - 1) + props.start
      if (next === n) continue
      cell.setAttribute("data-column-number", String(next))
      const text = cell.querySelector("[data-line-number-content]")
      if (text) text.textContent = String(next)
    }
  }
  const attach = (el: HTMLDivElement) => {
    root = el
    renumber()
    const mo = new MutationObserver(() => requestAnimationFrame(renumber))
    mo.observe(el, { childList: true, subtree: true })
    onCleanup(() => mo.disconnect())
  }
  return <div ref={attach}>{props.children}</div>
}

/** One cold-pool guard: pierre renders PLAIN text if the worker pool has
 * not finished booting when the card mounts, and never re-renders when it
 * does (live-caught intermittency). After the first render settles, if the
 * file has gutter cells but zero colored token spans, remount the File
 * ONCE - the pool is warm by then. */
function FileCard(props: {
  path?: string
  contents: string
  /** first REAL file line (reads sliced from an offset); 1 = whole file */
  lineStart?: number
  /** which file tool this card is - drives the PER-TOOL overflow setting */
  tool: "read" | "write"
  onRendered?: () => void
}) {
  const fileComponent = useFileComponent()
  const ov = () => fileOverflowSignal()[props.tool] ?? "wrap"
  let inner: HTMLDivElement | undefined
  const [attempt, setAttempt] = createSignal(0)
  let retried = false
  const settle = () => {
    if (retried) return
    retried = true
    setTimeout(() => {
      const root = inner
      if (!root) return
      const cells = root.querySelectorAll("[data-column-number]").length
      const tokens = root.querySelectorAll("[data-line] span[style]").length
      if (cells > 0 && tokens === 0) setAttempt(1)
    }, 1200)
  }
  return (
    <FileBody title={props.path} tool={props.tool}>
      <div ref={(el) => (inner = el)} style={{ display: "contents" }}>
        <GutterOffset start={props.lineStart ?? 1}>
          {/* keyed by attempt: Solid's Dynamic has NO remount API (a `key`
              prop is just passed through) - a distinct <Show keyed> branch
              is what actually re-creates the File when the cold-pool guard
              fires (live-caught: the guard never worked before) */}
          <Show when={attempt() === 0} keyed>
            <Dynamic
              component={fileComponent as any}
              mode="text"
              file={{ name: props.path, contents: props.contents }}
              overflow={ov()}
              onRendered={() => {
                settle()
                props.onRendered?.()
              }}
            />
          </Show>
          <Show when={attempt() === 1} keyed>
            <Dynamic
              component={fileComponent as any}
              mode="text"
              file={{ name: props.path, contents: props.contents }}
              overflow={ov()}
              onRendered={() => props.onRendered?.()}
            />
          </Show>
        </GutterOffset>
      </div>
    </FileBody>
  )
}

/** Shared body frame: tools indent under their trigger. The card controls
 *  (diff mode when present, overflow toggle always) stack on the title
 *  row's right edge. */
function FileBody(props: { title?: string; tool?: "read" | "write" | "edit"; controls?: JSX.Element; children: JSX.Element }) {
  return (
    <div data-component="osh-file-body" ref={(el) => queueMicrotask(() => trackColumn(el))}>
      <div class="osh-file-titlebar">
        <Show when={props.title}>
          <FileTitle path={props.title!} />
        </Show>
        <div class="osh-card-controls">
          {props.controls}
          <OverflowToggle tool={props.tool} />
        </div>
      </div>
      {props.children}
    </div>
  )
}
/** `read`: the file body in the unified FileCard. The plugin stamps
 * metadata.lineStart = offset+1 (authoritative); input.offset is the
 * old-share fallback. */
const ReadTool = (props: ToolProps) => {
  const path = createMemo(() => str((props.input as any).path) || str((props.input as any).filePath))
  const preview = createMemo(() => {
    const meta = (props.metadata as any) ?? {}
    return str(meta.preview) || str(props.output)
  })
  const failure = createMemo(() => errorText(props))
  const lines = createMemo(() => countLines(preview()))
  const lineStart = createMemo(() => {
    const stamped = Number((props.metadata as any)?.lineStart)
    if (Number.isFinite(stamped) && stamped > 1) return stamped
    return readStart(props)
  })
  return (
    <div data-component="osh-read-tool">
      <BasicTool
        {...props}
        icon="glasses"
        hasContent={!!preview() || !!failure()}
        defer
        trigger={() => (
          <FileHeader
            label="Read"
            path={path()}
            meta={
              <Show when={lines() > 1}>
                <span data-slot="osh-tool-meta">{readRange(props, lines())}</span>
              </Show>
            }
          />
        )}
      >
        <Show
          when={!failure()}
          fallback={<pre class="osh-pre osh-pre-error">{failure()}</pre>}
        >
          <FileCard tool="read" path={path()} contents={preview()} lineStart={lineStart()} onRendered={() => props.onContentRendered?.()} />
        </Show>
      </BasicTool>
    </div>
  )
}

/** Read output as a real code view: gutter numbers CONTINUE from the file
 * offset (v1 behaviour), horizontal scroll, no markdown mangling. */
/** `edit` / `patch`: header first (label, path, +added/-removed). Body is
 * the HOST's native unified patch when the share carries one (v1 metadata
 * .filediff.patch, v2 metadata.files[].patch) - pierre parses it and the
 * gutter shows REAL file line numbers plus the host's context lines
 * (createTwoFilesPatch default = 4 above/below each change, exactly like
 * opencode's own diff view). Old shares without a patch fall back to
 * before/after reconstruction (numbers from 1). */
const EditTool = (props: ToolProps) => {
  const fileComponent = useFileComponent()
  const path = createMemo(() => str((props.input as any).path) || str((props.input as any).filePath))
  const oldText = createMemo(() => str((props.input as any).oldString))
  const newText = createMemo(() => str((props.input as any).newString))
  const failure = createMemo(() => errorText(props))
  // the host's patch: v1 stamps metadata.filediff, v2 stamps metadata.files
  const patch = createMemo(() => {
    const meta = (props.metadata as any) ?? {}
    const p1 = meta.filediff?.patch
    if (typeof p1 === "string" && p1) return p1
    const p2 = Array.isArray(meta.files) ? meta.files[0]?.patch : undefined
    return typeof p2 === "string" && p2 ? p2 : undefined
  })
  const fileDiff = createMemo(() =>
    patch() != null
      ? // the kit's own adapter: patch string -> parsed FileDiffMetadata (cached)
        (resolveFileDiff as any)({ file: path() ?? "file", patch: patch() })
      : undefined,
  )
  // fixed card widths (owner round 2026-10-25): the split/unified decision
  // rides the shared column measurement — no per-card measurement left
  const effMode = effectiveDiffMode()
  const starved = () => diffModeSignal() === "split" && !splitFits()
  const stats = createMemo(() => {
    const known = counts(props)
    if (known) return known
    const before = oldText()
    const after = newText()
    const b = new Set(before.split("\n").map((l) => l.trim()))
    const a = new Set(after.split("\n").map((l) => l.trim()))
    let dels = 0
    let adds = 0
    for (const line of b) if (!a.has(line)) dels += 1
    for (const line of a) if (!b.has(line)) adds += 1
    return { adds, dels }
  })
  return (
    <div data-component="osh-edit-tool" data-osh-split={effMode() === "split" ? "on" : "off"}>
      <BasicTool
        {...props}
        icon="code-lines"
        hasContent={!!path() || !!failure()}
        defer
        trigger={() => (
          <FileHeader
            label={props.tool === "patch" ? "Patch" : "Edit"}
            path={path()}
            meta={
              <Show when={stats().adds || stats().dels}>
                <ChangeCounts adds={stats().adds} dels={stats().dels} />
              </Show>
            }
          />
        )}
      >
        <Show
          when={!failure()}
          fallback={<pre class="osh-pre osh-pre-error">{failure()}</pre>}
        >
          <FileBody
            title={path()}
            tool="edit"
            controls={
              /* per-card diff mode toggle (writes the global setting) —
                 right edge of the card, directly above the wrap/scroll
                 selector (owner round 2026-10-25) */
              <div data-slot="osh-diff-mode" role="group" aria-label="diff layout">
                <button
                  type="button"
                  class="osh-dm-btn"
                  classList={{ "osh-dm-on": diffModeSignal() === "unified" }}
                  title="Unified (forced)"
                  onclick={(e) => { e.stopPropagation(); setDiffMode("unified") }}
                >U</button>
                <button
                  type="button"
                  class="osh-dm-btn"
                  classList={{ "osh-dm-on": diffModeSignal() === "auto" }}
                  title="Auto (split when it fits)"
                  onclick={(e) => { e.stopPropagation(); setDiffMode("auto") }}
                >A</button>
                <button
                  type="button"
                  class="osh-dm-btn"
                  classList={{ "osh-dm-on": diffModeSignal() === "split", "osh-dm-starved": starved() }}
                  title={starved() ? "Split — not enough width here; showing unified" : "Split (forced, needs width)"}
                  onclick={(e) => { e.stopPropagation(); setDiffMode("split") }}
                >S</button>
              </div>
            }
          >
            <div data-component="edit-content">
              {/* keyed branch pair: Solid's Dynamic has NO remount API (a
                  `key` prop is passed through, does nothing - live-caught:
                  the first card of a batch rendered split, the rest stayed
                  unified forever). Distinct <Show keyed> branches actually
                  re-create the File when the mode flips. */}
              <Show when={effMode() === "split"} keyed>
                <Dynamic
                  component={fileComponent as any}
                  mode="diff"
                  virtualize={false}
                  diffStyle="split"
                  overflow={fileOverflowSignal().edit ?? "wrap"}
                  {...(fileDiff()
                    ? { fileDiff: fileDiff() }
                    : { before: { name: path(), contents: oldText() }, after: { name: path(), contents: newText() } })}
                  onRendered={() => props.onContentRendered?.()}
                />
              </Show>
              <Show when={effMode() === "unified"} keyed>
                <Dynamic
                  component={fileComponent as any}
                  mode="diff"
                  virtualize={false}
                  diffStyle="unified"
                  overflow={fileOverflowSignal().edit ?? "wrap"}
                  {...(fileDiff()
                    ? { fileDiff: fileDiff() }
                    : { before: { name: path(), contents: oldText() }, after: { name: path(), contents: newText() } })}
                  onRendered={() => props.onContentRendered?.()}
                />
              </Show>
            </div>
          </FileBody>
        </Show>
      </BasicTool>
    </div>
  )
}

/** `write`: same card as read/edit, body is the written file. */
const WriteTool = (props: ToolProps) => {
  const path = createMemo(() => str((props.input as any).path) || str((props.input as any).filePath))
  const content = createMemo(() => str((props.input as any).content))
  const failure = createMemo(() => errorText(props))
  const lines = createMemo(() => countLines(content()))
  return (
    <div data-component="osh-write-tool">
      <BasicTool
        {...props}
        icon="code-lines"
        hasContent={!!path() && (!!content() || !!failure())}
        defer
        trigger={() => (
          <FileHeader
            label="Write"
            path={path()}
            meta={<Show when={lines() > 0}><span data-slot="osh-tool-meta">{lines()} lines</span></Show>}
          />
        )}
      >
        <Show
          when={!failure()}
          fallback={<pre class="osh-pre osh-pre-error">{failure()}</pre>}
        >
          <FileCard tool="write" path={path()} contents={content()} onRendered={() => props.onContentRendered?.()} />
        </Show>
      </BasicTool>
    </div>
  )
}
/** Text-result tools: raw output in a preformatted surface, never
 *  markdown (markdown turned each result line into a paragraph, which is
 *  where the blank-line inflation came from). Subtitle = the search path
 *  RELATIVIZED against the session directory (live-caught: the full
 *  absolute path stretched the row even for files in the same folder). */
const TextResultTool =
  (label: string, icon: string) => (props: ToolProps) => {
    const searchPath = createMemo(() => {
      const input = props.input as any
      return typeof input.path === "string" ? input.path : undefined
    })
    const args = createMemo(() => {
      const input = props.input as any
      if (typeof input.pattern === "string") return [input.pattern]
      if (typeof input.query === "string") return [input.query]
      return []
    })
    const count = createMemo(() => {
      const meta = (props.metadata as any) ?? {}
      const n = typeof meta.count === "number" ? meta.count : typeof meta.matches === "number" ? meta.matches : undefined
      return typeof n === "number" && n > 0 ? `${n} ${label === "Grep" ? "matches" : "results"}` : undefined
    })
    const body = createMemo(() =>
      str(props.output)
        .replace(/\r\n/g, "\n")
        // result groups arrived separated by blank lines; the rail already
        // provides the rhythm, so drop the doubling
        .replace(/\n{2,}/g, "\n"),
    )
    return (
      <BasicTool
        {...props}
        icon={icon}
        hasContent={!!body()}
        defer
        trigger={() => (
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">{label}</span>
              <Show when={searchPath()}>
                {(p) => <span data-slot="osh-tool-dir">{displayPath(p())}</span>}
              </Show>
              <For each={args()}>
                {(a) => <span data-slot="basic-tool-tool-arg">{a}</span>}
              </For>
            </div>
            <Show when={count()}>
              {(c) => <span data-slot="osh-tool-meta">{c()}</span>}
            </Show>
          </div>
        )}
      >
        <div class="osh-pre-wrap">
          <pre data-component="osh-pre" class="osh-pre">{body()}</pre>
          <OverflowToggle />
        </div>
      </BasicTool>
    )
  }

/** `todowrite`: the kit drops it entirely; v1 rendered a checklist. */
const TodoTool = (props: ToolProps) => {
  const todos = createMemo(() => {
    const raw = (props.input as any).todos
    return Array.isArray(raw) ? raw : []
  })
  return (
    <BasicTool
      {...props}
      icon="bullet-list"
      hasContent={todos().length > 0}
      defer
      trigger={() => (
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">Todos</span>
              <span data-slot="osh-tool-meta">
                {todos().filter((t: any) => t?.status === "completed").length}/{todos().length} done
              </span>
            </div>
          </div>
        )}
    >
      <div class="flex flex-col gap-1 py-1">
        {todos().map((todo: any) => (
          <div class="flex items-start gap-2 text-13-regular">
            <span class="w-4 shrink-0 text-center font-mono" style={{ color: "var(--text-weaker)" }}>
              {todo?.status === "completed" ? "x" : todo?.status === "in_progress" ? ">" : "-"}
            </span>
            <span class={todo?.status === "completed" ? "line-through opacity-60" : ""}>{str(todo?.content)}</span>
          </div>
        ))}
      </div>
    </BasicTool>
  )
}

ToolRegistry.register({ name: "read", render: ReadTool })
ToolRegistry.register({ name: "edit", render: EditTool })
ToolRegistry.register({ name: "write", render: WriteTool })
ToolRegistry.register({ name: "patch", render: EditTool })
ToolRegistry.register({ name: "grep", render: TextResultTool("Grep", "magnifying-glass") })
ToolRegistry.register({ name: "glob", render: TextResultTool("Glob", "magnifying-glass-menu") })
ToolRegistry.register({ name: "list", render: TextResultTool("List", "bullet-list") })
ToolRegistry.register({ name: "todowrite", render: TodoTool })
// subagent/task stay on the KIT renderer (card, expand, click-through to the
// child session) - only its LABEL is forked to the real agent name; the map
// it reads lives in subagent-map.ts (globalThis.__oshAgents)
