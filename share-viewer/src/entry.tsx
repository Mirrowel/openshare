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
import { Suspense } from "solid-js"
import { App } from "./app"
import "./app.css"
import "./views/skins.css"

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

const t = (key: keyof typeof uiEn, params?: UiI18nParams) => {
  const value = uiEn[key]
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
            <App />
          </Suspense>
        </I18nProvider>
      </DialogProvider>
    </MetaProvider>
  ),
  document.getElementById("root")!,
)
