import * as Effect from "effect/Effect"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Command from "foldkit/command"
import { defineMessageUnion } from "foldkit/message"
import {
  childAttributes,
  type Attribute,
  type ChildAttribute,
  type Html,
  type HtmlBuilder,
} from "foldkit/html"
import { evo } from "foldkit/struct"
import * as Subscription from "foldkit/subscription"
import { defineView, type View } from "foldkit/submodel"
import * as Update from "foldkit/update"
import type { ButtonSize, ButtonVariant } from "@/components/ui/button"
import { inputClass } from "@/components/ui/input"
import * as Sheet from "@/components/ui/sheet"
import { skeletonClass } from "@/components/ui/skeleton"
import * as Icon from "@/lib/icons"
import { cn } from "@/lib/utils"
import { PanelLeft } from "lucide"

export const SIDEBAR_KEYBOARD_SHORTCUT = "b"

export const SIDEBAR_WIDTH = "16rem"

export const SIDEBAR_WIDTH_MOBILE = "18rem"

export const SIDEBAR_WIDTH_ICON = "3rem"

export const SIDEBAR_MOBILE_MEDIA_QUERY = "(max-width: 767px)"

export type Collapsible = "offcanvas" | "icon" | "none"

export type Side = "left" | "right"

export type Variant = "floating" | "inset" | "sidebar"

export const Message = defineMessageUnion({
  Toggled: {},
  SetIsOpen: { isOpen: Schema.Boolean },
  SetIsMobile: { isMobile: Schema.Boolean },
  GotSheetMessage: { message: Sheet.Message },
})
export type Message = typeof Message.Type

export const Model = Schema.Struct({
  isOpen: Schema.Boolean,
  isMobile: Schema.Boolean,
  sheet: Sheet.Model,
})
export type Model = typeof Model.Type

export type InitConfig = {
  /**
   * Unique id for this sidebar instance (names the embedded mobile sheet).
   */
  readonly id: string
  /**
   * Whether or not the sidebar should be expanded initially on desktop.
   *
   * Defaults to `true`.
   */
  readonly defaultOpen?: boolean
}

export const init = (config: InitConfig): Model => ({
  isOpen: config.defaultOpen ?? true,
  isMobile: false,
  sheet: Sheet.init({ id: `${config.id}-mobile-sidebar-sheet` }),
})

export type State = "expanded" | "collapsed"

export const state = (model: Model): State => (model.isOpen ? "expanded" : "collapsed")

export const setOpen = (model: Model, isOpen: boolean): Model =>
  evo(model, { isOpen: () => isOpen })

const mapSheet = (
  model: Model,
  update: Update.ReturnWithOutMessage<Sheet.Model, Sheet.Message, Sheet.OutMessage>,
): Update.Return<Model, Message> => ({
  model: evo(model, { sheet: () => update.model }),
  commands: Command.mapMessages(update.commands, (message) => Message.GotSheetMessage({ message })),
})

export const openMobile = (model: Model): Update.Return<Model, Message> =>
  mapSheet(model, Sheet.open(model.sheet))

export const closeMobile = (model: Model): Update.Return<Model, Message> =>
  mapSheet(model, Sheet.close(model.sheet))

export const toggle = (model: Model): Update.Return<Model, Message> =>
  model.isMobile
    ? model.sheet.isOpen
      ? closeMobile(model)
      : openMobile(model)
    : { model: setOpen(model, !model.isOpen) }

const foldNoOpStep = (): Update.Step<Model, Message> => (model) => ({ model })

const foldSheetOutMessage = Match.type<Sheet.OutMessage>().pipe(
  Match.withReturnType<Update.Step<Model, Message>>(),
  Match.tagsExhaustive({
    Opened: foldNoOpStep,
    Closed: foldNoOpStep,
  }),
)

