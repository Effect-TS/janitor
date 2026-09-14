import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"

/** Page chrome from DESIGN.md § Layout: a scrolling main column at 24px
 *  padding and, when the screen has one, a 320px inspector on the right.
 *  Below 1240px the inspector stacks under the main column. */
type Attributes<M> = ReadonlyArray<Attribute<M> | ChildAttribute>

export const layout = <M>(
  h: HtmlBuilder<M>,
  config: {
    readonly main: ReadonlyArray<Html>
    readonly inspector?: ReadonlyArray<Html>
    readonly className?: string
    readonly attributes?: Attributes<M>
  },
): Html =>
  h.div(
    [h.Class(cn("page-layout", config.className)), ...(config.attributes ?? [])],
    [
      h.main([h.Class("page-main")], config.main),
      ...(config.inspector === undefined
        ? []
        : [h.aside([h.Class("page-inspector")], config.inspector)]),
    ],
  )

/** Title and lede on the left, actions bottom-aligned on the right. */
export const header = <M>(
  h: HtmlBuilder<M>,
  config: {
    readonly title: Html | string
    readonly lede?: Html | string
    readonly actions?: ReadonlyArray<Html>
  },
): Html =>
  h.div(
    [h.Class("flex shrink-0 flex-wrap items-end justify-between gap-x-6 gap-y-3")],
    [
      h.div(
        [h.Class("flex max-w-[64ch] flex-col gap-1")],
        [
          typeof config.title === "string" ? h.h1([], [config.title]) : config.title,
          ...(config.lede === undefined
            ? []
            : [h.p([h.Class("text-body-md text-ink-muted")], [config.lede])]),
        ],
      ),
      ...(config.actions === undefined || config.actions.length === 0
        ? []
        : [h.div([h.Class("flex shrink-0 items-center gap-2")], config.actions)]),
    ],
  )

/** One inspector block: caption label above a bordered card. */
export const inspectorCard = <M>(
  h: HtmlBuilder<M>,
  config: {
    readonly heading: string
    readonly className?: string
    readonly flush?: boolean
    readonly children: ReadonlyArray<Html | string>
  },
): Html =>
  h.section(
    [h.Class("flex flex-col gap-2"), h.DataAttribute("slot", "inspector-card")],
    [
      h.h3([h.Class("text-caption font-medium text-ink-subtle")], [config.heading]),
      h.div(
        [
          h.Class(
            cn(
              "rounded-md border border-border bg-card",
              config.flush === true ? "" : "p-3",
              config.className,
            ),
          ),
        ],
        config.children,
      ),
    ],
  )

/** Key in a 96px column, value in mono unless it is prose someone wrote. */
export const kv = <M>(
  h: HtmlBuilder<M>,
  key: string,
  value: Html | string | ReadonlyArray<Html | string>,
  options: { readonly mono?: boolean } = {},
): Html =>
  h.div(
    [h.Class("flex gap-3 py-1.5 text-body-md")],
    [
      h.span([h.Class("w-24 shrink-0 text-ink-muted")], [key]),
      h.span(
        [
          h.Class(
            cn(
              "min-w-0 wrap-anywhere",
              options.mono === false ? "" : "font-mono text-mono-sm leading-5",
            ),
          ),
        ],
        Array.isArray(value) ? (value as ReadonlyArray<Html | string>) : [value as Html | string],
      ),
    ],
  )

/** Rows of `kv` separated by hairlines. */
export const kvList = <M>(h: HtmlBuilder<M>, rows: ReadonlyArray<Html>): Html =>
  h.div([h.Class("flex flex-col divide-y divide-border-subtle")], rows)

/** Card-level footer strip: muted, 40px, mono counts either side. */
export const footerStrip = <M>(
  h: HtmlBuilder<M>,
  left: ReadonlyArray<Html | string>,
  right: ReadonlyArray<Html | string>,
): Html =>
  h.div(
    [
      h.Class(
        "flex h-10 shrink-0 items-center gap-3 border-t border-border bg-surface-muted px-4 text-body-md text-ink-muted",
      ),
    ],
    [h.span([], left), h.span([h.Class("ml-auto")], right)],
  )
