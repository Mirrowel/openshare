// Open(code)Share — server plugin entry.
//
// Dual-target:
//  - OpenCode v1 invokes the `server` factory with (input, options); the
//    input carries the SDK client, directory and worktree.
//  - OpenCode v2 validates `default` as `{ id, setup }` and calls setup
//    with the v2 plugin context (see v2-server.ts).
// The excess keys are ignored by the other host, so one default export
// serves both loaders.

import { moduleDir } from "./config.js"
import { createEngine, type Engine, type EngineDeps } from "./core.js"
import { createV2ServerSetup } from "./v2-server.js"

export const PLUGIN_ID = "openshare"

type V1PluginInput = {
  client?: EngineDeps["client"]
  directory?: string
  worktree?: string
  [key: string]: unknown
}

export type V1Plugin = (
  input: V1PluginInput,
  options?: Record<string, unknown>,
) => Promise<Engine["hooks"] | Record<string, never>>

export const OpenSharePlugin: V1Plugin = async (input, options) => {
  const deps: EngineDeps = {
    client: input?.client as EngineDeps["client"],
    directory: typeof input?.directory === "string" ? input.directory : undefined,
    worktree: typeof input?.worktree === "string" ? input.worktree : undefined,
    pluginDir: moduleDir(),
    options,
  }
  const engine = createEngine(deps)
  return engine.hooks
}

const server = OpenSharePlugin

export default {
  id: PLUGIN_ID,
  server,
  setup: createV2ServerSetup(),
}