const foldSheet = Update.foldChild({
  update: Sheet.update,
  read: (model: Model) => Option.some(model.sheet),
  write: (model, next) => evo(model, { sheet: () => next }),
  toParentMessage: (message) => Message.GotSheetMessage({ message }),
  foldOutMessage: foldSheetOutMessage,
})

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match(message, {
    Toggled: () => toggle(model),
    SetIsOpen: ({ isOpen }) => ({ model: setOpen(model, isOpen) }),
    SetIsMobile: ({ isMobile }) => ({ model: evo(model, { isMobile: () => isMobile }) }),
    GotSheetMessage: ({ message }) => foldSheet(model, message),
  })

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  keyboardShortcut: entry(
    { isListening: Schema.Boolean },
    {
      modelToDependencies: () => ({ isListening: true }),
      dependenciesToStream: ({ isListening }) =>
        Subscription.fromEventFilterMap<KeyboardEvent, Message>({
          target: window,
          type: "keydown",
          toMessage: (event) => {
            if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              return Option.some(Message.Toggled())
            }
            return Option.none()
          },
        }).pipe(Stream.when(Effect.sync(() => isListening))),
    },
  ),
  mediaQuery: entry(
    { isListening: Schema.Boolean },
    {
      modelToDependencies: () => ({ isListening: true }),
      dependenciesToStream: ({ isListening }) =>
        Stream.callback<Message>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const mediaQuery = window.matchMedia(SIDEBAR_MOBILE_MEDIA_QUERY)
              const handler = (event: MediaQueryListEvent) => {
                const message = Message.SetIsMobile({ isMobile: event.matches })
                Queue.offerUnsafe(queue, message)
              }
              mediaQuery.addEventListener("change", handler)
              // Emit once on subscribe so that a mobile viewport corrects the
              // desktop default right after mount
              const message = Message.SetIsMobile({ isMobile: mediaQuery.matches })
              Queue.offerUnsafe(queue, message)
              return { handler, mediaQuery }
            }),
            ({ handler, mediaQuery }) =>
              Effect.sync(() => {
                mediaQuery.removeEventListener("change", handler)
              }),
          ).pipe(Effect.andThen(Effect.never)),
        ).pipe(Stream.when(Effect.sync(() => isListening))),
    },
  ),
}))

type Child = string | Html

type Attributes<M> = ReadonlyArray<Attribute<M> | ChildAttribute>

export type SidebarSlots = {
  readonly isOpen: boolean
  readonly isMobile: boolean
  readonly state: State
  /**
   * Spread onto a control (i.e. `Sidebar.toggle`) to toggle.
   */
  readonly trigger: ReadonlyArray<ChildAttribute>
  /**
   * Spread onto `Sidebar.rail` to make the hot-spot clickable.
   */
  readonly rail: ReadonlyArray<ChildAttribute>
}

export type ViewInputs = {
  readonly className?: string
  readonly collapsible?: Collapsible
  readonly side?: Side
  readonly variant?: Variant
  /**
   * The content wrapped by the sidebar.
   */
  readonly children: (slots: SidebarSlots) => ReadonlyArray<Child>
  /**
   * The content inside the sidebar.
   */
  readonly content: (slots: SidebarSlots) => ReadonlyArray<Child>
}

type Padding = "docked" | "padded"

export const sidebarProviderClass =
  "group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar"

export const sidebarShellClass = "group peer hidden text-sidebar-foreground md:block"

export const sidebarMobilePanelClass =
  "bg-sidebar p-0 text-sidebar-foreground [&>button]:hidden [--sidebar-width:18rem] w-(--sidebar-width)"

export const sidebarContainerClass =
  "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-linear data-[side=left]:left-0 data-[side=left]:group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)] data-[side=right]:right-0 data-[side=right]:group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)] md:flex"

export const sidebarInnerContainerClass =
  "bg-sidebar group-data-[variant=floating]:ring-sidebar-border group-data-[variant=floating]:rounded-md group-data-[variant=floating]:shadow-mount group-data-[variant=floating]:ring-2 flex size-full flex-col"

export const sidebarContainerVariantClass = {
  docked:
    "group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r-2 group-data-[side=right]:border-l-2 border-sidebar-border",
  padded:
    "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]",
} as const satisfies Record<Padding, string>

export const sidebarGapClass =
  "transition-[width] duration-200 ease-linear relative w-(--sidebar-width) bg-transparent group-data-[collapsible=offcanvas]:w-0 group-data-[side=right]:rotate-180"

export const sidebarIconWidthClass = {
  docked: "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
  padded: "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]",
} as const satisfies Record<Padding, string>

