import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"

/** Section heading. Sentence case h2, one per section, above its card. */
export const signClass = "text-h2 font-semibold"

export type SignConfig<M> = {
  readonly id?: string
  readonly className?: string
  readonly attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
  readonly children: ReadonlyArray<Html | string>
}

export const sign = <M>(h: HtmlBuilder<M>, config: SignConfig<M>): Html =>
  h.h2(
    [
      ...(config.id === undefined ? [] : [h.Id(config.id)]),
      h.Class(cn(signClass, config.className)),
      h.DataAttribute("slot", "section-heading"),
      ...(config.attributes ?? []),
    ],
    config.children,
  )
