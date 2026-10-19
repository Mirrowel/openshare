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
// SLOT CONTRACT (live-caught 2x): (1) @opentui/core SlotRenderer is called
// as (ctx, props) — CONTEXT FIRST. (2) The payload MUST be box-rooted:
// a text root with text children is not hostable through the slot
// machinery ("TextNodeRenderable only accepts strings…" on embed). Every
// proven consumer returns box-rooted trees (opencode's own default
// children, magic-context's sidebar, the host's slot self-test); text
// nodes stay LEAVES here — string content only.
//
// TEMPORARY crash-hunt instrumentation (owner-approved 2026-10-19): every
// render logs its inputs (with TYPES), the computed locals, and a dump of
// the returned element tree to %TEMP%/openshare-tui-debug.log via
// synchronous appends, so a crash mid-render still leaves evidence. Any
// throw inside the renderer is logged with its stack, then rethrown.
// Remove once the live crash is cornered.

import type { JSX } from "@opentui/solid"
import { bindingOf } from "./share-flow.js"
import type { TuiPluginApi, TuiSlotContext } from "@opencode-ai/plugin/tui"
import type { Session } from "@opencode-ai/sdk/v2"
import { appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DBG_FILE = join(tmpdir(), "openshare-tui-debug.log")

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

/** shallow structural dump of a rendered element tree (type names, children kinds) */
function dbgEl(el: unknown, depth = 0): string {
  if (el === null || el === undefined || typeof el === "string" || typeof el === "number" || typeof el === "boolean") return dbg(el)
  if (Array.isArray(el)) return `[${el.map((x) => dbgEl(x, depth)).join(",")}]`
  if (typeof el === "function") return "fn-node"
  if (depth >= 4) return "…"
  try {
    const rec = el as Record<string, unknown>
    const t = dbg(rec.t ?? rec.type, 2)
    const kids = rec.children
    const props = Object.keys(rec).filter((k) => !["t", "type", "children"].includes(k))
    return `<${t} ${props.join(" ")}>${kids === undefined ? "" : dbgEl(kids, depth + 1)}</${t}>`
  } catch (e) {
    return `el?-${dbg(e)}`
  }
}

export function dbgLog(line: string): void {
  try {
    appendFileSync(DBG_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

let renderSeq = 0

type SidebarTitleProps = {
  session_id: string
  title: string
  share_url?: string
}

export function createSidebarSlot(api: TuiPluginApi) {
  dbgLog(`createSidebarSlot called; api.state=${!!api.state} api.theme=${!!api.theme} api.version=${dbg(api.app?.version)}`)
  return {
    slots: {
      sidebar_title: (ctx: TuiSlotContext, props: SidebarTitleProps): JSX.Element => {
        const seq = ++renderSeq
        try {
          dbgLog(`render#${seq} ctx=${dbg(ctx)} props=${dbg(props)}`)
          const sid = typeof props?.session_id === "string" ? props.session_id : ""
          const title = String(props?.title ?? "") || "Session"
          const session = sid ? api.state.session.get(sid) : undefined
          const binding = bindingOf(session as never)
          const status = session?.time?.archived ? undefined : binding?.url ? (binding.enabled === false ? "attached" : "live") : undefined
          const theme = ctx?.theme?.current ?? api.theme.current
          dbgLog(
            `render#${seq} sid=${dbg(sid)} title=${dbg(title)} session=${session ? "found" : "MISSING"} binding=${binding ? `id=${dbg(binding.id)} enabled=${dbg(binding.enabled)}` : "none"} status=${dbg(status)} theme=${dbg(theme)}`,
          )
          const el = (
            <box paddingRight={1}>
              <text fg={theme.text}>{title}</text>
              {status ? (
                <text fg={binding?.enabled === false ? theme.warning : theme.success}>
                  {status === "live" ? "  ◉ re:share" : "  ◉ re:share (dormant)"}
                </text>
              ) : null}
            </box>
          )
          dbgLog(`render#${seq} RETURNS ${dbgEl(el)}`)
          return el
        } catch (error) {
          dbgLog(`render#${seq} THREW ${(error as Error)?.stack ?? dbg(error)} — rethrowing`)
          throw error
        }
      },
    },
  }
}
