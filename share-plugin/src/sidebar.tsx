/** @jsxImportSource @opentui/solid */

// OpenShare sidebar chip: rendered into the `sidebar_title` slot
// (single_winner mode — our render replaces the default title block, so it
// re-renders the session title and appends the share state). The share
// state reads the live session store, so the chip updates the moment the
// server plugin writes the binding.
//
// v1-only: the v2 TUI plugin context has no slot registry. The v2 adapter
// simply skips this module.

import type { JSX } from "@opentui/solid"
import { bindingOf } from "./share-flow.js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Session } from "@opencode-ai/sdk/v2"

type SidebarTitleProps = {
  session_id: string
  title: string
  share_url?: string
}

export function createSidebarSlot(api: TuiPluginApi) {
  return {
    slots: {
      sidebar_title: (props: SidebarTitleProps): JSX.Element => {
        const session = api.state.session.get(props.session_id) as Session | undefined
        const binding = bindingOf(session as never)
        const status = session?.time?.archived ? undefined : binding?.url ? (binding.enabled === false ? "attached" : "live") : undefined
        const theme = api.theme.current
        return (
          <text>
            <text fg={theme.text}>{props.title || "Session"}</text>
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
