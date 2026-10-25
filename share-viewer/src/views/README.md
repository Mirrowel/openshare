# Building a share view (the views SDK)

A view is a **skin over the shared base**: the layout identity (column,
rhythm, chrome flavor) is yours; the data, mode logic, search, paging,
virtualization, settings surface and navigation are the SDK's. "Same
features, completely different page." Be bold, be distinct - but you
compose the shared pieces, you don't rebuild them.

## The whole contract

One file: `src/views/<your-id>.tsx`. You export a `Skin` and register
it, plus two lines in `registry.tsx` (import + the registration call)
that make the module load:

```tsx
import { type Skin } from "./base-view"
import { useView } from "./view-context"
import { SkinHeader, SkinFooter } from "./chrome"
import { SkinSettingsPopover } from "../settings-panel"
import { registerSkin } from "./registry"

const mySkin: Skin = {
  id: "myid",                       // lowercase, unique, the settings key
  columnClass: "max-w-3xl mx-auto px-6 py-6 flex flex-col gap-8",
  wrappers: {
    // all optional; each receives `settings` + its slice, and every
    // wrapper can read useView() for the full context
    Header: (p) => (
      <SkinHeader
        class="h-10 px-4 flex items-center justify-between bg-background-base border-b border-border-weak-base"
        settingsTrigger={
          <SkinSettingsPopover
            settings={p.settings}
            update={p.updateSettings}
            branding={p.source.branding()}
            search={p.search}
            onSearch={p.onSearch}
          /> /* the shared anchored settings surface - pass it explicitly */
        }
      />
    ),
    Footer: () => <SkinFooter label="myid" />,
    TurnWrap: (p) => <article class="py-6">{p.children}</article>,
    PromptWrap: (p) => <div class="text-14-medium text-text-strong">{p.children}</div>,
    ToolWrap: (p) => <div class="my-1">{p.children}</div>,
    ReasoningWrap: (p) => <div class="opacity-80">{p.children}</div>,
    ResponseWrap: (p) => <div class="text-14-regular">{p.children}</div>,
    Nav: undefined,                 // optional custom prompt list for the rail
  },
}

registerSkin(mySkin, {
  label: "myid",                    // settings selector label
  mark: "◆",                        // selector glyph
  // paged: false,                  // continuous-only views hide the paged toggle
  // settings: [                    // view-scoped settings, rendered for you
  //   { kind: "switch", key: "myToggle", label: "My toggle", hint: "..." },
  // ],
})
```

That is a complete, working view: virtualized, searchable, paged-capable,
themeable, settings-equipped, agent-labeled, subagent-navigable.

## What you get for free (do not rebuild)

- **Rendering**: the base lays out prompt / tool entries / reasoning /
  response from the shared section model, two-level virtualized
  (`section-window.tsx`) - a 500-part turn never mounts whole.
- **`useView()`** (`view-context.tsx`): `data`, `sessionID`, `source`,
  `settings`/`updateSettings`, `search`/`onSearch`, `sections`/`visible`/
  `query`, `continuous`/`active`/`setActive`, `info`/`version`/`model`/
  `status`, `back`/`isSub`, `copyMarkdown`, `cachePrefix`. Every wrapper,
  header, footer and nav reads this - no module globals, no prop
  smuggling, no duplicated lookups.
- **Chrome** (`chrome.tsx`): `SkinHeader` (back, title, version, model,
  status, copy-markdown, GitHub, your settings trigger - styled by class
  props, flavored by `afterBack`/`afterTitle`/`statusRender`/`trailing`
  slots, plus a right-side `parentLink` affordance on subagent pages),
  `SkinFooter` (brand row + label + GitHub), `statusTone`,
  `sessionCode`, `pad2`, `promptTitle`. Strongly-themed mastheads may
  stay bespoke (see teletype/atlas/timeline) - that is the escape hatch,
  not the default.
- **Prompt nav**: `PromptNav` (`src/hover-rail.tsx`) is the shared
  prompt navigation - pill or sidebar state, hover previews, focus-mode
  affordance, and the subagent parent row. `BaseSessionView` mounts it
  for every skin; a core view with its own navigation (see
  `conversation`) registers through `src/prompt-nav.ts` so `j`/`k` and
  `[`/`]` dispatch to it.
- **Settings**: the ONE shared popover (every skin's trigger mounts it;
  Ctrl+K toggles it anywhere). View-scoped settings render automatically
  from your `registerSkin` `settings` array - the shared files never
  need editing for a new setting. `sessionTools` (this share's tool
  vocabulary for the auto-expand picker) is self-sourced from the
  context.
- **The prompt rail**: mounted by the base when there is more than one
  prompt; paged pages, continuous fast-skips. Your `Nav` wrapper (if
  any) renders inside its popover.
- **Search**: prompt AND response text, uniform across all views. You
  read `view.visible()`; the empty state is the base's.
- **j/k navigation**: works in every view (falls back from classic's
  message rows to your `data-section-key` sections).
- **Subagents**: task rows are clickable into sub-pages; agent labels
  come from the plugin's authoritative stamp. `view.back()` returns.

## Rules that stay

- **Theme**: use the design tokens (`bg-background-base`,
  `text-text-base`, `border-border-weak-base`, the `text-12-mono`
  family...). Never raw hex. All themes then work for free.
- **Font identity** uses `titleStyle` on SkinHeader (inline font-family)
  or your own wrapper classes.
- Honor the settings you consume via `useView().settings`; the base
  already wires the ones it owns (followLive, paged, rail, search).
- **Auth/loading**: your view renders only when `source.ready()`; don't
  crash on empty arrays.
- Craft: no em dashes, no side-stripe accents, no gradient text, no
  glassmorphism-by-default; motion only for state, 150-250 ms ease-out.
  Load a design skill (`impeccable` / `frontend-design`) and follow it.
- Self-verify: `npm run typecheck && npm run build` green with your file;
  run the fingerprint rig before and after if you touch shared code -
  your change may not move any OTHER view's fingerprint.

## Verification (the parity bar)

The fingerprint instrument (`%TEMP%\opencode\osh-fingerprint.mjs
snap|diff`) renders every view on a fixture share and hashes text +
structure. A refactor of shared code must keep every view identical
(deliberate unifications are listed in the commit, nothing else moves).
The gate (`osh-gate.mjs`) asserts the invariants: settings schema per
view, Ctrl+K, search parity, rail, agent labels, zero page errors.
