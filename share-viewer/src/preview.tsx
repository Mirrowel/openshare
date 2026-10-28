// Tool gallery: every tool we render, in every state it can be in, in one
// static page. No share, no network. Run `npm run preview` and open the URL
// it prints; the settings that change a tool's appearance are editable in
// the left column (the real settings panel body).
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

const PATCH = (file: string, body: string) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,6 +1,7 @@\n import { app } from "./app"\n \n-const port = 3000\n+const port = 3001\n+const host = "127.0.0.1"\n app.listen(port)\n export default app\n`

const READ_BODY = Array.from({ length: 14 }, (_, i) => `${String(i + 1).padStart(3, " ")}  const value${i + 1} = compute(${i + 1}) // result`).join("\n")

type State = { label: string; entry: ToolEntry }

const groups: Array<{ tool: string; blurb: string; states: State[] }> = [
  {
    tool: "shell",
    blurb: "scrollable + drag the bottom edge to resize; copy controls come from the kit",
    states: [
      { label: "completed, short", entry: entry("shell", { command: "python greet.py" }, "fresh diff at midnight\na second pair of eyes sees\nthe bug I wrote blind") },
      { label: "long output (clips, drag to see more)", entry: entry("shell", { command: "for i in $(seq 1 60); do echo \"line $i\"; done" }, Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n")) },
      { label: "failed", entry: entry("shell", { command: "npm run build" }, "error: command failed with exit code 1", "error") },
      { label: "running", entry: entry("shell", { command: "sleep 5" }, "", "running") },
    ],
  },
  {
    tool: "read",
    blurb: "file card, real line numbers, wrap/scroll per tool",
    states: [
      { label: "small file", entry: entry("read", { filePath: `${DIR}/src/app.ts`, offset: 0, limit: 14 }, READ_BODY, "completed", { lineStart: 1, language: "typescript" }) },
      { label: "offset (numbering starts at 41)", entry: entry("read", { filePath: `${DIR}/src/deep.ts`, offset: 40, limit: 8 }, READ_BODY, "completed", { lineStart: 41, language: "typescript" }) },
      { label: "failed", entry: entry("read", { filePath: `${DIR}/missing.ts` }, "ENOENT: no such file or directory", "error") },
    ],
  },
  {
    tool: "write",
    blurb: "new file contents in the shared file card",
    states: [
      { label: "created", entry: entry("write", { filePath: `${DIR}/NOTES.md` }, "# Notes\n\n- one\n- two", "completed", { language: "markdown" }) },
    ],
  },
  {
    tool: "edit",
    blurb: "unified/split via the U|A|S toggle, plus the global diff mode setting",
    states: [
      { label: "replace one line", entry: entry("edit", { filePath: `${DIR}/src/app.ts`, oldString: "const port = 3000", newString: "const port = 3001\nconst host = \"127.0.0.1\"" }, "", "completed", { diff: PATCH("src/app.ts", ""), files: [{ file: "src/app.ts", patch: PATCH("src/app.ts", ""), additions: 2, deletions: 1 }] }) },
      { label: "failed", entry: entry("edit", { filePath: `${DIR}/src/app.ts`, oldString: "nope", newString: "x" }, "Could not find oldString in the file", "error") },
    ],
  },
  {
    tool: "grep",
    blurb: "plain preformatted output with copy + wrap/scroll",
    states: [
      { label: "matches", entry: entry("grep", { pattern: "haiku", path: DIR }, `Found 3 matches\n${DIR}/README.md:\n  Line 1: # Demo\ngrep/glob/list output hugs its content.`, "completed", { count: 3 }) },
      { label: "no matches", entry: entry("grep", { pattern: "zzz", path: DIR }, "No matches found", "completed", { count: 0 }) },
    ],
  },
  {
    tool: "glob",
    blurb: "same card as grep",
    states: [{ label: "files", entry: entry("glob", { pattern: "**/*.ts", path: DIR }, `${DIR}/src/app.ts\n${DIR}/src/util.ts`, "completed", { count: 2 }) }],
  },
  {
    tool: "list",
    blurb: "same card as grep",
    states: [{ label: "directory", entry: entry("list", { path: DIR }, "README.md\nsrc/\npackage.json", "completed", { count: 3 }) }],
  },
  {
    tool: "todowrite",
    blurb: "checklist (the kit drops this tool entirely)",
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
    ],
  },
  {
    tool: "ctx_reduce",
    blurb: "generic tool card: name + args, output with copy + wrap/scroll",
    states: [
      { label: "completed", entry: entry("ctx_reduce", { drop: "16,17" }, "2 tags stamped.") },
      { label: "long", entry: entry("ctx_reduce", { drop: "1-40" }, Array.from({ length: 24 }, (_, i) => `tag ${i + 1} stamped`).join("\n")) },
    ],
  },
  {
    tool: "webfetch",
    blurb: "kit renderer (untouched)",
    states: [{ label: "fetched", entry: entry("webfetch", { url: "https://example.com/docs" }, "# Example\n\nA page body.", "completed") }],
  },
  {
    tool: "subagent",
    blurb: "hover the card: chevron + accent underline reveal; clicking opens the child page",
    states: [
      { label: "completed", entry: entry("subagent", { description: "Explore the repo", subagent_type: "explore", prompt: "List files" }, "Child session finished: 4 files summarised.", "completed") },
      { label: "running", entry: entry("subagent", { description: "Refactor layout", subagent_type: "build", prompt: "Move the header" }, "", "running") },
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
  const total = createMemo(() => groups.reduce((n, g) => n + g.states.length, 0))

  return (
    <div class="flex h-screen w-full overflow-hidden bg-background-base text-text-base">
      <Show when={showSettings()}>
        <aside class="w-[320px] shrink-0 overflow-y-auto border-r border-border-weak-base px-3 py-3">
          <div class="mb-2 flex items-center justify-between">
            <div class="text-14-medium">Tool gallery settings</div>
            <button class="text-12-regular text-text-weaker hover:text-text-base" onClick={() => setShowSettings(false)}>hide</button>
          </div>
          <SettingsBody settings={settings()} update={update} branding={{}} search={search()} onSearch={setSearch} sessionTools={groups.map((g) => g.tool)} />
        </aside>
      </Show>
      <main class="min-w-0 flex-1 overflow-y-auto">
        <header class="sticky top-0 z-20 flex items-center gap-3 border-b border-border-weak-base bg-background-base px-5 py-3">
          <div class="text-14-medium">Tool gallery</div>
          <div class="text-12-regular text-text-weaker">{total()} states · {groups.length} tools · no share data</div>
          <label class="ml-auto flex items-center gap-2 text-12-regular text-text-weaker">
            <input type="checkbox" checked={forceHover()} onChange={(e) => toggleHover(e.currentTarget.checked)} />
            force hover
          </label>
          <Show when={!showSettings()}>
            <button class="text-12-regular text-text-weaker hover:text-text-base" onClick={() => setShowSettings(true)}>settings</button>
          </Show>
        </header>
        <div class="flex flex-col gap-8 px-5 py-5">
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
                      <div>
                        <div class="mb-1 text-12-regular text-text-weaker">{state.label}</div>
                        <VendoredPart entry={state.entry} settings={settings()} data={data} />
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
