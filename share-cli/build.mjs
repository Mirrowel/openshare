// Bundle the CLI to one ESM file (dist/osh.mjs): ink + react are bundled
// in, so the built artifact runs on any Node 20+ with no node_modules.
import { build } from "esbuild"

await build({
  entryPoints: ["src/main.tsx"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  jsx: "automatic",
  outfile: "dist/osh.mjs",
    // CJS deps (signal-exit etc.) require() node builtins; ESM output
    // needs the shim for that
    banner: { js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);" },
    // ink's optional devtools peer is aliased to a stub: eager ESM import
    // resolution would otherwise demand the real package at runtime
    alias: { "react-devtools-core": "./src/devtools-stub.js" },
  logLevel: "info",
})
console.log("built dist/osh.mjs")
