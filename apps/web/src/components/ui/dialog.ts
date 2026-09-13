import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"

/** Modal dialog chrome. Pair with `@foldkit/ui/dialog`'s `render` values:
 *  the root `<dialog>` is transparent and fills the viewport, the overlay is
 *  the flat scrim, and the content box carries the only shadow in the system. */
export const dialogRootClass =
  "fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none bg-transparent p-0 text-foreground open:block"

export const dialogOverlayClass = "fixed inset-0 z-50 bg-scrim"

export const dialogContentClass =
  "relative z-50 mx-auto flex max-w-md flex-col gap-3 rounded-sm border border-border bg-popover p-4 text-popover-foreground shadow-overlay"

export const dialogTitleClass = "text-h2 font-semibold"

export const dialogDescriptionClass = "text-body-sm text-ink-muted"

export const dialogActionsClass = "flex justify-end gap-2 pt-1"

type Attributes<M> = ReadonlyArray<Attribute<M> | ChildAttribute>

export type DialogContentConfig<M> = {
  readonly dialog: Attributes<M>
  readonly backdrop: Attributes<M>
  readonly panel: Attributes<M>
  readonly title: Attributes<M>
  readonly description: Attributes<M>
  readonly isVisible: boolean
  readonly titleText: string
  readonly descriptionText: Html | string
  readonly actions: ReadonlyArray<Html>
  readonly className?: string
}

export const view = <M>(h: HtmlBuilder<M>, config: DialogContentConfig<M>): Html =>
  h.dialog(
    [...config.dialog, h.Class(dialogRootClass), h.DataAttribute("slot", "dialog")],
    config.isVisible
      ? [
          h.div(
            [
              ...config.backdrop,
              h.Class(dialogOverlayClass),
              h.DataAttribute("slot", "dialog-overlay"),
            ],
            [],
          ),
          h.div(
            [
              ...config.panel,
              h.Class(cn(dialogContentClass, config.className)),
              h.DataAttribute("slot", "dialog-content"),
            ],
            [
              h.h2([...config.title, h.Class(dialogTitleClass)], [config.titleText]),
              h.p(
                [...config.description, h.Class(dialogDescriptionClass)],
                [config.descriptionText],
              ),
              h.div([h.Class(dialogActionsClass)], config.actions),
            ],
          ),
        ]
      : [],
  )
