// Gallery: every tool in every state, plus whole-message feature docs
// (prompts, reasoning, markdown, math, images, transcript structures,
// grouping), in one static page. No share, no network. Run `npm run
// preview:tools` and open the URL it prints; the settings that change
// appearance sit in the left column. The point is to answer "how does X
// look when Y" without hunting through shares, so every variant lives
// here, including hover-only ones.
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { VendoredPart, setVendoredData } from "./views/vendored-part"
import { GalleryTimeline } from "./gallery-timeline"
import { SettingsBody } from "./settings-panel"
import { applySettings, readSettings, writeSettings, type OshSettings } from "./settings"
import type { ToolEntry } from "./views/session-data"
import type { ShareData } from "./fold"

const SESSION = "ses_preview"
const MESSAGE = "msg_preview"
const DIR = "/home/dev/preview-project"

const data = {
  shareID: "preview",
  sessionID: SESSION,
  session: [{ id: SESSION, title: "Tool gallery", directory: DIR } as any],
  message: { [SESSION]: [] },
  session_diff: { [SESSION]: [] },
  model: {},
  provider: { all: new Map(), default: {}, connected: [] },
  // task cards render their chevron only when they can open a child; give
  // the gallery a no-op navigation target so the hover affordances exist
  navigateToSession: () => {},
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

// v1-flavoured Index patch: a REAL host hunk (counts the parser accepts -
// pierre throws on declared/parsed hunk-count mismatch, which the kit's
// splitPatch swallows into an empty diff) behind node-diff's Index preamble,
// so this fixture exercises the viewer's Index->git normalization itself
const PATCH_SINGLE = (() => {
  const git = patch("src/app.ts", [{ from: 8, before: ["const port = 3000"], after: ["const port = 3001", 'const host = "127.0.0.1"'] }])
  const body = git.split("\n").filter((l) => !l.startsWith("diff --git")).join("\n")
  return `Index: src/app.ts\n===================================================================\n${body}`
})()
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
  /** scroll the card body once mounted: shows both scroll chevrons */
  scrollTo?: "middle"
  /** design-trial wrapper attribute for the subagent running animation */
  /** disable the running animation for A/B (gallery only) */
  subanim?: "plain"
  /** shrink the column so split cannot fit - shows the starved indicator */
  narrow?: boolean
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
      { label: "scrolled to the middle (both chevrons)", entry: entry("read", { filePath: `${DIR}/src/long.ts`, offset: 0, limit: 40 }, READ_LONG, "completed", { lineStart: 1, language: "typescript" }), scrollTo: "middle" },
      { label: "very long lines (wrap/scroll toggle)", entry: entry("read", { filePath: `${DIR}/src/wide.ts`, offset: 0, limit: 6 }, READ_HUGE_LINES, "completed", { lineStart: 1, language: "typescript" }) },
      { label: "failed", entry: entry("read", { filePath: `${DIR}/missing.ts` }, "ENOENT: no such file or directory", "error") },
      { label: "hover (controls)", hover: true, entry: entry("read", { filePath: `${DIR}/src/app.ts`, offset: 0, limit: 6 }, READ_SMALL, "completed", { lineStart: 1, language: "typescript" }) },
    ],
  },
  {
    tool: "write",
    blurb: "new file contents in the shared file card",
    states: [
      { label: "create", entry: entry("write", { filePath: `${DIR}/NOTES.md`, content: "# Notes\n\n- one\n- two" }, "# Notes\n\n- one\n- two", "completed", { language: "markdown" }) },
      { label: "overwrite existing", entry: entry("write", { filePath: `${DIR}/src/app.ts`, content: READ_SMALL }, READ_SMALL, "completed", { language: "typescript" }) },
      { label: "large file (capped)", entry: entry("write", { filePath: `${DIR}/src/generated.ts`, content: READ_LONG }, READ_LONG, "completed", { language: "typescript" }) },
      { label: "failed", entry: entry("write", { filePath: `${DIR}/locked.ts` }, "EACCES: permission denied", "error") },
      { label: "hover (controls)", hover: true, entry: entry("write", { filePath: `${DIR}/NOTES.md`, content: "# Notes\n\n- one" }, "# Notes\n\n- one", "completed", { language: "markdown" }) },
    ],
  },
  {
    tool: "edit",
    blurb: "unified/split via the U|A|S toggle; every diff shape the host emits",
    states: [
      { label: "one changed line (v1 Index-style patch)", entry: entry("edit", { filePath: `${DIR}/src/app.ts` }, "", "completed", editFiles("src/app.ts", PATCH_SINGLE, 2, 1)) },
      { label: "two hunks close together", entry: entry("edit", { filePath: `${DIR}/src/app.ts` }, "", "completed", editFiles("src/app.ts", PATCH_MULTI, 2, 2)) },
      { label: "hunks 50 lines apart (separate blocks)", entry: entry("edit", { filePath: `${DIR}/src/app.ts` }, "", "completed", editFiles("src/app.ts", PATCH_FAR, 3, 2)) },
      { label: "many changes (large diff)", entry: entry("edit", { filePath: `${DIR}/src/big.ts` }, "", "completed", editFiles("src/big.ts", PATCH_LARGE, 4, 3)) },
      { label: "new file (additions only)", entry: entry("edit", { filePath: `${DIR}/src/new.ts` }, "", "completed", editFiles("src/new.ts", PATCH_ADD, 4, 0)) },
      { label: "deletion only", entry: entry("edit", { filePath: `${DIR}/src/dead.ts` }, "", "completed", editFiles("src/dead.ts", PATCH_DELETE, 0, 3)) },
      { label: "failed", entry: entry("edit", { filePath: `${DIR}/src/app.ts`, oldString: "nope", newString: "x" }, "Could not find oldString in the file", "error") },
      { label: "no room to split (narrow column)", narrow: true, entry: entry("edit", { filePath: `${DIR}/src/app.ts` }, "", "completed", editFiles("src/app.ts", PATCH_SINGLE, 2, 1)) },
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
      { label: "completed", entry: entry("subagent", { description: "Explore the repo", subagent_type: "explore", agent: "explore", prompt: "List files" }, "Child session finished: 4 files summarised.", "completed", { sessionID: "ses_preview_child" }) },
      { label: "completed, hover", hover: true, entry: entry("subagent", { description: "Explore the repo", subagent_type: "explore", agent: "explore", prompt: "List files" }, "Child session finished.", "completed", { sessionID: "ses_preview_child" }) },
      { label: "running", entry: entry("subagent", { description: "Refactor layout", subagent_type: "build", agent: "build", prompt: "Move the header" }, "", "running") },
      { label: "running, hover", hover: true, entry: entry("subagent", { description: "Refactor layout", subagent_type: "build", agent: "build", prompt: "Move the header" }, "", "running") },
      { label: "failed", entry: entry("subagent", { description: "Audit security", subagent_type: "explore", agent: "explore", prompt: "Audit" }, "Subagent aborted", "error") },
      { label: "running - combined sweep (explore = blue)", entry: entry("subagent", { description: "Explore the repo", subagent_type: "explore", agent: "explore", prompt: "List files" }, "", "running") },
      { label: "running - combined sweep (general = dark red)", entry: entry("subagent", { description: "Refactor layout", subagent_type: "general", agent: "general", prompt: "Move the header" }, "", "running") },
      { label: "running - combined sweep (unnamed type = next palette slot)", entry: entry("subagent", { description: "Check the build", subagent_type: "verify", agent: "verify", prompt: "Run tests" }, "", "running") },
      { label: "running - animation off (A/B)", subanim: "plain", entry: entry("subagent", { description: "Explore the repo", subagent_type: "explore", agent: "explore", prompt: "List files" }, "", "running") },
      { label: "running, hover (sweep + underline + chevron)", hover: true, entry: entry("subagent", { description: "Explore the repo", subagent_type: "explore", agent: "explore", prompt: "List files" }, "", "running", { sessionID: "ses_preview_child" }) },
    ],
  },
]

