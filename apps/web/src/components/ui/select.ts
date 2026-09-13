import * as FoldkitSelect from "@foldkit/ui/select"
import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"
import { inputLabelClass, inputDescriptionClass, inputWrapperClass } from "./input"

/** Native select styled like an input: surface-muted fill, 1px border, 28px. */
export const selectClass =
  "h-7 w-full min-w-0 appearance-none rounded-sm border border-border bg-surface-muted pr-7 pl-2 text-body-md text-foreground outline-none transition-colors duration-120 ease-ui focus-visible:border-primary focus-visible:bg-card aria-invalid:border-destructive disabled:cursor-not-allowed disabled:opacity-50"

export type SelectConfig<M> = {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly value: string
  readonly options: ReadonlyArray<readonly [string, string]>
  readonly isDisabled?: boolean
  readonly isLabelHidden?: boolean
  readonly className?: string
  readonly wrapperClass?: string
  readonly onChange: (value: string) => M
}

const chevron = <M>(h: HtmlBuilder<M>): Html =>
  h.svg(
    [
      h.AriaHidden(true),
      h.Class(
        "pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground",
      ),
      h.Xmlns("http://www.w3.org/2000/svg"),
      h.Fill("none"),
      h.ViewBox("0 0 24 24"),
      h.StrokeWidth("1.5"),
      h.Stroke("currentColor"),
      h.StrokeLinecap("round"),
      h.StrokeLinejoin("round"),
    ],
    [h.path([h.Attribute("d", "m6 9 6 6 6-6")])],
  )

export const view = <M>(h: HtmlBuilder<M>, config: SelectConfig<M>): Html =>
  FoldkitSelect.view<M>(
    {
      id: config.id,
      value: config.value,
      ...(config.isDisabled === undefined ? {} : { isDisabled: config.isDisabled }),
      onChange: config.onChange,
      toView: (attributes) =>
        h.div(
          [h.Class(cn(inputWrapperClass, config.wrapperClass))],
          [
            h.label(
              [
                ...attributes.label,
                h.DataAttribute("slot", "label"),
                h.Class(cn(inputLabelClass, config.isLabelHidden && "sr-only")),
              ],
              [config.label],
            ),
            h.div(
              [h.Class("relative")],
              [
                h.select(
                  [
                    ...attributes.select,
                    h.DataAttribute("slot", "select-trigger"),
                    h.Class(cn(selectClass, config.className)),
                  ],
                  config.options.map(([value, text]) =>
                    h.option([h.Value(value), h.Selected(value === config.value)], [text]),
                  ),
                ),
                chevron(h),
              ],
            ),
            config.description === undefined
              ? h.empty
              : h.span([h.Class(inputDescriptionClass)], [config.description]),
          ],
        ),
    },
    h,
  )
