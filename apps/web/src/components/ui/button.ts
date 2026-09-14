import { Button as FoldkitButton } from "@foldkit/ui"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"

export type ButtonVariant = (typeof buttonVariantKeys)[number]

export const buttonVariantKeys = [
  "default",
  "destructive",
  "outline",
  "secondary",
  "ghost",
  "link",
] as const

export const buttonVariants: Record<ButtonVariant, string> = {
  // Ops Console: primary is filled blue (interactive), danger is filled for
  // irreversible actions only, outline and secondary are the plain surface
  // button, ghost has no border, link is blue text.
  default:
    "bg-action text-action-foreground border-action hover:bg-action-hover hover:border-action-hover",
  destructive:
    "bg-destructive text-destructive-foreground border-destructive hover:bg-destructive-hover hover:border-destructive-hover",
  outline:
    "bg-card text-foreground border-border hover:bg-surface-muted aria-expanded:bg-surface-muted",
  secondary:
    "bg-card text-foreground border-border hover:bg-surface-muted aria-expanded:bg-surface-muted",
  ghost: "border-transparent bg-transparent hover:bg-surface-muted aria-expanded:bg-surface-muted",
  link: "h-auto border-transparent bg-transparent px-0 text-primary underline-offset-4 hover:underline",
}

export type ButtonSize = (typeof buttonSizeKeys)[number]

export const buttonSizeKeys = [
  "default",
  "xs",
  "sm",
  "lg",
  "icon",
  "icon-xs",
  "icon-sm",
  "icon-lg",
] as const

export const buttonSizes: Record<ButtonSize, string> = {
  default: "h-8 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
  xs: "h-7 gap-1 px-2.5 text-body-sm has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
  sm: "h-7 gap-1 px-2.5 text-body-sm has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
  lg: "h-9 gap-1.5 px-3.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
  icon: "size-8 p-0",
  "icon-xs": "size-7 p-0 [&_svg:not([class*='size-'])]:size-3.5",
  "icon-sm": "size-7 p-0",
  "icon-lg": "size-9 p-0",
}

/** Flat: a 1px border, no shadow. Feedback is the background change plus a
 *  0.96 press scale (styles.css § 9). */
export const buttonBase =
  "aria-invalid:border-destructive rounded-md border text-label font-medium leading-none shadow-none transition-[transform,background-color,border-color,color] duration-120 ease-ui [&_svg:not([class*='size-'])]:size-4 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-disabled:pointer-events-none data-disabled:opacity-50 disabled:pointer-events-none disabled:opacity-50 cursor-pointer"

export type ButtonConfig<M> = {
  readonly type?: "button" | "submit" | "reset" | undefined
  readonly size?: ButtonSize | undefined
  readonly variant?: ButtonVariant | undefined
  readonly className?: string | undefined
  readonly label?: Html | string
  readonly isDisabled?: boolean | undefined
  readonly isAutofocus?: boolean | undefined
  readonly onClick?: M | undefined
  readonly attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
}

export const view = <M>(h: HtmlBuilder<M>, config: ButtonConfig<M>): Html =>
  FoldkitButton.view<M>(
    {
      ...(config.type === undefined ? {} : { type: config.type }),
      ...(config.onClick === undefined ? {} : { onClick: config.onClick }),
      ...(config.isAutofocus === undefined ? {} : { isAutofocus: config.isAutofocus }),
      ...(config.isDisabled === undefined ? {} : { isDisabled: config.isDisabled }),
      toView: (attributes) =>
        h.button(
          [
            ...attributes.button,
            h.Class(
              cn(
                buttonBase,
                "inline-flex items-center justify-center shrink-0 whitespace-nowrap [&_svg]:shrink-0",
                buttonVariants[config.variant ?? "default"],
                buttonSizes[config.size ?? "default"],
                config.className,
              ),
            ),
            h.DataAttribute("slot", "button"),
            h.DataAttribute("size", config.size ?? "default"),
            h.DataAttribute("variant", config.variant ?? "default"),
            ...(config.attributes ?? []),
          ],
          config.label === undefined ? [] : [config.label],
        ),
    },
    h,
  )
