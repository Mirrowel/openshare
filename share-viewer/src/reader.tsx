import type { JSX } from "solid-js"

// Switching presentation keeps the conversation and its disclosure state mounted.
export function ReaderView(props: { active: boolean; children: JSX.Element }) {
  return <div class="flex flex-col flex-1 min-h-0 min-w-0 w-full" classList={{ "osh-reader": props.active }}>{props.children}</div>
}
