import * as Menu from "@foldkit/ui/menu"
import * as Overlay from "@/components/ui/overlay"
import { cn } from "@/lib/utils"
import * as Effect from "effect/Effect"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import * as FoldkitCommand from "foldkit/command"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import * as Submodel from "foldkit/submodel"
import * as Subscription from "foldkit/subscription"
import * as Update from "foldkit/update"
import * as Icon from "@/lib/icons"
import { Check, Computer, Moon, Sun } from "lucide"

// CONSTANTS

export const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)"

export const THEME_STORAGE_KEY = "theme"

// MODEL

export const ThemePreference = Schema.Literals(["Light", "Dark", "System"])
export type ThemePreference = typeof ThemePreference.Type

export const Theme = Schema.Literals(["Light", "Dark"])
export type Theme = typeof Theme.Type

export const ThemeMenu: ReturnType<typeof Menu.create<ThemePreference>> =
  Menu.create<ThemePreference>()

export const Model = Schema.Struct({
  menu: Menu.Model,
  preferredTheme: ThemePreference,
  systemTheme: Theme,
  resolvedTheme: Theme,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ChangedSystemTheme: {
    theme: Theme,
  },
  GotMenuMessage: {
    message: Menu.Message,
  },
  SelectedThemePreference: {
    preference: ThemePreference,
  },
  CompletedApplyTheme: {},
  CompletedSaveThemePreference: {},
})
export type Message = typeof Message.Type

// COMMANDS

export type Command = FoldkitCommand.Command<Message, never, KeyValueStore.KeyValueStore>

export const applyTheme = (theme: Theme): Effect.Effect<void> =>
  Effect.sync(() => {
    globalThis.document.documentElement.classList.toggle("dark", theme === "Dark")
  })

export const ApplyTheme = FoldkitCommand.define("ApplyTheme", {
  args: { theme: Theme },
  messages: [Message.CompletedApplyTheme],
  execute: ({ theme }) => Effect.as(applyTheme(theme), Message.CompletedApplyTheme()),
})

export const PersistThemePreference = FoldkitCommand.define("PersistThemePreference", {
  args: { preference: ThemePreference },
  messages: [Message.CompletedSaveThemePreference],
  execute: Effect.fnUntraced(function* ({ preference }) {
    const store = yield* KeyValueStore.KeyValueStore
    const themeStore = KeyValueStore.toSchemaStore(store, ThemePreference)
    yield* Effect.ignore(themeStore.set(THEME_STORAGE_KEY, preference))
    return Message.CompletedSaveThemePreference()
  }),
})

// FLAGS

export const Flags = Schema.Struct({
  preferredTheme: ThemePreference,
  systemTheme: Theme,
})
export type Flags = typeof Flags.Type

export const flags = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore
  const themeStore = KeyValueStore.toSchemaStore(store, ThemePreference)

  const preferredTheme = yield* themeStore
    .get(THEME_STORAGE_KEY)
    .pipe(Effect.orElseSucceed(() => Option.none<ThemePreference>()))

  const systemTheme: Theme = yield* Effect.sync(() =>
    globalThis.window.matchMedia("(prefers-color-scheme: dark)").matches ? "Dark" : "Light",
  )

  return Flags.make(
    {
      preferredTheme: Option.getOrElse(preferredTheme, () => "System"),
      systemTheme,
    },
    { disableChecks: true },
  )
})

// INIT

const resolveTheme = ({ preferredTheme, systemTheme }: Flags): Theme =>
  preferredTheme === "System" ? systemTheme : preferredTheme

export const init = (flags: Flags): UpdateReturn => {
  const menu = Menu.init({ id: "theme-menu" })

  const resolvedTheme = resolveTheme(flags)

  return {
    model: Model.make({
      ...flags,
      menu,
      resolvedTheme,
    }),
    commands: [ApplyTheme({ theme: resolvedTheme })],
  }
}

// UPDATE

const foldMenuOutMessage = Match.type<Menu.OutMessage<ThemePreference>>().pipe(
  Match.withReturnType<Update.Step<Model, Message, KeyValueStore.KeyValueStore>>(),
  Match.tagsExhaustive({
    Selected:
      ({ value }: Extract<Menu.OutMessage<ThemePreference>, { _tag: "Selected" }>) =>
      (model: Model) => {
        const resolvedTheme = resolveTheme({
          preferredTheme: value,
          systemTheme: model.systemTheme,
        })

        return {
          model: evo(model, {
            resolvedTheme: () => resolvedTheme,
            preferredTheme: () => value,
          }),
          commands: [PersistThemePreference({ preference: value })],
        }
      },
  }),
)

