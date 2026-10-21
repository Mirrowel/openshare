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

// --- session-ui ---
copyTree(join(SRC, "packages/session-ui/src"), join(ROOT, "vendor/session-ui-v2/src"))
// (the ./tools/tool-renderer export is added in the package.json written below)
// vendor fork: projection.ts groups per ASSISTANT MESSAGE (one response),
// never across responses, and our explicit detail forces content spacing.
// Re-applied after copyTree; fails loudly if upstream anchors drift.
{
  const p = join(ROOT, "vendor/session-ui-v2/src/timeline/projection.ts")
  if (existsSync(p)) {
    let s = readFileSync(p, "utf8")
    const fail = (what) => {
      throw new Error(`vendor-v2: projection fork anchor missing (${what}) — upstream drifted`)
    }
    if (!s.includes("openshare fork: grouping is PER ASSISTANT MESSAGE")) {
      // CRLF-tolerant anchors: the vendored tree is checked out with CRLF
      // on Windows, so literal "\n" markers never match
      const startMatch = / {4}const appendAssistantSegment = \(messages: SessionMessageAssistant\[\]\) => \{/.exec(s)
      const start = startMatch ? startMatch.index : -1
      const endRe = /appendGroups\(after\)\r?\n {6}\}/
      const endMatch = start >= 0 ? endRe.exec(s.slice(start)) : null
      if (start < 0 || !endMatch) fail("appendAssistantSegment")
      const end = start + endMatch.index
      const replacement = `    // openshare fork: grouping is PER ASSISTANT MESSAGE (one response).
    const appendAssistantSegment = (messages: SessionMessageAssistant[]) => {
      const segments = messages.map((message, messageIndex) => ({
        messageIndex,
        refs: contentEntries(message)
          .filter(
            (entry) =>
              isRenderable(entry.content, showReasoning, detail) && !(thinking && entry.content === lastContent),
          )
          .map((entry) => ({ messageID: message.id, messageIndex, partID: entry.id, content: entry.content })),
      }))
      const interruptedAt = messages.findIndex((message) => isInterrupted(message.error))
      const appendGroups = (items: { messageID: string; partID: string; content: Content }[]) => {
        let offset = 0
        groupContent(items, shellToolDefaultOpen, editToolDefaultOpen, detail).forEach((group) => {
          const tool = group.type !== "part" || items[offset]?.content.type !== "text"
          offset += group.type === "part" ? 1 : group.refs.length
          rows.push(
            new TimelineRow.AssistantPart({
              userMessageID: turnID,
              group,
              previousAssistantPart: assistantGroupIndex > 0,
              spacing:
                assistantGroupIndex > 0
                  ? detail
                    ? "content"
                    : previousAssistantTool && tool
                      ? "tool"
                      : "content"
                  : undefined,
            }),
          )
          assistantGroupIndex += 1
          previousAssistantTool = tool
        })
      }
      const appendSegmentGroups = (selected: typeof segments) => {
        for (const segment of selected) appendGroups(segment.refs)
      }

      appendSegmentGroups(segments.filter((segment) => interruptedAt < 0 || segment.messageIndex <= interruptedAt))
      if (interruptedAt >= 0) {
        if (!compaction && detail?.notices.placement !== "hidden")
          rows.push(new TimelineRow.TurnDivider({ userMessageID: turnID }))
        appendSegmentGroups(segments.filter((segment) => segment.messageIndex > interruptedAt))
      }`
      s = s.slice(0, start) + (s.includes("\r\n") ? replacement.replace(/\n/g, "\r\n") : replacement) + s.slice(end + endMatch[0].length)
      s = s.replace(
        / {6}previous\.userMessageID === current\.userMessageID\r?\n {4}\) \{/,
        `      previous.userMessageID === current.userMessageID &&
      // openshare fork: never merge groups across assistant messages
      previous.group.refs.at(-1)?.messageID === current.group.refs[0]?.messageID
    ) {`,
      )
      if (!s.includes("never merge groups across assistant messages")) fail("groupMessages guard")
      writeFileSync(p, s)
    }
  }
}

// vendor fork: session-timeline.tsx gained a `detail` prop (timeline
// grouping placements) that upstream doesn't have. Re-apply it after
// copyTree by patching the two anchors — regenerate and this still works.
{
  const p = join(ROOT, "vendor/session-ui-v2/src/timeline/session-timeline.tsx")
  if (existsSync(p)) {
    let s = readFileSync(p, "utf8")
    if (!s.includes("timelineDetail")) {
      const nl = s.includes("\r\n") ? "\r\n" : "\n"
      const before = s
      s = s.replace(
        /import \{ createReactiveTimelineProjection, TimelineRow, type ReasoningMode \} from "\.\/projection"/,
        '$&\nimport type { TimelineDetail } from "./detail"',
      )
      s = s.replace(
        /  editToolDefaultOpen\?: boolean\r?\n  class\?: string/,
        "  editToolDefaultOpen?: boolean\n  /** fork: explicit detail (grouping placements) - undefined = kit default */\n  detail?: TimelineDetail\n  class?: string",
      )
      s = s.replace(
        / {4}editToolDefaultOpen: \(\) => props\.editToolDefaultOpen \?\? false,\r?\n {2}\}\)\r?\n {0,2}const \[toolOpen/,
        "    editToolDefaultOpen: () => props.editToolDefaultOpen ?? false,\n    timelineDetail: () => props.detail,\n  })\n  const [toolOpen",
      )
      if (s === before || !s.includes("timelineDetail") || !s.includes("detail?: TimelineDetail"))
        throw new Error("vendor-v2: session-timeline fork anchors missing — upstream drifted")
      // keep the file's newline style (regex replacements above used \n)
      if (nl === "\r\n") s = s.replace(/\r?\n/g, "\r\n")
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
      dependencies: {
        "@kobalte/core": "0.13.13",
        "@opencode/client": "file:../client-v2",
        "@opencode/ui": "file:../ui-v2",
        "@opencode/util": "file:../util-v2",
        "@pierre/diffs": "1.2.10",
        "@shikijs/stream": "4.4.3",
        "@solid-primitives/event-listener": "2.4.6",
        "@solid-primitives/media": "2.3.6",
        "@solid-primitives/resize-observer": "2.2.0",
        "@solidjs/meta": "0.29.4",
        "diff": "8.0.4",
        "dompurify": "3.4.14",
        "effect": "4.0.0-rc.112",
        "marked": "18.0.11",
        "mermaid": "11.17.2",
        "motion": "12.34.5",
        "remend": "1.3.1",
        "shiki": "4.4.3",
        "solid-js": "1.9.15",
        "strip-ansi": "7.1.2",
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
          "@kobalte/core": "0.13.13",
          "@pierre/diffs": "1.2.10",
          "@solid-primitives/media": "2.3.6",
          "@solid-primitives/resize-observer": "2.2.0",
          "@solid-primitives/event-listener": "2.4.6",
          "marked": "18.0.11",
          "motion": "12.34.5",
          "solid-js": "1.9.15",
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