// --- message fixtures -------------------------------------------------------
// Whole-message docs rendered through the production projection + row
// renderer (GalleryTimeline): prompts, reasoning, markdown, math, images,
// transcript structures and grouping - the parts the single-tool cards
// above cannot show.
const T0 = Date.now() - 3_600_000
const gUser = (id: string, text: string, minute: number, metadata: Record<string, unknown> = {}) => ({
  id, sessionID: SESSION, role: "user", type: "user", text, metadata,
  time: { created: T0 + minute * 60_000 },
})
const gAssistant = (id: string, minute: number, content: unknown[], extra: Record<string, unknown> = {}) => ({
  id, sessionID: SESSION, role: "assistant", type: "assistant", agent: "build",
  model: { providerID: "zai", id: "glm-5.3" }, content, ...extra,
  time: { created: T0 + minute * 60_000, completed: T0 + (minute + 1) * 60_000 },
})
const gText = (text: string) => ({ type: "text", text })
const gThought = (id: string, text: string) => ({ type: "reasoning", id, text })
const gTool = (id: string, name: string, input: Record<string, unknown>, output: string, metadata: Record<string, unknown> = {}) => ({
  type: "tool", id, name, state: { status: "completed", input, content: [{ type: "text", text: output }], metadata },
})

// real payloads (embedded base64, dev-only module): a deployment logo and
// a rendered OG share card, so the media path is shown on actual images
import { MIRROBOT_PNG, OG_CARD_PNG } from "./preview-assets"

