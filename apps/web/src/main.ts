import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import * as Command from "foldkit/command"
import * as Runtime from "foldkit/runtime"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import * as Subscription from "foldkit/subscription"
import * as Update from "foldkit/update"
import * as JanitorIcon from "@/components/janitor-icon"
import * as Repositories from "@/components/repositories"
import * as RepositorySwitcher from "@/components/repository-switcher"
import * as Sidebar from "@/components/ui/sidebar"
import * as SyncButton from "@/components/sync-button"
import * as ThemeSwitcher from "@/components/theme-switcher"
import { cn } from "@/lib/utils"
import * as Toast from "@foldkit/ui/toast"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as Match from "effect/Match"

export const ToastPayload = Schema.Struct({
  title: Schema.String,
  description: Schema.String,
})
export type ToastPayload = typeof ToastPayload.Type

export const AppToast = Toast.make(ToastPayload)

export const Model = Schema.Struct({
  sidebar: Sidebar.Model,
  theme: ThemeSwitcher.Model,
  sync: SyncButton.Model,
  toast: AppToast.Model,
  repositories: Repositories.Model,
  repositorySwitcher: RepositorySwitcher.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  GotSidebarMessage: {
    message: Sidebar.Message,
  },
  GotThemeSwitcherMessage: {
    message: ThemeSwitcher.Message,
  },
  GotSyncButtonMessage: {
    message: SyncButton.Message,
  },
  GotToastMessage: {
    message: AppToast.Message,
  },
  GotRepositoriesMessage: {
    message: Repositories.Message,
  },
  GotRepositorySwitcherMessage: {
    message: RepositorySwitcher.Message,
  },
})
export type Message = typeof Message.Type

export const Flags = Schema.Struct({
  theme: ThemeSwitcher.Flags,
})
export type Flags = typeof Flags.Type

export const flags = Effect.gen(function* () {
  const theme = yield* ThemeSwitcher.flags
  return Flags.make({ theme }, { disableChecks: true })
})

const foldSidebar = Update.foldChild({
  update: Sidebar.update,
  read: (model: Model) => Option.some(model.sidebar),
  write: (model, next) => evo(model, { sidebar: () => next }),
  toParentMessage: (message) => Message.GotSidebarMessage({ message }),
})

const foldThemeSwitcher = Update.foldChild({
  update: ThemeSwitcher.update,
  read: (model: Model) => Option.some(model.theme),
  write: (model, next) => evo(model, { theme: () => next }),
  toParentMessage: (message) => Message.GotThemeSwitcherMessage({ message }),
})

const foldToastOutMessage = Match.type<typeof AppToast.OutMessage.Type>().pipe(
  Match.withReturnType<Update.Step<Model, Message, AppServices>>(),
  Match.tagsExhaustive({
    DismissedToast: () => (model) => ({ model }),
  }),
)

const foldToast = Update.foldChild({
  update: AppToast.update,
  read: (model: Model) => Option.some(model.toast),
  write: (model, next) => evo(model, { toast: () => next }),
  toParentMessage: (message) => Message.GotToastMessage({ message }),
  foldOutMessage: foldToastOutMessage,
})

/** Toast copy for each sync transition the button reports. */
export const toastFor = Match.type<SyncButton.OutMessage>().pipe(
  Match.withReturnType<Toast.ShowInput<ToastPayload>>(),
  Match.tagsExhaustive({
    SyncStarted: ({ pendingTargets }) => ({
      variant: "Info",
      payload: {
        title: "Sync started",
        description: `Refreshing ${pendingTargets} GitHub scopes.`,
      },
    }),
    SyncFinished: ({ state, blockedTargets, failedTargets }) =>
      state === "failed"
        ? {
            variant: "Error",
            payload: {
              title: "Sync finished with failures",
              description: `${failedTargets} scopes failed. You can retry synchronization.`,
            },
          }
        : state === "blocked"
          ? {
              variant: "Warning",
              payload: {
                title: "Sync finished with blocked scopes",
                description: `${blockedTargets} scopes could not be read from GitHub.`,
              },
            }
          : {
              variant: "Success",
              payload: {
                title: "Sync complete",
                description: "Requested synchronization finished. Local data refreshed.",
              },
            },
    SyncFailed: ({ reason }) => ({
      variant: "Error",
      payload: { title: "Sync request failed", description: reason },
    }),
  }),
)