const foldMenu = Update.foldChild({
  update: ThemeMenu.update,
  read: (model: Model) => Option.some(model.menu),
  write: (model, next) => evo(model, { menu: () => next }),
  toParentMessage: (message) => Message.GotMenuMessage({ message }),
  foldOutMessage: foldMenuOutMessage,
})

export type UpdateReturn = Update.Return<Model, Message, KeyValueStore.KeyValueStore>

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    GotMenuMessage: ({ message }) => foldMenu(model, message),

    ChangedSystemTheme: ({ theme }) => {
      const resolvedTheme = resolveTheme({
        preferredTheme: model.preferredTheme,
        systemTheme: theme,
      })

      return {
        model: evo(model, {
          systemTheme: () => theme,
          resolvedTheme: () => resolvedTheme,
        }),
      }
    },
    SelectedThemePreference: ({ preference }) => {
      const resolvedTheme = resolveTheme({
        preferredTheme: preference,
        systemTheme: model.systemTheme,
      })

      return {
        model: evo(model, {
          preferredTheme: () => preference,
          resolvedTheme: () => resolvedTheme,
        }),
        commands: [PersistThemePreference({ preference })],
      }
    },
    CompletedApplyTheme: () => ({ model }),
    CompletedSaveThemePreference: () => ({ model }),
  })

// SUBSCRIPTIONS

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  documentTheme: entry(
    { resolvedTheme: Theme },
    {
      modelToDependencies: (model) => ({
        resolvedTheme: model.resolvedTheme,
      }),
      dependenciesToStream: ({ resolvedTheme }) =>
        Stream.callback<Message>(() => applyTheme(resolvedTheme)),
    },
  ),
  systemTheme: Subscription.persistent(
    Stream.callback<Message>(
      Effect.fnUntraced(function* (queue) {
        const mediaQuery = globalThis.window.matchMedia(THEME_MEDIA_QUERY)

        const publish = (isDark: boolean) => {
          const theme: Theme = isDark ? "Dark" : "Light"
          const message = Message.ChangedSystemTheme({ theme })
          Queue.offerUnsafe(queue, message)
        }

        const onChange = (event: MediaQueryListEvent) => {
          publish(event.matches)
        }

        // Reconcile any changes that occurred after flags were read
        publish(mediaQuery.matches)

        mediaQuery.addEventListener("change", onChange)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => mediaQuery.removeEventListener("change", onChange)),
        )

        return yield* Effect.void
      }),
    ),
  ),
}))

const menuItemIcon = (h: HtmlBuilder<Message>, item: ThemePreference): Html =>
  Match.value(item).pipe(
    Match.when("Dark", () => Icon.view(h, Moon)),
    Match.when("Light", () => Icon.view(h, Sun)),
    Match.when("System", () => Icon.view(h, Computer)),
    Match.exhaustive,
  )

const menuItem = (
  h: HtmlBuilder<Message>,
  preferredTheme: ThemePreference,
  item: ThemePreference,
): Html =>
  h.div(
    [h.Class(cn(Overlay.menuItemClass, "hover:bg-surface-muted"))],
    [
      menuItemIcon(h, item),
      h.span([h.Class("flex-1")], [item]),
      preferredTheme === item ? h.span([], [Icon.view(h, Check)]) : h.empty,
    ],
  )

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.submodel({
    slotId: "theme-switcher",
    model: model.menu,
    view: ThemeMenu.view,
    toParentMessage: (message) => Message.GotMenuMessage({ message }),
    viewInputs: {
      items: ThemePreference.literals,
      anchor: { placement: "bottom-end", gap: 4, padding: 8 },
      ariaLabel: "Theme",
      buttonContent: menuItemIcon(h, model.resolvedTheme),
      buttonClassName: Overlay.menuButtonClass,
      itemsClassName: cn(Overlay.menuItemsClass, "w-36"),
      itemToConfig: (item) => ({
        content: menuItem(h, model.preferredTheme, item),
      }),
      backdropClassName: Overlay.menuBackdropClass,
    },
  }),
)
