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
import { createMemo, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { BasicTool } from "@opencode/session-ui/basic-tool"
import { useFileComponent } from "@opencode/ui/context"
import { registerOpenCodeTheme } from "@opencode/ui/context/marked-theme-register"
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



/** Auto unified/split: split ONLY when the container fits both columns of
 * the LONGEST line, measured with the REAL font (canvas TextMetrics), not a
 * px-per-char guess (the guess misjudged real fonts and the diff silently
 * fell back to unified - live-caught). Falls back to unified on narrow
 * viewports or long lines. */
function useSplitFit(props: { longest: () => number; sample?: () => string }) {
  const [wrap, setWrap] = createSignal<HTMLDivElement | undefined>()
  const [width, setWidth] = createSignal(0)
  const [charWidth, setCharWidth] = createSignal(7.9)
  const needed = createMemo(() => {
    // two panes + two number gutters + breathing room
    return Math.round(props.longest() * charWidth() * 2 + 150)
  })
  const ref = (el: HTMLDivElement) => {
    setWrap(el)
    // measure the AVAILABLE width, not the content: edit-content itself
    // hugs (width: fit-content, the no-page-stretch rule), so measuring it
    // feeds back - unified renders narrow, split never engages, deadlocked
    // (live-caught). The parent (osh-file-body) is full-width.
    const host = el.parentElement ?? el
    const measure = () => {
      setWidth(host.clientWidth)
      const font = getComputedStyle(host).font
      const sample = (props.sample?.() ?? "0".repeat(40)).slice(0, 160)
      try {
        const ctx = measureCanvas ??= document.createElement("canvas").getContext("2d")
        if (ctx) {
          ctx.font = font
          const w = ctx.measureText(sample).width / sample.length
          if (w > 2) setCharWidth(w)
        }
      } catch {}
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    if (host !== el) ro.observe(el)
    onCleanup(() => ro.disconnect())
  }
  const split = createMemo(() => width() > 0 && width() >= needed())
  return { ref, split }
}
let measureCanvas: CanvasRenderingContext2D | null = null

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
/** `read`: the v1 behaviour - show the file body when there is one.
 * Prefers metadata.preview, else the tool's text output (our contract
 * puts the v1 `state.output` into content[0].text). */
/** `read`: the file body, in the same card as write and edit. */
const ReadTool = (props: ToolProps) => {
  const fileComponent = useFileComponent()
  const path = createMemo(() => str((props.input as any).path) || str((props.input as any).filePath))
  const preview = createMemo(() => {
    const meta = (props.metadata as any) ?? {}
    return str(meta.preview) || str(props.output)
  })
  const failure = createMemo(() => errorText(props))
  const lines = createMemo(() => countLines(preview()))
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
          <FileBody title={path()}>
            <ReadCode contents={preview()} start={readStart(props)} path={path()} language={str((props.metadata as any)?.language)} />
          </FileBody>
        </Show>
      </BasicTool>
    </div>
  )
}

/** Read output as a real code view: gutter numbers CONTINUE from the file
 * offset (v1 behaviour), horizontal scroll, no markdown mangling. */
// shiki language for a path - the PLUGIN stamps metadata.language
// (authoritative); this map is the old-share fallback only
const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", md: "markdown", mdx: "mdx",
  py: "python", rs: "rust", go: "go", java: "java", rb: "ruby",
  css: "css", scss: "scss", html: "html", xml: "xml", yaml: "yaml", yml: "yaml",
  toml: "toml", sh: "shellscript", bash: "shellscript", ps1: "powershell",
  sql: "sql", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp",
  swift: "swift", kt: "kotlin", php: "php", lua: "lua", vue: "vue", svelte: "svelte",
}
const langOfPath = (path: string | undefined): string => {
  const ext = (path ?? "").split(".").pop()?.toLowerCase() ?? ""
  return LANG_BY_EXT[ext] ?? "plaintext"
}

// shared main-thread highlighter (pierre, theme "OpenCode" = CSS variables,
// so tokens follow the page theme). Loaded once, cached per language.
let highlighterPromise: Promise<any> | undefined
const highlightLine = async (line: string, lang: string): Promise<string> => {
  if (lang === "plaintext") return ""
  try {
    highlighterPromise ??= (async () => {
      const m = await import("@pierre/diffs")
      registerOpenCodeTheme()
      return m.getSharedHighlighter({ themes: ["OpenCode" as any], langs: [lang as any] })
    })()
    const hl = await highlighterPromise
    const html = hl.codeToHtml(line || " ", { lang, theme: "OpenCode" }) as string
    // shiki wraps in <pre><code>...; keep only the token spans
    const m = /<code[^>]*>([\s\S]*)<\/code>/.exec(html)
    return m ? m[1] : ""
  } catch {
    return ""
  }
}

function ReadCode(props: { contents: string; start: number; path?: string; language?: string }) {
  const rows = createMemo(() => props.contents.replace(/\n$/, "").split("\n"))
  const lang = () => (props.language && props.language !== "plaintext" ? props.language : langOfPath(props.path))
  // [line html | ""] per row; "" = plain (pending, unsupported, or too big)
  const [tokens, setTokens] = createSignal<string[]>([])
  onMount(() => {
    const n = rows().length
    if (lang() === "plaintext" || n > 400) return
    let alive = true
    onCleanup(() => (alive = false))
    void (async () => {
      const out: string[] = []
      // one shared pass; per-line for our gutter
      for (let i = 0; i < rows().length; i++) out.push(await highlightLine(rows()[i], lang()))
      if (alive) setTokens(out)
    })()
  })
  return (
    <div data-component="osh-read-code">
      {rows().map((line, i) => (
        <div class="osh-read-row">
          <span class="osh-read-ln">{props.start + i}</span>
          <span class="osh-read-line" innerHTML={tokens()[i] || undefined}>
            {tokens()[i] ? undefined : line || " "}
          </span>
        </div>
      ))}
    </div>
  )
}
/** `edit`: annotation ABOVE the diff, compact when collapsed, diff below. */
/** `edit` / `patch`: header first (label, path, +added/-removed), diff below. */
const EditTool = (props: ToolProps) => {
  const fileComponent = useFileComponent()
  const path = createMemo(() => str((props.input as any).path) || str((props.input as any).filePath))
  const oldText = createMemo(() => str((props.input as any).oldString))
  const newText = createMemo(() => str((props.input as any).newString))
  const failure = createMemo(() => errorText(props))
  const longest = createMemo(() => {
    let n = 0
    for (const line of oldText().split("\n")) n = Math.max(n, line.length)
    for (const line of newText().split("\n")) n = Math.max(n, line.length)
    return n
  })
  const fit = useSplitFit({ longest, sample: () => newText() || oldText() })
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
    <div data-component="osh-edit-tool">
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
                before={{ name: path(), contents: oldText() }}
                after={{ name: path(), contents: newText() }}
                onRendered={() => props.onContentRendered?.()}
              />
            </div>
          </FileBody>
        </Show>
      </BasicTool>
    </div>
  )
}
/** `write`: same header discipline as edit, body is the written file. */
/** `write`: same card as read/edit, body is the written file. */
const WriteTool = (props: ToolProps) => {
  const fileComponent = useFileComponent()
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
          <FileBody title={path()}>
            <Dynamic
              component={fileComponent as any}
              mode="text"
              file={{ name: path(), contents: content() }}
              overflow="scroll"
              onRendered={() => props.onContentRendered?.()}
            />
          </FileBody>
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
