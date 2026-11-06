// Host-agnostic dialog size preferences, stored in host kv rather than the
// config file because UI settings are per-host and synced by opencode
// itself. Dialog width maps to the host's fixed dialog widths; height is a
// percent of terminal rows. v1 dialogs apply these directly (dialogs.tsx);
// the settings dialog edits them through this module so the flows stay
// host-agnostic.

export const UI_WIDTH_KV = "openshare.ui-width"
export const UI_HEIGHT_PERCENT_KV = "openshare.ui-height-percent"

export type DialogWidth = "medium" | "large" | "xlarge"

export const HEIGHT_PERCENT_MIN = 25
export const HEIGHT_PERCENT_MAX = 100

/** what each width means in columns (opencode's fixed dialog widths) */
export const DIALOG_WIDTH_COLUMNS: Record<DialogWidth, number> = { medium: 60, large: 88, xlarge: 116 }

export function clampHeightPercent(value: number) {
  return Math.max(HEIGHT_PERCENT_MIN, Math.min(HEIGHT_PERCENT_MAX, Math.round(value)))
}

export function nextDialogWidth(width: DialogWidth): DialogWidth {
  return width === "medium" ? "large" : width === "large" ? "xlarge" : "medium"
}

/** kv read with validation; falls back to the default on garbage. */
export function kvWidthOf(kv: { get<Value = unknown>(key: string, fallback?: Value): Value }): DialogWidth {
  const value = kv.get<DialogWidth>(UI_WIDTH_KV, "large")
  return value === "medium" || value === "large" || value === "xlarge" ? value : "large"
}

export function kvHeightPercentOf(kv: { get<Value = unknown>(key: string, fallback?: Value): Value }): number {
  const value = kv.get<number>(UI_HEIGHT_PERCENT_KV, 50)
  return typeof value === "number" && Number.isFinite(value) ? clampHeightPercent(value) : 50
}
