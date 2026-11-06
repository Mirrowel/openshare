import {
  createEffect,
  createMemo,
  createRenderEffect,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  type Accessor,
  type JSX,
} from "solid-js"
import { Option, Schema } from "effect"
import { useI18n } from "@opencode/ui/context/i18n"
import { createStore } from "solid-js/store"
import { Collapsible } from "@opencode/ui/collapsible"
import type { IconProps } from "@opencode/ui/icon"
import { TextShimmer } from "@opencode/ui/text-shimmer"

export type TriggerTitle = {
  title: string
  titleClass?: string
  subtitle?: string
  subtitleClass?: string
  args?: string[]
  argsClass?: string
  action?: JSX.Element
}

const isTriggerTitle = (value: TriggerTitle | JSX.Element): value is TriggerTitle =>
  value instanceof Object && !("nodeType" in value) && "title" in value

export interface BasicToolProps {
  icon: IconProps["name"]
  trigger: TriggerTitle | JSX.Element | ((open: Accessor<boolean>) => JSX.Element)
  children?: JSX.Element
  /** Declare known content without constructing lazy JSX to test its presence. */
  hasContent?: boolean
  status?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  forceOpen?: boolean
  allowOpenWhilePending?: boolean
  defer?: boolean
  locked?: boolean
  /** openshare fork: keepMounted keeps the collapsible content MOUNTED
   *  when closed (forceMount) so a collapse animation can run. */
  keepMounted?: boolean
  /** opt out of the openshare tool-height motion for lazily rendered
   *  file bodies (read/write/edit), which own complex pierre layout
   *  inside shadow roots and use the kit's original instant mounting. */
  pour?: boolean
  rail?: boolean
  onSubtitleClick?: () => void
  onTriggerClick?: JSX.EventHandlerUnion<HTMLElement, MouseEvent>
  onTriggerKeyDown?: JSX.EventHandlerUnion<HTMLElement, KeyboardEvent>
  triggerHref?: string
  triggerAsLink?: boolean
  clickable?: boolean
  compact?: boolean
  /** Rendered beside the trigger rather than inside it, so it can be its own button. Shown on hover or focus. */
  action?: JSX.Element
}

const deferredMounts: Array<{ active: boolean; fn: () => void }> = []

let deferredFrame: number | undefined

function flushDeferredMounts() {
  while (deferredMounts.length > 0) {
    // Timeline tools are mounted top-to-bottom, but the viewport starts at the latest turn.
    // Pop from the end so heavy default-open bodies near the bottom become interactive first.
    const item = deferredMounts.pop()!

    if (item.active) {
      deferredFrame = deferredMounts.length > 0 ? requestAnimationFrame(flushDeferredMounts) : undefined
      item.fn()

      return
    }
  }

  deferredFrame = undefined
}

function scheduleDeferredFlush() {
  if (deferredFrame !== undefined) return
  deferredFrame = requestAnimationFrame(() => {
    deferredFrame = requestAnimationFrame(flushDeferredMounts)
  })
}

function scheduleDeferredMount(fn: () => void) {
  const item = { active: true, fn }
  deferredMounts.push(item)
  scheduleDeferredFlush()

  return () => {
    item.active = false
  }
}

function scheduleFrameMount(fn: () => void) {
  const frame = requestAnimationFrame(fn)

  return () => cancelAnimationFrame(frame)
}

