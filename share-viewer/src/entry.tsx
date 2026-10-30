// @refresh reload
import { render } from "solid-js/web"
import { applySettings, readSettings } from "./settings"
// pre-paint: apply the settings cookie before anything renders (no theme flash)
const __s = readSettings()
applySettings(__s)
import { MetaProvider } from "@solidjs/meta"
import { DialogProvider } from "@opencode/ui/context/dialog"
import { I18nProvider, pluralCategory, pluralKey, type UiI18nParams } from "@opencode/ui/context/i18n"
import { dict as uiEn } from "@opencode/ui/i18n/en"
import { Suspense, lazy } from "solid-js"
import { App } from "./app"
// the gallery is dev-only: a lazy dev-gated import keeps its fixtures out of
// the production bundle (a static import ships them dead)
const Preview = import.meta.env.DEV ? lazy(() => import("./preview").then((m) => ({ default: m.Preview }))) : () => null
// register our tool renderers before anything renders - an entry-level
// import guarantees registration order regardless of which component
// tree mounts first (classic or a skin)
import "./tool-overrides"

import "./app.css"
import "./views/skins.css"
// boot the pierre worker pools now: the kit creates them lazily on first
// card open, which made the first expanded file card paint plain for a beat
import { getWorkerPool } from "@opencode/session-ui/pierre/worker"
import { installOutputResize } from "./output-resize"
import { installSubagentMotion } from "./subagent-motion"
getWorkerPool()
installOutputResize()
installSubagentMotion()

// Provider stack for the vendored v2 kit: en locale only, but with the
// REAL dictionary (raw keys rendering on the page were this bridge
// returning String(key)). v2 needs no MarkedProvider (markdown runs in
// its own worker) and Font is a no-op.
const locale = () => "en" as const

function resolveTemplate(text: string, params?: UiI18nParams) {
  if (!params) return text
  return text.replace(/{{\s*([^}]+?)\s*}}/g, (_, rawKey) => {
    const value = params[String(rawKey)]
    return value === undefined ? "" : String(value)
  })
}

// merged dictionary: the vendored kit calls at least one key upstream's
// own en.ts never defines (ui.tool.todos - upstream bug, report filed;
// live-caught rendering the raw key). Merging here keeps the vendor tree
// pristine - no i18n fork needed.
const dict: Record<string, string> = { ...uiEn, "ui.tool.todos": "Todos" }

const t = (key: keyof typeof uiEn | (string & {}), params?: UiI18nParams) => {
  const value = dict[key as string]
  return resolveTemplate(value ?? String(key), params)
}

const plural = (key: any, count: number, params?: UiI18nParams) =>
  t(pluralKey(key, pluralCategory(locale(), count)) as keyof typeof uiEn, { ...params, count })

render(
  () => (
    <MetaProvider>
      <DialogProvider>
        <I18nProvider value={{ locale, t, plural }}>
          <Suspense>
            {import.meta.env.DEV && new URLSearchParams(location.search).has("preview") ? <Preview /> : <App />}
          </Suspense>
        </I18nProvider>
      </DialogProvider>
    </MetaProvider>
  ),
  document.getElementById("root")!,
)
