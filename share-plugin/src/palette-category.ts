/**
 * Shared palette category for Mirrowel OpenCode plugins loaded in the same
 * session. Every family plugin declares its own label into a process-wide
 * registry at TUI activation; a delayed reconciler joins all declared labels
 * (alphabetical, deterministic) and writes the join into every registered
 * command object, so the palette shows one combined section. A plugin loaded
 * alone keeps its own name; third-party plugins never declare and stay out.
 *
 * Labels are defined only in each plugin's entry point - this module carries
 * no per-plugin data. Keep the logic copies in sync across family repos.
 */

const REGISTRY_KEY = Symbol.for("mirrowel.opencode.paletteCategory")

// v1 command objects group via `category`; v2 keymap commands use `group`.
// Stamping both keeps one registry meaningful on both hosts.
type CategorizedCommand = { category?: string; group?: string }
type RegistryEntry = { label: string; commands: CategorizedCommand[] }
type Registry = { entries: RegistryEntry[] }

function registry(): Registry {
  const globals = globalThis as { [key: symbol]: Registry | undefined }
  if (!globals[REGISTRY_KEY]) globals[REGISTRY_KEY] = { entries: [] }
  return globals[REGISTRY_KEY]!
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? ""
  return `${labels.slice(0, -1).join(", ")} & ${labels[labels.length - 1]!}`
}

function joinedCategory(): string {
  const labels = [...new Set(registry().entries.map((entry) => entry.label))].sort((a, b) => a.localeCompare(b))
  return joinLabels(labels)
}

/**
 * Declares this plugin's category label and attaches command objects whose
 * `category` field is kept in sync. Returns the current join, so the very
 * first registration already renders correctly even before reconcilers run.
 */
export function declarePaletteCategory(label: string, ...commands: CategorizedCommand[]): string {
  const reg = registry()
  let entry = reg.entries.find((item) => item.label === label)
  if (!entry) {
    entry = { label, commands: [] }
    reg.entries.push(entry)
  }
  for (const command of commands) {
    if (command && !entry.commands.includes(command)) entry.commands.push(command)
  }
  reconcilePaletteCategories()
  return joinedCategory()
}

/** Live join for callback-style command registration (reads fresh each call). */
export function currentPaletteCategory(): string {
  return joinedCategory()
}

/** Writes the current join into every declared command (idempotent). */
export function reconcilePaletteCategories(): void {
  const category = joinedCategory()
  for (const entry of registry().entries) {
    for (const command of entry.commands) {
      command.category = category
      command.group = category
    }
  }
}

/** Delayed reconciles so later-activating siblings join before the user opens the palette. */
export function schedulePaletteReconcile(delaysMs: readonly number[] = [2000, 6000]): void {
  for (const delay of delaysMs) {
    const timer = setTimeout(() => reconcilePaletteCategories(), delay)
    ;(timer as { unref?: () => void }).unref?.()
  }
}

/** Tests only: drop all declarations. */
export function __resetPaletteRegistry(): void {
  ;(globalThis as { [key: symbol]: Registry | undefined })[REGISTRY_KEY] = undefined
}
