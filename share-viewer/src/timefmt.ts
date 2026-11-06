// Session time display. Shares record epochs, not a timezone, so the honest
// default is "as recorded" (UTC). One toggle converts every stamp in the
// session - prompt footers, turn footers, the header - to the reader's own
// timezone, and the choice is remembered per browser.
import { createSignal } from "solid-js"

const COOKIE = "osh_localtime"
// bumped on every toggle so Solid subscribers (the vendored stamp memo)
// re-render without a page reload
const [tzTick, setTzTick] = createSignal(0)
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

let localMode: boolean | undefined

/** True when stamps render in the reader's timezone instead of as recorded. */
export function useLocalTime(): boolean {
  tzTick()
  if (localMode === undefined) {
    localMode = document.cookie.split(";").some((part) => part.trim() === `${COOKIE}=1`)
  }
  return localMode
}

/** Flip the timezone mode, persist it, and repaint every stamp in place. */
export function toggleLocalTime(): boolean {
  localMode = !useLocalTime()
  document.cookie = useLocalTime() ? `${COOKIE}=1; path=/; max-age=31536000; samesite=lax` : `${COOKIE}=; path=/; max-age=0`
  document.documentElement.dataset.oshLocaltime = useLocalTime() ? "1" : "0"
  setTzTick((n) => n + 1)
  window.dispatchEvent(new CustomEvent("osh:localtime", { detail: useLocalTime() }))
  return useLocalTime()
}

const pad = (n: number) => String(n).padStart(2, "0")

function parts(ms: number) {
  const d = new Date(ms)
  if (useLocalTime()) {
    return {
      date: d.getDate(),
      month: MONTHS[d.getMonth()],
      year: d.getFullYear(),
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    }
  }
  return {
    date: d.getUTCDate(),
    month: MONTHS[d.getUTCMonth()],
    year: d.getUTCFullYear(),
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  }
}

/** Compact stamp: the clock today, `07:57 27 Oct` on any other day. */
export function compactStamp(ms: number, now = Date.now()): string {
  const p = parts(ms)
  const n = parts(now)
  const sameDay = p.date === n.date && p.month === n.month && p.year === n.year
  return sameDay ? p.time : `${p.time} ${p.date} ${p.month}`
}

/** Full stamp for the session header: `27 Oct 2026, 07:57`. */
export function fullStamp(ms: number): string {
  const p = parts(ms)
  return `${p.date} ${p.month} ${p.year}, ${p.time}`
}

/** Label for the header toggle, stating what a click will do. */
export function timezoneHint(): string {
  return useLocalTime() ? "Showing your local time - click to show times as recorded" : "Showing times as recorded - click to convert to your timezone"
}

// The vendored stamp (prompt footers) calls this instead of formatting
// itself, so one cookie drives the whole session.
;(globalThis as any).__oshStamp = (ms: number) => compactStamp(ms)
