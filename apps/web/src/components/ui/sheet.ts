import * as FoldkitDialog from "@foldkit/ui/dialog"
import type { AnchorConfig } from "@foldkit/ui/anchor"
import type { Attribute, ChildAttribute, HtmlBuilder, Html } from "foldkit/html"
import { cn } from "@/lib/utils"

export const Model = FoldkitDialog.Model
export type Model = FoldkitDialog.Model

export const Message = FoldkitDialog.Message
export type Message = FoldkitDialog.Message

export const OutMessage = FoldkitDialog.OutMessage
export type OutMessage = FoldkitDialog.OutMessage

export type InitConfig = FoldkitDialog.InitConfig

export type RenderInfo = FoldkitDialog.RenderInfo

export type ViewInputs = FoldkitDialog.ViewInputs

export const init = (config: InitConfig): Model =>
  FoldkitDialog.init({
    isAnimated: true,
    ...config,
  })

export const update = FoldkitDialog.update

export const open = FoldkitDialog.open

export const close = FoldkitDialog.close

export const titleId = FoldkitDialog.titleId

export const descriptionId = FoldkitDialog.descriptionId

export const view = FoldkitDialog.view

export type Side = "top" | "bottom" | "left" | "right"

const baseAnchorConfig = {
  gap: 0,
  padding: 0,
}

export const SHEET_ANCHOR = {
  top: { ...baseAnchorConfig, placement: "top" },
  bottom: { ...baseAnchorConfig, placement: "bottom" },
  left: { ...baseAnchorConfig, placement: "left" },
  right: { ...baseAnchorConfig, placement: "right" },
} as const satisfies Record<Side, AnchorConfig>

type Child = string | Html

type StyleConfig<M> = {
  readonly className?: string
  readonly attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
}

// HEADER

export type HeaderConfig<M> = StyleConfig<M> & {
  readonly children: ReadonlyArray<Child>
}

const headerClass = "gap-0.5 p-4 flex flex-col"

export const header = <M>(h: HtmlBuilder<M>, config: HeaderConfig<M>): Html =>
  h.div(
    [
      ...(config.attributes ?? []),
      h.DataAttribute("slot", "sheet-header"),
      h.Class(cn(headerClass, config.className)),
    ],
    config.children,
  )

// TITLE

export type TitleConfig<M> = StyleConfig<M> & {
  readonly children: ReadonlyArray<Child>
}

const titleClass = "text-foreground text-base font-medium font-sans"

export const title = <M>(h: HtmlBuilder<M>, config: TitleConfig<M>): Html =>
  h.div(
    [
      ...(config.attributes ?? []),
      h.DataAttribute("slot", "sheet-title"),
      h.Class(cn(titleClass, config.className)),
    ],
    config.children,
  )

// DESCRIPTION

export type DescriptionConfig<M> = StyleConfig<M> & {
  readonly children: ReadonlyArray<Child>
}

const descriptionClass = "text-muted-foreground text-sm"

export const description = <M>(h: HtmlBuilder<M>, config: DescriptionConfig<M>): Html =>
  h.div(
    [
      ...(config.attributes ?? []),
      h.DataAttribute("slot", "sheet-description"),
      h.Class(cn(descriptionClass, config.className)),
    ],
    config.children,
  )

// FOOTER

export type FooterConfig<M> = StyleConfig<M> & {
  readonly children: ReadonlyArray<Child>
}

const footerClass = "gap-2 p-4 mt-auto flex flex-col"

export const footer = <M>(h: HtmlBuilder<M>, config: FooterConfig<M>): Html =>
  h.div(
    [
      ...(config.attributes ?? []),
      h.DataAttribute("slot", "sheet-footer"),
      h.Class(cn(footerClass, config.className)),
    ],
    config.children,
  )

// CLOSE BUTTON

export type CloseButtonConfig<M> = StyleConfig<M> & {
  readonly children: ReadonlyArray<Child>
}

const closeButtonClass =
  "absolute top-3 right-3 focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 border border-transparent bg-clip-padding text-sm font-medium focus-visible:ring-3 aria-invalid:ring-3 active:not-aria-[haspopup]:translate-y-px [&_svg:not([class*='size-'])]:size-4 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-disabled:pointer-events-none data-disabled:opacity-50 hover:bg-muted hover:text-foreground dark:hover:bg-muted/50 aria-expanded:bg-muted aria-expanded:text-foreground size-7 rounded-sm"

export const closeButton = <M>(h: HtmlBuilder<M>, config: CloseButtonConfig<M>): Html =>
  h.div(
    [
      ...(config.attributes ?? []),
      h.DataAttribute("slot", "sheet-close"),
      h.Class(cn(closeButtonClass, config.className)),
    ],
    config.children,
  )

export type SheetContent<M> = {
  readonly title: ReadonlyArray<Attribute<M> | ChildAttribute>
  readonly description: ReadonlyArray<Attribute<M> | ChildAttribute>
  readonly closeButton: ReadonlyArray<Attribute<M> | ChildAttribute>
}

export type StyledViewInputs<M> = {
  readonly side?: Side
  readonly className?: string
  readonly backdropClass?: string
  readonly panelClass?: string
  readonly content: (h: HtmlBuilder<M>, render: SheetContent<M>) => ReadonlyArray<Child>
}

