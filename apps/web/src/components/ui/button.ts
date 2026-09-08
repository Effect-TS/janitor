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
  default: "bg-primary text-primary-foreground hover:bg-primary/80",
  destructive:
    "bg-destructive/10 hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/20 text-destructive focus-visible:border-destructive/40 dark:hover:bg-destructive/30",
  outline:
    "border-border bg-background hover:bg-muted hover:text-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50 aria-expanded:bg-muted aria-expanded:text-foreground",
  secondary:
    "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
  ghost:
    "hover:bg-muted hover:text-foreground dark:hover:bg-muted/50 aria-expanded:bg-muted aria-expanded:text-foreground",
  link: "text-primary underline-offset-4 hover:underline",
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
  default: "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
  xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
  sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
  lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
  icon: "size-8 p-0",
  "icon-xs":
    "size-6 p-0 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
  "icon-sm":
    "size-7 p-0 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
  "icon-lg": "size-9 p-0",
}

const buttonBase =
  "focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 rounded-lg border border-transparent bg-clip-padding text-sm font-medium focus-visible:ring-3 aria-invalid:ring-3 active:not-aria-[haspopup]:translate-y-px [&_svg:not([class*='size-'])]:size-4 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-disabled:pointer-events-none data-disabled:opacity-50 cursor-pointer"

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
            ...(config.attributes ?? []),
          ],
          config.label === undefined ? [] : [config.label],
        ),
    },
    h,
  )