const messageDocs: Array<{ label: string; blurb: string; messages: unknown[] }> = [
  {
    label: "prompts",
    blurb: "bubble vs flat via settings; agent-switch event row; per-prompt model change",
    messages: [
      gUser("g_u1", "Summarise the repository layout in two sentences.", 0),
      gAssistant("g_a1", 1, [gText("Two source roots: the plugin (TUI + engine) and the viewer. The worker and the portable server are backends for the same contract.")]),
      gUser("g_u2", "Switch to plan mode and outline a redesign before touching code.", 4, { agentSwitch: "plan", agent: "plan", model: { id: "glm-5.3-plan", providerID: "zai" } }),
      gAssistant("g_a2", 5, [gText("Plan: keep the two-root layout, extract the shared contract types, then move the settings keys behind one module.")]),
    ],
  },
  {
    label: "reasoning",
    blurb: "compact collapsed thought rows; expand by clicking; durations stay untouched",
    messages: [
      gUser("g_u3", "Why did the flaky test only fail cold?", 10),
      gAssistant("g_a3", 11, [
        gThought("g_t1", "Cold start means the first paint runs before the worker pool is warm. The measurement cache starts empty, so the first estimate is used for layout, then corrected. If a click lands in that window it hits a row that is about to be replaced."),
        gText("The flake was a race between first measurement and first click: the row was remeasured after the click target mounted, so the click landed on stale geometry."),
      ]),
      gUser("g_u4", "Show a long one.", 14),
      gAssistant("g_a4", 15, [
        gThought("g_t2", Array.from({ length: 12 }, (_, i) => `Reasoning paragraph ${i + 1}: the worker pool warms lazily, the virtualizer defers its first measure, and the disclosure store owns open state, so a remount preserves nothing unless keyed.`).join(" ")),
        gText("Long reasoning collapses the same way; expansion is per row."),
      ]),
    ],
  },
  {
    label: "markdown",
    blurb: "headings, lists, tables, quotes, links, inline code - everything prose can carry",
    messages: [
      gUser("g_u5", "Write a markdown kitchen sink.", 20),
      gAssistant("g_a5", 21, [gText(`# Heading one
## Heading two
### Heading three

- bullet one
- bullet two
  - nested bullet
1. ordered one
2. ordered two

| column a | column b | notes |
| --- | --- | --- |
| 1 | 2 | short cell |
| a longer cell | 22 | wraps when the table outgrows the column |

> A blockquote line that stands apart from the flow.

Inline \`code\`, **bold**, *italic*, ~~struck~~, and a [link](https://example.com/docs).

---`)]),
    ],
  },
  {
    label: "code blocks",
    blurb: "min-width floor, cap, wrap; the copy button rides the corner",
    messages: [
      gUser("g_u6", "Show code blocks at every width.", 24),
      gAssistant("g_a6", 25, [
        gText("Tiny block (shows the 18rem floor):"),
        gText("```ts\nconst x = 1\n```"),
        gText("Medium with syntax highlighting:"),
        gText("```python\ndef sieve(limit: int) -> list[int]:\n    flags = [True] * (limit + 1)\n    flags[0] = flags[1] = False\n    for n in range(2, int(limit ** 0.5) + 1):\n        if flags[n]:\n            for m in range(n * n, limit + 1, n):\n                flags[m] = False\n    return [i for i, ok in enumerate(flags) if ok]\n```"),
        gText("A very long line (wrap, not scroll):"),
        gText("```bash\ndocker run --rm -it -e OPENSHARE_WORKER_URL -e OPENSHARE_CREATE_TOKEN -v \"$PWD/work:/work\" -w /work ghcr.io/example/agent:latest opencode run \"review the diff and post findings\"\n```"),
        gText("```json\n{ \"name\": \"openshare\", \"version\": \"0.2.1\", \"private\": true, \"works\": [\"worker\", \"server\", \"viewer\", \"plugin\"] }\n```"),
      ]),
    ],
  },
  {
    label: "math",
    blurb: "katex render: $$display$$ blocks and $inline$ math",
    messages: [
      gUser("g_u7", "Render some math.", 30),
      gAssistant("g_a7", 31, [
        gText("Inline math renders mid-sentence: the discriminant $b^2 - 4ac$ decides the root count, and $E = mc^2$ stays famous."),
        gText("$$\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}$$"),
        gText("$$c = \\pm\\sqrt{a^2 + b^2} \\quad\\text{and}\\quad \\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}$$"),
      ]),
    ],
  },
  {
    label: "images",
    blurb: "markdown image, a written PNG, a read PNG - the card renders media, not base64 soup",
    messages: [
      gUser("g_u8", "Show every way an image can appear.", 34),
      gAssistant("g_a8", 35, [
        gText("An inline markdown image (a deployment logo):"),
        gText(`![mirrobot logo](${MIRROBOT_PNG})`),
        gTool("g_img_write", "write", { filePath: `${DIR}/assets/share-card.png`, content: OG_CARD_PNG.split(",")[1] }, "Wrote the OG share card PNG."),
        gTool("g_img_read", "read", { filePath: `${DIR}/assets/share-card.png` }, OG_CARD_PNG),
        gText("The write created a real PNG (a rendered share card); the read of the same file renders it through the same media path."),
      ]),
    ],
  },
  {
    label: "structures",
    blurb: "compaction divider, retry notice, error finish - the rows between turns",
    messages: [
      gUser("g_u9", "Clean up the workspace.", 40),
      gAssistant("g_a9", 41, [gText("Deleted the stale export files."), gTool("g_rm", "bash", { command: "rm -rf export/" }, "removed 3 files")]),
      { id: "g_compact", sessionID: SESSION, type: "compaction", summary: "Earlier turns compacted: the workspace cleanup finished and the export directory was removed.", time: { created: T0 + 42 * 60_000 } },
      gUser("g_u10", "Continue with the retry story.", 44),
      gAssistant("g_a10", 45, [gText("This attempt failed once and was retried.")], { retry: true }),
      gUser("g_u11", "And an error finish?", 48),
      gAssistant("g_a11", 49, [gText("Never completed.")], { error: { type: "rate_limited", message: "rate limited: retry after 60s" } }),
    ],
  },
  {
    label: "grouping",
    blurb: "one response, four reads - flip Grouping off / custom / all in settings",
    messages: [
      gUser("g_u12", "Read these four files.", 52),
      gAssistant("g_a12", 53, [
        gTool("g_grp_r1", "read", { filePath: `${DIR}/src/one.ts` }, READ_SMALL, { lineStart: 1, language: "typescript" }),
        gTool("g_grp_r2", "read", { filePath: `${DIR}/src/two.ts` }, READ_SMALL, { lineStart: 1, language: "typescript" }),
        gTool("g_grp_r3", "read", { filePath: `${DIR}/src/three.ts` }, READ_SMALL, { lineStart: 1, language: "typescript" }),
        gTool("g_grp_r4", "read", { filePath: `${DIR}/src/four.ts` }, READ_SMALL, { lineStart: 1, language: "typescript" }),
        gText("Four separate reads in one response."),
      ]),
    ],
  },
]

