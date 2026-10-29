// Gallery timeline: the production projection + row renderer over fixture
// messages, without the virtualizer. The tool gallery renders single tool
// parts in isolation; this component renders WHOLE message sequences, so the
// gallery can fixture user prompts, reasoning, markdown, math, images,
// transcript structures (agent switch, compaction, retry) and grouping —
// through the same render path a live share uses.
import { For } from "solid-js"
import type { SessionStatus } from "@opencode/client/promise"
import { createReactiveTimelineProjection } from "@opencode/session-ui/timeline/projection"
import { createSessionTimelineRowRenderer } from "@opencode/session-ui/timeline/row"
import { DataProvider } from "@opencode/session-ui/context"
import { SourcesProvider } from "@opencode/session-ui/context/sources"
import { DialogProvider } from "@opencode/ui/context/dialog"
import { FileComponentProvider } from "@opencode/ui/context/file"
import { File } from "@opencode/session-ui/file"
import { createStore } from "solid-js/store"
import { sessionStatus, type ShareData } from "./fold"
import { buildTimelineDetail } from "./timeline-detail"
import type { OshSettings } from "./settings"

export function GalleryTimeline(props: {
  messages: unknown[]
  data: ShareData
  settings: OshSettings
  sessionID?: string
}) {
  const d = () => props.data
  return (
    <DataProvider
      data={{
        session: (d()?.session ?? []) as never,
        session_status: Object.fromEntries((d()?.session ?? []).map((s) => [s.id, sessionStatus(d()?.status ?? "live")])),
        session_diff: (d()?.session_diff ?? {}) as never,
        provider: d()?.provider ?? { all: new Map(), default: {}, connected: [] },
      }}
      directory={(d()?.session[0] as { directory?: string })?.directory}
    >
      <SourcesProvider enabled={false} icons="letters" onOpen={() => {}}>
        <DialogProvider>
          <FileComponentProvider component={File}>
            {/* the renderer factory reads i18n/data/sources contexts at
                CREATION, so it must be constructed inside the provider tree */}
            <GalleryRows messages={props.messages} settings={props.settings} sessionID={props.sessionID} />
          </FileComponentProvider>
        </DialogProvider>
      </SourcesProvider>
    </DataProvider>
  )
}

function GalleryRows(props: { messages: unknown[]; settings: OshSettings; sessionID?: string }) {
  // local disclosure so gallery rows toggle; default open for tool parts is
  // driven by the settings' autoExpand list, same as a real transcript
  const [open, setOpen] = createStore<Record<string, boolean | undefined>>({})
  const projection = createReactiveTimelineProjection({
    sessionMessages: () => props.messages as never,
    status: () => ({ type: "idle" }) as SessionStatus,
    reasoningMode: () => "compact",
    shellToolDefaultOpen: () => false,
    editToolDefaultOpen: () => false,
    timelineDetail: () => buildTimelineDetail(props.settings),
  })
  const renderer = createSessionTimelineRowRenderer({
    sessionID: () => props.sessionID ?? "ses_preview",
    status: () => ({ type: "idle" }) as SessionStatus,
    projection,
    presentation: () => undefined,
    reasoningMode: () => "compact",
    shellToolDefaultOpen: () => false,
    editToolDefaultOpen: () => false,
    toolDefaultOpen: (tool) => (props.settings.autoExpand.includes(tool.name) || undefined) as boolean | undefined,
    timelineDetail: () => buildTimelineDetail(props.settings),
    disclosure: {
      value: (key) => open[key],
      set: (key, next) => setOpen(key, next),
    },
  })
  return (
    <div class="osh-gallery-timeline">
      <For each={projection.rows()}>{(row) => <renderer.Row row={() => row} />}</For>
    </div>
  )
}
