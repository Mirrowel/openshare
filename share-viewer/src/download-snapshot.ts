// Build the offline snapshot ENTIRELY in the browser: fetch the live
// envelope, then fetch the page's own assets and inline them (the same
// bundling rules as the server endpoint - see share-worker/og/snapshot.js).
// Browser-side generation exists because a free Cloudflare isolate caps at
// ~50 subrequests per invocation, far below the ~1300 files a snapshot
// needs; the browser has no such cap and already holds every asset.
import type { ShareData } from "./fold"

/** the JSON island the offline page boots from */
type Envelope = {
  items: unknown[]
  status: string
  rev: number
  sessionID: string
  private?: Record<string, Record<string, string>>
}
import type { Branding } from "./data-source"

async function fetchEnvelope(shareID: string): Promise<Envelope> {
  const r = await fetch(`/api/share/${shareID}/data`, { cache: "no-store", credentials: "same-origin" })
  if (!r.ok) throw new Error(`share data unavailable (${r.status})`)
  const body = (await r.json()) as { v?: number; data?: unknown[]; status?: string; rev?: number; private?: Envelope["private"] }
  const items = (body.data ?? []) as Array<{ type?: string; data?: { id?: string; parentID?: string } }>
  const root = items.find((i) => i.type === "session" && i.data && !i.data.parentID)
  return {
    items,
    status: body.status ?? "completed",
    rev: body.rev ?? 0,
    sessionID: root?.data?.id ?? "",
    private: body.private,
  }
}

/**
 * Assemble the offline HTML for a share and hand it to the browser as a
 * download. Throws when the share is gone or gated and unauthenticated.
 */
export async function downloadSnapshot(shareID: string, branding: Branding): Promise<void> {
  const envelope = await fetchEnvelope(shareID)
  const { buildSnapshotHtml } = await import("../../share-worker/og/snapshot")
  const html = await (await fetch("/index.html", { cache: "force-cache" })).text()
  const island = JSON.stringify({ ...envelope, branding }).replace(/</g, "\\u003c")
  const out = await buildSnapshotHtml({
    html,
    island,
    readAsset: async (name) => {
      const r = await fetch(`/assets/${name}`)
      return r.ok ? await r.text() : null
    },
  })
  const blob = new Blob([out], { type: "text/html;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `openshare-${shareID}.html`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export type { ShareData }
