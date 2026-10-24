import type { JSX } from "solid-js"

// view-scoped extras for the global Session info panel (owner round
// 2026-10-24 night: atlas's legend + coordinates merge INTO the info
// popup). Lives in its OWN leaf module on purpose: registry.ts imports
// the view modules, the view modules import registry - a module-scope
// setInfoExtra() call from a view would hit registry mid-cycle (TDZ,
// live-caught as 'Cannot access before initialization' killing the app).
export type InfoExtra = () => JSX.Element
let infoExtra: InfoExtra | undefined
export function setInfoExtra(component: InfoExtra | undefined) {
  infoExtra = component
}
export function getInfoExtra(): InfoExtra | undefined {
  return infoExtra
}
