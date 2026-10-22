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
import { createMemo, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { BasicTool } from "@opencode/session-ui/basic-tool"
import { useFileComponent } from "@opencode/ui/context"
import { resolveFileDiff } from "@opencode/session-ui/session-diff"
import { ToolRegistry, type ToolProps } from "@opencode/session-ui/tools/tool-renderer"

const str = (value: unknown) => (typeof value === "string" ? value : "")
const basename = (path: string) => path.split(/[/\\]/).filter(Boolean).at(-1) ?? path
const dirname = (path: string) => {
  const clean = path.split(/[/\\]/).filter(Boolean)
  return clean.slice(0, -1).join("/")
}
const countLines = (text: string) => (text ? text.split("\n").length : 0)

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
    <span class="font-mono text-11-regular whitespace-nowrap">
      <span style={{ color: "var(--syntax-diff-add)" }}>+{props.adds}</span>{" "}
      <span style={{ color: "var(--syntax-diff-delete)" }}>−{props.dels}</span>
    </span>
  )
}



/** Auto unified/split (owner spec, VSCode-style): split engages when the
 * card can grow to double the reading column (capped at viewport-48) with
 * each pane keeping a sane minimum; panes scroll horizontally with a hidden
 * scrollbar instead of stretching. Narrow viewports fall back to unified.
 * The card stays LEFT-anchored like every other tool - it only extends
 * right, never centers. */
function useSplitFit() {
  const [width, setWidth] = createSignal(0)
  const ref = (el: HTMLDivElement) => {
    // measure the column width (edit-content's parent, osh-file-body);
    // edit-content itself hugs (fit-content) - measuring it feeds back
    // (live-caught: unified rendered narrow, split never engaged)
    const host = el.parentElement ?? el
    const measure = () => setWidth(host.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    onCleanup(() => ro.disconnect())
  }
  const split = createMemo(() => {
    const avail = Math.min(width() * 2, (typeof window === "undefined" ? 0 : window.innerWidth) - 48)
    return width() > 0 && avail >= 2 * 320 + 140
  })
  return { ref, split }
}

/** One header for every file tool: label, directory, filename, meta. */
function FileHeader(props: { label: string; path: string; meta?: JSX.Element }) {
  return (
    <div data-slot="basic-tool-tool-info-structured">
      <div data-slot="basic-tool-tool-info-main">
        <span data-slot="basic-tool-tool-title">{props.label}</span>
        <Show when={dirname(props.path)}>
          <span data-slot="osh-tool-dir">{dirname(props.path)}/</span>
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
  onRendered?: () => void
}) {
  const fileComponent = useFileComponent()
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
    <FileBody title={props.path}>
      <div ref={(el) => (inner = el)} style={{ display: "contents" }}>
        <GutterOffset start={props.lineStart ?? 1}>
          <Dynamic
            key={attempt()}
            component={fileComponent as any}
            mode="text"
            file={{ name: props.path, contents: props.contents }}
            overflow="scroll"
            onRendered={() => {
              settle()
              props.onRendered?.()
            }}
          />
        </GutterOffset>
      </div>
    </FileBody>
  )
}

/** Shared body frame: tools indent under their trigger. */
function FileBody(props: { title?: string; children: JSX.Element }) {
  return (
    <div data-component="osh-file-body">
      <Show when={props.title}>
        <FileTitle path={props.title!} />
      </Show>
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
          <FileCard path={path()} contents={preview()} lineStart={lineStart()} onRendered={() => props.onContentRendered?.()} />
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
  const fit = useSplitFit()
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
    <div data-component="osh-edit-tool" data-osh-split={fit.split() ? "on" : "off"}>
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
          <FileBody title={path()}>
            <div data-component="edit-content" ref={fit.ref}>
              <Dynamic
                component={fileComponent as any}
                mode="diff"
                virtualize={false}
                diffStyle={fit.split() ? "split" : "unified"}
                {...(fileDiff()
                  ? { fileDiff: fileDiff() }
                  : { before: { name: path(), contents: oldText() }, after: { name: path(), contents: newText() } })}
                onRendered={() => props.onContentRendered?.()}
              />
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
          <FileCard path={path()} contents={content()} onRendered={() => props.onContentRendered?.()} />
        </Show>
      </BasicTool>
    </div>
  )
}
/** Text-result tools: raw output in a preformatted surface, never
 * markdown (markdown turned each result line into a paragraph, which is
 * where the blank-line inflation came from). */
const TextResultTool =
  (label: string, icon: string) => (props: ToolProps) => {
    const args = createMemo(() => {
      const input = props.input as any
      if (typeof input.pattern === "string") return [input.pattern]
      if (typeof input.query === "string") return [input.query]
      if (typeof input.path === "string") return [input.path]
      return []
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
        trigger={{ title: label, subtitle: args()[0] ?? "", args: args().slice(1) }}
      >
        <pre data-component="osh-pre" class="osh-pre">{body()}</pre>
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
