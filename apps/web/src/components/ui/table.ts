import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"

/** Dense table. 28px rows, caption column heads, border-subtle dividers,
 *  hover and selection as the row affordances. Numeric columns pass
 *  `numeric` and are right-aligned and tabular; machine values pass `code`. */
type Attributes<M> = ReadonlyArray<Attribute<M> | ChildAttribute>

export const tableClass = "w-full border-collapse text-body-md tabular-nums"

export const table = <M>(
  h: HtmlBuilder<M>,
  config: {
    readonly className?: string
    readonly attributes?: Attributes<M>
    readonly children: ReadonlyArray<Html>
  },
): Html =>
  h.table(
    [
      h.Class(cn(tableClass, config.className)),
      h.DataAttribute("slot", "table"),
      ...(config.attributes ?? []),
    ],
    config.children,
  )

export const head = <M>(h: HtmlBuilder<M>, rows: ReadonlyArray<Html>): Html =>
  h.thead([h.DataAttribute("slot", "table-header")], rows)

export const body = <M>(h: HtmlBuilder<M>, rows: ReadonlyArray<Html>): Html =>
  h.tbody([h.DataAttribute("slot", "table-body")], rows)

export type RowConfig<M> = {
  readonly isSelected?: boolean
  readonly className?: string
  readonly attributes?: Attributes<M>
  readonly children: ReadonlyArray<Html>
}

export const row = <M>(h: HtmlBuilder<M>, config: RowConfig<M>): Html =>
  h.tr(
    [
      h.DataAttribute("slot", "table-row"),
      ...(config.isSelected === true ? [h.Attribute("aria-selected", "true")] : []),
      h.Class(cn(config.className)),
      ...(config.attributes ?? []),
    ],
    config.children,
  )

export type CellConfig<M> = {
  readonly numeric?: boolean
  readonly code?: boolean
  readonly className?: string
  readonly attributes?: Attributes<M>
  readonly children: ReadonlyArray<Html | string>
}

export const headCell = <M>(h: HtmlBuilder<M>, config: CellConfig<M>): Html =>
  h.th(
    [
      h.DataAttribute("slot", "table-head"),
      h.Attribute("scope", "col"),
      ...(config.numeric === true ? [h.DataAttribute("numeric", "")] : []),
      h.Class(cn(config.className)),
      ...(config.attributes ?? []),
    ],
    config.children,
  )

export const cell = <M>(h: HtmlBuilder<M>, config: CellConfig<M>): Html =>
  h.td(
    [
      h.DataAttribute("slot", "table-cell"),
      ...(config.numeric === true ? [h.DataAttribute("numeric", "")] : []),
      ...(config.code === true ? [h.DataAttribute("code", "")] : []),
      h.Class(cn(config.className)),
      ...(config.attributes ?? []),
    ],
    config.children,
  )
