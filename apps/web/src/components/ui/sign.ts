import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"

/** Enamel section sign: a cobalt plate with a mounting screw, set in the
 *  signage face, uppercase. One per section; it sits above its panel. */
export const signClass = "jn-sign font-sign text-sign font-bold uppercase"

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
      h.DataAttribute("slot", "sign"),
      ...(config.attributes ?? []),
    ],
    [h.span([h.Class("jn-screw"), h.AriaHidden(true)], []), ...config.children],
  )
