// The classic tool presentation, reusable by every view: renders a synced
// tool content block through the vendored v2 ToolDisplay (BasicTool rows,
// diff accordions, expandable outputs, the per-tool open rule).
import { ToolDisplay } from "@opencode/session-ui/tools/tool-renderer"
// our renderers override read/edit/write/patch/grep/glob/list/todowrite
// AFTER the kit registered its own (last registration wins)
import "../tool-overrides"
import { setSubagentData } from "../subagent-map"
import { DataProvider } from "@opencode/session-ui/context"
import { DialogProvider } from "@opencode/ui/context/dialog"
import { FileComponentProvider } from "@opencode/ui/context/file"
import { WorkerPoolProvider } from "@opencode/ui/context/worker-pool"
import { getWorkerPools } from "@opencode/session-ui/pierre/worker"
import { FileSSR } from "@opencode/session-ui/file-ssr"
import { sessionStatus, type ShareData } from "../fold"
import { armToggleAnchor, settleToggleAnchor } from "../toggle-anchor"
import type { OshSettings } from "../settings"
import type { ToolEntry } from "./session-data"

// the page's share data + subagent navigation, set once per view mount
// (avoids plumbing it through every ordered-entry component). The nav
// bundle is what makes subagent rows clickable: the vendored renderer
// links through data.sessionHref and clicks through data.navigateToSession
export type VendoredNav = {
  sessionHref: (id: string) => string | undefined
  navigateToSession: (id: string) => void
}
let currentData: ShareData | undefined
let currentNav: VendoredNav | undefined
export function setVendoredData(d: ShareData | undefined, nav?: VendoredNav) {
  currentData = d
  currentNav = nav
}

// per-entry open state for composed views, module-level so section-window
// remounts keep it, + toggle anchoring (same discipline as classic)
const partOpen = new Map<string, boolean | undefined>()
armToggleAnchor()

export function VendoredPart(props: { entry: ToolEntry; settings: OshSettings; data?: ShareData }) {
  const data = () => props.data ?? currentData
  const entryId = () => String((props.entry.part as any)?.id ?? props.entry.tool + ":" + (props.entry.part as any)?.time?.created ?? "x")
  const open = () => partOpen.get(entryId()) ?? (props.settings.autoExpand.includes(props.entry.tool) || undefined)
  return (
    <DataProvider
      data={{
        session: (data()?.session ?? []) as any,
        session_status: Object.fromEntries((data()?.session ?? []).map((s) => [s.id, sessionStatus(data()?.status ?? "live")])),
        session_diff: (data()?.session_diff ?? {}) as any,
        provider: data()?.provider ?? { all: new Map(), default: {}, connected: [] },
      }}
      directory={(data()?.session.find((s: any) => s.id === props.entry.part?.sessionID) as any)?.directory}
      onSessionHref={currentNav?.sessionHref}
      onNavigateToSession={currentNav?.navigateToSession}
    >
      <WorkerPoolProvider pools={getWorkerPools()}>
        <FileComponentProvider component={FileSSR as any}>
          <DialogProvider>
            <ToolDisplay
              id={String(props.entry.part?.id ?? props.entry.tool)}
              tool={props.entry.tool}
              input={(props.entry.state?.input ?? {}) as Record<string, unknown>}
              metadata={(props.entry.state?.metadata ?? {}) as Record<string, unknown>}
              output={props.entry.output ?? ""}
              status={props.entry.status}
              // failed calls must read as failures in every view: ToolDisplay
              // swaps in the error card when status="error" AND error is set
              // (classic passes the same via currentToolError - live-caught:
              // reader showed failed reads as ordinary ones)
              error={
                props.entry.state?.status === "error"
                  ? typeof props.entry.state?.error === "string"
                    ? props.entry.state.error
                    : ((props.entry.state?.error as any)?.message ?? "Failed")
                  : undefined
              }
              // the per-tool natural-open rule + the toggle on top;
              // CONTROLLED open (module store) so remounts keep it and the
              // toggle anchors (close collapses toward the trigger)
              defaultOpen={props.settings.autoExpand.includes(props.entry.tool) || undefined}
              open={open()}
              onOpenChange={(next: boolean) => {
                partOpen.set(entryId(), next)
                settleToggleAnchor()
              }}
            />
          </DialogProvider>
        </FileComponentProvider>
      </WorkerPoolProvider>
    </DataProvider>
  )
}