export function BasicTool(props: BasicToolProps) {
  const [state, setState] = createStore({
    open: props.defaultOpen ?? false,
    ready: !props.defer && (props.defaultOpen ?? false),
  })

  const open = () => props.open ?? state.open
  const ready = () => state.ready
  const pending = () => props.status === "streaming" || props.status === "running"
  const hasChildren = () => props.hasContent ?? (props.defer ? "children" in props : props.children)

  // openshare fork (tool pour): opted-in plain tool content stays mounted
  // through collapse so the height transition runs both directions. Lazy
  // pierre file bodies opt out and keep upstream's immediate unmount.
  const [animAlive, setAnimAlive] = createSignal(false)
  let animCloseTimer: ReturnType<typeof setTimeout> | undefined
  let pourRoot: HTMLElement | undefined
  // true only across an OPEN->CLOSED transition: the effect below also
  // runs at mount for every born-closed card, and those must not mark
  // themselves as closing (no wipe ever ran)
  let oshWasOpen = false
  let oshWipeTimer: ReturnType<typeof setTimeout> | undefined
  const pourContent = () => pourRoot?.querySelector(':scope > [data-slot="collapsible-content"]') as HTMLElement | undefined
  onCleanup(() => {
    if (animCloseTimer) clearTimeout(animCloseTimer)
    if (oshWipeTimer) clearTimeout(oshWipeTimer)
  })
  createRenderEffect(
    on(
      open,
      (value) => {
        if (props.pour === false) return
        if (animCloseTimer) {
          clearTimeout(animCloseTimer)
          animCloseTimer = undefined
        }
        if (oshWipeTimer) {
          clearTimeout(oshWipeTimer)
          oshWipeTimer = undefined
        }
        if (value) {
          pourRoot?.removeAttribute("data-osh-closing")
          oshWasOpen = true
          if (!animAlive()) {
            // stage a newly mounted body at 0 before its release below;
            // lazy bodies can mount a few frames after the trigger, so the
            // release retries until content has a real height
            setAnimAlive(true)
            pourRoot?.style.setProperty("--osh-pour-h", "0px")
            let tries = 0
            const release = () => {
              const el = pourContent()
              const h = el?.scrollHeight ?? 0
              if (h > 0 || ++tries > 36) {
                if (el && h > 0) {
                  // Commit the staged zero before the real height: a
                  // shared mount/release frame cannot start a height
                  // transition without a committed old style
                  pourRoot?.style.setProperty("--osh-pour-h", "0px")
                  void el.offsetHeight
                  pourRoot?.style.setProperty("--osh-pour-h", `${h}px`)
                  // Natural height resumes after the pour so later child
                  // growth and output dragging aren't clipped by this value
                  animCloseTimer = setTimeout(() => pourRoot?.style.removeProperty("--osh-pour-h"), 300)
                } else {
                  pourRoot?.style.removeProperty("--osh-pour-h")
                }
                return
              }
              requestAnimationFrame(release)
            }
            requestAnimationFrame(release)
            return
          }
          setAnimAlive(true)
          // reopened while the close was still running: the pinned
          // close-time height must release again or later growth stays
          // trapped at the old measurement
          animCloseTimer = setTimeout(() => pourRoot?.style.removeProperty("--osh-pour-h"), 300)
        } else {
          const wasOpen = oshWasOpen
          oshWasOpen = false
          const h = wasOpen ? (pourContent()?.scrollHeight ?? 0) : 0
          if (h > 0) pourRoot?.style.setProperty("--osh-pour-h", `${h}px`)
          // mark the closing card LATE: the top fade mask only needs to
          // exist for the sweep's final pixels (the remnant forms there),
          // and arming at click fades the card top for the whole close
          if (wasOpen) oshWipeTimer = setTimeout(() => pourRoot?.setAttribute("data-osh-closing", ""), 190)
          animCloseTimer = setTimeout(() => {
            setAnimAlive(false)
            if (oshWipeTimer) clearTimeout(oshWipeTimer)
            pourRoot?.removeAttribute("data-osh-closing")
            pourRoot?.style.removeProperty("--osh-pour-h")
            if (props.defer) setState("ready", false)
            // the last painted frame of the shrinking box can survive the
            // unmount as a 1px compositor remnant; one opacity nudge forces
            // the layer to rebuild (invisible, two frames)
            const row = pourRoot?.closest("[data-row-key],[data-timeline-row]") as HTMLElement | undefined
            if (row) {
              row.style.opacity = "0.999"
              requestAnimationFrame(() => row.style.removeProperty("opacity"))
            }
          }, 420)
        }
      },
      { defer: false },
    ),
  )

  const triggerContent = createMemo(() => {
    const value = props.trigger

    return value instanceof Function ? value(open) : value
  })

  const triggerTitle = createMemo(() => {
    const value = triggerContent()

    return isTriggerTitle(value) ? value : undefined
  })

  const triggerElement = () => {
    const value = triggerContent()

    return isTriggerTitle(value) ? undefined : value
  }

  let cancelReady: (() => void) | undefined

  const cancel = () => {
    cancelReady?.()
    cancelReady = undefined
  }

  const scheduleReady = (initial = false) => {
    cancel()
    cancelReady = (initial ? scheduleDeferredMount : scheduleFrameMount)(() => {
      cancelReady = undefined

      if (!open()) return
      setState("ready", true)
    })
  }

  onCleanup(cancel)

  onMount(() => {
    if (props.defer && open()) scheduleReady(true)
  })

  const setOpen = (value: boolean) => {
    if (props.open === undefined) setState("open", value)
    props.onOpenChange?.(value)
  }

  createEffect(() => {
    if (!props.forceOpen) return

    if (open()) return
    setOpen(true)
  })

  createEffect(
    on(
      open,
      (value) => {
        if (!props.defer) return

        if (!value) {
          cancel()
          // File cards keep upstream's immediate lazy-body disposal; plain
          // tool bodies stay until the collapse has finished
          if (props.pour === false) setState("ready", false)
          return
        }

        scheduleReady()
      },
      { defer: true },
    ),
  )

  const handleOpenChange = (value: boolean) => {
    if (pending() && !props.allowOpenWhilePending) return

    if (props.locked && !value) return
    setOpen(value)
  }

  // openshare fork (tool pour): the render effect above owns all staging;
  // the kit's open handler also keeps its native pending/locked guards

  const trigger = () => (
    <div
      data-component="tool-trigger"
      data-clickable={props.clickable ? "true" : undefined}
      data-hide-details={props.hideDetails ? "true" : undefined}
    >
      <div data-slot="basic-tool-tool-trigger-content">
        <div data-slot="basic-tool-tool-info">
          <Switch>
            <Match when={triggerTitle()}>
              {(title) => (
                <div data-slot="basic-tool-tool-info-structured">
                  <div data-slot="basic-tool-tool-info-main">
                    <span
                      data-slot="basic-tool-tool-title"
                      classList={{
                        [title().titleClass ?? ""]: !!title().titleClass,
                      }}
                    >
                      <TextShimmer text={title().title} active={pending()} />
                    </span>
                    <Show when={!pending() || title().subtitle || title().args?.length}>
                      <Show when={title().subtitle}>
                        <span
                          data-slot="basic-tool-tool-subtitle"
                          classList={{
                            [title().subtitleClass ?? ""]: !!title().subtitleClass,
                            clickable: !!props.onSubtitleClick,
                          }}
                          onClick={(e) => {
                            if (props.onSubtitleClick) {
                              e.stopPropagation()
                              props.onSubtitleClick()
                            }
                          }}
                        >
                          {title().subtitle}
                        </span>
                      </Show>
                      <Show when={title().args?.length}>
                        <For each={title().args}>
                          {(arg) => (
                            <span
                              data-slot="basic-tool-tool-arg"
                              classList={{
                                [title().argsClass ?? ""]: !!title().argsClass,
                              }}
                            >
                              {arg}
                            </span>
                          )}
                        </For>
                      </Show>
                    </Show>
                  </div>
                  <Show when={!pending() && title().action}>
                    <span data-slot="basic-tool-tool-action">{title().action}</span>
                  </Show>
                </div>
              )}
            </Match>
            <Match when={true}>{triggerElement()}</Match>
          </Switch>
        </div>
      </div>
      <Show when={hasChildren() && !props.hideDetails && !props.locked && (!pending() || props.allowOpenWhilePending)}>
        <Collapsible.Arrow />
      </Show>
    </div>
  )

  return (
    <Collapsible
      ref={(el) => (pourRoot = el)}
      // openshare fork: forceMount is a ROOT prop (kobalte reads it in
      // CollapsibleRoot.shouldMount); on Content it is silently ignored.
      // animAlive mounts the content through close animations and the
      // staged pour (see the fork block above); excluded file cards keep
      // the kit's normal lifecycle
      forceMount={props.keepMounted || (props.pour !== false ? animAlive() : undefined) || undefined}
      data-osh-pour={props.pour === false ? undefined : ""}
      open={open()}
      onOpenChange={props.locked ? undefined : handleOpenChange}
      class="tool-collapsible"
      data-compact={props.compact ? "true" : undefined}
      data-rail={props.rail === false ? "false" : undefined}
      data-has-action={props.action ? "true" : undefined}
    >
      <Show
        when={!props.locked && (props.triggerAsLink || props.triggerHref)}
        fallback={
          <Show
            when={!props.locked}
            fallback={
              <div
                data-slot="collapsible-trigger"
                data-locked
                data-hide-details={props.hideDetails ? "true" : undefined}
              >
                {trigger()}
              </div>
            }
          >
            <Collapsible.Trigger
              data-hide-details={props.hideDetails ? "true" : undefined}
              onClick={props.onTriggerClick}
            >
              {trigger()}
            </Collapsible.Trigger>
          </Show>
        }
      >
        <Collapsible.Trigger
          as="a"
          href={props.triggerHref}
          role={!props.triggerHref && props.clickable ? "button" : undefined}
          tabIndex={!props.triggerHref && props.clickable ? 0 : undefined}
          data-hide-details={props.hideDetails ? "true" : undefined}
          onClick={props.onTriggerClick}
          onKeyDown={props.onTriggerKeyDown}
        >
          {trigger()}
        </Collapsible.Trigger>
      </Show>
      <Show when={props.action}>{(action) => <span data-slot="basic-tool-action">{action()}</span>}</Show>
      <Show when={hasChildren() && !props.hideDetails}>
        <Show
          when={props.locked && open() && !props.defer}
          fallback={
            <Collapsible.Content>
              <Show when={!props.defer || ready()}>{props.children}</Show>
            </Collapsible.Content>
          }
        >
          <div data-slot="collapsible-content" data-expanded="">
            {props.children}
          </div>
        </Show>
      </Show>
    </Collapsible>
  )
}

