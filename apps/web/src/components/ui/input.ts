import * as FoldkitInput from "@foldkit/ui/input"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"

/** Input: surface-muted fill, 1px border, 28px tall, brightens to surface
 *  and takes a primary border on focus. */
export const inputClass =
  "h-8 w-full min-w-0 rounded-md border border-border bg-card px-2.5 py-1 text-body-md text-foreground transition-colors duration-120 ease-ui placeholder:text-muted-foreground focus-visible:border-primary focus-visible:bg-card aria-invalid:border-destructive file:inline-flex file:h-5 file:border-0 file:bg-transparent file:text-body-sm file:font-medium file:text-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50"

/** Same string as the `label` item's component classes (upstream label.tsx). */
/** Upstream string re-keyed for foldkit: the label precedes the control, so
 *  upstream's native peer-disabled sibling variant can never match; disabled
 *  state flows from the wrapper (group/field + data-disabled, mirroring
 *  switch.ts). */
export const inputLabelClass =
  "gap-2 text-label leading-none font-medium group-data-[disabled]:opacity-50 flex items-center select-none group-data-[disabled]/field:pointer-events-none group-data-[disabled]/field:cursor-not-allowed group-data-[disabled]/field:opacity-50"

/** Help text sits under its label at foreground-muted, never in a tooltip. */
export const inputDescriptionClass = "text-body-sm text-ink-muted"

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
