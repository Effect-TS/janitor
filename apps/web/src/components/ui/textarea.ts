import { Textarea as FoldkitTextarea } from "@foldkit/ui"
import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"

export const textareaClass =
  "flex field-sizing-content min-h-16 w-full rounded-sm border border-border bg-surface-muted px-2 py-1.5 text-body-md text-foreground transition-colors duration-120 ease-ui placeholder:text-muted-foreground focus-visible:border-primary focus-visible:bg-card aria-invalid:border-destructive aria-disabled:cursor-not-allowed aria-disabled:opacity-50 data-disabled:cursor-not-allowed data-disabled:opacity-50 disabled:cursor-not-allowed disabled:opacity-50"

export const textareaLabelClass =
  "gap-2 text-label leading-none font-medium group-data-[disabled]:opacity-50 flex items-center select-none group-data-[disabled]/field:pointer-events-none group-data-[disabled]/field:cursor-not-allowed group-data-[disabled]/field:opacity-50"

export const textareaDescriptionClass = "text-body-sm text-ink-muted"

export const textareaWrapperClass = "group/field flex flex-col gap-1.5 w-full"

export type TextareaConfig<M> = {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly value?: string
  readonly isDisabled?: boolean
  readonly isReadOnly?: boolean
  readonly isInvalid?: boolean
  readonly isAutofocus?: boolean
  readonly name?: string
  readonly rows?: number
  readonly placeholder?: string
  readonly className?: string
  readonly labelClass?: string
  readonly descriptionClass?: string
  readonly wrapperClass?: string
  readonly onInput?: (value: string) => M
}

export const textarea = <M>(config: TextareaConfig<M>, h: HtmlBuilder<M>): Html => {
  const { label, description, ...props } = config
  return FoldkitTextarea.view<M>(
    {
      ...props,
      toView: (attributes) =>
        h.div(
          [
            h.Class(cn(textareaWrapperClass, config.wrapperClass)),
            ...(config.isDisabled !== undefined ? [h.DataAttribute("disabled", "")] : []),
          ],
          [
            h.label(
              [
                ...attributes.label,
                h.DataAttribute("slot", "label"),
                h.Class(cn(textareaLabelClass, config.labelClass)),
              ],
              [label],
            ),
            h.textarea([
              ...attributes.textarea,
              h.DataAttribute("slot", "textarea"),
              h.Class(cn(textareaClass, config.className)),
            ]),
            description === undefined
              ? h.empty
              : h.span(
                  [
                    ...attributes.description,
                    h.Class(cn(textareaDescriptionClass, config.descriptionClass)),
                  ],
                  [description],
                ),
          ],
        ),
    },
    h,
  )
}
