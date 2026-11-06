const sessionID = "ses_openshare_demo"
const childID = "ses_openshare_demo_child"
const now = Date.now() - 60 * 60_000
const cssDiff = {
  file: "share-viewer/src/app.css", additions: 5, deletions: 1, status: "modified",
  patch: "diff --git a/share-viewer/src/app.css b/share-viewer/src/app.css\n--- a/share-viewer/src/app.css\n+++ b/share-viewer/src/app.css\n@@ -1,3 +1,7 @@\n .session-content {\n-  padding: 1.5rem;\n+  padding: 1rem;\n+  max-width: 72rem;\n }\n+pre {\n+  overflow-x: auto;\n+}\n",
}

// turn 4 fixtures: multi-hunk edit, one-line edit, creation, full delete, multi-file patch
const multiHunkDiff = {
  file: "share-viewer/src/app.css", additions: 5, deletions: 3, status: "modified",
  patch: "diff --git a/share-viewer/src/app.css b/share-viewer/src/app.css\n--- a/share-viewer/src/app.css\n+++ b/share-viewer/src/app.css\n@@ -1,4 +1,4 @@\n :root {\n-  --page-gutter: 2rem;\n+  --page-gutter: 1rem;\n }\n \n@@ -9,5 +9,6 @@\n \n @media (max-width: 640px) {\n-  .session-content { padding: 1.5rem; }\n+  .session-content { padding: 0.75rem; }\n+  .session-content pre { overflow-x: auto; }\n }\n \n@@ -20,4 +21,5 @@\n .tool-output {\n-  max-height: none;\n+  max-height: 24rem;\n+  overflow: auto;\n }\n \n",
}
const navDiff = {
  file: "share-viewer/src/turn-nav.tsx", additions: 1, deletions: 1, status: "modified",
  patch: "diff --git a/share-viewer/src/turn-nav.tsx b/share-viewer/src/turn-nav.tsx\n--- a/share-viewer/src/turn-nav.tsx\n+++ b/share-viewer/src/turn-nav.tsx\n@@ -40,3 +40,3 @@\n const row = \"flex items-center gap-2 px-2\"\n-const rowHeight = \"min-h-11\"\n+const rowHeight = \"min-h-7\"\n export const rowClass = `${row} ${rowHeight}`\n",
}
const longLineDiff = {
  file: "share-viewer/src/views/skins.css", additions: 1, deletions: 1, status: "modified",
  patch: "diff --git a/share-viewer/src/views/skins.css b/share-viewer/src/views/skins.css\n--- a/share-viewer/src/views/skins.css\n+++ b/share-viewer/src/views/skins.css\n@@ -12,3 +12,3 @@\n .transcript {\n-  grid-template-columns: [gutter] minmax(0.75rem, 2rem) [content] minmax(0, 52rem) [margin] minmax(0.75rem, 1fr) [rail] minmax(0, 14rem);\n+  grid-template-columns: [gutter] minmax(0.5rem, 1rem) [content] minmax(0, 52rem) [margin] minmax(0.5rem, 1fr) [rail] minmax(0, 12rem) [end] 0;\n }\n",
}
const legacyDeleteDiff = {
  file: "share-viewer/src/legacy-gutter.css", additions: 0, deletions: 8, status: "deleted",
  patch: "diff --git a/share-viewer/src/legacy-gutter.css b/share-viewer/src/legacy-gutter.css\ndeleted file mode 100644\n--- a/share-viewer/src/legacy-gutter.css\n+++ /dev/null\n@@ -1,8 +0,0 @@\n-.legacy-gutter {\n-  padding: 2rem;\n-}\n-\n-.legacy-gutter pre {\n-  overflow: visible;\n-}\n-/* remove after mobile rollout */\n",
}
const mobileCss = ".gutter {\n  padding: 0.75rem;\n}\n\n.gutter pre {\n  max-width: 100%;\n  overflow-x: auto;\n}\n"
const batchAdd = {
  file: "share-viewer/src/tokens.css", additions: 4, deletions: 0, status: "added",
  patch: "diff --git a/share-viewer/src/tokens.css b/share-viewer/src/tokens.css\nnew file mode 100644\n--- /dev/null\n+++ b/share-viewer/src/tokens.css\n@@ -0,0 +1,4 @@\n+:root {\n+  --row-height: 28px;\n+  --control-radius: 6px;\n+}\n",
}
const batchDelete = {
  file: "share-viewer/src/old-tokens.css", additions: 0, deletions: 3, status: "deleted",
  patch: "diff --git a/share-viewer/src/old-tokens.css b/share-viewer/src/old-tokens.css\ndeleted file mode 100644\n--- a/share-viewer/src/old-tokens.css\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-:root {\n-  --row-height: 44px;\n-}\n",
}
const batchModify = {
  file: "share-viewer/src/index.css", additions: 1, deletions: 1, status: "modified",
  patch: "diff --git a/share-viewer/src/index.css b/share-viewer/src/index.css\n--- a/share-viewer/src/index.css\n+++ b/share-viewer/src/index.css\n@@ -1,2 +1,2 @@\n-@import \"./old-tokens.css\";\n+@import \"./tokens.css\";\n body { margin: 0; }\n",
}

