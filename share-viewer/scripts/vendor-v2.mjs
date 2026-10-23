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
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = process.env.OPENSHARE_BETA_SRC ?? "c:/tools/opencode-beta"

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
    let s = readFileSync(p, "utf8")
    const fail = (what) => {
      throw new Error(`vendor-v2: projection fork anchor missing (${what}) - upstream drifted`)
    }
    const nl = s.includes("\r\n") ? "\r\n" : "\n"
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
      patch(
        /(const appendAssistantSegment = \(messages: SessionMessageAssistant\[\]\) => \{\r?\n {6}if \(thoughtOnly\) return)\r?\n/,
        "$1\n\n      // openshare fork: each segment call starts a NEW assistant message -\n      // its first row gets the \"message\" break (consumed by appendGroups)\n      openshareSegmentStart = true\n",
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
      patch(
        / {10}const tool = group\.type !== "part" \|\| items\[offset\]\?\.content\.type !== "text"\r?\n {10}offset \+= group\.type === "part" \? 1 : group\.refs\.length\r?\n {10}rows\.push\(\r?\n {12}new TimelineRow\.AssistantPart\(\{\r?\n {14}userMessageID: turnID,\r?\n {14}group,\r?\n {14}previousAssistantPart: assistantGroupIndex > 0,\r?\n {14}spacing: assistantGroupIndex > 0 \? \(previousAssistantTool && tool \? "tool" : "content"\) : undefined,/m,
        [
          '          const tool = group.type !== "part" || items[offset]?.content.type !== "text"',
          '          // openshare fork: does this row START with a bare tool call? (a',
          '          // tool group, or a part whose content is a tool) - needed for the',
          '          // tool->tool suppression below',
          '          const firstIsTool = group.type !== "part" || items[offset]?.content.type === "tool"',
          '          offset += group.type === "part" ? 1 : group.refs.length',
          '          // openshare fork: the first row of every assistant message (after',
          '          // the turn\'s first) carries the "message" break - EXCEPT when the',
          '          // previous row ended in a tool call AND this row starts with one',
          '          // (pure-tool messages flow as one action cluster; a break belongs',
          '          // only where the content TYPE changes: tool->reasoning/text)',
          "          const messageStart =",
          "            openshareSegmentStart && assistantGroupIndex > 0 && !(firstIsTool && opensharePrevRowTool)",
          "          openshareSegmentStart = false",
          "          opensharePrevRowTool = firstIsTool",
          "          rows.push(",
          "            new TimelineRow.AssistantPart({",
          "              userMessageID: turnID,",
          "              group,",
          "              previousAssistantPart: assistantGroupIndex > 0,",
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
    }    if (!s.includes("a category may refine grouping")) {
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
    let s = readFileSync(p, "utf8")
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

// vendor fork: file-change tools never merge with each other inside a
// context group (owner directive 2026-10-24: grouping groups individual
// tools; edit/write/patch each render as their own expandable card - the
// merged CurrentFileToolGroup showed one aggregate row for N edits with
// broken expansion). Literal anchors; throws on upstream drift.
{
  const p = join(ROOT, "vendor/session-ui-v2/src/tools/tool-renderer.tsx")
  if (existsSync(p)) {
    let s = readFileSync(p, "utf8")
    if (!s.includes("openshare fork: file-change tools NEVER merge")) {
      const nl = s.includes("\r\n") ? "\r\n" : "\n"
      const A = ["      if (isFileChangeTool(tool) && Array.isArray(previous) && previous[0] && isFileChangeTool(previous[0])) {", "        previous.push(tool)", "", "        return groups", "      }"].join(nl)
      const B = ["      // openshare fork: file-change tools NEVER merge with each other -", "      // each edit/write/patch renders as its own expandable card inside", "      // the group, exactly like every other tool (owner directive)", "      if (isFileChangeTool(tool)) {", "        groups.push([tool])", "", "        return groups", "      }"].join(nl)
      if (!s.includes(A)) throw new Error("vendor-v2: file-tools-merge anchor missing - upstream drifted")
      s = s.replace(A, B)
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
    let s = readFileSync(p, "utf8")
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

// openshare addition + fork: subagent/task rows label the agent that ACTUALLY
// ran, resolved from the plugin-stamped registry first (metadata.agent keyed
// by call id); input.agent/subagent_type remain as old-share fallbacks.
{
  // our own module (not an upstream fork): regenerated every run
  writeFileSync(
    join(ROOT, "vendor/session-ui-v2/src/tools/agent-registry.ts"),
    `// openshare addition (not an upstream fork - our own module, regenerated by
// scripts/vendor-v2.mjs): call-id -> agent registry.
// The PLUGIN stamps metadata.agent on every task tool part (authoritative);
// the viewer fills this registry from folded share data. Old shares without
// the stamp get a fallback computed once at fold time (subagent-map.ts) -
// never at render time. The kit's TaskTool reads it via agentFor(props.id).
const agents = new Map<string, string>()

export function setAgentFor(callID: string, agent: string): void {
  if (!callID || !agent) return
  agents.set(callID, agent)
}

export function agentFor(callID: string | undefined): string | undefined {
  if (!callID) return undefined
  return agents.get(callID)
}
`,
  )

  const p = join(ROOT, "vendor/session-ui-v2/src/tools/tool-renderer.tsx")
  if (existsSync(p)) {
    let s = readFileSync(p, "utf8")
    if (!s.includes("openshare fork: the agent label resolves from the PLUGIN-stamped")) {
      let before = s
      s = s.replace(
        /^import \{ BasicTool, GenericTool \} from "\.\.\/components\/basic-tool"/m,
        'import { BasicTool, GenericTool } from "../components/basic-tool"\nimport { agentFor } from "./agent-registry"',
      )
      if (s === before) throw new Error("vendor-v2: tool-renderer import anchor missing - upstream drifted")
      before = s
      s = s.replace(
        /^export interface ToolProps \{\r?\n/m,
        "export interface ToolProps {\n  /** the tool call's part id (ToolDisplay always passes it) - the agent\n   * registry (openshare) keys authoritative agent stamps by it */\n  id?: string\n",
      )
      if (s === before) throw new Error("vendor-v2: ToolProps anchor missing - upstream drifted")
      before = s
      s = s.replace(
        /const agent = createMemo\(\(\) => taskAgent\(props\.input\.agent, data\.store\.agent\)\)/,
        "// openshare fork: the agent label resolves from the PLUGIN-stamped\n    // registry first (metadata.agent on the call, keyed by call id) - the\n    // raw input only matters for old shares and unknown tools\n    const agent = createMemo(() => taskAgent(agentFor(props.id) ?? (props.input as any).agent ?? (props.input as any).subagent_type, data.store.agent))",
      )
      if (s === before) throw new Error("vendor-v2: task agent anchor missing - upstream drifted")
      before = s
      s = s.replace(
        /: part\.name === "subagent"\r?\n\s*\? i18n\.t\("ui\.tool\.agent\.default"\)/,
        ': part.name === "subagent"\n                  // openshare fork: grouped label prefers the plugin-stamped\n                  // registry (call id), then the input fields (old shares)\n                  ? taskAgent(agentFor((part as any).id) ?? (part as any).input?.agent ?? (part as any).input?.subagent_type, undefined).name ?? i18n.t("ui.tool.agent.default")',
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
    let s = readFileSync(p, "utf8")
    if (!s.includes("openshare fork: generic tools show output")) {
      let before = s
      s = s.replace(/export function GenericTool\(props: \{[^}]*\}\) \{/, (m) =>
        m.replace(
          "input?: Record<string, unknown>",
          "input?: Record<string, unknown>\n  /** openshare fork: generic tools show output */\n  output?: string\n  metadata?: Record<string, unknown>",
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
    let s = readFileSync(p, "utf8")
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

// vendor fork: row rhythm classes -> app.css data attribute
// (arbitrary tailwind classes in the vendor tree are never generated)
{
  const p = join(ROOT, "vendor/session-ui-v2/src/timeline/session-timeline-row.tsx")
  if (existsSync(p)) {
    let s = readFileSync(p, "utf8")
    if (!s.includes("row rhythm lives in app.css")) {
      const before = s
      s = s.replace(
        / {8}"pt-2": Predicate\.isTagged\(props\.row, "AssistantPart"\) && props\.row\.spacing === "tool",\r?\n {8}"pt-4": Predicate\.isTagged\(props\.row, "AssistantPart"\) && props\.row\.spacing === "content",/,
        `        // openshare fork: row rhythm lives in app.css keyed by
        // data-timeline-spacing (emitted on this element) - arbitrary
        // tailwind classes added here are NEVER generated: the kit's CSS is
        // prebuilt upstream and the viewer's tailwind does not scan the
        // vendor tree (live-caught: spacing forks silently did nothing and
        // removed upstream's pt-2/pt-4)`,
      )
      if (s === before) throw new Error("vendor-v2: row spacing anchor missing - upstream drifted")
      writeFileSync(p, s)
    }
    // openshare fork: agent transition chip on user rows (renders the
    // plugin-stamped metadata.agentSwitch, never computes anything)
    {
      let s = readFileSync(p, "utf8")
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
    {
      let s = readFileSync(p, "utf8")
      if (!s.includes("openshare fork: the viewer's per-tool auto-expand list wins first")) {
        const before = s
        s = s.replace(
          "  editToolDefaultOpen: Accessor<boolean>\r\n",
          "  editToolDefaultOpen: Accessor<boolean>\r\n  /** openshare fork: per-tool-name default-open (the viewer's auto-expand\r\n   *  checkbox list). Consulted BEFORE the category booleans; undefined =\r\n   *  fall through to the kit's own logic. */\r\n  toolDefaultOpen?: (tool: { name: string }) => boolean | undefined\r\n",
        )
        s = s.replace(
          "  function contentDefaultOpen(item: SessionMessageAssistant[\"content\"][number]) {\r\n    if (input.timelineDetail) {",
          "  function contentDefaultOpen(item: SessionMessageAssistant[\"content\"][number]) {\r\n    // openshare fork: the viewer's per-tool auto-expand list wins first\r\n    if (item.type === \"tool\" && input.toolDefaultOpen) {\r\n      const custom = input.toolDefaultOpen(item)\r\n      if (custom !== undefined) return custom\r\n    }\r\n    if (input.timelineDetail) {",
        )
        s = s.replace(
          "    const defaultOpen = createMemo(() => {\r\n      if (!input.timelineDetail) return input.shellToolDefaultOpen()",
          "    const defaultOpen = createMemo(() => {\r\n      // openshare fork: the viewer's per-tool auto-expand list wins first\r\n      if (input.toolDefaultOpen) {\r\n        const custom = input.toolDefaultOpen({ name: \"shell\" })\r\n        if (custom !== undefined) return custom\r\n      }\r\n      if (!input.timelineDetail) return input.shellToolDefaultOpen()",
        )
        if (s === before) throw new Error("vendor-v2: toolDefaultOpen anchors missing - upstream drifted")
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
      let s = readFileSync(p, "utf8")
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
        // openshare fork: hidden PREWARM copy while collapsed - the body
        // only mounts on expand, so the markdown worker parse started at
        // expand and the fallback->rich swap showed as a visible "snap".
        // The hidden copy parses under the same cacheKey at row mount.
        {
          const nl2 = s.includes("\r\n") ? "\r\n" : "\n"
          const A = ["        <PacedMarkdown text={props.content.text} cacheKey={props.id} streaming={props.streaming} defer={false} />", "      </BasicTool>"].join(nl2)
          const B = ["        <PacedMarkdown text={props.content.text} cacheKey={props.id} streaming={props.streaming} defer={false} />", "        <Show when={!open() && props.content.text.trim()}>", "          {/* openshare fork: hidden PREWARM copy - expansion finds the cache warm */}", "          <div style={{ display: \"none\" }} aria-hidden=\"true\">", "            <PacedMarkdown text={props.content.text} cacheKey={props.id} streaming={props.streaming} defer={false} />", "          </div>", "        </Show>", "      </BasicTool>"].join(nl2)
          if (!s.includes(A)) throw new Error("vendor-v2: prewarm anchor missing - upstream drifted")
          s = s.replace(A, B)
        }
        if (s === before) throw new Error("vendor-v2: message-content anchors missing - upstream drifted")
        writeFileSync(p, s)
      }
    }
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
        "./tools/agent-registry": "./src/tools/agent-registry.ts",
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
      },
    },
    null,
    2,
  ),
)

// --- ui ---
copyTree(join(SRC, "packages/ui/src"), join(ROOT, "vendor/ui-v2/src"))

// vendor fork (en locale): the kit's group label reads ui.tool.todos for
// todowrite rows; upstream en.ts ships without the key so the label shows
// the raw key (live-caught: "Used 3 ui.tool.todos, Shell, Glob").
{
  const p = join(ROOT, "vendor/ui-v2/src/i18n/en.ts")
  if (existsSync(p)) {
    let s = readFileSync(p, "utf8")
    if (!s.includes('"ui.tool.todos"')) {
      const nl = s.includes("\r\n") ? "\r\n" : "\n"
      const A = '  "ui.tool.task": "Task",'
      if (!s.includes(A)) throw new Error("vendor-v2: en locale anchor missing - upstream drifted")
      s = s.replace(A, A + nl + '  "ui.tool.todos": "Todos",')
      writeFileSync(p, s)
    }
  }
}
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
  `// vendor shim: re-export the generated client types + the single\n// runtime helper session-ui imports (isShellNotFoundError).\nexport * from "./generated/types.js"\nexport const isShellNotFoundError = (e: unknown): e is { _tag: "ShellNotFoundError" } =>\n  typeof e === "object" && e !== null && (e as { _tag?: unknown })._tag === "ShellNotFoundError"\n`,
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

// --- util (path + encode only) ---
mkdirSync(join(ROOT, "vendor/util-v2/src"), { recursive: true })
for (const f of ["path.ts", "encode.ts"]) {
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
      },
    },
    null,
    2,
  ),
)

writeFileSync(join(ROOT, "vendor/V2-SOURCE.txt"), `vendored from ${SRC}\ngit: ${rev} (${describe})\ndate: ${new Date().toISOString()}\n`)
{
  // upstream beta type bugs (narrowed unions) — suppress typechecking for
  // these files rather than forking them
  const suppress = ["session-ui-v2/src/tools/shell-output.ts", "ui-v2/src/forms/select/select.tsx"]
  const notes = {
    "session-ui-v2/src/tools/shell-output.ts": "string|object union narrowed as object-only",
    "ui-v2/src/forms/select/select.tsx": "onCleanup(void|fn) union",
  }
  for (const rel of suppress) {
    const p = join(ROOT, "vendor", rel)
    if (existsSync(p)) writeFileSync(p, `// @ts-nocheck — upstream beta type bug: ${notes[rel]}\n` + readFileSync(p, "utf8"))
  }
}
writeFileSync(join(ROOT, "vendor/V2-SOURCE.txt"), `vendored from ${SRC}\ngit: ${rev} (${describe})\ndate: ${new Date().toISOString()}\n`)
console.log("vendor complete")