// Compiles the TUI module exactly the family way: @opentui/solid's Bun
// transform (createSolidTransformPlugin). The transform is REQUIRED for
// reactive props — @opentui/solid's runtime pairs with this transform,
// which compiles dynamic attributes into explicit _$effect blocks. tsc's
// automatic-runtime output produces static props (menu selection moves but
// the highlight never repaints) and is only used for typechecking and the
// server-side dist files.
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["src/tui.tsx"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  packages: "external",
  plugins: [createSolidTransformPlugin()],
})

if (result.success) {
  for (const output of result.outputs) console.log(`[build:tui] ${output.path} (${output.size} bytes)`)
} else {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
