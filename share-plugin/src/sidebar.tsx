/** @jsxImportSource @opentui/solid */

// OpenShare sidebar chip: rendered into the `sidebar_title` slot
// (single_winner mode — our render replaces the default title block, so it
// re-renders the session title and appends the share state). The share
// state reads the live session store, so the chip updates the moment the
// server plugin writes the binding.
//
// v1-only: the v2 TUI plugin context has no slot registry. The v2 adapter
// simply skips this module.
//
// SLOT CONTRACT: (1) @opentui/core SlotRenderer is called as (ctx, props),
// CONTEXT FIRST. (2) The payload MUST be box-rooted: a text root with text
// children is not hostable through the slot machinery
// ("TextNodeRenderable only accepts strings..." on embed). Every proven
// consumer returns box-rooted trees (opencode's own default children,
// magic-context's sidebar, the host's slot self-test); text nodes stay
// LEAVES here, string content only.

import type { JSX } from "@opentui/solid"
import { bindingsOf, bindingOf, verifyShare } from "./share-flow.js"
import type { TuiPluginApi, TuiSlotContext } from "@opencode-ai/plugin/tui"
import type { Session } from "@opencode-ai/sdk/v2"
/** value -> `kind:preview` so the log shows TYPES (the crash was a type bug) */
export function dbg(v: unknown, depth = 0): string {
  const t = typeof v
  if (v === null) return "null"
  if (t === "string") return `str(${(v as string).length}):${JSON.stringify((v as string).slice(0, 60))}`
  if (t === "number" || t === "boolean" || t === "bigint") return `${t}:${String(v)}`
  if (t === "undefined") return "undef"
  if (t === "function") return `fn:${(v as { name?: string }).name || "anon"}`
  if (Array.isArray(v)) return `arr[${v.length}]:[${v.slice(0, 6).map((x) => dbg(x, depth + 1)).join(",")}]`
  if (depth >= 3) return "obj:…"
  try {
    const keys = Object.keys(v as object)
    return `obj{${keys.slice(0, 8).join(",")}}` + (depth < 2 ? `{${keys.slice(0, 8).map((k) => `${k}=${dbg((v as Record<string, unknown>)[k], depth + 1)}`).join(",")}}` : "")
  } catch {
    return "obj:?}"
  }
}

/** no-op: the TUI debug log file was a crash-hunt aid and must not write
 * to temp any more (owner request 2026-10-21) */
export function dbgLog(_line: string): void {}

/** Share liveness cache for the chip: a binding can claim "shared" long
 * after the page died server-side (purge/TTL/delete with no event ever
 * reaching this host). One credential-free probe per (session, server)
 * per minute; the chip picks the verdict up on the next render. */
type GoneVerdict = { status: "live" | "gone" | "unknown"; at: number }
const GONE_TTL_MS = 60_000
const goneCache = new Map<string, GoneVerdict>()

function goneVerdict(sid: string, server: string, shareId: string): GoneVerdict | undefined {
  const key = `${sid}|${server}`
  const cached = goneCache.get(key)
  if (cached && Date.now() - cached.at < GONE_TTL_MS) return cached
  void verifyShare(server, shareId).then((status) => {
    goneCache.set(key, { status, at: Date.now() })
  })
  return cached
}

type SidebarTitleProps = {
  session_id: string
  title: string
  share_url?: string
}

export function createSidebarSlot(api: TuiPluginApi, opts?: { onShareCommand?: () => void }) {
  return {
    slots: {
      sidebar_title: (ctx: TuiSlotContext, props: SidebarTitleProps): JSX.Element => {
        try {
          const sid = typeof props?.session_id === "string" ? props.session_id : ""
          const title = String(props?.title ?? "") || "Session"
          const session = sid ? api.state.session.get(sid) : undefined
          const binding = bindingOf(session as never)
          const allBindings = bindingsOf(session as never)
          const liveCount = allBindings.filter((b) => b.url && b.enabled !== false).length
          const status = session?.time?.archived ? undefined : binding?.url ? (binding.enabled === false ? "attached" : "live") : undefined
          // gone detection: any live-bound server whose page died server-side
          const checked = allBindings.filter((b) => b.url && b.enabled !== false && b.id && b.server)
          const verdicts = checked.map((b) => goneVerdict(sid, b.server, b.id))
          const anyGone = verdicts.some((v) => v?.status === "gone")
          const multi = liveCount > 1 ? `·${liveCount} ` : ""
          const theme = ctx?.theme?.current ?? api.theme.current

          // chip on its own line under the title (takes the blank line that
          // separated the title block from the context blocks); clicking it
          // copies the share link — proven pattern: onMouseDown on a box.
          // A verified-gone share renders dim (⊘) and clicking opens the
          // share manager (verify + gone modal) instead of a dead copy.
          const copyLink = () => {
            if (anyGone) {
              opts?.onShareCommand?.()
              return
            }
            const url = binding?.url
            if (!url) return
            // navigator first (no-op-resolves in the TUI runtime are
            // possible), then ALWAYS OSC52 — the empirically working path
            let copied = false
            try {
              const clip = (navigator as unknown as { clipboard?: { writeText?: (t: string) => Promise<void> } }).clipboard
              if (typeof clip?.writeText === "function") {
                void clip.writeText(url).then(
                  () => {},
                  () => {},
                )
                copied = true
              }
            } catch {}
            try {
              // OSC52 escape (most modern terminals, incl. Windows Terminal)
              process.stdout.write(`\x1b]52;c;${Buffer.from(url, "utf8").toString("base64")}\x07`)
              copied = true
            } catch {}
            try {
              api.ui.toast({ variant: copied ? "success" : "info", title: "OpenShare", message: copied ? `Share link copied: ${url}` : `Share link: ${url}`, duration: 6000 })
            } catch {}
          }
          const el = (
            <box flexDirection="column" paddingRight={1}>
              <text fg={theme.text}>{title}</text>
              {status ? (
                <box onMouseDown={copyLink}>
                  <text fg={anyGone ? theme.error : binding?.enabled === false ? theme.warning : theme.success}>
                    {anyGone
                      ? `⊘ re:share — gone (removed/expired) — click to fix`
                      : status === "live"
                        ? `◉ re:share ${multi}— click to copy link`
                        : "◉ re:share (dormant)"}
                  </text>
                </box>
              ) : null}
            </box>
          )
          return el
        } catch (error) {
          throw error
        }
      },
    },
  }
}