const user = (id: string, text: string, minute: number, metadata: Record<string, unknown> = {}) => ({
  type: "message",
  sessionID,
  data: { id, sessionID, role: "user", type: "user", text, metadata, time: { created: now + minute * 60_000 } },
})

const assistant = (id: string, minute: number, content: any[], extra: Record<string, unknown> = {}) => ({
  type: "message",
  sessionID,
  data: {
    id, sessionID, role: "assistant", type: "assistant", agent: "build",
    model: { providerID: "anthropic", id: "claude-sonnet-4" },
    time: { created: now + minute * 60_000, completed: now + (minute + 1) * 60_000 },
    content, ...extra,
  },
})

const text = (text: string) => ({ type: "text", text })
const tool = (id: string, name: string, input: Record<string, unknown>, output: string, extra: Record<string, unknown> = {}) => ({
  type: "tool", id, name,
  state: { status: "completed", input, content: [{ type: "text", text: output }], ...extra },
})

export const demoSnapshot = {
  sessionID,
  items: [
    { type: "session", data: { id: sessionID, title: "Make the share page feel at home on every screen", directory: "/workspace/openshare", time: { created: now, updated: now + 50 * 60_000 } } },
    { type: "session", data: { id: childID, parentID: sessionID, title: "Check mobile layout edge cases", directory: "/workspace/openshare", time: { created: now + 20 * 60_000, updated: now + 30 * 60_000 } } },
    { type: "model", sessionID, data: [{ id: "claude-sonnet-4", providerID: "anthropic", name: "Claude Sonnet 4" }] },
    user("msg_demo_user_1", "The share page feels cramped on my phone. Can you review the layout, identify the biggest issues, and suggest a focused fix?", 0),
    assistant("msg_demo_assistant_1", 1, [
      { type: "reasoning", id: "prt_demo_thought_1", text: "I should inspect the existing page structure and responsive rules first, then make the smallest useful change.", time: { created: now + 65_000 } },
      tool("tool_demo_glob", "glob", { pattern: "share-viewer/src/**/*" }, "share-viewer/src/app.tsx\nshare-viewer/src/app.css\nshare-viewer/src/turn-nav.tsx\nshare-viewer/src/settings-panel.tsx"),
      tool("tool_demo_read", "read", { filePath: "share-viewer/src/app.css" }, ":root {\n  --page-gutter: 2rem;\n}\n\n.session-content {\n  max-width: 72rem;\n  margin: 0 auto;\n}\n\n/* one deliberately long line: exercises the wrap vs scroll overflow choice for file cards */\n  --a-very-long-css-custom-property-line: this line is intentionally far longer than the card width so that the overflow behavior (wrap or horizontal scroll) is directly observable in the rendered transcript;\n\n@media (max-width: 640px) {\n  .session-content { padding: 1.5rem; }\n}"),
      text("I found the main issue: the mobile breakpoint keeps desktop-sized padding, and the transcript has no narrow-screen width constraint. I’ll check the component and nearby styles before changing anything."),
    ]),
    user("msg_demo_user_2", "Also make sure code, long tool output, and a subagent link still work after the change.", 5),
    assistant("msg_demo_assistant_2", 6, [
      tool("tool_demo_task", "subagent", { description: "Review mobile transcript edge cases", prompt: "Check narrow viewport behavior for code blocks, tool output, and subagent navigation." }, "Reviewed the mobile layout. Code blocks need horizontal scrolling; tool output should keep its own scroll area; task links need a comfortable tap target.", { metadata: { sessionID: childID } }),
      // two CONSECUTIVE subagent calls: the hint/room-carving geometry
      // case (a floating hint clipped into the sibling card)
      tool("tool_demo_task_2", "subagent", { description: "Audit theme tokens", prompt: "Verify the gutter tokens resolve on both themes." }, "Checked both themes: the gutter tokens resolve, and the mobile override wins under 640px.", { metadata: { sessionID: childID } }),
      tool("tool_demo_edit", "edit", { filePath: "share-viewer/src/app.css", oldString: ".session-content { padding: 1.5rem; }", newString: ".session-content { padding: 1rem; }" }, "Updated mobile page gutter and constrained transcript width.", { title: "Tighten mobile page spacing", metadata: { files: [cssDiff] } }),
      { type: "reasoning", id: "prt_demo_thought_2", text: "The narrow-screen changes are intentionally limited to spacing and overflow, so the desktop reading width stays unchanged." },
      text("The layout review found three practical mobile fixes: reduce page gutters, let code scroll horizontally, and preserve independent scrolling inside large outputs."),
    ]),
    user("msg_demo_user_3", "Show me a small CSS example for the scrolling code block, then summarize what you changed.", 12),
    assistant("msg_demo_assistant_3", 13, [
      text("For code blocks, keep the transcript width fluid and scroll only the code itself:"),
      text("```css\npre {\n  max-width: 100%;\n  overflow-x: auto;\n  overscroll-behavior-inline: contain;\n}\n```"),
      { type: "reasoning", id: "prt_demo_thought_3", text: "The demo should exercise multiple message types and realistic widths without making the main thread excessively long." },
      text("This demo includes user and assistant turns, reasoning, file tools, an edit diff, a subagent task, long output, and formatted code. The main layout change is a smaller mobile gutter with overflow contained in the content that needs it."),
    ]),
    user("msg_demo_user_4", "Now clean it up: split the gutter styles into their own file, drop the legacy stylesheet, and tighten the tool output.", 30),
    assistant("msg_demo_assistant_4", 31, [
      { type: "reasoning", id: "prt_demo_thought_4", text: "Four separate changes: tune app.css in a few places, shrink the turn rows, add a small mobile stylesheet, and remove the legacy one that nothing imports any more.", time: { created: now + 31 * 60_000 } },
      tool("tool_demo_edit_multi", "edit", { filePath: "share-viewer/src/app.css", oldString: "--page-gutter: 2rem;", newString: "--page-gutter: 1rem;" }, "Applied 3 changes to app.css.", { title: "Tune gutters and tool output", metadata: { files: [multiHunkDiff] } }),
      tool("tool_demo_edit_nav", "edit", { filePath: "share-viewer/src/turn-nav.tsx", oldString: "min-h-11", newString: "min-h-7" }, "Updated the turn row height.", { title: "Shrink turn rows", metadata: { files: [navDiff] } }),
      tool("tool_demo_edit_long", "edit", { filePath: "share-viewer/src/views/skins.css", oldString: "minmax(0, 14rem);", newString: "minmax(0, 12rem) [end] 0;" }, "Tightened the transcript grid.", { title: "Tighten grid columns", metadata: { files: [longLineDiff] } }),
      tool("tool_demo_write", "write", { filePath: "share-viewer/src/mobile.css", content: mobileCss }, "Created share-viewer/src/mobile.css.", { metadata: { files: [{ file: "share-viewer/src/mobile.css", additions: 8, deletions: 0, status: "added" }] } }),
      tool("tool_demo_delete", "patch", { filePath: "share-viewer/src/legacy-gutter.css" }, "Deleted share-viewer/src/legacy-gutter.css.", { title: "Remove the legacy stylesheet", metadata: { files: [legacyDeleteDiff] } }),
      tool("tool_demo_patch_batch", "patch", { patchText: "*** Begin Patch\n*** Add File: share-viewer/src/tokens.css\n*** Delete File: share-viewer/src/old-tokens.css\n*** Update File: share-viewer/src/index.css\n*** End Patch" }, "Applied 3 file changes.", { title: "Swap design tokens", metadata: { files: [batchAdd, batchDelete, batchModify] } }),
      text("Gutters, tool output and turn rows are tightened. The gutter styles now live in mobile.css, and the legacy stylesheet and the old token file are gone."),
    ]),
    { type: "message", sessionID: childID, data: { id: "msg_demo_child_user", sessionID: childID, role: "user", type: "user", text: "Check code blocks, output overflow, and task link sizing on narrow screens.", time: { created: now + 21 * 60_000 } } },
    { type: "message", sessionID: childID, data: { id: "msg_demo_child_assistant", sessionID: childID, role: "assistant", type: "assistant", agent: "explore", model: { providerID: "anthropic", id: "claude-sonnet-4" }, time: { created: now + 22 * 60_000, completed: now + 25 * 60_000 }, content: [text("The parent task row links to this subagent session. At phone widths, keep the link easy to tap, allow preformatted content to scroll inside its own region, and avoid horizontal overflow on the page.")] } },
    { type: "message", sessionID: childID, data: { id: "msg_demo_child_user_2", sessionID: childID, role: "user", type: "user", text: "Now double-check the sidebar and pill render correctly on this child page too.", time: { created: now + 27 * 60_000 } } },
    { type: "message", sessionID: childID, data: { id: "msg_demo_child_assistant_2", sessionID: childID, role: "assistant", type: "assistant", agent: "explore", model: { providerID: "anthropic", id: "claude-sonnet-4" }, time: { created: now + 28 * 60_000, completed: now + 29 * 60_000 }, content: [text("Both navigation states mount on child pages the same way as on the parent; the parent row sits above the prompt list so the way back is always one click.")] } },
    // turn 5: the feature shapes a share can carry that the story above
    // doesn't hit - compaction, an agent switch, math, an image write, and
    // a retry-then-error finish
    { type: "message", sessionID, data: { id: "msg_demo_compact", sessionID, type: "compaction", summary: "Turns 1-4 compacted: the mobile layout work landed (smaller gutters, scrolling code, independent output regions) and the legacy styles were removed.", time: { created: now + 40 * 60_000 } } },
    user("msg_demo_user_5", "Switch to plan mode: sketch how math rendering and image assets should look here.", 42, { agentSwitch: "plan", agent: "plan", model: { id: "claude-sonnet-4-plan", providerID: "anthropic" } }),
    assistant("msg_demo_assistant_5", 43, [
      text("Display math, inline math like $E = mc^2$, and a real image asset:"),
      text("$$\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}$$"),
      tool("tool_demo_img", "write", { filePath: "/workspace/openshare/assets/blue-dot.png", content: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGOInvMNK2IYWhIAAdh7QU52w2gAAAAASUVORK5CYII=" }, "Wrote an 8x8 PNG."),
    ]),
    user("msg_demo_user_6", "Retry once, then let it fail.", 46),
    assistant("msg_demo_assistant_6", 47, [text("Retried once and failed again.")], { retry: true }),
    assistant("msg_demo_assistant_7", 48, [text("Never completed.")], { error: { type: "rate_limited", message: "rate limited: retry after 60s" } }),
    { type: "session_diff", sessionID, data: [cssDiff] },
  ],
}