// SAFETY: tool input is an open per-tool record. GenericTool shows arbitrary keys and decodes each value it reads.
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- see SAFETY above
type GenericToolInput = Record<string, unknown>

const labelKeys = ["description", "query", "url", "path", "pattern", "name"]

const labelValue = Schema.decodeUnknownOption(Schema.NonEmptyString)

const argValue = Schema.decodeUnknownOption(Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))

function label(input: GenericToolInput | undefined) {
  return labelKeys.flatMap((key) => Option.toArray(labelValue(input?.[key])))[0]
}

function args(input: GenericToolInput | undefined) {
  if (!input) return []

  return Object.entries(input)
    .filter(([key]) => !labelKeys.includes(key))
    .flatMap(([key, value]) => Option.toArray(argValue(value)).map((arg) => `${key}=${arg}`))
    .slice(0, 3)
}

export function GenericTool(props: { tool: string; status?: string; hideDetails?: boolean; input?: GenericToolInput
  /** openshare fork: generic tools show output */
  output?: string
  metadata?: Record<string, unknown> }) {
  const i18n = useI18n()

  return (
    <BasicTool
      icon="mcp"
      status={props.status}
      trigger={{
        title: props.tool,
        subtitle: label(props.input),
        args: args(props.input),
      }}
      hideDetails={props.hideDetails}
    >
      <Show when={typeof props.output === "string" && props.output}>
        <pre data-component="tool-output" data-scrollable tabIndex={0} class="osh-pre">
          {props.output}
        </pre>
      </Show>
    </BasicTool>
  )
}