const foldSyncOutMessage =
  (outMessage: SyncButton.OutMessage): Update.Step<Model, Message, AppServices> =>
  (model) => {
    const shown = AppToast.show(model.toast, toastFor(outMessage))
    const refreshed =
      outMessage._tag === "SyncFinished"
        ? Repositories.refreshAfterSync(model.repositories)
        : { model: model.repositories, commands: [] }
    return {
      model: evo(model, { toast: () => shown.model, repositories: () => refreshed.model }),
      commands: [
        ...Command.mapMessages(shown.commands, (message) => Message.GotToastMessage({ message })),
        ...Command.mapMessages(refreshed.commands, (message) =>
          Message.GotRepositoriesMessage({ message }),
        ),
      ],
    }
  }

/** Toast copy for what the repository page reports. */
export const repositoriesToastFor = Match.type<Repositories.OutMessage>().pipe(
  Match.withReturnType<Toast.ShowInput<ToastPayload>>(),
  Match.tagsExhaustive({
    Notified: ({ title, description }) => ({ variant: "Success", payload: { title, description } }),
    Failed: ({ title, reason }) => ({ variant: "Error", payload: { title, description: reason } }),
  }),
)

const foldRepositoriesOutMessage =
  (outMessage: Repositories.OutMessage): Update.Step<Model, Message, AppServices> =>
  (model) => {
    const shown = AppToast.show(model.toast, repositoriesToastFor(outMessage))
    return {
      model: evo(model, { toast: () => shown.model }),
      commands: Command.mapMessages(shown.commands, (message) =>
        Message.GotToastMessage({ message }),
      ),
    }
  }

const foldRepositories = Update.foldChild({
  update: Repositories.update,
  read: (model: Model) => Option.some(model.repositories),
  write: (model, next) => evo(model, { repositories: () => next }),
  toParentMessage: (message) => Message.GotRepositoriesMessage({ message }),
  foldOutMessage: foldRepositoriesOutMessage,
})

/** Picking in the switcher is the same act as picking in the repository list,
 *  so it goes through the same Message and reuses the fetches that follow. */
const foldRepositorySwitcherOutMessage = Match.type<RepositorySwitcher.OutMessage>().pipe(
  Match.withReturnType<Update.Step<Model, Message, AppServices>>(),
  Match.tagsExhaustive({
    SelectedRepository:
      ({ repositoryId }) =>
      (model) =>
        foldRepositories(model, Repositories.Message.Selected({ repositoryId })),
  }),
)

const foldRepositorySwitcher = Update.foldChild({
  update: RepositorySwitcher.update,
  read: (model: Model) => Option.some(model.repositorySwitcher),
  write: (model, next) => evo(model, { repositorySwitcher: () => next }),
  toParentMessage: (message) => Message.GotRepositorySwitcherMessage({ message }),
  foldOutMessage: foldRepositorySwitcherOutMessage,
})

const foldSyncButton = Update.foldChild({
  update: SyncButton.update,
  read: (model: Model) => Option.some(model.sync),
  write: (model, next) => evo(model, { sync: () => next }),
  toParentMessage: (message) => Message.GotSyncButtonMessage({ message }),
  foldOutMessage: foldSyncOutMessage,
})

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message, AppServices>>(message, {
    GotSidebarMessage: ({ message }) => foldSidebar(model, message),
    GotThemeSwitcherMessage: ({ message }) => foldThemeSwitcher(model, message),
    GotSyncButtonMessage: ({ message }) => foldSyncButton(model, message),
    GotToastMessage: ({ message }) => foldToast(model, message),
    GotRepositoriesMessage: ({ message }) => foldRepositories(model, message),
    GotRepositorySwitcherMessage: ({ message }) => foldRepositorySwitcher(model, message),
  })

