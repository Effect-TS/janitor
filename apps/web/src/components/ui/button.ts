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
  // Utility Room: primary is safety yellow, danger is a rust fill with the same
  // hard drop edge, secondary and outline are cream plates, ghost is a dashed
  // outline that does not travel, link is cobalt text.
  default: "bg-primary text-primary-foreground border-outline hover:bg-yellow-safety-dark",
  destructive:
    "bg-rust text-cream-hi border-rust-dark shadow-[0_3px_0_var(--jn-rust-dark)] hover:bg-rust-dark",
  outline: "bg-card text-card-foreground border-outline hover:bg-popover aria-expanded:bg-popover",
  secondary:
    "bg-secondary text-secondary-foreground border-outline hover:bg-popover aria-expanded:bg-popover",
  ghost:
    "border-dashed border-outline/70 bg-transparent shadow-none hover:bg-muted/40 aria-expanded:bg-muted/40 active:not-aria-[haspopup]:translate-y-0",
  link: "border-transparent bg-transparent shadow-none text-cobalt-dark underline underline-offset-4 hover:text-cobalt dark:text-cobalt-light active:not-aria-[haspopup]:translate-y-0",
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
  xs: "h-6 gap-1 px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
  sm: "h-7 gap-1 px-2.5 text-body-sm has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
  lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
  icon: "size-8 p-0",
  "icon-xs": "size-6 p-0 [&_svg:not([class*='size-'])]:size-3",
  "icon-sm": "size-7 p-0",
  "icon-lg": "size-9 p-0",
}

/** Every button is a mounted object: a 2.5px outline and a 3px hard drop edge.
 *  Pressing it travels 3px into the surface and loses the edge. */
const buttonBase =
  "aria-invalid:border-destructive rounded-sm border-[2.5px] border-outline bg-clip-padding text-button font-bold shadow-edge transition-[transform,box-shadow,background-color] duration-100 active:not-aria-[haspopup]:translate-y-[3px] active:not-aria-[haspopup]:shadow-none [&_svg:not([class*='size-'])]:size-4 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-disabled:pointer-events-none data-disabled:opacity-50 disabled:pointer-events-none disabled:opacity-50 cursor-pointer"

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
