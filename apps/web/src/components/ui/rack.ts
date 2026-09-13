import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"

/** Hook rack: a steel rail with two screw heads and key tags hanging below.
 *  Navigation you take down and carry. The current tag is yellow and hangs
 *  straight; `aria-current` carries the state, colour never does alone. */
export type RackItem<M> = {
  readonly href: string
  readonly label: string
  readonly isCurrent: boolean
  readonly variant?: "default" | "danger"
  readonly attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
}

export type RackConfig<M> = {
  readonly label: string
  readonly items: ReadonlyArray<RackItem<M>>
  readonly className?: string
}

export const rackRailClass = "jn-steel relative mb-3.5 h-3.5 rounded-xs"
const screwClass = "absolute top-0.5 size-1.5 rounded-full bg-navy-deep"

export const rack = <M>(h: HtmlBuilder<M>, config: RackConfig<M>): Html =>
  h.div(
    [h.Class(cn("flex flex-col", config.className)), h.DataAttribute("slot", "rack")],
    [
      h.div(
        [h.Class(rackRailClass), h.AriaHidden(true)],
        [
          h.span([h.Class(cn(screwClass, "left-3"))], []),
          h.span([h.Class(cn(screwClass, "right-3"))], []),
        ],
      ),
      h.nav(
        [h.AriaLabel(config.label), h.Class("flex flex-row flex-wrap gap-3 px-1 md:flex-col")],
        config.items.map((item) =>
          h.a(
            [
              h.Href(item.href),
              h.Class("jn-tag text-body-sm"),
              h.AriaCurrent(item.isCurrent ? "page" : "false"),
              ...(item.variant === "danger" ? [h.DataAttribute("variant", "danger")] : []),
              ...(item.attributes ?? []),
            ],
            [item.label],
          ),
        ),
      ),
    ],
  )