export const view = defineView<Model, Message, ViewInputs>((model, viewInputs, h) => {
  const side = viewInputs.side ?? "left"
  const variant = viewInputs.variant ?? "sidebar"
  const collapsible = viewInputs.collapsible ?? "offcanvas"

  const slots: SidebarSlots = {
    isOpen: model.isOpen,
    isMobile: model.isMobile,
    state: state(model),
    rail: childAttributes([h.OnClick(Message.Toggled())]),
    trigger: childAttributes([h.OnClick(Message.Toggled())]),
  }

  const padding: Padding = variant === "floating" || variant === "inset" ? "padded" : "docked"

  if (collapsible === "none") {
    return h.div(
      [
        h.DataAttribute("slot", "sidebar-provider"),
        h.Class(cn(sidebarProviderClass, viewInputs.className)),
        h.Style({
          "--sidebar-width": SIDEBAR_WIDTH,
          "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
        }),
      ],
      [
        h.div(
          [
            h.DataAttribute("slot", "sidebar"),
            h.DataAttribute("sidebar", "sidebar"),
            h.Class(cn(sidebarProviderClass, viewInputs.className)),
          ],
          viewInputs.content(slots),
        ),
        ...viewInputs.children(slots),
      ],
    )
  }

  if (model.isMobile) {
    const mobileSheetView: View<Sheet.Model, Sheet.Message, Sheet.ViewInputs> = Sheet.view
    const mobileSheetInputs: Sheet.ViewInputs = Sheet.styledViewInputs(h, {
      side,
      panelClass: sidebarMobilePanelClass,
      content: (sheetH, { description, title }) => [
        sheetH.div(
          [h.Class("sr-only flex flex-col")],
          [
            Sheet.title(sheetH, {
              attributes: title,
              children: ["Sidebar"],
            }),
            Sheet.description(sheetH, {
              attributes: description,
              children: ["Displays the mobile sidebar"],
            }),
          ],
        ),
        ...viewInputs.content(slots),
      ],
    })
    return h.div(
      [
        h.DataAttribute("slot", "sidebar-provider"),
        h.Class(cn(sidebarProviderClass, viewInputs.className)),
        h.Style({
          "--sidebar-width": SIDEBAR_WIDTH,
          "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
        }),
      ],
      [
        h.submodel({
          slotId: model.sheet.id,
          model: model.sheet,
          view: mobileSheetView,
          viewInputs: mobileSheetInputs,
          toParentMessage: (message) => Message.GotSheetMessage({ message }),
        }),
        ...viewInputs.children(slots),
      ],
    )
  }

  return h.div(
    [
      h.DataAttribute("slot", "sidebar-provider"),
      h.Class(cn(sidebarProviderClass, viewInputs.className)),
      h.Style({
        "--sidebar-width": SIDEBAR_WIDTH,
        "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
      }),
    ],
    [
      h.div(
        [
          h.DataAttribute("slot", "sidebar"),
          h.DataAttribute("sidebar", "sidebar"),
          h.DataAttribute("state", slots.state),
          h.DataAttribute("collapsible", slots.state === "collapsed" ? collapsible : ""),
          h.DataAttribute("variant", variant),
          h.DataAttribute("side", side),
          h.Class(sidebarShellClass),
        ],
        [
          h.div([
            h.DataAttribute("slot", "sidebar-gap"),
            h.Class(cn(sidebarGapClass, sidebarIconWidthClass[padding])),
          ]),
          h.div(
            [
              h.DataAttribute("slot", "sidebar-container"),
              h.DataAttribute("side", side),
              h.Class(
                cn(
                  sidebarContainerClass,
                  sidebarContainerVariantClass[padding],
                  viewInputs.className,
                ),
              ),
            ],
            [
              h.div(
                [
                  h.DataAttribute("slot", "sidebar-inner"),
                  h.DataAttribute("sidebar", "sidebar"),
                  h.Class(sidebarInnerContainerClass),
                ],
                viewInputs.content(slots),
              ),
            ],
          ),
        ],
      ),
      ...viewInputs.children(slots),
    ],
  )
})

type StyleConfig = {
  readonly className?: string
}

export type HeaderConfig = StyleConfig & {
  readonly children: ReadonlyArray<Child>
}

export const sidebarHeaderClass = "flex flex-col gap-2 p-2"

