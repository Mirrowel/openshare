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
// SLOT CONTRACT (@opentui/core SlotRenderer): the host calls the renderer
// as (ctx, props) — CONTEXT FIRST. Reading props off the first parameter
// made ctx.theme (an object) flow into <text> children and crashed the
// TUI with "TextNodeRenderable only accepts strings" (live-caught) —
// hence the strict String() coercion of anything rendered.

import type { JSX } from "@opentui/solid"
import { bindingOf } from "./share-flow.js"
import type { TuiPluginApi, TuiSlotContext } from "@opencode-ai/plugin/tui"
import type { Session } from "@opencode-ai/sdk/v2"

type SidebarTitleProps = {
  session_id: string
  title: string
  share_url?: string
}

export function createSidebarSlot(api: TuiPluginApi) {
  return {
    slots: {
      sidebar_title: (ctx: TuiSlotContext, props: SidebarTitleProps): JSX.Element => {
        const sid = typeof props?.session_id === "string" ? props.session_id : ""
        const title = String(props?.title ?? "") || "Session"
        const session = sid ? (api.state.session.get(sid) as Session | undefined) : undefined
        const binding = bindingOf(session as never)
        const status = session?.time?.archived ? undefined : binding?.url ? (binding.enabled === false ? "attached" : "live") : undefined
        const theme = ctx?.theme?.current ?? api.theme.current
        return (
          <text>
            <text fg={theme.text}>{title}</text>
            {status ? (
              <text fg={binding?.enabled === false ? theme.warning : theme.success}>
                {"  ◉ "}
                {status === "live" ? "re:share" : "re:share (dormant)"}
              </text>
            ) : null}
          </text>
        )
      },
    },
  }
}
