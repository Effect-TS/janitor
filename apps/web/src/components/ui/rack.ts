import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"

/** Section navigation: 26px rows in body-sm. The current item takes the
 *  primary wash with a 2px primary left edge; `aria-current` carries the
 *  state, colour never does alone. */
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

export const rackItemClass =
  "flex h-6.5 items-center border-l-2 border-transparent px-2 text-body-sm text-foreground no-underline transition-colors duration-120 ease-ui hover:bg-surface-muted hover:no-underline aria-[current=page]:border-primary aria-[current=page]:bg-primary-wash aria-[current=page]:font-semibold data-[variant=danger]:text-destructive"

export const rack = <M>(h: HtmlBuilder<M>, config: RackConfig<M>): Html =>
  h.nav(
    [
      h.AriaLabel(config.label),
      h.Class(cn("flex flex-row flex-wrap gap-1 md:flex-col md:gap-0.5", config.className)),
      h.DataAttribute("slot", "section-nav"),
    ],
    config.items.map((item) =>
      h.a(
        [
          h.Href(item.href),
          h.Class(rackItemClass),
          h.AriaCurrent(item.isCurrent ? "page" : "false"),
          ...(item.variant === "danger" ? [h.DataAttribute("variant", "danger")] : []),
          ...(item.attributes ?? []),
        ],
        [item.label],
      ),
    ),
  )