export const header = <M>(h: HtmlBuilder<M>, config: HeaderConfig): Html =>
  h.div(
    [
      h.DataAttribute("slot", "sidebar-header"),
      h.DataAttribute("sidebar", "header"),
      h.Class(cn(sidebarHeaderClass, config.className)),
    ],
    config.children,
  )

export type ContentConfig = StyleConfig & {
  readonly children: ReadonlyArray<Child>
}

export const sidebarContentClass =
  "no-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden"

export const content = <M>(h: HtmlBuilder<M>, config: ContentConfig): Html =>
  h.div(
    [
      h.DataAttribute("slot", "sidebar-content"),
      h.DataAttribute("sidebar", "content"),
      h.Class(cn(sidebarContentClass, config.className)),
    ],
    config.children,
  )

export type FooterConfig = StyleConfig & {
  readonly children: ReadonlyArray<Child>
}

export const sidebarFooterClass = "flex flex-col gap-2 p-2"

export const footer = <M>(h: HtmlBuilder<M>, config: FooterConfig): Html =>
  h.div(
    [
      h.DataAttribute("slot", "sidebar-footer"),
      h.DataAttribute("sidebar", "footer"),
      h.Class(cn(sidebarFooterClass, config.className)),
    ],
    config.children,
  )

export type GroupConfig = StyleConfig & {
  readonly children: ReadonlyArray<Child>
}

export const sidebarGroupClass = "p-2 relative flex w-full min-w-0 flex-col"

export const group = <M>(h: HtmlBuilder<M>, config: GroupConfig): Html =>
  h.div(
    [
      h.DataAttribute("slot", "sidebar-group"),
      h.DataAttribute("sidebar", "group"),
      h.Class(cn(sidebarGroupClass, config.className)),
    ],
    config.children,
  )

export type GroupLabelConfig = StyleConfig & {
  readonly children: ReadonlyArray<Child>
}

export const sidebarGroupLabelClass =
  "text-muted-foreground ring-sidebar-ring h-8 rounded-sm px-2 font-mono text-mono-sm font-semibold transition-[margin,opacity] duration-200 ease-linear group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0 focus-visible:ring-2 [&>svg]:size-4 flex shrink-0 items-center outline-hidden [&>svg]:shrink-0"

export const groupLabel = <M>(h: HtmlBuilder<M>, config: GroupLabelConfig): Html =>
  h.div(
    [
      h.DataAttribute("slot", "sidebar-group-label"),
      h.DataAttribute("sidebar", "group-label"),
      h.Class(cn(sidebarGroupLabelClass, config.className)),
    ],
    config.children,
  )

export type GroupActionConfig<M> = StyleConfig & {
  readonly attributes: Attributes<M>
  readonly children: ReadonlyArray<Child>
}

export const sidebarGroupActionClass =
  "text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground absolute top-3.5 right-3 w-5 rounded-md p-0 focus-visible:ring-2 [&>svg]:size-4 flex aspect-square items-center justify-center outline-hidden transition-transform group-data-[collapsible=icon]:hidden after:absolute after:-inset-2 md:after:hidden [&>svg]:shrink-0"

export const groupAction = <M>(h: HtmlBuilder<M>, config: GroupActionConfig<M>): Html =>
  h.button(
    [
      ...config.attributes,
      h.Type("button"),
      h.DataAttribute("slot", "sidebar-group-action"),
      h.DataAttribute("sidebar", "group-action"),
      h.Class(cn(sidebarGroupActionClass, config.className)),
    ],
    config.children,
  )

export type GroupContentConfig = StyleConfig & {
  readonly children: ReadonlyArray<Child>
}

export const sidebarGroupContentClass = "w-full text-sm"

export const groupContent = <M>(h: HtmlBuilder<M>, config: GroupContentConfig): Html =>
  h.div(
    [
      h.DataAttribute("slot", "sidebar-group-content"),
      h.DataAttribute("sidebar", "group-content"),
      h.Class(cn(sidebarGroupContentClass, config.className)),
    ],
    config.children,
  )

export type MenuConfig = StyleConfig & {
  readonly children: ReadonlyArray<Child>
}

export const sidebarMenuClass = "flex w-full min-w-0 flex-col gap-1"

