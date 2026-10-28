// Deep links: stable, shareable anchors for a single transcript row.
//
// A row is addressed by its projection key (the same key the timeline uses
// for reconciliation), URL-encoded into `#row=<key>`. Keys are derived from
// the session data, so a link keeps working across reloads and deployments;
// it never depends on scroll position or row index.
//
// Snapshot pages reuse the hash for child-session routes (`#n2`), so this
// module owns only the `row=` form and leaves other hashes alone.

/** Row key to hash (no leading `#`). */
export function rowHash(key: string): string {
  return `#row=${encodeURIComponent(key)}`
}

/** Read the deep-link row key from a hash like `#row=user-message%3Amsg_1`. */
export function rowKeyFromHash(hash: string): string | undefined {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash
  if (!raw.startsWith("row=")) return undefined
  try {
    return decodeURIComponent(raw.slice(4))
  } catch {
    return undefined
  }
}

/** Absolute URL for a row in the current page. */
export function rowUrl(key: string): string {
  return `${location.origin}${location.pathname}${rowHash(key)}`
}

/** One-shot toast so a copy has visible feedback. */
let toastEl: HTMLDivElement | undefined
let toastTimer: number | undefined

/** Show a short confirmation bubble at the bottom of the page. */
export function toast(text: string) {
  if (!toastEl) {
    toastEl = document.createElement("div")
    toastEl.className = "osh-toast"
    document.body.appendChild(toastEl)
  }
  toastEl.textContent = text
  toastEl.dataset.on = "true"
  if (toastTimer) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    if (toastEl) toastEl.dataset.on = "false"
  }, 1800)
}

/** Copy a row's deep link, falling back to a prompt when the API is blocked. */
export async function copyRowLink(key: string) {
  const url = rowUrl(key)
  try {
    await navigator.clipboard.writeText(url)
    toast("link copied")
  } catch {
    const input = document.createElement("input")
    input.value = url
    document.body.appendChild(input)
    input.select()
    try {
      document.execCommand("copy")
      toast("link copied")
    } catch {
      toast(url)
    } finally {
      input.remove()
    }
  }
  // keep the address bar in sync so a reload lands on the same row
  history.replaceState(history.state, "", rowHash(key))
}
