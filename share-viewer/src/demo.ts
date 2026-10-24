const sessionID = "ses_openshare_demo"
const childID = "ses_openshare_demo_child"
const now = Date.now() - 60 * 60_000
const cssDiff = {
  file: "share-viewer/src/app.css", additions: 5, deletions: 1, status: "modified",
  patch: "diff --git a/share-viewer/src/app.css b/share-viewer/src/app.css\n--- a/share-viewer/src/app.css\n+++ b/share-viewer/src/app.css\n@@ -1,3 +1,7 @@\n .session-content {\n-  padding: 1.5rem;\n+  padding: 1rem;\n+  max-width: 72rem;\n }\n+pre {\n+  overflow-x: auto;\n+}\n",
}

const user = (id: string, text: string, minute: number) => ({
  type: "message",
  sessionID,
  data: { id, sessionID, role: "user", type: "user", text, time: { created: now + minute * 60_000 } },
})

const assistant = (id: string, minute: number, content: any[]) => ({
  type: "message",
  sessionID,
  data: {
    id, sessionID, role: "assistant", type: "assistant", agent: "build",
    model: { providerID: "anthropic", id: "claude-sonnet-4" },
    time: { created: now + minute * 60_000, completed: now + (minute + 1) * 60_000 },
    content,
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
    { type: "prefs", data: { openTasksInNewTab: false } },
    user("msg_demo_user_1", "The share page feels cramped on my phone. Can you review the layout, identify the biggest issues, and suggest a focused fix?", 0),
    assistant("msg_demo_assistant_1", 1, [
      { type: "reasoning", text: "I should inspect the existing page structure and responsive rules first, then make the smallest useful change.", time: { created: now + 65_000 } },
      tool("tool_demo_glob", "glob", { pattern: "share-viewer/src/**/*" }, "share-viewer/src/app.tsx\nshare-viewer/src/app.css\nshare-viewer/src/turn-nav.tsx\nshare-viewer/src/settings-panel.tsx"),
      tool("tool_demo_read", "read", { filePath: "share-viewer/src/app.css" }, ":root {\n  --page-gutter: 2rem;\n}\n\n.session-content {\n  max-width: 72rem;\n  margin: 0 auto;\n}\n\n@media (max-width: 640px) {\n  .session-content { padding: 1.5rem; }\n}"),
      text("I found the main issue: the mobile breakpoint keeps desktop-sized padding, and the transcript has no narrow-screen width constraint. I’ll check the component and nearby styles before changing anything."),
    ]),
    user("msg_demo_user_2", "Also make sure code, long tool output, and a subagent link still work after the change.", 5),
    assistant("msg_demo_assistant_2", 6, [
      tool("tool_demo_task", "subagent", { description: "Review mobile transcript edge cases", prompt: "Check narrow viewport behavior for code blocks, tool output, and subagent navigation." }, "Reviewed the mobile layout. Code blocks need horizontal scrolling; tool output should keep its own scroll area; task links need a comfortable tap target.", { metadata: { sessionID: childID } }),
      tool("tool_demo_edit", "edit", { filePath: "share-viewer/src/app.css", oldString: ".session-content { padding: 1.5rem; }", newString: ".session-content { padding: 1rem; }" }, "Updated mobile page gutter and constrained transcript width.", { title: "Tighten mobile page spacing", metadata: { files: [cssDiff] } }),
      { type: "reasoning", text: "The narrow-screen changes are intentionally limited to spacing and overflow, so the desktop reading width stays unchanged." },
      text("The layout review found three practical mobile fixes: reduce page gutters, let code scroll horizontally, and preserve independent scrolling inside large outputs."),
    ]),
    user("msg_demo_user_3", "Show me a small CSS example for the scrolling code block, then summarize what you changed.", 12),
    assistant("msg_demo_assistant_3", 13, [
      text("For code blocks, keep the transcript width fluid and scroll only the code itself:"),
      text("```css\npre {\n  max-width: 100%;\n  overflow-x: auto;\n  overscroll-behavior-inline: contain;\n}\n```"),
      { type: "reasoning", text: "The demo should exercise multiple message types and realistic widths without making the main thread excessively long." },
      text("This demo includes user and assistant turns, reasoning, file tools, an edit diff, a subagent task, long output, and formatted code. The main layout change is a smaller mobile gutter with overflow contained in the content that needs it."),
    ]),
    { type: "message", sessionID: childID, data: { id: "msg_demo_child_user", sessionID: childID, role: "user", type: "user", text: "Check code blocks, output overflow, and task link sizing on narrow screens.", time: { created: now + 21 * 60_000 } } },
    { type: "message", sessionID: childID, data: { id: "msg_demo_child_assistant", sessionID: childID, role: "assistant", type: "assistant", agent: "explore", model: { providerID: "anthropic", id: "claude-sonnet-4" }, time: { created: now + 22 * 60_000, completed: now + 25 * 60_000 }, content: [text("The parent task row links to this subagent session. At phone widths, keep the link easy to tap, allow preformatted content to scroll inside its own region, and avoid horizontal overflow on the page.")] } },
    { type: "session_diff", sessionID, data: [cssDiff] },
  ],
}
