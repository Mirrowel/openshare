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

    // module-scope marker so the spacing expression inside appendGroups can
    // see whether the NEXT row starts a new assistant message
    if (!s.includes("openshare module: segment marker")) {
      patch(
        /(^import \{ TimelineRow[^\r\n]*\r?\n)/m,
        "$1\n// openshare module: segment marker\nlet openshareSegmentStart = false\n",
        "segment marker",
      )
    }

    if (!s.includes("openshareSegmentStart")) {
      patch(
        /( {6}appendGroups\(before\)\r?\n)/,
        [
          "      // openshare fork: grouping per assistant message - one response's",
          "      // badge must never absorb another response's tools",
          "      const appendSegments = (items: typeof refs) => {",
          "        let start = 0",
          "        while (start < items.length) {",
          "          const messageID = items[start]!.messageID",
          "          let end = start",
          "          while (end < items.length && items[end]!.messageID === messageID) end += 1",
          "          openshareSegmentStart = start > 0",
          "          appendGroups(items.slice(start, end))",
          "          start = end",
          "        }",
          "      }",
          "",
          "      appendSegments(before)",
          "      openshareSegmentStart = false",
          "",
        ].join("\n"),
        "appendGroups(before)",
      )
      patch(/ {6}appendGroups\(after\)/, "      appendSegments(after)", "appendGroups(after)")
      patch(
        /spacing: assistantGroupIndex > 0 \? \(previousAssistantTool && tool \? "tool" : "content"\) : undefined,/,
        [
          "spacing: (() => {",
          "                  const messageStart = openshareSegmentStart",
          "                  openshareSegmentStart = false",
          "                  if (messageStart) return \"message\"",
          "                  if (assistantGroupIndex === 0) return undefined",
          "                  return detail ? \"content\" : previousAssistantTool && tool ? \"tool\" : \"content\"",
          "                })() as \"tool\" | \"content\" | \"message\" | undefined,",
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

// vendor fork: tighter rhythm between tool calls in one response
// (v1 was a 12px flex gap; upstream's 16px reads loose in a share page)
{
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
  const p = join(ROOT, "vendor/session-ui-v2/src/timeline/session-timeline-row.tsx")
  if (existsSync(p)) {
    let s = readFileSync(p, "utf8")
    if (!s.includes("pt-[0.45rem]")) {
      const before = s
      s = s.replace(
        / {8}"pt-4": Predicate\.isTagged\(props\.row, "AssistantPart"\) && props\.row\.spacing === "content",/,
        `        // openshare fork: tighter rhythm inside one response, a clear break
        // between responses (v1 separated turns, we separate messages)
        "pt-[0.45rem]": Predicate.isTagged(props.row, "AssistantPart") && props.row.spacing === "content",
        "pt-5": Predicate.isTagged(props.row, "AssistantPart") && props.row.spacing === "message",`,
      )
      if (s === before) throw new Error("vendor-v2: row spacing anchor missing - upstream drifted")
      writeFileSync(p, s)
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