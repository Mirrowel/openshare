# Design

Captured from the shipped viewer (app.css, the vendored v2 kit token
system, and owner-approved rounds). This is descriptive, not aspirational.

## Visual theme

Two themes driven by the kit's token system (`light-dark()` +
`color-scheme` + `[data-ln]`), plus six forced premades built by
`scripts/build-themes.mjs`. Surface stack: `background-base` page,
`surface-base` recessed code/output panels, `surface-raised-base` hover
and active states, `border-weak-base` hairlines (1px). No shadows on
in-page content; shadows only on floating layers (popover, dialogs).

## Color strategy

Restrained: tinted neutrals across the board, one accent used sparingly
(active prompt marker, agent-switch event row, focused rows). Semantic
colors only where the data is semantic: diff add/delete, error red,
status dot colors (live green, completed blue, error red, interrupted
amber). Never `#000`/`#fff`.

## Typography

Kit text scale: 12 (meta, mono facts), 13 (body), 14 (prose/emphasis),
16 (titles). Hierarchy via weight (medium/semibold) + size, ratio ≥1.25
between steps. Mono (`ui-monospace, SFMono-Regular, Consolas`) for:
versions, counts, timestamps, keycaps, file extensions, line numbers,
status line. Prose stays sans. Code inside prose at 0.9em with a
`surface-base` chip background.

## Components

- **File cards** (`osh-file-body`): fixed `--osh-card` (30rem) width,
  2x for split diffs; titlebar = extension badge + basename + muted dir;
  right-edge control stack (U/A/S above wrap/scroll).
- **Tool rows**: BasicTool trigger line, 12px indent under trigger,
  `osh-pre` surfaces for grep/glob/list output (75vw cap).
- **Prompt rail pill**: fixed `left-2`, vertically centered, 40% opacity
  at rest → 100% near cursor → popover on hover; 150ms scale+slide.
- **Event rows**: compaction divider and agent-switch rows — hairline
  rules flanking a centered mono label, accent-tinted.
- **Chrome bar**: brand chip (only when branded) | centered status |
  copy/GitHub/info/settings on the right.

## Layout

Full-viewport app shell; transcript column `max-w-[52rem]` centered when
centerContent, otherwise left with `osh-indent` (~18px). Paged = one turn
at a time; continuous = virtualized full session (two-level windowing in
skins). 24px+ vertical break between assistant messages; 5px tool-to-tool
hugs inside a message.

## Motion

150ms ease-out for hover/pop transitions; no layout-property animation;
spring only for the kit's collapsible disclosure (never compensated in
JS). Scroll jumps smooth by default with an instant fallback beyond four
viewports, and a setting to disable smoothing entirely.

## Tokens

All colors flow through kit CSS variables (`--text-*`, `--surface-*`,
`--border-*`, `--syntax-*`); our additions: `--osh-card: 30rem`,
`--openshare-accent` (branding). Theme switches re-resolve everything —
no hardcoded palette values in components.
