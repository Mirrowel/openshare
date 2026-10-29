// Tool gallery: every tool we render, in every state it can be in, in one
// static page. No share, no network. Run `npm run preview:tools` and open the
// URL it prints; the settings that change a tool's appearance sit in the left
// column. The point is to answer "how does X look when Y" without hunting
// through shares, so every variant lives here, including hover-only ones.
import { For, Show, createMemo, createSignal } from "solid-js"
import { VendoredPart } from "./views/vendored-part"
import { SettingsBody } from "./settings-panel"
import { applySettings, readSettings, writeSettings, type OshSettings } from "./settings"
import type { ToolEntry } from "./views/session-data"
import type { ShareData } from "./fold"

const SESSION = "ses_preview"
const MESSAGE = "msg_preview"
const DIR = "/home/dev/preview-project"

const data: ShareData = {
  shareID: "preview",
  sessionID: SESSION,
  session: [{ id: SESSION, title: "Tool gallery", directory: DIR } as any],
  message: { [SESSION]: [] },
  session_diff: { [SESSION]: [] },
  model: {},
  provider: { all: new Map(), default: {}, connected: [] },
  status: "completed",
}

let seq = 0
function entry(tool: string, input: Record<string, unknown>, output = "", status = "completed", metadata: Record<string, unknown> = {}): ToolEntry {
  const id = `prt_${tool}_${seq++}`
  return {
    kind: "tool",
    tool,
    title: tool,
    output,
    input,
    part: { type: "tool", name: tool, id, time: { created: Date.now() }, state: { input, status, output, metadata } } as any,
    messageID: MESSAGE,
    state: { input, status, output, metadata },
    status,
  } as ToolEntry
}

// --- fixtures ---------------------------------------------------------------
const ctx = (n: number, label: string) => Array.from({ length: n }, (_, i) => `${label} ${i + 1}`).join("\n")