export function Preview() {
  // --- load benchmark ------------------------------------------------------
  // Marks the phases from navigation to "settled" (every tall card measured
  // and chevroned), exposes them as window.__oshBench and renders the corner
  // panel. Dev build, so absolute numbers include vite transforms; the point
  // is catching load REGRESSIONS between rounds, and the probe reads the
  // same object for automation.
  const bench: Record<string, number | string> = { boot: Math.round(performance.now()) }
  ;(window as any).__oshBench = bench
  const [benchDone, setBenchDone] = createSignal<boolean>(false)
  onMount(() => {
    bench.mount = Math.round(performance.now())
    const t0 = Date.now()
    const poll = window.setInterval(() => {
      const stats = (window as any).__oshOutStats ?? { bursts: 0, syncs: 0 }
      const h2s = document.querySelectorAll("h2").length
      let deep = 0
      const walk = (node: ParentNode) => {
        deep += node.querySelectorAll("[data-line]").length
        for (const el of node.querySelectorAll("*")) if ((el as HTMLElement).shadowRoot) walk((el as HTMLElement).shadowRoot!)
      }
      walk(document)
      if (!bench.paint && h2s >= 20 && deep > 100) bench.paint = Math.round(performance.now())
      if (bench.paint && !bench.settle) {
        // the exact regression this bench guards: the first tall read card
        // measured and chevroned without any interaction or reload
        const sec = [...document.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent === "read")
        const row = [...(sec?.querySelectorAll(":scope > div > div") ?? [])].find((r) => r.querySelector(".text-12-regular")?.textContent?.includes("long (capped, scrolls)"))
        const card = row?.querySelector('[data-osh-out="file"]')
        if (card?.hasAttribute("data-osh-clipped")) {
          bench.settle = Math.round(performance.now())
          bench.bursts = stats.bursts
          bench.syncs = stats.syncs
          bench.wallMs = Date.now() - t0
          setBenchDone(true)
          window.clearInterval(poll)
        }
      }
      if (Date.now() - t0 > 40000) {
        bench.error = "timeout"
        setBenchDone(true)
        window.clearInterval(poll)
      }
    }, 120)
    onCleanup(() => window.clearInterval(poll))
  })

  // task cards render their chevron/link affordances only when a child
  // session is reachable; register a no-op nav so the gallery shows them
  setVendoredData(data as any, { sessionHref: () => "#preview-child", navigateToSession: () => {} })
  const [settings, setSettings] = createSignal<OshSettings>(readSettings())
  const [showSettings, setShowSettings] = createSignal(true)
  const [forceHover, setForceHover] = createSignal(false)
  // temp A/B (owner round): kill switch for the running-subagent sweeps,
  // gallery-only, for isolating the FPS cost on real hardware
  const [sweepOff, setSweepOff] = createSignal<boolean>(new URLSearchParams(location.search).get("oshanim") === "off" || document.documentElement.dataset.oshSweep === "off")
  const setSweep = (mode: "on" | "off") => {
    if (mode === "off") document.documentElement.dataset.oshSweep = "off"
    else delete document.documentElement.dataset.oshSweep
    setSweepOff(mode === "off")
  }
  // the URL param initializes the signal; the CSS consumes the attribute
  if (sweepOff()) document.documentElement.dataset.oshSweep = "off"
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
    <>
      <Show when={benchDone()}>
        <div style={{ position: "fixed", right: "10px", bottom: "10px", "z-index": "200", "font-size": "11px", "font-family": "monospace", padding: "6px 9px", background: "color-mix(in srgb, var(--background-base, #111) 88%, transparent)", border: "1px solid var(--border-weak-base, #333)", "border-radius": "8px", color: "var(--text-weaker, #999)", "pointer-events": "none" }}>
          <div>load bench {bench.error ? `(error: ${bench.error})` : ""}</div>
          <div>boot {bench.boot}ms · paint +{typeof bench.paint === "number" ? bench.paint - (bench.boot as number) : "?"}ms · settle +{typeof bench.settle === "number" ? bench.settle - (bench.boot as number) : "?"}ms</div>
          <div>mutation bursts {bench.bursts ?? "?"} · card syncs {bench.syncs ?? "?"}</div>
        </div>
      </Show>
      <div class="osh-gallery flex h-dvh w-full overflow-hidden bg-background-base text-text-base">
      <Show when={showSettings()}>
        <aside class="w-[320px] shrink-0 overflow-y-auto border-r border-border-weak-base px-3 py-3">
          <div class="mb-2 flex items-center justify-between">
            <div class="text-14-medium">Gallery settings</div>
            <button class="text-12-regular text-text-weaker hover:text-text-base" onClick={() => setShowSettings(false)}>hide</button>
          </div>
          <SettingsBody settings={settings()} update={update} branding={{}} search={search()} onSearch={setSearch} sessionTools={groups.map((g) => g.tool)} />
        </aside>
      </Show>
      <main class="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <header class="sticky top-0 z-20 flex items-center gap-3 border-b border-border-weak-base bg-background-base px-5 py-3">
          <div class="text-14-medium">Gallery</div>
          <div class="text-12-regular text-text-weaker">{total()} tool states / {groups.length} tools / {messageDocs.length} feature docs / no share data</div>
          <label class="ml-auto flex items-center gap-2 text-12-regular text-text-weaker">
            <input type="checkbox" checked={forceHover()} onChange={(e) => toggleHover(e.currentTarget.checked)} />
            force hover everywhere
          </label>
          <label class="flex items-center gap-2 text-12-regular text-text-weaker" title="temp A/B: kills the running-subagent sweep animations to isolate the FPS cost">
            <input type="checkbox" checked={sweepOff()} onChange={(e) => setSweep(e.currentTarget.checked ? "off" : "on")} />
            sweeps off (temp A/B)
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
                      <div data-osh-preview-hover={state.hover ? "" : undefined} data-osh-subanim={state.subanim} data-osh-col={state.narrow ? "" : undefined} style={state.narrow ? { "max-width": "38rem" } : undefined}>
                        <div class="mb-1 text-12-regular text-text-weaker">{state.label}</div>
                        <div ref={(el) => {
                          if (state.scrollTo !== "middle") return
                          // pierre paints inside a shadow root at its own
                          // pace and a cold load can outrun any fixed timer
                          // list: retry until the body actually has
                          // somewhere to go, then stop
                          let parked = false
                          const park = () => {
                            if (parked) return true
                            const sc = el.querySelector<HTMLElement>("[data-osh-scroll]")
                            if (sc && sc.scrollHeight > sc.clientHeight + 20) {
                              sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) / 2)
                              parked = true
                              return true
                            }
                            return false
                          }
                          const timers: number[] = []
                          const tick = () => {
                            if (park()) { timers.splice(0).forEach((t) => clearTimeout(t)); return }
                            timers.push(window.setTimeout(tick, 350))
                          }
                          timers.push(window.setTimeout(tick, 400))
                          onCleanup(() => timers.forEach((t) => clearTimeout(t)))
                        }}>
                          <VendoredPart entry={state.entry} settings={allOpen()} data={data} />
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </section>
            )}
          </For>
          <For each={messageDocs}>
            {(doc) => (
              <section>
                <div class="mb-1 flex items-baseline gap-2">
                  <h2 class="text-14-medium">{doc.label}</h2>
                  <span class="text-12-regular text-text-weaker">{doc.blurb}</span>
                </div>
                <div class="border-l-2 border-border-weak-base pl-3">
                  <GalleryTimeline messages={doc.messages} data={data as any} settings={settings()} />
                </div>
              </section>
            )}
          </For>
        </div>
      </main>
    </div>
    </>
  )
}
