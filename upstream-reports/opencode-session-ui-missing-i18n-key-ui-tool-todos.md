# Upstream bug report: `ui.tool.todos` i18n key is called but never defined — raw key renders on the page

**Target repository:** `anomalyco/opencode` (session-ui / ui packages, v2 line)
**Status:** Draft report — publish when ready (owner publishes findings himself)
**Verified against:** v2.0.0-1105-g4617210822 (the current `v2` branch at the time of writing)

---

## Summary

`packages/session-ui/src/tools/tool-renderer.tsx` calls `i18n.t("ui.tool.todos")` (line 423,
in the tool trigger-title builder, `case "todowrite"`), but `packages/ui/src/i18n/en.ts`
never defines the key `ui.tool.todos`. When that code path renders, the UI shows the
**literal string `ui.tool.todos`** instead of a label — the i18n `t()` fallback returns
`String(key)` when the dictionary has no entry.

## The inconsistency, in one check

Every *sibling* key of the same builder case exists in the dictionary; only `todos` is missing:

```console
$ rg '"ui\.tool\.(todos|questions|patch|skill|task)":' packages/ui/src/i18n/en.ts
192:  "ui.tool.task": "Task",
203:  "ui.tool.patch": "Patch",
204:  "ui.tool.questions": "Questions",
209:  "ui.tool.skill": "Skill",
```

`ui.tool.todos` is absent, yet the code calls it:

```ts
// packages/session-ui/src/tools/tool-renderer.tsx (around line 420)
case "todowrite":
  return {
    icon: "checklist",
    title: i18n.t("ui.tool.todos"),   // <-- key not in en.ts
  }
```

## Reachability (honest scope)

In the **opencode app itself** the path is currently masked, twice:

1. `packages/session-ui/src/timeline/projection.ts` (line 795) filters todowrite out of the
   timeline: `if (content.name === "todowrite") return false` — the app renders a todo dock
   instead.
2. `ToolDisplay` returns `null` for `props.tool === "todowrite"` before any registry lookup.

So a stock app build does not hit the raw key today. It is still a genuine defect, not dead
code in the general sense:

- The title builder itself is a shared, exported surface — any consumer that renders todo
  rows (a setting change, the todo dock migrating onto the shared builder, an embedding app
  like ours) immediately renders the raw key.
- We hit this **live** in [OpenShare](https://github.com/Mirrowel/OpenShare) (a share viewer
  built on the vendored v2 session-ui): we deliberately render todowrite rows in the
  transcript (a share page has no todo dock), and grouped rows showed
  **"Used 3 ui.tool.todos, Shell, Glob"** on the page. Screenshot evidence from a live
  session is available.

## Suggested fix

One line in `packages/ui/src/i18n/en.ts`, next to its siblings:

```diff
   "ui.tool.task": "Task",
+  "ui.tool.todos": "Todos",
   "ui.tool.patch": "Patch",
```

(If other locales exist, the same key should be added or fall back to `en`.)

## Workaround we ship

We merge the missing key into the i18n dictionary at the provider boundary instead of
patching the vendored package:

```ts
// entry.tsx — the I18nProvider's t() resolves against this merged dict
const dict: Record<string, string> = { ...uiEn, "ui.tool.todos": "Todos" }
const t = (key, params) => resolveTemplate(dict[key] ?? String(key), params)
```

This keeps the vendored tree pristine and makes the bug visible the moment upstream defines
the key (the merged entry simply matches upstream's).
