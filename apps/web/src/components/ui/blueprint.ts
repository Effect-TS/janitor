import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"

/** Blueprint canvas primitives. Graph views only; these must not appear on
 *  ordinary pages. Layout is a left-to-right chain of columns; connectors are
 *  orthogonal SVG segments drawn between columns. */
type Attributes<M> = ReadonlyArray<Attribute<M> | ChildAttribute>

/** The card body: 22px grid, horizontal scroll, never reflows. */
export const canvas = <M>(
  h: HtmlBuilder<M>,
  config: {
    readonly className?: string
    readonly attributes?: Attributes<M>
    readonly children: ReadonlyArray<Html>
  },
): Html =>
  h.div(
    [
      h.Class(cn("oc-canvas overflow-x-auto", config.className)),
      h.DataAttribute("slot", "blueprint-canvas"),
      ...(config.attributes ?? []),
    ],
    [h.div([h.Class("flex w-max min-w-full items-start gap-0 px-6 py-5")], config.children)],
  )

/** A column: caption label above a stack of nodes. */
export const column = <M>(
  h: HtmlBuilder<M>,
  config: {
    readonly label: string
    readonly className?: string
    readonly children: ReadonlyArray<Html>
  },
): Html =>
  h.div(
    [
      h.Class(cn("flex w-64 shrink-0 flex-col gap-3", config.className)),
      h.DataAttribute("slot", "blueprint-column"),
    ],
    [
      h.div([h.Class("text-caption font-medium text-ink-subtle")], [config.label]),
      ...config.children,
    ],
  )

export type NodeConfig<M> = {
  readonly kind: string
  readonly isSelected?: boolean
  /** The Janitor evaluates this node itself (an AI classification). */
  readonly isAgent?: boolean
  readonly className?: string
  readonly attributes?: Attributes<M>
  readonly children: ReadonlyArray<Html | string>
}

/** A step: caption kind label above a mono expression. */
export const node = <M>(h: HtmlBuilder<M>, config: NodeConfig<M>): Html =>
  h.div(
    [
      h.Class(
        cn("oc-node flex flex-col gap-1", config.isAgent && "oc-agent-edge", config.className),
      ),
      h.DataAttribute("slot", "blueprint-node"),
      ...(config.isSelected === true ? [h.DataAttribute("selected", "true")] : []),
      ...(config.attributes ?? []),
    ],
    [
      h.div(
        [h.Class("flex items-center gap-1.5 text-caption font-medium text-ink-subtle")],
        [
          config.kind,
          ...(config.isAgent ? [h.span([h.Class("oc-agent-badge")], ["The Janitor"])] : []),
        ],
      ),
      h.div([h.Class("font-mono text-mono-sm text-foreground")], config.children),
    ],
  )

export type WirePath = {
  readonly fromY: number
  readonly toY: number
  readonly label?: string
}

/** Orthogonal connectors between two columns: a horizontal run, a vertical
 *  drop at the midpoint, and a horizontal run, with junction dots at both
 *  ends. Pass `paths` for a branch; a single path is the default. */
export const wire = <M>(
  h: HtmlBuilder<M>,
  config: {
    readonly height?: number
    readonly fromY?: number
    readonly toY?: number
    readonly label?: string
    readonly paths?: ReadonlyArray<WirePath>
    readonly className?: string
  },
): Html => {
  const paths: ReadonlyArray<WirePath> = config.paths ?? [
    {
      fromY: config.fromY ?? 24,
      toY: config.toY ?? 24,
      ...(config.label === undefined ? {} : { label: config.label }),
    },
  ]
  const height =
    config.height ?? Math.max(48, ...paths.map((path) => Math.max(path.fromY, path.toY) + 24))
  const width = 56
  const mid = width / 2
  return h.div(
    [
      h.Class(cn("relative mt-7 shrink-0", config.className)),
      h.DataAttribute("slot", "blueprint-wire"),
      h.AriaHidden(true),
    ],
    [
      h.svg(
        [
          h.Xmlns("http://www.w3.org/2000/svg"),
          h.Class("block"),
          h.Attribute("width", String(width)),
          h.Attribute("height", String(height)),
          h.ViewBox(`0 0 ${width} ${height}`),
        ],
        paths.flatMap((path) => [
          h.path([
            h.Class("oc-wire"),
            h.Attribute("d", `M0 ${path.fromY} H${mid} V${path.toY} H${width}`),
            h.Attribute("shape-rendering", "crispEdges"),
          ]),
          h.circle([
            h.Class("fill-wire"),
            h.Attribute("cx", "0"),
            h.Attribute("cy", String(path.fromY)),
            h.Attribute("r", "2.6"),
          ]),
          h.circle([
            h.Class("fill-wire"),
            h.Attribute("cx", String(width)),
            h.Attribute("cy", String(path.toY)),
            h.Attribute("r", "2.6"),
          ]),
        ]),
      ),
      ...paths.flatMap((path) =>
        path.label === undefined
          ? []
          : [
              h.span(
                [
                  h.Class("oc-junction absolute left-1/2 -translate-x-1/2 -translate-y-1/2"),
                  h.Style({ top: `${Math.round((path.fromY + path.toY) / 2)}px` }),
                ],
                [path.label],
              ),
            ],
      ),
    ],
  )
}

/** Annotation: a note The Janitor wrote about the graph. Use sparingly. */
export const annotation = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html | string>): Html =>
  h.div([h.Class("oc-annotation"), h.DataAttribute("slot", "blueprint-annotation")], children)

/** Footer bar: controls left, plain summary middle, machine counts right. */
export const footer = <M>(
  h: HtmlBuilder<M>,
  config: {
    readonly controls?: ReadonlyArray<Html>
    readonly summary: string
    readonly counts: string
  },
): Html =>
  h.div(
    [
      h.Class(
        "flex min-h-7 items-center gap-3 border-t border-border bg-surface-muted px-3 py-1 text-body-sm text-ink-muted",
      ),
      h.DataAttribute("slot", "blueprint-footer"),
    ],
    [
      h.div([h.Class("flex items-center gap-1")], config.controls ?? []),
      h.div([h.Class("min-w-0 flex-1 truncate")], [config.summary]),
      h.div([h.Class("font-mono text-mono-xs text-ink-subtle")], [config.counts]),
    ],
  )