const backdropClass =
  "bg-navy-deep/55 data-enter:opacity-0 data-leave:opacity-0 fixed inset-0 z-50 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0"

const motionClass =
  "data-ending-style:opacity-0 data-starting-style:opacity-0 data-[side=bottom]:data-ending-style:translate-y-[2.5rem] data-[side=bottom]:data-starting-style:translate-y-[2.5rem] data-[side=left]:data-ending-style:translate-x-[-2.5rem] data-[side=left]:data-starting-style:translate-x-[-2.5rem] data-[side=right]:data-ending-style:translate-x-[2.5rem] data-[side=right]:data-starting-style:translate-x-[2.5rem] data-[side=top]:data-ending-style:translate-y-[-2.5rem] data-[side=top]:data-starting-style:translate-y-[-2.5rem]"

const panelClass = {
  top: "bg-card text-card-foreground border-outline fixed z-50 flex flex-col gap-4 bg-clip-padding text-sm shadow-mount transition duration-200 ease-in-out data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t-[3px] data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r-[3px] data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l-[3px] data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b-[3px] data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm data-enter:opacity-0 data-leave:opacity-0 data-[side=bottom]:data-enter:translate-y-[2.5rem] data-[side=bottom]:data-leave:translate-y-[2.5rem] data-[side=left]:data-enter:translate-x-[-2.5rem] data-[side=left]:data-leave:translate-x-[-2.5rem] data-[side=right]:data-enter:translate-x-[2.5rem] data-[side=right]:data-leave:translate-x-[2.5rem] data-[side=top]:data-enter:translate-y-[-2.5rem] data-[side=top]:data-leave:translate-y-[-2.5rem]",
  bottom:
    "bg-card text-card-foreground border-outline fixed z-50 flex flex-col gap-4 bg-clip-padding text-sm shadow-mount transition duration-200 ease-in-out data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t-[3px] data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r-[3px] data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l-[3px] data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b-[3px] data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm data-enter:opacity-0 data-leave:opacity-0 data-[side=bottom]:data-enter:translate-y-[2.5rem] data-[side=bottom]:data-leave:translate-y-[2.5rem] data-[side=left]:data-enter:translate-x-[-2.5rem] data-[side=left]:data-leave:translate-x-[-2.5rem] data-[side=right]:data-enter:translate-x-[2.5rem] data-[side=right]:data-leave:translate-x-[2.5rem] data-[side=top]:data-enter:translate-y-[-2.5rem] data-[side=top]:data-leave:translate-y-[-2.5rem]",
  left: "bg-card text-card-foreground border-outline fixed z-50 flex flex-col gap-4 bg-clip-padding text-sm shadow-mount transition duration-200 ease-in-out data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t-[3px] data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r-[3px] data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l-[3px] data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b-[3px] data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm data-enter:opacity-0 data-leave:opacity-0 data-[side=bottom]:data-enter:translate-y-[2.5rem] data-[side=bottom]:data-leave:translate-y-[2.5rem] data-[side=left]:data-enter:translate-x-[-2.5rem] data-[side=left]:data-leave:translate-x-[-2.5rem] data-[side=right]:data-enter:translate-x-[2.5rem] data-[side=right]:data-leave:translate-x-[2.5rem] data-[side=top]:data-enter:translate-y-[-2.5rem] data-[side=top]:data-leave:translate-y-[-2.5rem]",
  right:
    "bg-card text-card-foreground border-outline fixed z-50 flex flex-col gap-4 bg-clip-padding text-sm shadow-mount transition duration-200 ease-in-out data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t-[3px] data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r-[3px] data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l-[3px] data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b-[3px] data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm data-enter:opacity-0 data-leave:opacity-0 data-[side=bottom]:data-enter:translate-y-[2.5rem] data-[side=bottom]:data-leave:translate-y-[2.5rem] data-[side=left]:data-enter:translate-x-[-2.5rem] data-[side=left]:data-leave:translate-x-[-2.5rem] data-[side=right]:data-enter:translate-x-[2.5rem] data-[side=right]:data-leave:translate-x-[2.5rem] data-[side=top]:data-enter:translate-y-[-2.5rem] data-[side=top]:data-leave:translate-y-[-2.5rem]",
} as const satisfies Record<Side, string>

export const styledViewInputs = <M>(
  h: HtmlBuilder<M>,
  viewInputs: StyledViewInputs<M>,
): ViewInputs => {
  const side = viewInputs.side ?? "right"
  return {
    toView: ({ backdrop, closeButton, description, dialog, isVisible, panel, title }) =>
      h.dialog(
        [...dialog, h.Class(cn("p-0 bg-transparent open:block", viewInputs.className))],
        isVisible
          ? [
              h.div([
                ...backdrop,
                h.DataAttribute("slot", "sheet-overlay"),
                h.Class(cn(backdropClass, viewInputs.backdropClass)),
              ]),
              h.div(
                [
                  ...panel,
                  h.DataAttribute("slot", "sheet-content"),
                  h.DataAttribute("side", side),
                  h.Class(cn(panelClass[side], motionClass, viewInputs.panelClass)),
                ],
                viewInputs.content(h, { closeButton, title, description }),
              ),
            ]
          : [],
      ),
  }
}