export type AppServices = KeyValueStore.KeyValueStore | HttpClient.HttpClient

export const init: Runtime.ApplicationInit<Model, Message, Flags, AppServices> = (flags: Flags) => {
  const theme = ThemeSwitcher.init(flags.theme)
  const sidebar = Sidebar.init({ id: "app-sidebar" })
  const sync = SyncButton.init()
  const toast = AppToast.init({ id: "app-toast", defaultDuration: "6 seconds" })
  const repositories = Repositories.init()
  return {
    model: Model.make({
      sidebar,
      theme: theme.model,
      sync: sync.model,
      toast,
      repositories: repositories.model,
      repositorySwitcher: RepositorySwitcher.init(),
    }),
    commands: [
      ...Command.mapMessages(repositories.commands, (message) =>
        Message.GotRepositoriesMessage({ message }),
      ),
      ...Command.mapMessages(theme.commands, (message) =>
        Message.GotThemeSwitcherMessage({ message }),
      ),
      ...Command.mapMessages(sync.commands, (message) => Message.GotSyncButtonMessage({ message })),
    ],
  }
}

const sidebarSubscriptions = Subscription.lift(Sidebar.subscriptions)<Model, Message>({
  toChildModel: (model) => model.sidebar,
  toParentMessage: (message) => Message.GotSidebarMessage({ message }),
})

const themeSubscriptions = Subscription.lift(ThemeSwitcher.subscriptions)<Model, Message>({
  toChildModel: (model) => model.theme,
  toParentMessage: (message) => Message.GotThemeSwitcherMessage({ message }),
})

const syncSubscriptions = Subscription.lift(SyncButton.subscriptions)<Model, Message>({
  toChildModel: (model) => model.sync,
  toParentMessage: (message) => Message.GotSyncButtonMessage({ message }),
})

const repositoriesSubscriptions = Subscription.lift(Repositories.subscriptions)<Model, Message>({
  toChildModel: (model) => model.repositories,
  toParentMessage: (message) => Message.GotRepositoriesMessage({ message }),
})

export const subscriptions = Subscription.aggregate<Model, Message, AppServices>()(
  sidebarSubscriptions,
  themeSubscriptions,
  syncSubscriptions,
  repositoriesSubscriptions,
)

const brandHeader = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("flex gap-2 items-center")],
    [
      JanitorIcon.view(h, { className: "size-8 rounded-lg" }),
      h.div(
        [h.Class("flex flex-col")],
        [
          h.span([h.Class("font-semibold truncate")], ["The Janitor"]),
          h.span([h.Class("text-xs text-muted-foreground truncate")], ["Repository Maintenance"]),
        ],
      ),
    ],
  )

/** Everything the switcher renders. It groups and filters the list itself; the
 *  page only owns which repository is current. */
const switcherInputs = (model: Model): RepositorySwitcher.ViewInputs => ({
  repositories: Option.getOrElse(model.repositories.repositories, () => []),
  maybeSelectedId: model.repositories.selected,
})

const repositorySwitcher = (h: HtmlBuilder<Message>, model: Model): Html =>
  Sidebar.menuItem(h, {
    // The header's `p-2` and the first group's `p-2` put 16px between this and
    // the nav below it. `Sidebar.menu` only contributes `gap-1` above, so add
    // the missing 12px and the switcher sits evenly between the two.
    className: "mt-3",
    children: [
      h.submodel({
        slotId: "repository-switcher",
        model: model.repositorySwitcher,
        view: RepositorySwitcher.view,
        toParentMessage: (message) => Message.GotRepositorySwitcherMessage({ message }),
        viewInputs: switcherInputs(model),
      }),
    ],
  })