/** Unified patch with a single hunk, `around` context lines each side. */
function patch(file: string, hunks: Array<{ from: number; before: string[]; after: string[] }>, around = 4) {
  const head = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n`
  const body = hunks
    .map((h) => {
      const ctxBefore = Array.from({ length: around }, (_, i) => ` context line ${h.from - around + i}`)
      const ctxAfter = Array.from({ length: around }, (_, i) => ` context line ${h.from + h.before.length + i}`)
      const oldLen = ctxBefore.length + h.before.length + ctxAfter.length
      const newLen = ctxBefore.length + h.after.length + ctxAfter.length
      return [
        `@@ -${h.from - around},${oldLen} +${h.from - around},${newLen} @@`,
        ...ctxBefore.map((l) => ` ${l}`),
        ...h.before.map((l) => `-${l}`),
        ...h.after.map((l) => `+${l}`),
        ...ctxAfter.map((l) => ` ${l}`),
      ].join("\n")
    })
    .join("\n")
  return head + body + "\n"
}

const editFiles = (file: string, p: string, additions: number, deletions: number) => ({
  diff: p,
  files: [{ file, patch: p, additions, deletions }],
})

const PATCH_SINGLE = patch("src/app.ts", [{ from: 10, before: ['const port = 3000'], after: ['const port = 3001', 'const host = "127.0.0.1"'] }])
const PATCH_MULTI = patch("src/app.ts", [
  { from: 10, before: ["const port = 3000"], after: ["const port = 3001"] },
  { from: 24, before: ["app.listen(port)"], after: ["app.listen(port, host)"] },
])
const PATCH_FAR = patch("src/app.ts", [
  { from: 8, before: ["const port = 3000"], after: ["const port = 3001"] },
  { from: 60, before: ["export default app"], after: ["export { app }", "export default app"] },
])
const PATCH_ADD = [
  "diff --git a/src/new.ts b/src/new.ts",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,4 @@",
  "+export function greet(name: string) {",
  '+  return `hello ${name}`',
  "+}",
  "+",
].join("\n")
const PATCH_DELETE = [
  "diff --git a/src/dead.ts b/src/dead.ts",
  "--- a/src/dead.ts",
  "+++ /dev/null",
  "@@ -1,3 +0,0 @@",
  "-export const dead = true",
  "-export const unused = 1",
  "-",
].join("\n")
const PATCH_LARGE = patch("src/big.ts", [
  { from: 12, before: ["  return compute(a, b)"], after: ["  const out = compute(a, b)", "  return out"] },
  { from: 40, before: ["export const LIMIT = 10"], after: ["export const LIMIT = 25"] },
  { from: 88, before: ["// TODO: cache"], after: ["// cached by default now"] },
])

const READ_SMALL = Array.from({ length: 12 }, (_, i) => `const value${i + 1} = compute(${i + 1}) // result`).join("\n")
const READ_LONG = Array.from({ length: 40 }, (_, i) => `export const item${i + 1} = ${i + 1} // generated line`).join("\n")
const READ_HUGE_LINES = Array.from({ length: 6 }, (_, i) => `const configuredValue${i} = "${"x".repeat(180)}"`).join("\n")

type State = {
  label: string
  entry: ToolEntry
  /** renders the card with hover styling applied (hover-only affordances) */
  hover?: boolean
}

const groups: Array<{ tool: string; blurb: string; states: State[] }> = [
  {
    tool: "shell",
    blurb: "drag the bottom edge to resize; the scrollbar shows while clipped",
    states: [
      { label: "short", entry: entry("shell", { command: "python greet.py" }, "fresh diff at midnight\na second pair of eyes sees\nthe bug I wrote blind") },
      { label: "long (clips, drag to see more)", entry: entry("shell", { command: "for i in $(seq 1 60); do echo \"line $i\"; done" }, ctx(60, "line")) },
      { label: "no output", entry: entry("shell", { command: "true" }, "") },
      { label: "failed", entry: entry("shell", { command: "npm run build" }, "error: command failed with exit code 1", "error") },
      { label: "running", entry: entry("shell", { command: "sleep 5" }, "", "running") },
      { label: "hover (copy controls)", hover: true, entry: entry("shell", { command: "python greet.py" }, "fresh diff at midnight") },
    ],
  },
  {
    tool: "read",
    blurb: "file card, real line numbers, capped at ~25 lines with chevrons",
    states: [
      { label: "small file", entry: entry("read", { filePath: `${DIR}/src/app.ts`, offset: 0, limit: 12 }, READ_SMALL, "completed", { lineStart: 1, language: "typescript" }) },
      { label: "offset (numbering starts at 41)", entry: entry("read", { filePath: `${DIR}/src/deep.ts`, offset: 40, limit: 8 }, READ_SMALL, "completed", { lineStart: 41, language: "typescript" }) },
      { label: "long (capped, scrolls)", entry: entry("read", { filePath: `${DIR}/src/long.ts`, offset: 0, limit: 40 }, READ_LONG, "completed", { lineStart: 1, language: "typescript" }) },
      { label: "very long lines (wrap/scroll toggle)", entry: entry("read", { filePath: `${DIR}/src/wide.ts`, offset: 0, limit: 6 }, READ_HUGE_LINES, "completed", { lineStart: 1, language: "typescript" }) },
      { label: "failed", entry: entry("read", { filePath: `${DIR}/missing.ts` }, "ENOENT: no such file or directory", "error") },
      { label: "hover (controls)", hover: true, entry: entry("read", { filePath: `${DIR}/src/app.ts`, offset: 0, limit: 6 }, READ_SMALL, "completed", { lineStart: 1, language: "typescript" }) },
    ],
  },
  {
    tool: "write",
    blurb: "new file contents in the shared file card",
    states: [
      { label: "create", entry: entry("write", { filePath: `${DIR}/NOTES.md` }, "# Notes\n\n- one\n- two", "completed", { language: "markdown" }) },
      { label: "overwrite existing", entry: entry("write", { filePath: `${DIR}/src/app.ts` }, READ_SMALL, "completed", { language: "typescript" }) },
      { label: "large file (capped)", entry: entry("write", { filePath: `${DIR}/src/generated.ts` }, READ_LONG, "completed", { language: "typescript" }) },
      { label: "failed", entry: entry("write", { filePath: `${DIR}/locked.ts` }, "EACCES: permission denied", "error") },
      { label: "hover (controls)", hover: true, entry: entry("write", { filePath: `${DIR}/NOTES.md` }, "# Notes\n\n- one", "completed", { language: "markdown" }) },
    ],
  },
  {
    tool: "edit",
    blurb: "unified/split via the U|A|S toggle; every diff shape the host emits",
    states: [
      { label: "one changed line", entry: entry("edit", { filePath: `${DIR}/src/app.ts` }, "", "completed", editFiles("src/app.ts", PATCH_SINGLE, 2, 1)) },
      { label: "two hunks close together", entry: entry("edit", { filePath: `${DIR}/src/app.ts` }, "", "completed", editFiles("src/app.ts", PATCH_MULTI, 2, 2)) },
      { label: "hunks 50 lines apart (separate blocks)", entry: entry("edit", { filePath: `${DIR}/src/app.ts` }, "", "completed", editFiles("src/app.ts", PATCH_FAR, 3, 2)) },
      { label: "many changes (large diff)", entry: entry("edit", { filePath: `${DIR}/src/big.ts` }, "", "completed", editFiles("src/big.ts", PATCH_LARGE, 4, 3)) },
      { label: "new file (additions only)", entry: entry("edit", { filePath: `${DIR}/src/new.ts` }, "", "completed", editFiles("src/new.ts", PATCH_ADD, 4, 0)) },
      { label: "deletion only", entry: entry("edit", { filePath: `${DIR}/src/dead.ts` }, "", "completed", editFiles("src/dead.ts", PATCH_DELETE, 0, 3)) },
      { label: "failed", entry: entry("edit", { filePath: `${DIR}/src/app.ts`, oldString: "nope", newString: "x" }, "Could not find oldString in the file", "error") },
      { label: "hover (controls)", hover: true, entry: entry("edit", { filePath: `${DIR}/src/app.ts` }, "", "completed", editFiles("src/app.ts", PATCH_SINGLE, 2, 1)) },
    ],
  },
  {
    tool: "patch",
    blurb: "same renderer as edit",
    states: [{ label: "applied", entry: entry("patch", { filePath: `${DIR}/src/app.ts` }, "", "completed", editFiles("src/app.ts", PATCH_MULTI, 2, 2)) }],
  },
  {
    tool: "grep",
    blurb: "preformatted output, copy + wrap/scroll, drag to resize",
    states: [
      { label: "matches", entry: entry("grep", { pattern: "haiku", path: DIR }, `Found 3 matches\n${DIR}/README.md:\n  Line 1: # Demo\nhaiku-service is a stub fixture.`, "completed", { count: 3 }) },
      { label: "many matches (long)", entry: entry("grep", { pattern: "value", path: DIR }, ctx(30, `${DIR}/src/app.ts: line`), "completed", { count: 30 }) },
      { label: "no matches", entry: entry("grep", { pattern: "zzz", path: DIR }, "No matches found", "completed", { count: 0 }) },
      { label: "hover (controls)", hover: true, entry: entry("grep", { pattern: "haiku", path: DIR }, "Found 1 match", "completed", { count: 1 }) },
    ],
  },
  {
    tool: "glob",
    blurb: "same card as grep",
    states: [
      { label: "files", entry: entry("glob", { pattern: "**/*.ts", path: DIR }, `${DIR}/src/app.ts\n${DIR}/src/util.ts`, "completed", { count: 2 }) },
      { label: "no files", entry: entry("glob", { pattern: "**/*.rs", path: DIR }, "No files found", "completed", { count: 0 }) },
    ],
  },
  {
    tool: "list",
    blurb: "same card as grep",
    states: [{ label: "directory", entry: entry("list", { path: DIR }, "README.md\nsrc/\npackage.json", "completed", { count: 3 }) }],
  },
  {
    tool: "todowrite",
    blurb: "checklist - the upstream kit omits this tool, so we register our own renderer",
    states: [
      {
        label: "mixed states",
        entry: entry("todowrite", {
          todos: [
            { content: "Read the project", status: "completed" },
            { content: "Write notes.md", status: "in_progress" },
            { content: "Run the tests", status: "pending" },
          ],
        }),
      },
      { label: "all done", entry: entry("todowrite", { todos: [{ content: "Read", status: "completed" }, { content: "Write", status: "completed" }] }) },
      { label: "empty", entry: entry("todowrite", { todos: [] }) },
    ],
  },
  {
    tool: "ctx_reduce",
    blurb: "generic card: name + args, output with copy + wrap/scroll",
    states: [
      { label: "short", entry: entry("ctx_reduce", { drop: "16,17" }, "2 tags stamped.") },
      { label: "long (drag to resize)", entry: entry("ctx_reduce", { drop: "1-40" }, ctx(24, "tag stamped")) },
      { label: "failed", entry: entry("ctx_reduce", { drop: "1" }, "no such tag", "error") },
      { label: "hover (controls)", hover: true, entry: entry("ctx_reduce", { drop: "16,17" }, "2 tags stamped.") },
    ],
  },
  {
    tool: "webfetch",
    blurb: "kit renderer (untouched)",
    states: [
      { label: "fetched", entry: entry("webfetch", { url: "https://example.com/docs" }, "# Example\n\nA page body.", "completed") },
      { label: "failed", entry: entry("webfetch", { url: "https://example.com/missing" }, "404 Not Found", "error") },
    ],
  },
  {
    tool: "subagent",
    blurb: "hover shows the chevron + accent underline; clicking opens the child page",
    states: [
      { label: "completed", entry: entry("subagent", { description: "Explore the repo", subagent_type: "explore", prompt: "List files" }, "Child session finished: 4 files summarised.", "completed") },
      { label: "completed, hover", hover: true, entry: entry("subagent", { description: "Explore the repo", subagent_type: "explore", prompt: "List files" }, "Child session finished.", "completed") },
      { label: "running", entry: entry("subagent", { description: "Refactor layout", subagent_type: "build", prompt: "Move the header" }, "", "running") },
      { label: "running, hover", hover: true, entry: entry("subagent", { description: "Refactor layout", subagent_type: "build", prompt: "Move the header" }, "", "running") },
      { label: "failed", entry: entry("subagent", { description: "Audit security", subagent_type: "explore", prompt: "Audit" }, "Subagent aborted", "error") },
    ],
  },
]

export function Preview() {
  const [settings, setSettings] = createSignal<OshSettings>(readSettings())
  const [showSettings, setShowSettings] = createSignal(true)
  const [forceHover, setForceHover] = createSignal(false)
  const [search, setSearch] = createSignal("")
  const update = (patch: Partial<OshSettings>) => {
    const next = { ...readSettings(), ...patch }
    writeSettings(next)
    applySettings(next)
    setSettings(next)
  }
  const toggleHover = (on: boolean) => {
    setForceHover(on)
    document.documentElement.toggleAttribute("data-osh-preview-hover", on)
  }
  // every card starts open: this page exists to show states, not to click
  const allOpen = createMemo(() => ({ ...settings(), autoExpand: groups.map((g) => g.tool) }))
  const total = createMemo(() => groups.reduce((n, g) => n + g.states.length, 0))

  return (
    <div class="osh-gallery flex h-dvh w-full overflow-hidden bg-background-base text-text-base">
      <Show when={showSettings()}>
        <aside class="w-[320px] shrink-0 overflow-y-auto border-r border-border-weak-base px-3 py-3">
          <div class="mb-2 flex items-center justify-between">
            <div class="text-14-medium">Tool gallery settings</div>
            <button class="text-12-regular text-text-weaker hover:text-text-base" onClick={() => setShowSettings(false)}>hide</button>
          </div>
          <SettingsBody settings={settings()} update={update} branding={{}} search={search()} onSearch={setSearch} sessionTools={groups.map((g) => g.tool)} />
        </aside>
      </Show>
      <main class="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <header class="sticky top-0 z-20 flex items-center gap-3 border-b border-border-weak-base bg-background-base px-5 py-3">
          <div class="text-14-medium">Tool gallery</div>
          <div class="text-12-regular text-text-weaker">{total()} states / {groups.length} tools / no share data</div>
          <label class="ml-auto flex items-center gap-2 text-12-regular text-text-weaker">
            <input type="checkbox" checked={forceHover()} onChange={(e) => toggleHover(e.currentTarget.checked)} />
            force hover everywhere
          </label>
          <Show when={!showSettings()}>
            <button class="text-12-regular text-text-weaker hover:text-text-base" onClick={() => setShowSettings(true)}>settings</button>
          </Show>
        </header>
        <div class="flex flex-col gap-8 px-5 py-5 pb-24">
          <For each={groups}>
            {(group) => (
              <section>
                <div class="mb-1 flex items-baseline gap-2">
                  <h2 class="text-14-medium">{group.tool}</h2>
                  <span class="text-12-regular text-text-weaker">{group.blurb}</span>
                </div>
                <div class="flex flex-col gap-3 border-l-2 border-border-weak-base pl-3">
                  <For each={group.states}>
                    {(state) => (
                      <div data-osh-preview-hover={state.hover ? "" : undefined}>
                        <div class="mb-1 text-12-regular text-text-weaker">{state.label}</div>
                        <VendoredPart entry={state.entry} settings={allOpen()} data={data} />
                      </div>
                    )}
                  </For>
                </div>
              </section>
            )}
          </For>
        </div>
      </main>
    </div>
  )
}
