import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"

/** A mounted cream panel: the one raised treatment every object shares.
 *  `flush` drops the padding so row lists can run edge to edge. */
export const panelClass = "jn-mount bg-card text-card-foreground"

export type PanelConfig<M> = {
  readonly flush?: boolean
  readonly className?: string
  readonly attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
  readonly children: ReadonlyArray<Html | string>
}

export const panel = <M>(h: HtmlBuilder<M>, config: PanelConfig<M>): Html =>
  h.div(
    [
      h.Class(cn(panelClass, config.flush ? "overflow-hidden" : "p-[18px]", config.className)),
      h.DataAttribute("slot", "panel"),
      ...(config.attributes ?? []),
    ],
    config.children,
  )

/** Empty state inside a working panel: dashed top edge, faint hatch, one
 *  sentence naming the action. Never an illustration. */
export const emptyPanel = <M>(h: HtmlBuilder<M>, config: PanelConfig<M>): Html =>
  panel(h, { ...config, className: cn("jn-empty", config.className) })
