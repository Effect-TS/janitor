import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"

/** Card: surface, 1px border, 5px radius, no shadow. `flush` drops the
 *  padding so row lists and tables run edge to edge. Cards do not nest. */
export const panelClass = "rounded-sm border border-border bg-card text-card-foreground"

export type PanelConfig<M> = {
  readonly flush?: boolean
  readonly className?: string
  readonly attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
  readonly children: ReadonlyArray<Html | string>
}

export const panel = <M>(h: HtmlBuilder<M>, config: PanelConfig<M>): Html =>
  h.div(
    [
      h.Class(cn(panelClass, config.flush ? "overflow-hidden" : "p-4", config.className)),
      h.DataAttribute("slot", "card"),
      ...(config.attributes ?? []),
    ],
    config.children,
  )

export type PanelHeaderConfig<M> = {
  readonly title: Html | string
  /** Machine metadata, set in mono. */
  readonly meta?: Html | string
  readonly actions?: ReadonlyArray<Html>
  readonly className?: string
  readonly attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
}

/** Optional header strip: surface-muted, an h3 title, a mono metadata string,
 *  and right-aligned actions. Use inside a `flush` panel. */
export const panelHeader = <M>(h: HtmlBuilder<M>, config: PanelHeaderConfig<M>): Html =>
  h.div(
    [
      h.Class(
        cn(
          "flex min-h-8 items-center gap-2 border-b border-border bg-surface-muted px-3 py-1.5",
          config.className,
        ),
      ),
      h.DataAttribute("slot", "card-header"),
      ...(config.attributes ?? []),
    ],
    [
      h.h3([h.Class("min-w-0 truncate text-h3 font-semibold")], [config.title]),
      ...(config.meta === undefined
        ? []
        : [
            h.span(
              [
                h.Class("min-w-0 truncate font-mono text-mono-sm text-ink-subtle"),
                h.DataAttribute("slot", "card-meta"),
              ],
              [config.meta],
            ),
          ]),
      ...(config.actions === undefined
        ? []
        : [h.div([h.Class("ml-auto flex shrink-0 items-center gap-1.5")], config.actions)]),
    ],
  )

/** Empty state inside a working panel: one sentence naming the action, plus
 *  at most one button. Never an illustration. */
export const emptyPanel = <M>(h: HtmlBuilder<M>, config: PanelConfig<M>): Html =>
  panel(h, { ...config, className: cn("text-body-sm text-ink-muted", config.className) })