export const menu = <M>(h: HtmlBuilder<M>, config: MenuConfig): Html =>
  h.div(
    [
      h.DataAttribute("slot", "sidebar-menu"),
      h.DataAttribute("sidebar", "menu"),
      h.Class(cn(sidebarMenuClass, config.className)),
    ],
    config.children,
  )

export type MenuItemConfig = StyleConfig & {
  readonly children: ReadonlyArray<Child>
}

export const sidebarMenuItemClass = "group/menu-item relative"

export const menuItem = <M>(h: HtmlBuilder<M>, config: MenuItemConfig): Html =>
  h.div(
    [
      h.DataAttribute("slot", "sidebar-menu-item"),
      h.DataAttribute("sidebar", "menu-item"),
      h.Class(cn(sidebarMenuItemClass, config.className)),
    ],
    config.children,
  )

export type MenuButtonVariant = Extract<ButtonVariant, "default" | "outline">

export type MenuButtonSize = Extract<ButtonSize, "default" | "sm" | "lg">

export type MenuButtonConfig<M> = StyleConfig & {
  readonly size?: MenuButtonSize
  readonly variant?: MenuButtonVariant
  readonly isActive?: boolean
  readonly attributes?: Attributes<M>
  readonly children: ReadonlyArray<Child>
}

export const sidebarMenuButtonClass =
  "ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground data-open:hover:bg-sidebar-accent data-open:hover:text-sidebar-accent-foreground gap-2 rounded-sm p-2 text-left text-sm font-medium transition-[width,height,padding] group-has-data-[sidebar=menu-action]/menu-item:pr-8 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! focus-visible:ring-2 data-active:font-semibold peer/menu-button group/menu-button flex w-full items-center overflow-hidden outline-hidden disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&>span:last-child]:truncate cursor-pointer"

export const sidebarMenuButtonVariantClass = {
  default: "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  outline:
    "bg-background hover:bg-sidebar-accent hover:text-sidebar-accent-foreground shadow-[0_0_0_2px_var(--sidebar-border)]",
} as const satisfies Record<MenuButtonVariant, string>

export const sidebarMenuButtonSizeClass = {
  default: "h-8 text-sm",
  sm: "h-7 text-xs",
  lg: "h-12 text-sm group-data-[collapsible=icon]:p-0!",
} as const satisfies Record<MenuButtonSize, string>

export const menuButton = <M>(h: HtmlBuilder<M>, config: MenuButtonConfig<M>): Html => {
  const variant = config.variant ?? "default"
  const size = config.size ?? "default"
  return h.button(
    [
      h.Type("button"),
      ...(config.attributes ?? []),
      h.DataAttribute("slot", "sidebar-menu-button"),
      h.DataAttribute("sidebar", "menu-button"),
      h.DataAttribute("size", size),
      h.Class(
        cn(
          sidebarMenuButtonClass,
          sidebarMenuButtonVariantClass[variant],
          sidebarMenuButtonSizeClass[size],
          config.className,
        ),
      ),
      ...(config.isActive === true ? [h.DataAttribute("active", "true")] : []),
    ],
    config.children,
  )
}

export type MenuActionConfig<M> = StyleConfig & {
  readonly showOnHover?: boolean
  readonly attributes: Attributes<M>
  readonly children: ReadonlyArray<Child>
}

export const sidebarMenuActionClass =
  "text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground peer-hover/menu-button:text-sidebar-accent-foreground absolute top-1.5 right-1 aspect-square w-5 rounded-sm p-0 peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=lg]/menu-button:top-2.5 peer-data-[size=sm]/menu-button:top-1 focus-visible:ring-2 [&>svg]:size-4 flex items-center justify-center outline-hidden transition-transform group-data-[collapsible=icon]:hidden after:absolute after:-inset-2 md:after:hidden [&>svg]:shrink-0"

export const sidebarMenuActionShowOnHoverClass =
  "group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 peer-data-active/menu-button:text-sidebar-accent-foreground aria-expanded:opacity-100 md:opacity-0"