const sidebarMenu = (h: HtmlBuilder<Message>, model: Model): Html =>
  Sidebar.menu(h, {
    children: [
      Sidebar.menuItem(h, {
        children: [
          Sidebar.menuButton(h, {
            size: "lg",
            className:
              "data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground",
            children: [brandHeader(h)],
          }),
        ],
      }),
      repositorySwitcher(h, model),
    ],
  })

const navMain = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [],
    [
      Sidebar.group(h, {
        children: [
          Sidebar.groupLabel(h, { children: ["Platform"] }),
          Sidebar.menu(h, {
            children: ["hi"],
          }),
        ],
      }),
    ],
  )

const sidebarPanel = (h: HtmlBuilder<Message>, model: Model): ReadonlyArray<Html> => [
  Sidebar.header(h, { children: [sidebarMenu(h, model)] }),
  Sidebar.content(h, { children: [navMain(h)] }),
  Sidebar.footer(h, { children: ["Footer"] }),
]

const mainHeader = (h: HtmlBuilder<Message>, model: Model): Html =>
  h.header(
    [
      h.Class(
        "flex h-12 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear",
      ),
    ],
    [
      h.div(
        [h.Class("w-full flex justify-between px-4 lg:px-6")],
        [
          h.div(
            [h.Class("flex items-center gap-1 lg:gap-2")],
            [h.span([h.Class("text-sm font-medium")], ["Auto-labeling"])],
          ),
          h.div(
            [h.Class("flex items-center gap-1")],
            [
              h.submodel({
                slotId: "sync-button",
                model: model.sync,
                view: SyncButton.view,
                toParentMessage: (message) => Message.GotSyncButtonMessage({ message }),
              }),
              h.submodel({
                slotId: "theme-switcher",
                model: model.theme,
                view: ThemeSwitcher.view,
                toParentMessage: (message) => Message.GotThemeSwitcherMessage({ message }),
              }),
            ],
          ),
        ],
      ),
    ],
  )

const toastEntry = (h: HtmlBuilder<Message>, payload: ToastPayload, variant: Toast.Variant): Html =>
  h.div(
    [
      h.Class(
        cn(
          "pointer-events-auto w-80 rounded-md border bg-card px-4 py-3 text-sm shadow-lg",
          variant === "Error" && "border-destructive/40",
          variant === "Warning" && "border-amber-500/40",
          variant === "Success" && "border-emerald-500/40",
        ),
      ),
    ],
    [
      h.div([h.Class("font-medium")], [payload.title]),
      h.div([h.Class("text-muted-foreground")], [payload.description]),
    ],
  )

const toasts = (h: HtmlBuilder<Message>, model: Model): Html =>
  h.submodel({
    slotId: "app-toast",
    model: model.toast,
    view: AppToast.view,
    toParentMessage: (message) => Message.GotToastMessage({ message }),
    viewInputs: {
      position: "BottomRight",
      ariaLabel: "Notifications",
      containerClassName: "pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2",
      entryToView: (entry, handlers) =>
        h.div([...handlers.dismiss], [toastEntry(h, entry.payload, entry.variant)]),
    },
  })

const sidebarContent = (h: HtmlBuilder<Message>, model: Model): ReadonlyArray<Html> => [
  Sidebar.inset(h, {
    children: [
      mainHeader(h, model),
      h.submodel({
        slotId: "repositories",
        model: model.repositories,
        view: Repositories.view,
        toParentMessage: (message) => Message.GotRepositoriesMessage({ message }),
      }),
    ],
  }),
  toasts(h, model),
]

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "The Janitor",
  body: h.submodel({
    slotId: "app-sidebar",
    model: model.sidebar,
    view: Sidebar.view,
    toParentMessage: (message) => Message.GotSidebarMessage({ message }),
    viewInputs: {
      side: "left",
      variant: "sidebar",
      collapsible: "icon",
      content: () => sidebarPanel(h, model),
      children: () => sidebarContent(h, model),
    },
  }),
})
