// reader: the editorial skin over the shared base - hover-TOC navigation,
// quiet section markers, continuous-leaning single column.
import { For, Show, createSignal } from "solid-js"
import { BaseSessionView } from "./views/base-view"
import { useView } from "./views/view-context"
import { SkinHeader } from "./views/chrome"
import type { Skin, SkinWrappers } from "./views/base-view"
import type { ViewEntry } from "./views/registry"
import { SkinSettingsPopover } from "./settings-panel"
import { sessionToolNamesOf } from "./views/session-data"
import { BrandMark } from "./views/chrome"
import { MetaLine } from "./views/meta-line"

function promptTitle(s: { prompt: string }) {
  return s.prompt.trim().split("\n")[0].slice(0, 60) || "(no prompt)"
}

function HoverToc(props: Parameters<NonNullable<SkinWrappers["Nav"]>>[0]) {
  return (
    <div class="w-48 flex flex-col gap-0.5">
      <div class="text-12-medium text-text-weaker tracking-[0.14em] uppercase mb-2 px-2">prompts</div>
      <For each={props.sections}>
        {(s, i) => (
          <button
            class="flex items-baseline gap-2 py-1 px-2 rounded-md text-left bg-transparent border-none cursor-pointer transition-colors duration-150"
            classList={{ "bg-surface-base": props.active === i() }}
            onClick={() => props.onSelect(i())}
          >
            <span class="text-12-mono shrink-0" classList={{ "text-text-strong": props.active === i(), "text-text-weaker": props.active !== i() }}>
              {String(i() + 1).padStart(2, "0")}
            </span>
            <span class="text-12-regular truncate" classList={{ "text-text-base": props.active === i(), "text-text-weaker": props.active !== i() }}>
              {promptTitle(s)}
            </span>
          </button>
        )}
      </For>
    </div>
  )
}

// reader owns the FULL header (the classic chrome bar is hidden for reader,
// which duplicates this row): branding mark, title, version/model/status,
// copy, GitHub and the settings trigger all ride SkinHeader once
function ReaderHeader(props: Parameters<NonNullable<SkinWrappers["Header"]>>[0]) {
  const view = useView()
  const b = () => view.source.branding()
  return (
    <SkinHeader
      class="h-14 px-6 self-stretch bg-background-base border-b border-border-weak-base relative z-30"
      leadClass="flex items-center gap-3 min-w-0"
      titleClass="text-16-medium text-text-strong truncate"
      afterBack={
        <Show
          when={b().logoUrl && b().linkUrl}
          fallback={
            <Show when={b().logoUrl}>
              <span class="p-0.5 flex items-center rounded-md border border-border-weak-base bg-background-base">
                <BrandMark branding={b()} class="h-5 rounded" />
              </span>
            </Show>
          }
        >
          {(href) => (
            <a href={href()} target="_blank" rel="noreferrer" class="p-0.5 flex items-center rounded-md border border-border-weak-base bg-background-base hover:border-border-strong-base" title={b().name || ""}>
              <BrandMark branding={b()} class="h-5 rounded" />
            </a>
          )}
        </Show>
      }
      settingsTrigger={
        <SkinSettingsPopover
          settings={view.settings}
          update={view.updateSettings}
          branding={b()}
          search={view.search}
          onSearch={view.onSearch}
          sessionTools={sessionToolNamesOf(view.data, view.sessionID)}
        />
      }
    />
  )
}

export const readerSkin: Skin = {
  id: "reader",
  columnClass: "max-w-[46rem] mx-auto px-6 py-8 flex flex-col gap-10",
  wrappers: {
    Header: ReaderHeader,
    Nav: HoverToc,
    PromptWrap: (p) => (
      <div class="pt-4 border-t border-border-weak-base first:border-none first:pt-0">
        <div class="flex items-baseline gap-3 mb-1">
          <span class="text-12-mono text-text-weaker">§</span>
          {p.children}
        </div>
      </div>
    ),
  },
}

export function ReaderView(props: Parameters<ViewEntry["component"]>[0]) {
  return <BaseSessionView {...props} skin={readerSkin} />
}