export const menuAction = <M>(h: HtmlBuilder<M>, config: MenuActionConfig<M>): Html =>
  h.button(
    [
      ...config.attributes,
      h.Type("button"),
      h.DataAttribute("slot", "sidebar-menu-action"),
      h.DataAttribute("sidebar", "menu-action"),
      h.Class(
        cn(
          sidebarMenuActionClass,
          ...(config.showOnHover === true ? [sidebarMenuActionShowOnHoverClass] : []),
          config.className,
        ),
      ),
    ],
    config.children,
  )

export type MenuBadgeConfig = StyleConfig & {
  readonly children: ReadonlyArray<Child>
}

export const sidebarMenuBadgeClass =
  "text-sidebar-foreground peer-hover/menu-button:text-sidebar-accent-foreground peer-data-active/menu-button:text-sidebar-accent-foreground pointer-events-none absolute right-1 h-5 min-w-5 rounded-full px-1 font-mono text-mono-sm font-semibold peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=lg]/menu-button:top-2.5 peer-data-[size=sm]/menu-button:top-1 flex items-center justify-center tabular-nums select-none group-data-[collapsible=icon]:hidden"

export const menuBadge = <M>(h: HtmlBuilder<M>, config: MenuBadgeConfig): Html =>
  h.div(
    [
      h.DataAttribute("slot", "sidebar-menu-badge"),
      h.DataAttribute("sidebar", "menu-badge"),
      h.Class(cn(sidebarMenuBadgeClass, config.className)),
    ],
    config.children,
  )

export type MenuSkeletonConfig = StyleConfig & {
  readonly showIcon?: boolean
}

export const sidebarMenuSkeletonClass = "h-8 gap-2 rounded-sm px-2 flex items-center"

export const menuSkeleton = <M>(h: HtmlBuilder<M>, config: MenuSkeletonConfig): Html => {
  const width = `${Math.floor(Math.random() * 40) + 50}%`
  return h.div(
    [
      h.DataAttribute("slot", "sidebar-menu-skeleton"),
      h.DataAttribute("sidebar", "menu-skeleton"),
      h.Class(cn(sidebarMenuSkeletonClass, config.className)),
      h.Style({ "--skeleton-width": width }),
    ],
    [
      ...(config.showIcon === true
        ? [
            h.div([
              h.DataAttribute("sidebar", "menu-skeleton-icon"),
              h.Class(cn(skeletonClass, "size-4 rounded-xs")),
            ]),
          ]
        : []),
      h.div([
        h.DataAttribute("sidebar", "menu-skeleton-text"),
        h.Class(cn(skeletonClass, "h-4 max-w-(--skeleton-width) flex-1")),
      ]),
    ],
  )
}

export type MenuSubConfig = StyleConfig & {
  readonly children: ReadonlyArray<Child>
}

export const sidebarMenuSubClass =
  "border-sidebar-border mx-3.5 translate-x-px gap-1 border-l px-2.5 py-0.5 group-data-[collapsible=icon]:hidden flex min-w-0 flex-col"

export const menuSub = <M>(h: HtmlBuilder<M>, config: MenuSubConfig): Html =>
  h.ul(
    [
      h.DataAttribute("slot", "sidebar-menu-sub"),
      h.DataAttribute("sidebar", "menu-sub"),
      h.Class(cn(sidebarMenuSubClass, config.className)),
    ],
    config.children,
  )

export type MenuSubItemConfig = StyleConfig & {
  readonly children: ReadonlyArray<Child>
}

export const sidebarMenuSubItemClass = "group/menu-sub-item relative"

export const menuSubItem = <M>(h: HtmlBuilder<M>, config: MenuSubItemConfig): Html =>
  h.li(
    [
      h.DataAttribute("slot", "sidebar-menu-sub-item"),
      h.DataAttribute("sidebar", "menu-sub-item"),
      h.Class(cn(sidebarMenuSubItemClass, config.className)),
    ],
    config.children,
  )

export type MenuSubButtonConfig<M> = StyleConfig & {
  readonly size?: "sm" | "md"
  readonly isActive?: boolean
  readonly attributes: Attributes<M>
  readonly children: ReadonlyArray<Child>
}

export const sidebarMenuSubButtonClass =
  "text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground [&>svg]:text-sidebar-accent-foreground data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground h-7 gap-2 rounded-sm px-2 focus-visible:ring-2 data-[size=md]:text-sm data-[size=sm]:text-xs [&>svg]:size-4 flex min-w-0 -translate-x-px items-center overflow-hidden outline-hidden group-data-[collapsible=icon]:hidden disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:shrink-0"

