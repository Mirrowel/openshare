import type { JSX } from "solid-js"

// view-scoped extras for the global Session info panel (atlas's legend +
// coordinates merge INTO the info popup). Keyed by view id so a view's extra
// renders only while that view is active; registration is keyed (not
// mount-scoped), so no cleanup ordering exists to get wrong.
// Lives in its OWN leaf module on purpose: registry.ts imports the view
// modules and the view modules import registry, so a module-scope
// setInfoExtra() call from a view hits registry mid-cycle (TDZ: 'Cannot
// access before initialization', which kills the app).
export type InfoExtra = () => JSX.Element
const extras = new Map<string, InfoExtra>()
export function setInfoExtra(view: string, component: InfoExtra | undefined) {
  if (component) extras.set(view, component)
  else extras.delete(view)
}
export function getInfoExtra(view: string): InfoExtra | undefined {
  return extras.get(view)
}
