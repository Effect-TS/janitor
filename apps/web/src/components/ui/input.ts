import * as FoldkitInput from "@foldkit/ui/input"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"

/** Recessed control: cream well, 2px outline, inset lip, brightens on focus. */
export const inputClass =
  "border-outline aria-invalid:border-destructive h-8 rounded-sm border-2 bg-card text-card-foreground shadow-[inset_0_2px_0_rgb(18_34_92/0.1)] px-2.5 py-1 text-base transition-colors file:h-6 file:text-sm file:font-medium focus-visible:bg-popover md:text-sm w-full min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50"

/** Same string as the `label` item's component classes (upstream label.tsx). */
/** Upstream string re-keyed for foldkit: the label precedes the control, so
 *  upstream's native peer-disabled sibling variant can never match; disabled
 *  state flows from the wrapper (group/field + data-disabled, mirroring
 *  switch.ts). */
export const inputLabelClass =
  "gap-2 text-label leading-none font-semibold group-data-[disabled]:opacity-50 flex items-center select-none group-data-[disabled]/field:pointer-events-none group-data-[disabled]/field:cursor-not-allowed group-data-[disabled]/field:opacity-50"

export const inputDescriptionClass = "text-sm text-muted-foreground"

export const inputWrapperClass = "group/field flex flex-col gap-1.5 w-full"

export type InputConfig<M> = {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly onInput?: (value: string) => M
  readonly value?: string
  readonly isDisabled?: boolean
  readonly isReadOnly?: boolean
  readonly isInvalid?: boolean
  readonly isAutofocus?: boolean
  readonly name?: string
  readonly type?: string
  readonly placeholder?: string
  readonly className?: string
  readonly labelClass?: string
  readonly descriptionClass?: string
  readonly wrapperClass?: string
  readonly attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
}

/** Styled text input with label and optional description, built on the
 *  @foldkit/ui Input helper. */
export const input = <M>(h: HtmlBuilder<M>, config: InputConfig<M>): Html =>
  FoldkitInput.view<M>(
    {
      id: config.id,
      ...(config.name === undefined ? {} : { name: config.name }),
      ...(config.type === undefined ? {} : { type: config.type }),
      ...(config.value === undefined ? {} : { value: config.value }),
      ...(config.isAutofocus === undefined ? {} : { isAutofocus: config.isAutofocus }),
      ...(config.isDisabled === undefined ? {} : { isDisabled: config.isDisabled }),
      ...(config.isInvalid === undefined ? {} : { isInvalid: config.isInvalid }),
      ...(config.isReadOnly === undefined ? {} : { isReadOnly: config.isReadOnly }),
      ...(config.placeholder === undefined ? {} : { placeholder: config.placeholder }),
      ...(config.onInput === undefined ? {} : { onInput: config.onInput }),
      toView: (attributes) =>
        h.div(
          [
            h.Class(cn(inputWrapperClass, config.wrapperClass)),
            ...(config.isDisabled ? [h.DataAttribute("disabled", "")] : []),
          ],
          [
            h.label(
              [
                ...attributes.label,
                h.DataAttribute("slot", "label"),
                h.Class(cn(inputLabelClass, config.labelClass)),
              ],
              [config.label],
            ),
            h.input([
              ...attributes.input,
              h.DataAttribute("slot", "input"),
              h.Class(cn(inputClass, config.className)),
              ...(config.attributes ?? []),
            ]),
            config.description === undefined
              ? h.empty
              : h.span(
                  [
                    ...attributes.description,
                    h.Class(cn(inputDescriptionClass, config.descriptionClass)),
                  ],
                  [config.description],
                ),
          ],
        ),
    },
    h,
  )
