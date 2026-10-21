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
import { ToolRegistry, type ToolProps } from "@opencode/session-ui/tools/tool-renderer"
import { subagentInfo } from "./subagent-map"

const capitalize = (value: string) => (value ? value[0]!.toUpperCase() + value.slice(1) : "")

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



/** Split diff when the viewport is wide enough to show two columns. */
const diffLayout = () => {
  const [split, setSplit] = createSignal(window.innerWidth >= 1100)
  window.addEventListener("resize", () => setSplit(window.innerWidth >= 1100), { passive: true })
  onCleanup(() => setSplit(false as never))
  return split
}
const wideEnough = diffLayout()

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
        <div data-slot="osh-file-title">{props.title}</div>
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
            <Dynamic
              component={fileComponent as any}
              mode="text"
              file={{ name: path(), contents: preview() }}
              overflow="scroll"
              onRendered={() => props.onContentRendered?.()}
            />
          </FileBody>
        </Show>
      </BasicTool>
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
            <div data-component="edit-content">
              <Dynamic
                component={fileComponent as any}
                mode="diff"
                virtualize={false}
                diffStyle={wideEnough() ? "split" : "unified"}
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
            <span class="w-4 shrink-0 text-center" style={{ color: "var(--v2-text-text-muted)" }}>
              {todo?.status === "completed" ? "✓" : todo?.status === "in_progress" ? "◐" : "○"}
            </span>
            <span class={todo?.status === "completed" ? "line-through opacity-60" : ""}>{str(todo?.content)}</span>
          </div>
        ))}
      </div>
    </BasicTool>
  )
}


/** `subagent` / `task`: v1 showed the child's own agent name (Explore),
 * not a generic "Agent" - the child session's assistant message carries it. */
const SubagentTool = (props: ToolProps) => {
  const id = () => str((props.metadata as any)?.sessionID) || str((props.metadata as any)?.sessionId)
  const info = () => subagentInfo(id())
  const agent = () => capitalize(info()?.agent ?? "")
  const label = () => agent() || "Agent"
  const description = () => str((props.input as any).description) || info()?.title || ""
  const body = () => str(props.output)
  const failure = () => errorText(props)
  return (
    <div data-component="osh-subagent-tool">
      <BasicTool
        {...props}
        icon="mcp"
        hasContent={!!body() || !!failure()}
        defer
        trigger={() => (
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">{label()}</span>
              <Show when={description()}>
                <span data-slot="osh-tool-meta">{description()}</span>
              </Show>
            </div>
          </div>
        )}
      >
        <Show when={!failure()} fallback={<pre class="osh-pre osh-pre-error">{failure()}</pre>}>
          <pre data-component="osh-pre" class="osh-pre">{body()}</pre>
        </Show>
      </BasicTool>
    </div>
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
ToolRegistry.register({ name: "subagent", render: SubagentTool })
ToolRegistry.register({ name: "task", render: SubagentTool })
