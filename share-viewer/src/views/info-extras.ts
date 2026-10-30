import type { JSX } from "solid-js"

// view-scoped extras for the global Session info panel (atlas's legend +
// coordinates merge INTO the info popup). Lives in its OWN leaf module on
// purpose: registry.ts imports the view modules and the view modules import
// registry, so a module-scope setInfoExtra() call from a view hits registry
// mid-cycle (TDZ: 'Cannot access before initialization', which kills the app).
export type InfoExtra = () => JSX.Element
let infoExtra: InfoExtra | undefined
export function setInfoExtra(component: InfoExtra | undefined) {
  infoExtra = component
}
export function getInfoExtra(): InfoExtra | undefined {
  return infoExtra
}
