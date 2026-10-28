// Vendor the opencode v2 (beta) UI kit into share-viewer/vendor.
// Deterministic + re-runnable; records the source git rev for provenance.
//
//   node scripts/vendor-v2.mjs
//
// Sources (c:\tools\opencode-beta, recorded in vendor/V2-SOURCE.txt):
//   packages/session-ui  -> vendor/session-ui-v2  (@opencode/session-ui)
//   packages/ui          -> vendor/ui-v2          (@opencode/ui)
//   packages/client      -> vendor/client-v2      (@opencode/client, types only)
//   packages/util        -> vendor/util-v2        (@opencode/util, path+encode)
//
// Stories/tests are excluded (storybook/test deps are not vendored).
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync as writeFileImpl, existsSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"

// `--check` runs the whole port into a throwaway directory: every anchor is
// validated against the candidate checkout and no repo file is touched. This
// is the manual canary before an update.
const DRY = process.argv.includes("--check")

const REAL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ROOT = DRY ? mkdtempSync(join(tmpdir(), "osh-vendor-check-")) : REAL_ROOT
const writeFileSync = writeFileImpl
const SRC = process.env.OPENSHARE_BETA_SRC ?? "c:/tools/opencode-beta"

if (!existsSync(join(SRC, "packages/session-ui"))) {
  console.error(`vendor-v2: beta source checkout not found at ${SRC}.`)
  console.error("The vendored tree in this repo builds as-is (npm run build). Re-vendoring needs the opencode-beta checkout (OPENSHARE_BETA_SRC) at a TESTED rev — see vendor/V2-SOURCE.txt.")
  process.exit(1)
}

const rev = execSync("git log -1 --format=%H", { cwd: SRC }).toString().trim()
const describe = execSync("git describe --tags", { cwd: SRC }).toString().trim()
console.log(`vendoring from ${SRC} @ ${describe}`)

const EXCLUDE = /\.(stories|test)\.[ttsx]+$/

const copyTree = (from, to) => {
  rmSync(to, { recursive: true, force: true })
  mkdirSync(to, { recursive: true })
  const walk = (rel) => {
    const abs = join(from, rel)
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const r = join(rel, entry.name)
      if (entry.isDirectory()) walk(r)
      else if (EXCLUDE.test(entry.name)) continue
      else {
        const dest = join(to, r)
        mkdirSync(dirname(dest), { recursive: true })
        cpSync(join(abs, entry.name), dest)
      }
    }
  }
  walk(".")
}

// dependency versions are taken from the beta package itself, resolving
// `catalog:` entries through its workspace catalog (see betaDeps below)
const betaRoot = JSON.parse(readFileSync(join(SRC, "package.json"), "utf8"))
const betaCatalog = betaRoot.workspaces?.catalog ?? betaRoot.catalog ?? {}
const betaDeps = (pkg) => {
  const source = JSON.parse(readFileSync(join(SRC, "packages", pkg, "package.json"), "utf8"))
  return Object.fromEntries(
    Object.entries(source.dependencies ?? {}).map(([name, version]) => [
      name,
      version === "catalog:" ? (betaCatalog[name] ?? version) : version,
    ]),
  )
}

