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
import { createMemo, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { BasicTool } from "@opencode/session-ui/basic-tool"
import { useFileComponent } from "@opencode/ui/context"
import { ToolRegistry, type ToolProps } from "@opencode/session-ui/tools/tool-renderer"

const str = (value: unknown) => (typeof value === "string" ? value : "")
const basename = (path: string) => path.split(/[/\\]/).filter(Boolean).at(-1) ?? path
const dirname = (path: string) => {
  const clean = path.split(/[/\\]/).filter(Boolean)
  return clean.slice(0, -1).join("/")
}
const countLines = (text: string) => (text ? text.split("\n").length : 0)

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

/** `read`: the v1 behaviour - show the file body when there is one.
 * Prefers metadata.preview, else the tool's text output (our contract
 * puts the v1 `state.output` into content[0].text). */
const ReadTool = (props: ToolProps) => {
  const path = createMemo(() => str((props.input as any).path) || str((props.input as any).filePath))
  const preview = createMemo(() => {
    const meta = (props.metadata as any) ?? {}
    const fromMeta = str(meta.preview)
    if (fromMeta) return fromMeta
    return str(props.output)
  })
  const lines = createMemo(() => countLines(preview()))
  return (
    <div data-component="osh-read-tool">
      <BasicTool
        {...props}
        icon="glasses"
        hasContent={!!preview()}
        defer
        trigger={{
          title: "Read",
          subtitle: path() ? basename(path()) : "",
          args: lines() > 1 ? [`${lines()} lines`] : [],
        }}
      >
        <pre data-component="osh-pre" class="osh-pre">{preview()}</pre>
      </BasicTool>
    </div>
  )
}

/** `edit`: annotation ABOVE the diff, compact when collapsed, diff below. */
const EditTool = (props: ToolProps) => {
  const fileComponent = useFileComponent()
  const path = createMemo(() => str((props.input as any).path) || str((props.input as any).filePath))
  const oldText = createMemo(() => str((props.input as any).oldString))
  const newText = createMemo(() => str((props.input as any).newString))
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
        hasContent={!!path()}
        defer
        trigger={(open) => (
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">Edit</span>
              <Show when={dirname(path())}>
                <span data-slot="osh-tool-dir">{dirname(path())}/</span>
              </Show>
              <span data-slot="osh-tool-file">{basename(path())}</span>
              <Show when={!open() && (stats().adds || stats().dels)}>
                <ChangeCounts adds={stats().adds} dels={stats().dels} />
              </Show>
            </div>
          </div>
        )}
      >
        <div data-component="edit-content">
          <Dynamic
            component={fileComponent as any}
            mode="diff"
            virtualize={false}
            before={{ name: path(), contents: oldText() }}
            after={{ name: path(), contents: newText() }}
            onRendered={() => props.onContentRendered?.()}
          />
        </div>
      </BasicTool>
    </div>
  )
}

/** `write`: same header discipline as edit, body is the written file. */
const WriteTool = (props: ToolProps) => {
  const fileComponent = useFileComponent()
  const path = createMemo(() => str((props.input as any).path) || str((props.input as any).filePath))
  const content = createMemo(() => str((props.input as any).content))
  return (
    <div data-component="osh-write-tool">
      <BasicTool
        {...props}
        icon="code-lines"
        hasContent={!!path() && !!content()}
        defer
        trigger={{
          title: "Write",
          subtitle: path() ? basename(path()) : "",
          args: content() ? [`${countLines(content())} lines`] : [],
        }}
      >
        <div data-component="write-content">
          <Dynamic
            component={fileComponent as any}
            mode="text"
            file={{ name: path(), contents: content() }}
            overflow="scroll"
            onRendered={() => props.onContentRendered?.()}
          />
        </div>
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
    const body = createMemo(() => str(props.output))
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
      trigger={{ title: "Todos", subtitle: `${todos().filter((t: any) => t?.status === "completed").length}/${todos().length} done` }}
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

ToolRegistry.register({ name: "read", render: ReadTool })
ToolRegistry.register({ name: "edit", render: EditTool })
ToolRegistry.register({ name: "write", render: WriteTool })
ToolRegistry.register({ name: "patch", render: EditTool })
ToolRegistry.register({ name: "grep", render: TextResultTool("Grep", "magnifying-glass") })
ToolRegistry.register({ name: "glob", render: TextResultTool("Glob", "magnifying-glass-menu") })
ToolRegistry.register({ name: "list", render: TextResultTool("List", "bullet-list") })
ToolRegistry.register({ name: "todowrite", render: TodoTool })