export const menuSubButton = <M>(h: HtmlBuilder<M>, config: MenuSubButtonConfig<M>): Html => {
  const size = config.size ?? "md"
  return h.a(
    [
      ...config.attributes,
      h.DataAttribute("slot", "sidebar-menu-sub-button"),
      h.DataAttribute("sidebar", "menu-sub-button"),
      h.DataAttribute("size", size),
      h.Class(cn(sidebarMenuSubButtonClass, config.className)),
      ...(config.isActive === true ? [h.DataAttribute("active", "true")] : []),
    ],
    config.children,
  )
}

export type InputConfig<M> = StyleConfig & {
  readonly attributes: Attributes<M>
}

export const input = <M>(h: HtmlBuilder<M>, config: InputConfig<M>): Html =>
  h.input([
    ...config.attributes,
    h.DataAttribute("slot", "sidebar-input"),
    h.DataAttribute("sidebar", "input"),
    h.Class(cn(inputClass, "bg-background h-8 w-full shadow-none", config.className)),
  ])

export type SeparatorConfig = StyleConfig

export const sidebarSeparatorClass = "mx-2 h-px w-auto shrink-0 bg-sidebar-border"

export const separator = <M>(h: HtmlBuilder<M>, config: SeparatorConfig): Html =>
  h.div([
    h.DataAttribute("slot", "sidebar-separator"),
    h.DataAttribute("sidebar", "separator"),
    h.Class(cn(sidebarSeparatorClass, config.className)),
  ])

export type RailConfig<M> = StyleConfig & {
  readonly attributes: Attributes<M>
}

export const sidebarRailClass =
  "hover:after:bg-sidebar-border absolute inset-y-0 z-20 hidden w-4 transition-all ease-linear group-data-[side=left]:-right-4 group-data-[side=right]:left-0 after:absolute after:inset-y-0 after:start-1/2 after:w-[2px] sm:flex ltr:-translate-x-1/2 rtl:-translate-x-1/2 in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize [[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full hover:group-data-[collapsible=offcanvas]:bg-sidebar [[data-side=left][data-collapsible=offcanvas]_&]:-right-2 [[data-side=right][data-collapsible=offcanvas]_&]:-left-2"

export const rail = <M>(h: HtmlBuilder<M>, config: RailConfig<M>): Html =>
  h.button([
    ...config.attributes,
    h.Type("button"),
    h.Tabindex(-1),
    h.AriaLabel("Toggle Sidebar"),
    h.Attribute("title", "Toggle Sidebar"),
    h.DataAttribute("slot", "sidebar-rail"),
    h.DataAttribute("sidebar", "rail"),
    h.Class(cn(sidebarRailClass, config.className)),
  ])

export type TriggerConfig<M> = StyleConfig & {
  readonly attributes: Attributes<M>
}

export const sidebarTriggerClass =
  "inline-flex size-7 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-sm border-2 border-outline bg-card text-card-foreground text-sm font-medium cursor-pointer outline-none transition-colors hover:bg-popover disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

export const trigger = <M>(h: HtmlBuilder<M>, config: TriggerConfig<M>): Html =>
  h.button(
    [
      ...config.attributes,
      h.Type("button"),
      h.DataAttribute("slot", "sidebar-trigger"),
      h.DataAttribute("sidebar", "trigger"),
      h.Class(cn(sidebarTriggerClass, config.className)),
    ],
    [Icon.view(h, PanelLeft, "rtl:rotate-180"), h.span([h.Class("sr-only")], ["Toggle Sidebar"])],
  )

export type InsetConfig = StyleConfig & {
  readonly children: ReadonlyArray<Child>
}

export const sidebarInsetClass =
  "bg-transparent md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-md md:peer-data-[variant=inset]:shadow-mount md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2 relative flex w-full flex-1 flex-col"

export const inset = <M>(h: HtmlBuilder<M>, config: InsetConfig): Html =>
  h.main(
    [h.Class(cn(sidebarInsetClass, config.className)), h.DataAttribute("slot", "sidebar-inset")],
    config.children,
  )
