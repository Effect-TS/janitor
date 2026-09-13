import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"

/** Inspector: a stack of bordered sections with caption headings. Values
 *  are machine truth in mono; keys sit in a fixed 88px column. */
export const section = <M>(
  h: HtmlBuilder<M>,
  config: {
    readonly heading: string
    readonly className?: string
    readonly children: ReadonlyArray<Html | string>
  },
): Html =>
  h.section(
    [h.Class(cn(config.className)), h.DataAttribute("slot", "inspector-section")],
    [h.h3([h.DataAttribute("slot", "inspector-heading")], [config.heading]), ...config.children],
  )

export const row = <M>(h: HtmlBuilder<M>, key: string, value: Html | string): Html =>
  h.div(
    [h.DataAttribute("slot", "inspector-row")],
    [
      h.span([h.DataAttribute("slot", "inspector-key")], [key]),
      h.span([h.DataAttribute("slot", "inspector-value")], [value]),
    ],
  )

/** Same row, but the value is prose a human wrote, so it stays in Inter. */
export const proseRow = <M>(h: HtmlBuilder<M>, key: string, value: Html | string): Html =>
  h.div(
    [h.DataAttribute("slot", "inspector-row")],
    [
      h.span([h.DataAttribute("slot", "inspector-key")], [key]),
      h.span([h.Class("text-body-sm text-foreground")], [value]),
    ],
  )