// --- session-ui ---
copyTree(join(SRC, "packages/session-ui/src"), join(ROOT, "vendor/session-ui-v2/src"))
// (the ./tools/tool-renderer export is added in the package.json written below)
// vendor fork: projection.ts groups per ASSISTANT MESSAGE (one response) and
// our explicit detail forces content spacing.
//
// SURGICAL on purpose: upstream's appendAssistantSegment keeps growing
// (thoughtOnly guard, live Thinking row, Retry/Error notices). Replacing the
// whole function dropped those silently when the beta moved from
// v2.0.0-607 to v2.0.0-1105, so we only insert a per-message splitter and
// redirect the two call sites. Re-applied after copyTree; fails loudly if
// upstream anchors drift.
{
  const p = join(ROOT, "vendor/session-ui-v2/src/timeline/projection.ts")
  if (existsSync(p)) {
    let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n")
    const fail = (what) => {
      throw new Error(`vendor-v2: projection fork anchor missing (${what}) - upstream drifted`)
    }
    const nl = "\n"
    const patch = (from, to, what) => {
      const next = s.replace(from, to)
      if (next === s) fail(what)
      s = next
    }

    // openshare fork: row rhythm between messages. ONE guarded unit - the
    // old two-guard encoding silently skipped the whole fork when the module
    // var insert ran first (live-caught: spacing "fixed" repeatedly while
    // the built bundle ran upstream spacing; regen restored the var but not
    // the fork). All anchors throw, so upstream drift is loud.
    if (!s.includes("openshare fork: each segment call starts")) {
      patch(
        /(^import \{ TimelineRow[^\r\n]*\r?\n)/m,
        "$1\n// openshare module: segment marker\nlet openshareSegmentStart = false\n// openshare fork: was the last pushed AssistantPart row a tool row? drives\n// the tool->tool message-break suppression (pure-tool message clusters)\nlet opensharePrevRowTool = false\n",
        "segment marker",
      )
      // insert at the head of appendAssistantSegment; older revs guard
      // thoughtOnly segments first (the marker arms AFTER the guard,
      // matching the tested behavior exactly), newer revs have no guard
      patch(
        /(const appendAssistantSegment = \(messages: SessionMessageAssistant\[\]\) => \{\r?\n)( {6}if \(thoughtOnly\) return\r?\n)?/,
        (m, head, guard) =>
          head +
          (guard ?? "") +
          "      // openshare fork: each segment call starts a NEW assistant message -\n      // its first row gets the \"message\" break (consumed by appendGroups)\n      openshareSegmentStart = true\n\n",
        "segment marker set",
      )
      patch(
        /( {6}appendGroups\(before\)\r?\n)/,
        [
          "      // openshare fork: grouping per assistant message - one response's",
          "      // badge must never absorb another response's tools, and every message",
          "      // boundary re-arms the \"message\" spacing break",
          "      const appendSegments = (items: typeof refs) => {",
          "        let start = 0",
          "        while (start < items.length) {",
          "          const messageID = items[start]!.messageID",
          "          let end = start",
          "          while (end < items.length && items[end]!.messageID === messageID) end += 1",
          "          if (start > 0) openshareSegmentStart = true",
          "          appendGroups(items.slice(start, end))",
          "          start = end",
          "        }",
          "      }",
          "",
          "      appendSegments(before)",
        ].join("\n"),
        "appendGroups(before)",
      )
      patch(/ {8}appendGroups\(after\)/, "        appendSegments(after)", "appendGroups(after)")
      // openshare fork: row rhythm between messages. THREE narrow
      // single-line patches (was ONE 6-line whitespace-exact regex that
      // broke on any upstream reordering - each line below is verified
      // unique in pristine projection.ts).
      patch(
        / {10}const tool = group\.type !== "part" \|\| items\[offset\]\?\.content\.type !== "text"/,
        [
          '          const tool = group.type !== "part" || items[offset]?.content.type !== "text"',
          '          // openshare fork: does this row START with a bare tool call? (a',
          '          // tool group, or a part whose content is a tool) - needed for the',
          '          // tool->tool suppression below',
          '          const firstIsTool = group.type !== "part" || items[offset]?.content.type === "tool"',
        ].join("\n"),
        "assistant firstIsTool",
      )
      patch(
        / {10}offset \+= group\.type === "part" \? 1 : group\.refs\.length/,
        [
          '          offset += group.type === "part" ? 1 : group.refs.length',
          '          // openshare fork: the first row of every assistant message (after',
          "          // the turn's first) carries the \"message\" break - EXCEPT when the",
          '          // previous row ended in a tool call AND this row starts with one',
          '          // (pure-tool messages flow as one action cluster; a break belongs',
          '          // only where the content TYPE changes: tool->reasoning/text)',
          "          const messageStart =",
          "            openshareSegmentStart && assistantGroupIndex > 0 && !(firstIsTool && opensharePrevRowTool)",
          "          openshareSegmentStart = false",
          "          opensharePrevRowTool = firstIsTool",
        ].join("\n"),
        "assistant messageStart",
      )
      patch(
        / {14}spacing: assistantGroupIndex > 0 \? \(previousAssistantTool && tool \? "tool" : "content"\) : undefined,/,
        [
          "              spacing: messageStart",
          '                ? ("message" as const)',
          "                : assistantGroupIndex > 0",
          "                  ? previousAssistantTool && tool",
          '                    ? "tool"',
          '                    : "content"',
          "                  : undefined,",
        ].join("\n"),
        "assistant spacing",
      )
    }

    if (!s.includes("never merge groups across assistant messages")) {
      patch(
        / {6}previous\.userMessageID === current\.userMessageID\r?\n {4}\) \{/,
        [
          "      previous.userMessageID === current.userMessageID &&",
          "      // openshare fork: never merge groups across assistant messages",
          "      previous.group.refs.at(-1)?.messageID === current.group.refs[0]?.messageID",
          "    ) {",
        ].join("\n"),
        "groupMessages guard",
      )
    }

    // a lone tool call is not a group - render it as a normal part row
    if (!s.includes("openshare fork: a lone tool call is not a group")) {
      patch(
        /( {2}flush\(\)\r?\n\r?\n {2}return groups)/,
        `  flush()

  // openshare fork: a lone tool call is not a group - render it as a normal row
  return groups.map((group) =>
    group.type === "context" && group.refs.length === 1
      ? { type: "part" as const, key: \`part:\${group.refs[0]!.messageID}:\${group.refs[0]!.partID}\`, ref: group.refs[0]! }
      : group,
  )`,
        "singleton grouping",
      )
    }

    // a category may refine grouping to specific tools (v1 scope)
    if (!s.includes("a category may refine grouping")) {
      patch(
        /( {4}const category = timelineCategory\(content\)!\r?\n)(\r?\n)?( {4}if \(detail\[category\]\.placement === "grouped"\) return "context")/,
        [
          "    const category = timelineCategory(content)!",
          '    if (detail[category].placement === "grouped") {',
          "      // openshare fork: a category may refine grouping to specific tools",
          "      // (v1 scope grouped reads/searches only; shell/edit kept their rows)",
          "      const only = (detail[category] as { only?: readonly string[] }).only",
          '      if (!only || only.includes(content.name)) return "context"',
          "    }",
        ].join("\n"),
        "toolGroupType grouping refinement",
      )
    }

    // 5) with an explicit detail, a read is never a top-level "read" group:
    //    grouping off must give every read its own expandable row
    if (!s.includes("never a top-level read group")) {
      patch(
        /( {4}if \(currentToolGroupedRead\(content\)\) return "read")/,
        `    // openshare fork: with an explicit detail, never a top-level read group
    if (!detail && currentToolGroupedRead(content)) return "read"`,
        "read group gate",
      )
    }

    // 6) file edits are ordinary rows too: the "file" group renderer
    //    (CurrentFileToolGroup) bypasses ToolRegistry, so our edit/write
    //    card never ran. Let them fall through to ToolDisplay.
    if (!s.includes("never a top-level file group")) {
      patch(
        /( {4}if \(content\.name === "patch" \|\| content\.name === "edit" \|\| content\.name === "write"\) return "file")/,
        `    // openshare fork: never a top-level file group (our edit/write card owns it)`,
        "file group gate",
      )
    }

    // 7) todos are part of a shared session: the app hides them because it
    //    renders a todo dock, a share page has nowhere else to put them
    if (!s.includes("openshare fork: todos are renderable")) {
      patch(
        /( {2}if \(content\.name === "todowrite"\) return false\r?\n)/,
        `  // openshare fork: todos are renderable in a share page\n`,
        "todowrite renderable",
      )
    }

    if (nl === "\r\n") s = s.replace(/\r?\n/g, "\r\n")
    writeFileSync(p, s)
  }
}

// The `timelineDetail` prop we used to fork into session-timeline.tsx is
// upstream's own API as of v2.0.0-1105 (it forwards it to both the
// projection and the row renderer) - no patch needed.

// vendor fork: todo lists belong in the transcript on a share page. The app
// hides them (it renders a todo dock instead), but ToolDisplay returns null
// BEFORE consulting the registry, so no override can ever see them.
{
  const p = join(ROOT, "vendor/session-ui-v2/src/tools/tool-renderer.tsx")
  if (existsSync(p)) {
    let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n")
    if (!s.includes("openshare fork: todos render in the transcript")) {
      const before = s
      s = s.replace(
        /  if \(props\.tool === "todowrite"\) return null/,
        '  // openshare fork: todos render in the transcript (the app hides them here)',
      )
      if (s === before) throw new Error("vendor-v2: todowrite anchor missing - upstream drifted")
      writeFileSync(p, s)
    }
  }
}

// vendor fork: the markdown projection resource must not reject when the
// worker is unavailable (offline snapshot files on file://) — the fetcher
// falls back to the escaped-text projection instead of erroring the
// resource into the render boundary.
{
  const p = join(ROOT, "vendor/session-ui-v2/src/components/markdown.tsx")
  if (existsSync(p)) {
    let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n")
    if (!s.includes("openshare fork: a worker-less environment")) {
      const before = s
      s = s.replace(
        /    \(src\) => projectMarkdown\(src\.key, src\.text, src\.live\),/,
        `    (src) =>\n      // openshare fork: a worker-less environment (offline snapshot file\n      // on file://) rejects — render the escaped-text projection instead\n      // of letting the resource error reach the boundary\n      projectMarkdown(src.key, src.text, src.live).catch(() => completedProjection(src.text)),`,
      )
      if (s === before) throw new Error("vendor-v2: markdown.tsx projection fetcher anchor missing - upstream drifted")
      writeFileSync(p, s)
    }
  }
}

// vendor fork: the markdown worker's unavailable-throw is synchronous —
// parseMarkdown/projectMarkdown/highlightStreamingCode must REJECT so
// consumers take their fallback paths instead of the render boundary
// dying mid-effect (offline snapshot files run from file://, where
// Worker construction throws SecurityError).
{
  const p = join(ROOT, "vendor/session-ui-v2/src/components/markdown-worker.ts")
  if (existsSync(p)) {
    // normalize to LF: the guard insert anchors on a literal \n line, and
    // upstream files are CRLF — a missed replace wrote the call-site
    // patches WITHOUT the guard (half-applied fork, typecheck-caught)
    let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n")
    if (!s.includes("openshare fork: getWorker() THROWS synchronously")) {
      const before = s
      const guard = `// openshare fork: getWorker() THROWS synchronously once the worker is\n// known-unavailable (offline snapshot files run from file://, where\n// Worker construction throws SecurityError). The exports below turn\n// that throw into a normal promise rejection so consumers take their\n// fallback paths instead of the render boundary dying mid-effect.\nfunction workerOrNull(): Worker | null {\n  try {\n    return getWorker()\n  } catch {\n    return null\n  }\n}\n\n`
      s = s.replace("export function parseMarkdown(text: string, signal: AbortSignal) {\n", guard + "export function parseMarkdown(text: string, signal: AbortSignal) {\n")
      s = s.replace(
        /  if \(signal\.aborted\) return Promise\.reject\(new MarkdownWorkerDisposedError\(\)\)\r?\n  const instance = getWorker\(\)/,
        `  if (signal.aborted) return Promise.reject(new MarkdownWorkerDisposedError())\n  const instance = workerOrNull()\n  if (!instance) return Promise.reject(new MarkdownWorkerUnavailableError("markdown worker unavailable"))`,
      )
      s = s.replace(
        /export function projectMarkdown\(key: string, text: string, live: boolean\) \{\r?\n  getWorker\(\)/,
        `export function projectMarkdown(key: string, text: string, live: boolean) {\n  if (!workerOrNull()) return Promise.reject(new MarkdownWorkerUnavailableError("markdown worker unavailable"))\n  getWorker()`,
      )
      s = s.replace(
        /export function highlightStreamingCode\(key: string, text: string, language: string, complete = false\) \{\r?\n  getWorker\(\)/,
        `export function highlightStreamingCode(key: string, text: string, language: string, complete = false) {\n  if (!workerOrNull()) return Promise.reject(new MarkdownWorkerUnavailableError("markdown worker unavailable"))\n  getWorker()`,
      )
      if (s === before) throw new Error("vendor-v2: markdown-worker anchors missing - upstream drifted")
      writeFileSync(p, s)
    }
  }
}

// vendor fork: the markdown worker's unavailable-throw is synchronous —
// startMarkdown must defer the call into its promise chain so the
// rejection lands on consumers' escaped-text fallback instead of killing
// the render boundary (offline snapshot files run from file://, where
// Worker construction throws SecurityError).
{
  const p = join(ROOT, "vendor/session-ui-v2/src/components/markdown-cache.tsx")
  if (existsSync(p)) {
    let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n")
    if (!s.includes("openshare fork: parseMarkdown THROWS synchronously")) {
      const before = s
      s = s.replace(
        /  const promise = parseMarkdown\(block\.src, controller\.signal\)\r?\n    \.then\(\(html\) => \{/,
        `  // openshare fork: parseMarkdown THROWS synchronously when the worker is\n  // unavailable (offline snapshot files run from file://, where Worker\n  // construction throws) — deferring the call turns that throw into a\n  // normal rejection so consumers take the escaped-text fallback instead\n  // of the render boundary\n  const promise = Promise.resolve()\n    .then(() => parseMarkdown(block.src, controller.signal))\n    .then((html) => {`,
      )
      if (s === before) throw new Error("vendor-v2: markdown-cache startMarkdown anchor missing - upstream drifted")
      writeFileSync(p, s)
    }
  }
}

// vendor fork: pierre's worker pool must not kill the page when Workers
// are unavailable (offline snapshot files run from file://, where Worker
// construction throws SecurityError synchronously). A failed pool
// degrades highlighting/diffs to plain text instead. Whole-function
// replacement: every line of the original body moves inside the try.
{
  const p = join(ROOT, "vendor/session-ui-v2/src/pierre/worker.ts")
  if (existsSync(p)) {
    let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n")
    if (!s.includes("openshare fork: offline snapshot files run from file://")) {
      const before = s
      // generic body match (works across upstream revisions: the options
      // object changed between them); the matched body is RE-INDENTED into
      // the try instead of being hardcoded, so upstream changes ride along
      const m = /function createPool\(lineDiffType: "none" \| "word-line"\) \{\r?\n([\s\S]*?)\r?\n  return pool\r?\n\}/.exec(s)
      if (!m) throw new Error("vendor-v2: pierre worker.ts createPool anchor missing - upstream drifted")
      const body = m[1]
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => (line.trim() ? "  " + line : line))
        .join("\n")
        .replace("void pool.initialize()", "void pool.initialize().catch((e) => console.warn(\\"[openshare] pierre pool init failed; code renders plain\\", e))")
      const fork = `function createPool(lineDiffType: "none" | "word-line"): WorkerPoolManager | undefined {\n  // openshare fork: offline snapshot files run from file://, where Worker\n  // construction throws SecurityError synchronously — a failed pool must\n  // degrade rendering to plain text, not kill the whole page\n  try {\n${body}\n\n    return pool\n  } catch {\n    return undefined\n  }\n}`
      s = s.replace(m[0], fork)
      if (s === before) throw new Error("vendor-v2: pierre worker.ts createPool fork failed")
      writeFileSync(p, s)
    }
  }
}

// vendor fork: keep the token colours the previous (shiki) engine produced.
// The kit's Zed palette maps a few token classes differently from the
// TextMate scopes the old build tokenized through, so a plain code read
// changed hue after the engine switch: punctuation went from body text to a
// dim grey, JSON/property keys from the primitive hue to the variable one,
// and markdown headings from the info hue to the keyword one.
{
  const p = join(ROOT, "vendor/ui-v2/src/context/highlight-theme.tsx")
  if (existsSync(p)) {
    let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n")
    if (!s.includes('punctuation: "text-base"')) {
      const before = s
      s = s
        .replace('      punctuation: "syntax-punctuation",', '      punctuation: "text-base",')
        .replace('      property: "syntax-variable",', '      property: "syntax-primitive",')
        .replace('      title: { color: "syntax-keyword", font_weight: 700 },', '      title: { color: "syntax-info", font_weight: 700 },')
      if (s === before) throw new Error("vendor-v2: highlight-theme anchor missing - upstream drifted")
      writeFileSync(p, s)
    }
  }
}

// vendor fork: file-change tools never merge with each other inside a
// context group (owner directive 2026-10-24: grouping groups individual
// tools; edit/write/patch each render as their own expandable card - the
// merged CurrentFileToolGroup showed one aggregate row for N edits with
// broken expansion). Literal anchors; throws on upstream drift.
{
  const p = join(ROOT, "vendor/session-ui-v2/src/tools/tool-renderer.tsx")
  if (existsSync(p)) {
    let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n")
    if (!s.includes("openshare fork: file-change tools NEVER merge")) {
      const nl = "\n"
      const A = ["      if (isFileChangeTool(tool) && Array.isArray(previous) && previous[0] && isFileChangeTool(previous[0])) {", "        previous.push(tool)", "", "        return groups", "      }"].join(nl)
      const B = ["      // openshare fork: file-change tools NEVER merge with each other -", "      // each edit/write/patch renders as its own expandable card inside", "      // the group, exactly like every other tool (owner directive)", "      if (isFileChangeTool(tool)) {", "        groups.push([tool])", "", "        return groups", "      }"].join(nl)
      if (!s.includes(A)) throw new Error("vendor-v2: file-tools-merge anchor missing - upstream drifted")
      s = s.replace(A, B)
      writeFileSync(p, s)
    }
  }
}

// vendor fork: grouped rows all EXPAND. Upstream renders glob/grep/list
// inside a context group as a STATIC trigger row (no Collapsible at all -
// live-caught: grouped searches could never expand) and file-change tools
// as an aggregate CurrentFileToolGroup accordion. Both branches now fall
// through to ToolDisplay + our registry renderers: real expandable bodies,
// patch diffs, per-card toggles (owner directive: grouping groups
// individual tools, each one expands like its ungrouped self).
{
  const p = join(ROOT, "vendor/session-ui-v2/src/tools/tool-renderer.tsx")
  if (existsSync(p)) {
    let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n")
    if (!s.includes("openshare fork: glob/grep/list expand like every other grouped tool")) {
      const A = 'when={tool().state.status !== "error" && ["glob", "grep", "list"].includes(tool().name)}'
      const B = 'when={false /* openshare fork: glob/grep/list expand like every other grouped tool - the upstream static trigger row has NO collapsible, so grouped searches could never expand (live-caught). ToolDisplay + our registry renderers give them real bodies. The static-row markup below stays unreachable for reference. */}'
      if (!s.includes(A)) throw new Error("vendor-v2: glob/grep static-row anchor missing - upstream drifted")
      s = s.replace(A, B)
      const C = "when={isFileChangeTool(tool())}"
      const D = 'when={false /* openshare fork: file-change tools render as their own ToolDisplay cards (owner directive: grouping groups individual tools) - CurrentFileToolGroup is an aggregate accordion that does not fit single edit/write cards with patch diffs */}'
      if (!s.includes(C)) throw new Error("vendor-v2: file group render anchor missing - upstream drifted")
      s = s.replace(C, D)
      writeFileSync(p, s)
    }
  }
}

// vendor fork: reads keep their own renderer so their output can expand.
// Upstream (fresh) routes every `read` inside a context group into
// CurrentReadToolGroup, whose expanded state only lists filenames; and a
// detail-less read becomes a top-level "read" group. Our share pages want
// the file body available, so: reads use the ordinary ToolDisplay row
// (which our viewer overrides), inside groups and outside them.
{
  const p = join(ROOT, "vendor/session-ui-v2/src/tools/tool-renderer.tsx")
  if (existsSync(p)) {
    let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n")
    if (!s.includes("openshare fork: reads stay ordinary rows")) {
      const before = s
      s = s.replace(
        / {26}when=\{!currentToolGroupedRead\(tool\(\)\)\}/,
        `                          when={true /* openshare fork: reads stay ordinary rows so their output can expand */}`,
      )
      if (s === before) throw new Error("vendor-v2: context read-group anchor missing - upstream drifted")
      writeFileSync(p, s)
    }
  }
}

// vendor fork: reads no longer MERGE inside a context group. Upstream
// collapses consecutive reads into one inner array, rendered as the inline
// CurrentReadToolGroup subtitle row - but our forks bypass that renderer,
// so the merged array flows into a single ToolDisplay row that shows only
// group()[0] (live-caught: "Used 4 Read" expanded to one row, three reads
// invisible). Reads render as individual expandable rows, like every other
// grouped tool (owner directive: grouping groups individual tools).
{
  const p = join(ROOT, "vendor/session-ui-v2/src/tools/tool-renderer.tsx")
  if (existsSync(p)) {
    let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n")
    if (!s.includes("openshare fork: reads no longer merge inside a context group")) {
      const nl = "\n"
      const A = [
        "      if (",
        "        currentToolGroupedRead(tool) &&",
        "        Array.isArray(previous) &&",
        "        previous[0] &&",
        "        currentToolGroupedRead(previous[0])",
        "      ) {",
        "        previous.push(tool)",
        "",
        "        return groups",
        "      }",
      ].join(nl)
      const B = [
        "      // openshare fork: reads no longer merge inside a context group -",
        "      // the merged array rendered through one ToolDisplay row showing",
        "      // only the first tool (live-caught: \"Used 4 Read\" expanded to a",
        "      // single row). Reads stay individual expandable rows, like every",
        "      // other grouped tool (owner directive). CurrentReadToolGroup is",
        "      // bypassed below either way.",
      ].join(nl)
      if (!s.includes(A)) throw new Error("vendor-v2: read-merge anchor missing - upstream drifted")
      s = s.replace(A, B)
      writeFileSync(p, s)
    }
  }
}

// vendor fork: the subagent hover hint as a REAL element. The hint needs
// to carve room below the card without touching the card's bordered box;
// CSS-only attempts (:has() on ancestors, ::after on wrappers) broke in
// views whose nesting differs (flex-row trigger containers put the
// pseudo-element mid-page). A wrapper div + span element is deterministic
// in every view: the wrap is a block flex-item, the hint sits in-flow
// under the card, height-animated from 0 (app.css styles it).
{
  const p = join(ROOT, "vendor/session-ui-v2/src/tools/tool-renderer.tsx")
  if (existsSync(p)) {
    let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n")
    if (!s.includes("osh-task-wrap")) {
      const nl = "\n"
      // upstream reformatted the card div between revs (multi-line vs
      // single-line attributes) — match either shape
      const openA = s.includes('    const trigger = () => (\n      <div data-component="task-tool-card">')
        ? ['    const trigger = () => (', '      <div data-component="task-tool-card">'].join(nl)
        : ['    const trigger = () => (', '      <div', '        data-component="task-tool-card"'].join(nl)
      const openB = openA.replace(
        /(      <div)/,
        [
          "      // openshare fork: .osh-task-wrap carries the in-flow hint below the",
          '      // card (app.css: height 0 -> 22px on hover; the card box never grows)',
          '      <div class="osh-task-wrap">',
          "$1",
        ].join(nl),
      )
      // close anchor rides the task-unique `delegating()` Show that follows
      const closeA = ["      </div>", "    )", "", "    return (", "      <Show", "        when={delegating()}"].join(nl)
      const closeB = [
        "      </div>",
        "      </div>",
        "    )",
        "",
        "    return (",
        "      <Show",
        "        when={delegating()}",
      ].join(nl)
      if (!s.includes(openA)) throw new Error("vendor-v2: task trigger open anchor missing - upstream drifted")
      if (!s.includes(closeA)) throw new Error("vendor-v2: task trigger close anchor missing - upstream drifted")
      s = s.replace(openA, openB).replace(closeA, closeB)
      writeFileSync(p, s)
    }
  }
}

// vendor fork: grouped task rows label the agent that ACTUALLY ran.
// Upstream's toolTitle switch ignores the task input's agent entirely
// (always ui.tool.agent.default). The viewer's fold (subagent-map.ts)
// rewrites part.input.agent from the plugin-stamped metadata.agent
// (authoritative) or the old-share fallback; subagent_type stays as a
// last-resort fallback. The task ROW itself reads the agent natively
// since v2.0.18 (taskAgentName at the call site).
{
  const p = join(ROOT, "vendor/session-ui-v2/src/tools/tool-renderer.tsx")
  if (existsSync(p)) {
    let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n")
    if (!s.includes("openshare fork: grouped label prefers the stamped agent")) {
      const before = s
      // two upstream shapes: the ternary in the group label (older revs)
      // and the toolTitle switch case (newer revs)
      s = s.replace(
        /    case "subagent":\r?\n      return i18n\.t\("ui\.tool\.agent\.default"\)/,
        '    case "subagent":\n      // openshare fork: grouped label prefers the stamped agent (the fold\n      // rewrites state.input.agent from metadata.agent)\n      return taskAgentName((tool as any).state?.input?.agent ?? (tool as any).state?.input?.subagent_type, undefined) ?? i18n.t("ui.tool.agent.default")',
      )
      s = s.replace(
        /: part\.name === "subagent"\r?\n\s*\? i18n\.t\("ui\.tool\.agent\.default"\)/,
        ': part.name === "subagent"\n                  // openshare fork: grouped label prefers the stamped agent\n                  // (fold rewrites state.input.agent from metadata.agent)\n                  ? taskAgent((part as any).state?.input?.agent ?? (part as any).state?.input?.subagent_type, undefined).name ?? i18n.t("ui.tool.agent.default")',
      )
      if (s === before) throw new Error("vendor-v2: grouped agent label anchor missing - upstream drifted")
      writeFileSync(p, s)
    }
  }
}

// vendor fork: the generic fallback (mcp tools, plugin tools like ctx_*)
// showed only "Called <tool>" and its input summary - the OUTPUT was dropped,
// so those calls were unreadable on a share page.
{
  const p = join(ROOT, "vendor/session-ui-v2/src/components/basic-tool.tsx")
  if (existsSync(p)) {
    let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n")
    if (!s.includes("openshare fork: generic tools show output")) {
      let before = s
      s = s.replace(/export function GenericTool\(props: \{[^}]*\}\) \{/, (m) =>
        m.replace(
          /input\?: (GenericToolInput|Record<string, unknown>)/,
          "input?: $1\n  /** openshare fork: generic tools show output */\n  output?: string\n  metadata?: Record<string, unknown>",
        ),
      )
      if (s === before) throw new Error("vendor-v2: GenericTool signature anchor missing")
      before = s
      // openshare fork: generic rows read like shell rows - BOLD tool name
      // as the title ("ctx_reduce"), args stay in subtitle/args slots
      s = s.replace('title: i18n.t("ui.basicTool.called", { tool: props.tool }),', "title: props.tool,")
      if (s === before) throw new Error("vendor-v2: GenericTool title anchor missing")
      before = s
      s = s.replace(/(\r?\n      hideDetails=\{props\.hideDetails\}\r?\n    \/>\r?\n  \)\r?\n\})/, `
      hideDetails={props.hideDetails}
    >
      <Show when={typeof props.output === "string" && props.output}>
        <pre data-component="tool-output" data-scrollable tabIndex={0} class="osh-pre">
          {props.output}
        </pre>
      </Show>
    </BasicTool>
  )
}`)
      if (s === before) throw new Error("vendor-v2: GenericTool body anchor missing")
      writeFileSync(p, s)
    }
  }
}

// vendor fork: the row spacing union gains "message" - the break between two
// assistant messages inside one turn (v1 separated responses; so do we).
{
  const p = join(ROOT, "vendor/session-ui-v2/src/timeline/timeline-row.ts")
  if (existsSync(p)) {
    let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n")
    if (!s.includes("openshare fork: message spacing")) {
      const before = s
      s = s
        .split('spacing?: "tool" | "content"')
        .join('spacing?: "tool" | "content" | "message" /* openshare fork: message spacing */')
      if (s === before) throw new Error("vendor-v2: spacing type anchor missing - upstream drifted")
      writeFileSync(p, s)
    }
  }
}

// Row rhythm: upstream emits BOTH the pt-2/pt-4 classes AND the
// data-timeline-spacing attribute on the same element. share-viewer's
// app.css keys the rhythm on the attribute with UNLAYERED rules, which
// beat tailwind's @layer utilities in the cascade regardless of
// specificity - so no class-removal fork is needed here (app.css scans
// the vendor trees via @source, the classes are generated but lose).
{
  const p = join(ROOT, "vendor/session-ui-v2/src/timeline/session-timeline-row.tsx")
  if (existsSync(p)) {
    // openshare fork: agent transition chip on user rows (renders the
    // plugin-stamped metadata.agentSwitch, never computes anything)
    {
      let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n")
      if (!s.includes("osh-agent-switch")) {
        const before = s
        s = s.replace(
          /(\r?\n\s*<div data-slot="session-turn-message-content" aria-live="off">\r?\n)(\s*<SessionUserMessage)/,
          `$1                    {/* openshare fork: agent transition EVENT ROW - the plugin
                        stamps metadata.agentSwitch on prompts whose segment
                        runs a different agent than the previous one; the
                        viewer renders the stamp, nothing more */}
                    <Show when={(message() as any).metadata?.agentSwitch}>
                      {(agent) => (
                        <div data-component="osh-agent-switch" role="note">
                          <span class="osh-as-label">
                            <span class="osh-as-arrow">⇄</span>
                            <span>switched to</span>
                            <span class="osh-as-agent">{String(agent())}</span>
                          </span>
                        </div>
                      )}
                    </Show>
$2`,
        )
        if (s === before) throw new Error("vendor-v2: user row anchor missing - upstream drifted")
        writeFileSync(p, s)
      }
    }

    // openshare fork: per-tool-name default-open input (the viewer's
    // auto-expand checkbox list) consulted BEFORE the category booleans,
    // in the content default-open and the shell row's defaultOpen.
    // nl-aware: the anchors use the file's own EOL so regeneration works
    // on LF checkouts too (was hardcoded \r\n - a portability bug).
    {
      let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n")
      if (!s.includes("openshare fork: the viewer's per-tool auto-expand list wins first")) {
        const nl2 = s.includes("\r\n") ? "\r\n" : "\n"
        const before = s
        s = s.replace(
          ["  editToolDefaultOpen: Accessor<boolean>"].join(nl2),
          ["  editToolDefaultOpen: Accessor<boolean>", "  /** openshare fork: per-tool-name default-open (the viewer's auto-expand", "   *  checkbox list). Consulted BEFORE the category booleans; undefined =", "   *  fall through to the kit's own logic. */", "  toolDefaultOpen?: (tool: { name: string }) => boolean | undefined"].join(nl2),
        )
        s = s.replace(
          ["  function contentDefaultOpen(item: SessionMessageAssistant[\"content\"][number]) {", "    if (input.timelineDetail) {"].join(nl2),
          ["  function contentDefaultOpen(item: SessionMessageAssistant[\"content\"][number]) {", "    // openshare fork: the viewer's per-tool auto-expand list wins first", "    if (item.type === \"tool\" && input.toolDefaultOpen) {", "      const custom = input.toolDefaultOpen(item)", "      if (custom !== undefined) return custom", "    }", "    if (input.timelineDetail) {"].join(nl2),
        )
        s = s.replace(
          ["    const defaultOpen = createMemo(() => {", "      if (!input.timelineDetail) return input.shellToolDefaultOpen()"].join(nl2),
          ["    const defaultOpen = createMemo(() => {", "      // openshare fork: the viewer's per-tool auto-expand list wins first", "      if (input.toolDefaultOpen) {", "        const custom = input.toolDefaultOpen({ name: \"shell\" })", "        if (custom !== undefined) return custom", "      }", "      if (!input.timelineDetail) return input.shellToolDefaultOpen()"].join(nl2),
        )
        if (s === before) throw new Error("vendor-v2: toolDefaultOpen anchors missing - upstream drifted")
        writeFileSync(p, s)
      }
    }
  }

  // vendor fork (markdown.tsx): paragraph-SHAPED fallback. Upstream's
  // fallback() joined the whole text with <br>, so a paragraph break
  // rendered as a full blank LINE while ready markdown uses
  // p { margin-bottom: 12px } - the fallback->ready swap visibly snapped
  // spacing (live-caught "reasoning snap"). The fork emits real <p> chunks
  // with <br> soft breaks: metrically identical to the parsed result.
  {
    const p = join(ROOT, "vendor/session-ui-v2/src/components/markdown.tsx")
    if (existsSync(p)) {
      let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n")
      if (!s.includes("openshare fork: paragraph-SHAPED fallback")) {
        const nl = "\n"
        const A = ["function fallback(markdown: string) {", '  return escape(markdown).replace(/\\r\\n?/g, "\\n").replace(/\\n/g, "<br>")', "}"].join(nl)
        const B = [
          "function fallback(markdown: string) {",
          "  // openshare fork: paragraph-SHAPED fallback (live-caught \"reasoning",
          "  // snap\"): upstream joined everything with <br>, so a paragraph break",
          "  // (\\n\\n) rendered as a full blank LINE while the ready markdown uses",
          "  // p { margin-bottom: 12px } - visibly tighter, and the fallback->ready",
          "  // swap snapped the spacing. Emit real <p> chunks with <br> soft breaks",
          "  // so the fallback is metrically identical to the parsed result.",
          "  const esc = (s: string) =>",
          '    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")',
          "  return esc(markdown)",
          '    .replace(/\\r\\n?/g, "\\n")',
          "    .split(/\\n{2,}/)",
          '    .map((chunk) => `<p>${chunk.replace(/\\n/g, "<br>")}</p>`)',
          '    .join("")',
          "}",
        ].join(nl)
        if (!s.includes(A)) throw new Error("vendor-v2: markdown fallback anchor missing - upstream drifted")
        s = s.replace(A, B)
        writeFileSync(p, s)
      }
    }
  }

  // vendor fork (message-content): reasoning bodies mount ON EXPAND, and
  // Markdown deferUntilReady shows NOTHING until the markdown worker
  // parses the whole blob (live-caught: visible blank beat on a 12s
  // thought; minutes-long reasoning would be a long empty wait). The
  // fork adds a `defer` prop to PacedMarkdown (default true = unchanged
  // for load-time text) and passes defer={false} from the reasoning
  // call site only: instant plain fallback, rich markdown swaps in when
  // the worker completes.
  {
    const p = join(ROOT, "vendor/session-ui-v2/src/message/message-content.tsx")
    if (existsSync(p)) {
      let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n")
      if (!s.includes("openshare fork: `defer` defaults true")) {
        const before = s
        s = s.replace(
          "function PacedMarkdown(props: { text: string; cacheKey: string; streaming: boolean }) {",
          "function PacedMarkdown(props: { text: string; cacheKey: string; streaming: boolean; defer?: boolean }) {",
        )
        s = s.replace(
          "<Markdown text={value()} cacheKey={props.cacheKey} streaming={props.streaming} deferUntilReady />",
          "<Markdown text={value()} cacheKey={props.cacheKey} streaming={props.streaming} deferUntilReady={props.defer !== false} />",
        )
        s = s.replace(
          '<PacedMarkdown text={props.content.text} cacheKey={props.id} streaming={props.streaming} />',
          '<PacedMarkdown text={props.content.text} cacheKey={props.id} streaming={props.streaming} defer={false} />',
        )
        // (a hidden "prewarm" copy while collapsed was tried and deleted:
        // collapsed bodies unmount inside Collapsible.Content, so the
        // prewarm unmounted with them and never prewarmed anything - it
        // was a no-op; defer={false} is the entire snap fix)
        if (s === before) throw new Error("vendor-v2: message-content anchors missing - upstream drifted")
        writeFileSync(p, s)
      }
    }
  }
}

// Inline line virtualization must use the transcript's bounded viewport.
// pierre's inline file virtualizer picked the nearest overflowY ancestor
// as its scroll root - a horizontal tool-output wrapper - so line
// virtualization inside large files misbehaved (wrong scroll root, wrong
// content target). The fork prefers the transcript viewport element and
// the transcript content node, and file.tsx drops its now-duplicate
// scrollParent walker in favor of the shared one.
{
  let p = join(ROOT, "vendor/session-ui-v2/src/pierre/virtualizer.ts")
  let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n")
  const patch = (from, to) => {
    const next = s.replace(from, to)
    if (next === s) throw new Error(`vendor-v2: transcript viewport anchor missing in ${p}`)
    s = next
  }
  if (!s.includes("openshare fork: use the transcript viewport")) {
    patch(
      "function scrollRoot(container: HTMLElement) {",
      `export function scrollRoot(container: HTMLElement) {
  // openshare fork: use the transcript viewport, not horizontal tool wrappers.
  const transcript = container.closest<HTMLElement>("[data-transcript-scroll]")
  if (transcript) return transcript`,
    )
    patch(
      `root.querySelector("[role='log']")`,
      `root.querySelector("[data-transcript-content], [role='log']")`,
    )
    writeFileSync(p, s)
  }

  p = join(ROOT, "vendor/session-ui-v2/src/components/file.tsx")
  s = readFileSync(p, "utf8").replace(/\r\n/g, "\n")
  if (!s.includes("scrollRoot as scrollParent")) {
    // import anchor is member-agnostic (upstream adds/removes named
    // exports from pierre/virtualizer between revisions)
    patch(
      /import \{ ([^}]*) \} from "\.\.\/pierre\/virtualizer"/,
      (m, members) => m.replace(members, members.includes("scrollRoot") ? members : `scrollRoot as scrollParent, ${members}`),
    )
    patch(/function scrollParent\(el: HTMLElement\): HTMLElement \| undefined \{[\s\S]+?\n\}\n\n/, "")
    writeFileSync(p, s)
  }
}

writeFileSync(
  join(ROOT, "vendor/session-ui-v2/package.json"),
  JSON.stringify(
    {
      name: "@opencode/session-ui",
      version: "2.0.18-vendor",
      private: true,
      type: "module",
      license: "MIT",
      // exports map copied verbatim from the beta package (minus
      // ./storybook) — explicit paths, no directory-index guessing
      exports: {
        "./actions": "./src/actions.ts",
        "./document": "./src/document.ts",
        "./message": "./src/message/current-message.tsx",
        "./timeline/projection": "./src/timeline/projection.ts",
        "./timeline/detail": "./src/timeline/detail.ts",
        "./timeline/row": "./src/timeline/session-timeline-row.tsx",
        "./timeline": "./src/timeline/session-timeline.tsx",
        "./basic-tool": "./src/components/basic-tool.tsx",
        "./dock-prompt": "./src/components/dock-prompt.tsx",
        "./file": "./src/components/file.tsx",
        "./file-media": "./src/components/file-media.tsx",
        "./file-search": "./src/components/file-search.tsx",
        "./file-ssr": "./src/components/file-ssr.tsx",
        "./line-comment": "./src/components/line-comment.tsx",
        "./line-comment-annotations": "./src/components/line-comment-annotations.tsx",
        "./markdown": "./src/components/markdown.tsx",
        "./message-part": "./src/components/message-part.tsx",
        "./message-nav": "./src/components/message-nav.tsx",
        "./session-review": "./src/components/session-review.tsx",
        "./session-retry": "./src/components/session-retry.tsx",
        "./tool-count-label": "./src/components/tool-count-label.tsx",
        // our viewer imports ToolDisplay for the custom views; upstream
        // does not export the tool renderer
        "./tools/tool-renderer": "./src/tools/tool-renderer.tsx",
        "./tool-count-summary": "./src/components/tool-count-summary.tsx",
        "./tool-error-card": "./src/components/tool-error-card.tsx",
        "./tool-status-title": "./src/components/tool-status-title.tsx",
        "./session-diff": "./src/components/session-diff.ts",
        "./message-file": "./src/components/message-file.ts",
        "./attachment-card": "./src/message/attachment-card.tsx",
        "./comment-card": "./src/message/comment-card.tsx",
        "./markdown-stream": "./src/components/markdown-stream.ts",
        "./markdown-cache": "./src/components/markdown-cache.tsx",
        "./line-comment-styles": "./src/components/line-comment-styles.ts",
        "./pierre": "./src/pierre/index.ts",
        "./pierre/*": "./src/pierre/*.ts",
        "./context": "./src/context/index.ts",
        "./context/*": "./src/context/*.tsx",
        "./styles": "./src/styles/index.css",
        "./v2/*.css": "./src/v2/components/*.css",
        "./v2/*": "./src/v2/components/*.tsx",
      },
      // dependency versions come from the BETA, with `catalog:` entries
      // resolved through its workspace catalog. Hardcoding them went stale
      // the moment the beta moved (v2.0.0-607 -> -1105 bumped
      // @pierre/diffs to 1.5.1, whose generics the new sources require).
      dependencies: {
        ...betaDeps("session-ui"),
        "@opencode/client": "file:../client-v2",
        "@opencode/ui": "file:../ui-v2",
        "@opencode/util": "file:../util-v2",
        // only when the vendored tree exists (newer betas only)
        ...(existsSync(join(ROOT, "vendor/patchmark-v2")) ? { "@opencode/patchmark": "file:../patchmark-v2" } : {}),
      },
    },
    null,
    2,
  ),
)

// --- ui ---
copyTree(join(SRC, "packages/ui/src"), join(ROOT, "vendor/ui-v2/src"))

// (en locale: the kit's group label reads ui.tool.todos for todowrite
// rows, but upstream en.ts ships without the key. The key is merged in
// the viewer's OWN dictionary at src/entry.tsx - a vendor fork is not
// needed for an i18n key, the provider's t() resolves it. Report filed
// for the upstream bug: raw key on the page, live-caught as
// "Used 3 ui.tool.todos, Shell, Glob".)
// styles live under src/styles in the beta (no separate styles dir)
{
  // exports map copied verbatim from the beta package — per-component
  // explicit paths across src subdirectories, no guessing
  const srcPkg = JSON.parse(readFileSync(join(SRC, "packages/ui/package.json"), "utf8"))
  writeFileSync(
    join(ROOT, "vendor/ui-v2/package.json"),
    JSON.stringify(
      {
        name: "@opencode/ui",
        version: "2.0.18-vendor",
        private: true,
        type: "module",
        license: "MIT",
        sideEffects: srcPkg.sideEffects ?? ["**/*.css"],
        exports: { ...srcPkg.exports, "./logo": "./src/components/logo.tsx", "./provider-icon": "./src/components/provider-icon.tsx" },
        dependencies: {
          // same rule as session-ui: take the beta's versions (catalog
          // resolved) so the two packages never disagree on @pierre/diffs
          ...betaDeps("ui"),
          "tw-animate-css": "1.4.0",
        },
      },
      null,
      2,
    ),
  )
}

// --- client (types + the one runtime predicate) ---
const clientSrc = join(SRC, "packages/client/src/promise/generated/types.ts")
mkdirSync(join(ROOT, "vendor/client-v2/promise/generated"), { recursive: true })
cpSync(clientSrc, join(ROOT, "vendor/client-v2/promise/generated/types.ts"))
writeFileSync(
  join(ROOT, "vendor/client-v2/promise/index.ts"),
  `// vendor shim: re-export the generated client types + the single\n// runtime helper session-ui imports (isShellNotFoundError).\nexport * from "./generated/types.js"\n// the beta re-exports Attachment/MediaFileAttachment from @opencode/schema/prompt\nexport type PromptMention = { start: number; end: number; text: string }\nexport type PromptFileSource = { type: \"inline\" } | { type: \"uri\"; uri: string }\nexport type PromptBase64 = string\nexport type PromptFileAttachment = { data: PromptBase64; mime: string; source: PromptFileSource; name?: string; description?: string; mention?: PromptMention }\nexport type PromptMediaFileAttachment = { mime: string; source: PromptFileSource; name?: string; description?: string; mention?: PromptMention; uri: string; bytes?: number; width?: number; height?: number }\nexport type PromptAttachment = PromptFileAttachment | PromptMediaFileAttachment\nexport type PromptAgentAttachment = { name: string; mention?: PromptMention }\nexport type PromptSkillAttachment = { id: string; name: string; text?: string; mention?: PromptMention }\nexport const isShellNotFoundError = (e: unknown): e is { _tag: "ShellNotFoundError" } =>\n  typeof e === "object" && e !== null && (e as { _tag?: unknown })._tag === "ShellNotFoundError"\n`,
)
writeFileSync(
  join(ROOT, "vendor/client-v2/package.json"),
  JSON.stringify(
    {
      name: "@opencode/client",
      version: "2.0.18-vendor",
      private: true,
      type: "module",
      exports: {
        "./promise": "./promise/index.ts",
      },
    },
    null,
    2,
  ),
)

// --- util (leaf helpers only; self-contained modules) ---
mkdirSync(join(ROOT, "vendor/util-v2/src"), { recursive: true })
for (const f of ["path.ts", "encode.ts", "abort.ts", "session-mention.ts"]) {
  const p = join(SRC, "packages/util/src", f)
  if (existsSync(p)) cpSync(p, join(ROOT, "vendor/util-v2/src", f))
}
writeFileSync(
  join(ROOT, "vendor/util-v2/package.json"),
  JSON.stringify(
    {
      name: "@opencode/util",
      version: "2.0.18-vendor",
      private: true,
      type: "module",
      exports: {
        "./path": "./src/path.ts",
        "./encode": "./src/encode.ts",
        "./abort": "./src/abort.ts",
        "./session-mention": "./src/session-mention.ts",
      },
    },
    null,
    2,
  ),
)

// --- patchmark (upstream's own markdown streaming/patch parser, a
// session-ui dependency in newer betas; absent in older pins) ---
if (existsSync(join(SRC, "packages/patchmark/src"))) {
  mkdirSync(join(ROOT, "vendor/patchmark-v2/src"), { recursive: true })
  copyTree(join(SRC, "packages/patchmark/src"), join(ROOT, "vendor/patchmark-v2/src"))
  writeFileSync(
    join(ROOT, "vendor/patchmark-v2/package.json"),
    JSON.stringify({ name: "@opencode/patchmark", version: "0.0.0-vendor", private: true, type: "module", exports: { ".": "./src/index.ts" } }, null, 2),
  )
}

writeFileSync(join(ROOT, "vendor/V2-SOURCE.txt"), `vendored from ${SRC}\ngit: ${rev} (${describe})\ndate: ${new Date().toISOString()}\n`)
{
  // upstream beta type bugs (narrowed unions) — suppress typechecking for
  // these files rather than forking them
  const suppress = [
    "session-ui-v2/src/tools/shell-output.ts",
    "ui-v2/src/forms/select/select.tsx",
    "session-ui-v2/src/components/file.tsx",
    "session-ui-v2/src/pierre/index.ts",
    "session-ui-v2/src/pierre/worker.ts",
    "ui-v2/src/motion-tuning-fields.ts",
  ]
  const notes = {
    "session-ui-v2/src/tools/shell-output.ts": "string|object union narrowed as object-only",
    "ui-v2/src/forms/select/select.tsx": "onCleanup(void|fn) union",
    "session-ui-v2/src/components/file.tsx": "renderHeaderPrefix/preferredHighlighter unions vs @pierre/diffs 1.6.1 types (-679)",
    "session-ui-v2/src/pierre/index.ts": "createHighlighter arg count vs @pierre/highlights 0.2.0 types",
    "session-ui-v2/src/pierre/worker.ts": "preferredHighlighter \"highlights\" not in @pierre/diffs 1.6.1 HighlighterTypes",
    "ui-v2/src/motion-tuning-fields.ts": "imports storybook-only 'knobs' (upstream leak)",
  }
  for (const rel of suppress) {
    const p = join(ROOT, "vendor", rel)
    if (existsSync(p))     writeFileSync(p, `// @ts-nocheck — upstream beta type bug: ${notes[rel]}\n` + readFileSync(p, "utf8"))
  }
}
if (DRY) {
  const count = readdirSync(join(ROOT, "vendor"), { recursive: true }).length
  console.log(`check complete — every anchor applies; a real run would rewrite vendor/ (${count} entries)`)
  rmSync(ROOT, { recursive: true, force: true })
} else {
  console.log("vendor complete")
}