import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

import { cn } from "@/lib/utils"
import * as Icon from "@/lib/icons"
import { Search } from "lucide"
import { inputGroup, inputGroupAddon, inputGroupInput } from "./input-group"
import * as Button from "./button"

type Child = Html | string

export const commandClass =
  "bg-popover text-popover-foreground rounded-xl! p-1 flex size-full flex-col overflow-hidden"

export const commandInputClass =
  "w-full text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50"

export const commandListClass =
  "no-scrollbar max-h-72 scroll-py-1 outline-none overflow-x-hidden overflow-y-auto"

export const commandEmptyClass = "py-6 text-center text-sm"

export const commandGroupClass = "text-foreground overflow-hidden p-1"

export const commandGroupHeadingClass =
  "text-muted-foreground px-2 py-1.5 text-xs font-medium overflow-hidden"

export const commandItemClass =
  "data-selected:bg-muted data-selected:text-foreground data-selected:*:[svg]:text-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none in-data-[slot=dialog-content]:rounded-lg! [&_svg:not([class*='size-'])]:size-4 group/command-item data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0"

export const commandSeparatorClass = "bg-border -mx-1 h-px"

export const commandShortcutClass =
  "text-muted-foreground group-data-selected/command-item:text-foreground ml-auto text-xs tracking-widest"

type StyleConfig = {
  readonly className?: string
}

export type CommandContainerConfig = StyleConfig & {
  readonly children: ReadonlyArray<Child>
}

export const container = <M>(h: HtmlBuilder<M>, config: CommandContainerConfig): Html =>
  h.div(
    [h.Class(cn(commandClass, config.className)), h.DataAttribute("slot", "command")],
    config.children,
  )

export type CommandInputConfig<M> = {
  readonly ariaLabel?: string
  readonly wrapperClassName?: string
  readonly groupClassName?: string
  readonly id?: string
  readonly value?: string
  readonly placeholder?: string
  readonly isDisabled?: boolean
  readonly className?: string
  readonly onInput?: (value: string) => M
}

export const input = <M>(h: HtmlBuilder<M>, config: CommandInputConfig<M>): Html =>
  h.div(
    [
      h.Class(cn("p-1 pb-0", config.wrapperClassName)),
      h.DataAttribute("slot", "command-input-wrapper"),
    ],
    [
      inputGroup(h, {
        className: cn(
          "bg-input/30 border-input/30 h-8! rounded-lg! shadow-none! *:data-[slot=input-group-addon]:pl-2!",
          config.groupClassName,
        ),
        children: [
          inputGroupAddon(h, { children: [Icon.view(h, Search, "size-4 shrink-0 opacity-50")] }),
          inputGroupInput(h, {
            ...config,
            id: config.id ?? "command-input",
            ariaLabel: config.ariaLabel ?? "Search commands",
            className: cn(commandInputClass, config.className),
            attributes: [h.DataAttribute("slot", "command-input")],
          }),
        ],
      }),
    ],
  )

export type CommandListConfig = StyleConfig & {
  readonly children: ReadonlyArray<Child>
}

export const list = <M>(h: HtmlBuilder<M>, config: CommandListConfig): Html =>
  h.div(
    [h.Class(cn(commandListClass, config.className)), h.DataAttribute("slot", "command-list")],
    config.children,
  )

export type CommandEmptyConfig = StyleConfig & {
  readonly children: ReadonlyArray<Child>
}

export const empty = <M>(h: HtmlBuilder<M>, config: CommandEmptyConfig): Html =>
  h.div([h.Class(cn(commandEmptyClass)), h.DataAttribute("slot", "command-empty")], config.children)

export type CommandGroupConfig = StyleConfig & {
  /** Rendered above the items and used as the group's accessible name. */
  readonly heading?: string
  readonly headingSuffix?: Child
  readonly headingClassName?: string
  readonly children: ReadonlyArray<Child>
}

export const group = <M>(h: HtmlBuilder<M>, config: CommandGroupConfig): Html =>
  h.div(
    [
      h.Class(cn(commandGroupClass, config.className)),
      h.DataAttribute("slot", "command-group"),
      h.Role("group"),
      ...(config.heading === undefined ? [] : [h.AriaLabel(config.heading)]),
    ],
    config.heading === undefined
      ? config.children
      : [
          h.div(
            [
              h.Class(cn(commandGroupHeadingClass, config.headingClassName)),
              h.DataAttribute("slot", "command-group-heading"),
            ],
            [config.heading, ...(config.headingSuffix === undefined ? [] : [config.headingSuffix])],
          ),
          ...config.children,
        ],
  )

export type CommandItemConfig<M> = StyleConfig & {
  /** Interactive items use the shared Foldkit button for native keyboard activation. */
  readonly onClick?: M
  readonly isSelected?: boolean
  readonly isDisabled?: boolean
  readonly attributes?: ReadonlyArray<Attribute<M>>
  readonly children: ReadonlyArray<Child>
}

export const item = <M>(h: HtmlBuilder<M>, config: CommandItemConfig<M>): Html =>
  config.onClick === undefined
    ? h.div(
        [
          h.Class(cn(commandItemClass, config.className)),
          h.DataAttribute("slot", "command-item"),
          h.Role("menuitem"),
          ...(config.isSelected === true ? [h.DataAttribute("selected", "true")] : []),
          ...(config.isDisabled === true ? [h.DataAttribute("disabled", "true")] : []),
          ...(config.attributes ?? []),
        ],
        config.children,
      )
    : Button.view(h, {
        variant: "ghost",
        onClick: config.onClick,
        isDisabled: config.isDisabled,
        className: cn(
          commandItemClass,
          "h-auto w-full border-0 text-left font-normal",
          config.className,
        ),
        attributes: [
          h.DataAttribute("slot", "command-item"),
          ...(config.isSelected === true
            ? [h.DataAttribute("selected", "true"), h.Attribute("aria-current", "true")]
            : []),
          ...(config.attributes ?? []),
        ],
        label: h.span([h.Class("contents")], config.children),
      })

export type CommandSeparatorConfig = StyleConfig

export const separator = <M>(h: HtmlBuilder<M>, config: CommandSeparatorConfig): Html =>
  h.div(
    [
      h.Class(cn(commandSeparatorClass, config.className)),
      h.DataAttribute("slot", "command-separator"),
    ],
    [],
  )

export type CommandShortcutConfig = StyleConfig & {
  readonly children: ReadonlyArray<Child>
}

export const shortcut = <M>(h: HtmlBuilder<M>, config: CommandShortcutConfig): Html =>
  h.span(
    [
      h.Class(cn(commandShortcutClass, config.className)),
      h.DataAttribute("slot", "command-shortcut"),
    ],
    config.children,
  )
