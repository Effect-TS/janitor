import * as FoldkitSwitch from "@foldkit/ui/switch"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"

/** 26×15 switch. Off is a faint track (a non-text mark), on is primary blue.
 *  The label is a real `<label>`; pass `isLabelHidden` to keep it for
 *  assistive technology only. */
export const switchClass =
  "relative inline-flex shrink-0 cursor-pointer items-center rounded-full border-0 bg-ink-faint p-0 transition-colors duration-120 ease-ui aria-checked:bg-primary aria-disabled:cursor-default aria-disabled:opacity-50 disabled:cursor-default disabled:opacity-50"

export const switchThumbClass =
  "block rounded-full bg-card transition-transform duration-120 ease-ui"

export type SwitchConfig<M> = {
  readonly id: string
  readonly label: string
  readonly isChecked: boolean
  readonly isDisabled?: boolean
  readonly isBusy?: boolean
  readonly isLabelHidden?: boolean
  readonly className?: string
  readonly labelClass?: string
  readonly onToggle: (isChecked: boolean) => M
  readonly attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
}

export const view = <M>(h: HtmlBuilder<M>, config: SwitchConfig<M>): Html =>
  FoldkitSwitch.view<M>(
    {
      id: config.id,
      isChecked: config.isChecked,
      ...(config.isDisabled === undefined ? {} : { isDisabled: config.isDisabled }),
      onToggle: config.onToggle,
      toView: (attributes) =>
        h.div(
          [h.Class(cn("inline-flex items-center gap-2", config.className))],
          [
            h.label(
              [
                ...attributes.label,
                h.Class(
                  cn(
                    config.isLabelHidden ? "sr-only" : "cursor-pointer text-body-sm",
                    config.labelClass,
                  ),
                ),
              ],
              [config.label],
            ),
            h.button(
              [
                ...attributes.button,
                h.Class(cn(switchClass, "group/switch")),
                h.DataAttribute("slot", "switch"),
                h.DataAttribute("state", config.isChecked ? "checked" : "unchecked"),
                ...(config.isBusy === undefined ? [] : [h.AriaBusy(config.isBusy)]),
                ...(config.attributes ?? []),
              ],
              [
                h.span(
                  [
                    h.Class(switchThumbClass),
                    h.DataAttribute("slot", "switch-thumb"),
                    h.AriaHidden(true),
                  ],
                  [],
                ),
              ],
            ),
          ],
        ),
    },
    h,
  )
