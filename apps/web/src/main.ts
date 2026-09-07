import * as Connections from "@/components/repository-connections"
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
import { House, FileCode2, Tags, Activity, Settings } from "lucide"
import * as Icon from "@/lib/icons"
import { cn } from "@/lib/utils"
import * as Toast from "@foldkit/ui/toast"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as Match from "effect/Match"
import * as Stream from "effect/Stream"
import * as Routes from "@/routes"
import * as Navigation from "@/navigation"

export const ToastPayload = Schema.Struct({
  title: Schema.String,
  description: Schema.String,
})
export type ToastPayload = typeof ToastPayload.Type

export const AppToast = Toast.make(ToastPayload)

export const Model = Schema.Struct({
  connectionCancelPath: Schema.String,
  connections: Connections.Model,
  navigation: Navigation.Model,
  lastRepositoryId: Schema.Option(Schema.String),
  sidebar: Sidebar.Model,
  theme: ThemeSwitcher.Model,
  sync: SyncButton.Model,
  toast: AppToast.Model,
  repositories: Repositories.Model,
  repositorySwitcher: RepositorySwitcher.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  GotConnectionsMessage: { message: Connections.Message },
  GotNavigationMessage: { message: Navigation.Message },
  PersistedRepository: {},
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
  historyIndex: Schema.optionalKey(Schema.Int),
  lastRepositoryId: Schema.optionalKey(Schema.Option(Schema.String)),
})
export type Flags = typeof Flags.Type

export const flags = Effect.gen(function* () {
  const theme = yield* ThemeSwitcher.flags
  const store = yield* KeyValueStore.KeyValueStore
  const lastRepositoryId = yield* store.get("janitor:last-repository").pipe(
    Effect.map(Option.fromNullishOr),
    Effect.catch(() => Effect.succeed(Option.none<string>())),
  )
  const historyIndex = yield* Effect.sync(Navigation.historyIndex)
  return Flags.make({ theme, lastRepositoryId, historyIndex }, { disableChecks: true })
})

const PersistRepository = Command.define("PersistSelectedRepository", {
  args: { repositoryId: Schema.String },
  messages: [Message.PersistedRepository],
  execute: ({ repositoryId }) =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore
      yield* Effect.ignore(store.set("janitor:last-repository", repositoryId))
      return Message.PersistedRepository()
    }),
})

const ForgetRepository = Command.define("ForgetDisconnectedRepository", {
  args: {},
  messages: [Message.PersistedRepository],
  execute: () =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore
      yield* Effect.ignore(store.remove("janitor:last-repository"))
      return Message.PersistedRepository()
    }),
})
type Step = Update.Return<Model, Message, AppServices>
const navigationCommands = (commands: ReadonlyArray<Command.Command<Navigation.Message>>) =>
  Command.mapMessages(commands, (message) => Message.GotNavigationMessage({ message }))

const navigationContext = (model: Model): Navigation.Context => ({
  isSaving: Repositories.isSaving(model.repositories),
  hasUnsavedChanges: Repositories.hasUnsavedChanges(model.repositories),
})

export const requestNavigation = (
  model: Model,
  path: string,
  replace = false,
  guard = true,
  external = false,
): Step => {
  const next = Navigation.request(model.navigation, path, navigationContext(model), {
    replace,
    guard,
    external,
  })
  return {
    model: evo(model, { navigation: () => next.model }),
    commands: navigationCommands(next.commands ?? []),
  }
}

const enterRoute = (model: Model, route: Routes.AppRoute): Step => {
  if (route._tag === "Connect" || route._tag === "ConnectReturn")
    return {
      model: evo(model, {
        navigation: (navigation) => Navigation.enter(navigation, route),
        connections: (previous) =>
          route._tag === "ConnectReturn" && route.setup_action === "request"
            ? evo(previous, {
                notice: () =>
                  "Your GitHub installation request is awaiting organization approval. Refresh after an owner approves access.",
              })
            : previous,
        connectionCancelPath: (previous) =>
          "repositoryId" in model.navigation.route ? Routes.path(model.navigation.route) : previous,
        repositories: () => evo(model.repositories, { panel: () => ({ _tag: "Closed" as const }) }),
      }),
    }
  if (route._tag === "Home" && Option.isSome(model.repositories.repositories)) {
    const repositories = model.repositories.repositories.value.filter(
      (repo) => repo.access === "accessible",
    )
    const selected = repositories.find((repo) =>
      Option.contains(model.lastRepositoryId, repo.repositoryId),
    )
    return selected === undefined
      ? { model: evo(model, { navigation: (navigation) => Navigation.enter(navigation, route) }) }
      : requestNavigation(
          model,
          Routes.repositoryHome({ repositoryId: selected.repositoryId }),
          true,
          false,
        )
  }
  const panel = model.repositories.panel
  const justSaved =
    model.navigation.route._tag === "NewPolicy" &&
    route._tag === "Policy" &&
    panel._tag === "PolicyEditor" &&
    panel.editor.identity._tag === "Existing" &&
    panel.editor.identity.policyId === route.policyId
  const loaded = Repositories.openRoute(
    model.repositories,
    route,
    !justSaved && Routes.documentPath(model.navigation.route) !== Routes.documentPath(route),
  )
  const accessible =
    "repositoryId" in route &&
    Option.exists(model.repositories.repositories, (repositories) =>
      repositories.some(
        (repo) => repo.repositoryId === route.repositoryId && repo.access === "accessible",
      ),
    )
  return {
    model: evo(model, {
      navigation: (navigation) => Navigation.enter(navigation, route),
      repositories: () => loaded.model,
      lastRepositoryId: (previous) => (accessible ? Option.some(route.repositoryId) : previous),
    }),
    commands: [
      ...Command.mapMessages(loaded.commands, (message) =>
        Message.GotRepositoriesMessage({ message }),
      ),
      ...(accessible ? [PersistRepository({ repositoryId: route.repositoryId })] : []),
    ],
  }
}

const updateNavigation = (model: Model, message: Navigation.Message): Step => {
  const next = Navigation.update(model.navigation, message, navigationContext(model))
  const updated =
    next.model === model.navigation ? model : evo(model, { navigation: () => next.model })
  const entered = next.outMessage
    ? Navigation.OutMessage.match(next.outMessage, {
        AcceptedRoute: ({ route }) => enterRoute(updated, route),
      })
    : { model: updated }
  return {
    model: entered.model,
    commands: [...navigationCommands(next.commands ?? []), ...(entered.commands ?? [])],
  }
}

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
  Match.withReturnType<Toast.ShowInput<ToastPayload> | undefined>(),
  Match.tagsExhaustive({
    SyncWorkChanged: () => undefined,
    Notified: ({ title, description }) => ({ variant: "Success", payload: { title, description } }),
    Failed: ({ title, reason }) => ({ variant: "Error", payload: { title, description: reason } }),
  }),
)

const foldRepositoriesOutMessage =
  (outMessage: Repositories.OutMessage): Update.Step<Model, Message, AppServices> =>
  (model) => {
    const input = repositoriesToastFor(outMessage)
    const refreshed = outMessage._tag === "Failed" ? { model } : refreshSyncStatus(model)
    if (input === undefined) return refreshed
    const shown = AppToast.show(refreshed.model.toast, input)
    return {
      model: evo(refreshed.model, { toast: () => shown.model }),
      commands: [
        ...(refreshed.commands ?? []),
        ...Command.mapMessages(shown.commands, (message) => Message.GotToastMessage({ message })),
      ],
    }
  }

const foldRepositories = Update.foldChild({
  update: Repositories.update,
  read: (model: Model) => Option.some(model.repositories),
  write: (model, next) => evo(model, { repositories: () => next }),
  toParentMessage: (message) => Message.GotRepositoriesMessage({ message }),
  foldOutMessage: foldRepositoriesOutMessage,
})

const updateRepositories = (model: Model, message: Repositories.Message): Step => {
  const repositoryId =
    "repositoryId" in model.navigation.route
      ? model.navigation.route.repositoryId
      : Option.getOrUndefined(model.repositories.selected)
  if (message._tag === "Selected")
    return requestNavigation(model, Routes.repositoryHome({ repositoryId: message.repositoryId }))
  if (repositoryId !== undefined) {
    switch (message._tag) {
      case "SelectedSection":
        return requestNavigation(model, Routes.sectionPath(repositoryId, message.section))
      case "ClickedNewPolicy":
        return requestNavigation(model, Routes.newPolicy({ repositoryId }))
      case "ClickedEditPolicy":
        return requestNavigation(
          model,
          Routes.policy({
            repositoryId,
            policyId: message.policyId,
            ...(model.repositories.policySearch ? { q: model.repositories.policySearch } : {}),
          }),
        )
      case "ClickedNewRule":
        return requestNavigation(model, Routes.newRule({ repositoryId }))
      case "GotRuleMenuMessage":
        if (message.message._tag === "SelectedItem" && message.message.item === "Edit") {
          const next = foldRepositories(model, message)
          const routed = requestNavigation(
            next.model,
            Routes.rule({ repositoryId, ruleId: message.ruleId }),
          )
          return { ...routed, commands: [...(next.commands ?? []), ...(routed.commands ?? [])] }
        }
        break
      case "ClickedEditRule":
        return requestNavigation(model, Routes.rule({ repositoryId, ruleId: message.ruleId }))
      case "UpdatedPolicySearch":
        if (
          model.navigation.route._tag === "Policies" ||
          model.navigation.route._tag === "Policy" ||
          model.navigation.route._tag === "NewPolicy"
        ) {
          const { q: _q, ...route } = model.navigation.route
          return requestNavigation(
            model,
            Routes.path(message.value ? { ...route, q: message.value } : route),
            true,
          )
        }
        break
      case "GotPolicyEditorMessage": {
        const child = message.message
        if (child._tag === "ClickedCancel")
          return requestNavigation(model, Routes.policies({ repositoryId }))
        if (
          child._tag === "SelectedTestItem" &&
          (model.navigation.route._tag === "Policy" || model.navigation.route._tag === "NewPolicy")
        )
          return requestNavigation(
            model,
            Routes.path({ ...model.navigation.route, item: String(child.number) }),
            true,
          )
        break
      }
      case "GotRuleEditorMessage":
        if (message.message._tag === "ClickedCancel")
          return requestNavigation(model, Routes.rules({ repositoryId }))
        break
    }
  }
  const next = foldRepositories(model, message)
  if (message._tag === "GotRepositories" && model.navigation.route._tag === "Home") {
    const entered = enterRoute(next.model, model.navigation.route)
    return {
      model: entered.model,
      commands: [...(next.commands ?? []), ...(entered.commands ?? [])],
    }
  }
  if (
    message._tag === "GotRepositories" &&
    repositoryId !== undefined &&
    message.repositories.some(
      (repo) => repo.repositoryId === repositoryId && repo.access === "accessible",
    )
  ) {
    return {
      model: evo(next.model, { lastRepositoryId: () => Option.some(repositoryId) }),
      commands: [...(next.commands ?? []), PersistRepository({ repositoryId })],
    }
  }
  if (
    (message._tag === "GotDetail" && Option.isNone(model.repositories.detail)) ||
    message._tag === "GotPolicyDetail"
  ) {
    const loaded = Repositories.openRoute(next.model.repositories, model.navigation.route, false)
    return {
      model: evo(next.model, { repositories: () => loaded.model }),
      commands: [
        ...(next.commands ?? []),
        ...Command.mapMessages(loaded.commands, (message) =>
          Message.GotRepositoriesMessage({ message }),
        ),
      ],
    }
  }
  if (repositoryId !== undefined) {
    const panel = next.model.repositories.panel
    let path: string | undefined
    if (
      message._tag === "CompletedDelete" &&
      Repositories.isViewingSubject(
        model.repositories,
        message.repositoryId,
        message.what,
        message.subjectId,
      ) &&
      next.model.repositories.panel._tag === "Closed"
    )
      path = Routes.sectionPath(message.repositoryId, model.repositories.section)
    if (
      message._tag === "GotRuleEditorMessage" &&
      message.message._tag === "SucceededSaveRule" &&
      model.repositories.panel._tag === "RuleEditor" &&
      next.model.repositories.panel._tag === "Closed"
    )
      path = Routes.rules({ repositoryId })
    if (
      model.navigation.route._tag === "NewPolicy" &&
      panel._tag === "PolicyEditor" &&
      panel.editor.identity._tag === "Existing"
    )
      path = Routes.policy({ ...model.navigation.route, policyId: panel.editor.identity.policyId })
    if (path !== undefined) {
      const routed = requestNavigation(next.model, path, true, false)
      return {
        model: routed.model,
        commands: [...(next.commands ?? []), ...(routed.commands ?? [])],
      }
    }
  }
  return next
}

/** Picking in the switcher is the same act as picking in the repository list,
 *  so it goes through the same Message and reuses the fetches that follow. */
const foldRepositorySwitcherOutMessage = Match.type<RepositorySwitcher.OutMessage>().pipe(
  Match.withReturnType<Update.Step<Model, Message, AppServices>>(),
  Match.tagsExhaustive({
    SelectedRepository:
      ({ repositoryId }) =>
      (model) =>
        requestNavigation(model, Routes.repositoryHome({ repositoryId })),
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

const refreshSyncStatus = Update.foldChildStep({
  update: SyncButton.informWorkChanged,
  read: (model: Model) => Option.some(model.sync),
  write: (model, next) => evo(model, { sync: () => next }),
  toParentMessage: (message) => Message.GotSyncButtonMessage({ message }),
  foldOutMessage: foldSyncOutMessage,
})

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message, AppServices>>(message, {
    GotConnectionsMessage: ({ message }) => {
      const next = Connections.update(model.connections, message)
      const updated = evo(model, { connections: () => next.model })
      if (
        message._tag === "Loaded" &&
        Option.contains(model.connections.maybeLoadRequest, message.requestId) &&
        model.navigation.route._tag === "ConnectReturn"
      )
        return requestNavigation(updated, Routes.connect(), true, false)
      const commands = Command.mapMessages(next.commands, (message) =>
        Message.GotConnectionsMessage({ message }),
      )
      if (next.outMessage?._tag === "OpenGithub")
        return requestNavigation(updated, next.outMessage.url, false, false, true)
      if (next.outMessage?._tag === "Changed") {
        const { id, action } = next.outMessage
        const another = Option.getOrElse(model.repositories.repositories, () => []).find(
          (repo) => repo.repositoryId !== id && repo.access === "accessible",
        )
        const reconnect = Option.exists(model.connections.inventory, (inventory) =>
          inventory.repositories.some((repo) => repo.repositoryId === id && repo.reconnect),
        )
        const destination =
          action === "disconnect"
            ? another
              ? Routes.repositoryHome({ repositoryId: another.repositoryId })
              : Routes.home()
            : action === "connect" && !reconnect
              ? Routes.repositoryHome({ repositoryId: id })
              : Routes.settings({ repositoryId: id })
        const shown = AppToast.show(updated.toast, {
          variant: "Success",
          payload: {
            title:
              action === "disconnect"
                ? "Repository disconnected"
                : action === "connect"
                  ? "Repository connected"
                  : action === "pause"
                    ? "Automation paused"
                    : "Automation resumed",
            description:
              action === "disconnect"
                ? "Policies, rules and history are retained. Reconnect from the repository switcher."
                : action === "connect" && reconnect
                  ? "Review your saved rules before resuming automation."
                  : "",
          },
        })
        const repositoryChange = Repositories.informConnectionChanged(
          updated.repositories,
          id,
          action,
        )
        const refreshed = evo(updated, {
          toast: () => shown.model,
          lastRepositoryId: (previous) =>
            action === "disconnect" && Option.contains(previous, id) ? Option.none() : previous,
          repositories: () => repositoryChange.model,
        })
        const syncRefresh = refreshSyncStatus(refreshed)
        const ownsScreen =
          (model.navigation.route._tag === "Settings" &&
            model.navigation.route.repositoryId === id) ||
          model.navigation.route._tag === "Connect" ||
          model.navigation.route._tag === "ConnectReturn"
        const nav = ownsScreen
          ? requestNavigation(syncRefresh.model, destination, true, false)
          : { model: syncRefresh.model }
        return {
          ...nav,
          commands: [
            ...(nav.commands ?? []),
            ...commands,
            ...Command.mapMessages(shown.commands, (message) =>
              Message.GotToastMessage({ message }),
            ),
            ...(action === "disconnect" && Option.contains(model.lastRepositoryId, id)
              ? [ForgetRepository({})]
              : []),
            ...(syncRefresh.commands ?? []),
            ...Command.mapMessages(repositoryChange.commands, (message) =>
              Message.GotRepositoriesMessage({ message }),
            ),
          ],
        }
      }
      return { model: updated, commands }
    },
    GotNavigationMessage: ({ message }) => updateNavigation(model, message),
    PersistedRepository: () => ({ model }),
    GotSidebarMessage: ({ message }) => foldSidebar(model, message),
    GotThemeSwitcherMessage: ({ message }) => foldThemeSwitcher(model, message),
    GotSyncButtonMessage: ({ message }) =>
      message._tag === "PressedSync" && repositorySyncDisabled(model)
        ? { model }
        : foldSyncButton(model, message),
    GotToastMessage: ({ message }) => foldToast(model, message),
    GotRepositoriesMessage: ({ message }) => updateRepositories(model, message),
    GotRepositorySwitcherMessage: ({ message }) => foldRepositorySwitcher(model, message),
  })

export type AppServices = KeyValueStore.KeyValueStore | HttpClient.HttpClient

export const init: Runtime.RoutingApplicationInit<Model, Message, Flags, AppServices> = (
  flags,
  url,
) => {
  const theme = ThemeSwitcher.init(flags.theme)
  const sidebar = Sidebar.init({ id: "app-sidebar" })
  const sync = SyncButton.init()
  const toast = AppToast.init({ id: "app-toast", defaultDuration: "6 seconds" })
  const repositories = Repositories.init()
  const model = Model.make({
    connectionCancelPath: Option.match(flags.lastRepositoryId ?? Option.none(), {
      onNone: Routes.home,
      onSome: (repositoryId) => Routes.repositoryHome({ repositoryId }),
    }),
    connections: Connections.init(),
    navigation: Navigation.init(flags.historyIndex ?? 0),
    lastRepositoryId: flags.lastRepositoryId ?? Option.none(),
    sidebar,
    theme: theme.model,
    sync: sync.model,
    toast,
    repositories: repositories.model,
    repositorySwitcher: RepositorySwitcher.init(),
  })
  const entered = enterRoute(model, Routes.parse(url))
  return {
    model: entered.model,
    commands: [
      ...navigationCommands([
        Navigation.InitializeHistory({ index: model.navigation.historyIndex }),
      ]),
      ...(entered.commands ?? []),
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

const navigationSubscriptions = Subscription.make<Model, Message>()((entry) => ({
  unsavedChanges: entry(
    { dirty: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        dirty: Repositories.hasUnsavedChanges(model.repositories),
      }),
      dependenciesToStream: ({ dirty }) =>
        dirty
          ? Subscription.fromEvent<BeforeUnloadEvent, Message>({
              target: () => window,
              type: "beforeunload",
              toMessage: (event) => {
                event.preventDefault()
                return Message.GotNavigationMessage({
                  message: Navigation.Message.AttemptedUnload(),
                })
              },
            })
          : Stream.empty,
    },
  ),
}))

export const subscriptions = Subscription.aggregate<Model, Message, AppServices>()(
  sidebarSubscriptions,
  themeSubscriptions,
  syncSubscriptions,
  repositoriesSubscriptions,
  navigationSubscriptions,
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

const navMain = (h: HtmlBuilder<Message>, model: Model): Html =>
  !("repositoryId" in model.navigation.route)
    ? h.empty
    : h.div(
        [],
        [
          Sidebar.group(h, {
            children: [
              Sidebar.groupLabel(h, { children: ["Repository"] }),
              Sidebar.menu(h, {
                children: (["Overview", "Policies", "Rules", "Activity", "Settings"] as const).map(
                  (section) =>
                    Sidebar.menuItem(h, {
                      children: [
                        h.a(
                          [
                            h.Href(
                              "repositoryId" in model.navigation.route
                                ? Routes.sectionPath(model.navigation.route.repositoryId, section)
                                : Routes.home(),
                            ),
                            h.Class(
                              cn(
                                Sidebar.sidebarMenuButtonClass,
                                "repository-nav-link",
                                model.repositories.section === section &&
                                  "bg-sidebar-accent font-medium",
                              ),
                            ),
                            h.AriaCurrent(
                              "repositoryId" in model.navigation.route &&
                                model.repositories.section === section
                                ? "page"
                                : "false",
                            ),
                          ],
                          [
                            Icon.view(
                              h,
                              {
                                Overview: House,
                                Policies: FileCode2,
                                Rules: Tags,
                                Activity,
                                Settings,
                              }[section],
                              "size-4 shrink-0",
                            ),
                            h.span([], [section]),
                          ],
                        ),
                      ],
                    }),
                ),
              }),
            ],
          }),
        ],
      )

const sidebarPanel = (h: HtmlBuilder<Message>, model: Model): ReadonlyArray<Html> => [
  Sidebar.header(h, { children: [sidebarMenu(h, model)] }),
  Sidebar.content(h, { children: [navMain(h, model)] }),
]

const repositorySyncDisabled = (model: Model): boolean =>
  Option.exists(model.repositories.repositories, (repositories) =>
    repositories.some(
      (repository) =>
        "repositoryId" in model.navigation.route &&
        repository.repositoryId === model.navigation.route.repositoryId &&
        repository.syncEnabled === false,
    ),
  )

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
            [
              Sidebar.trigger(h, {
                className: "md:hidden",
                attributes: [
                  h.OnClick(Message.GotSidebarMessage({ message: Sidebar.Message.Toggled() })),
                ],
              }),
              h.span(
                [h.Class("text-sm font-medium")],
                [
                  model.navigation.route._tag === "Connect" ||
                  model.navigation.route._tag === "ConnectReturn"
                    ? "Connect repository"
                    : model.navigation.route._tag === "Home"
                      ? "Repositories"
                      : model.navigation.route._tag === "NotFound"
                        ? "Page not found"
                        : model.repositories.section,
                ],
              ),
            ],
          ),
          h.div(
            [h.Class("flex items-center gap-1")],
            [
              h.submodel({
                slotId: "sync-button",
                model: model.sync,
                view: SyncButton.view,
                viewInputs: { syncDisabled: repositorySyncDisabled(model) },
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
    children: [mainHeader(h, model), routeContent(h, model)],
  }),
  toasts(h, model),
]

const connectionView = (h: HtmlBuilder<Message>, model: Model, repositoryId: string | null) =>
  h.submodel({
    slotId: "repository-connections",
    model: model.connections,
    view: Connections.view,
    toParentMessage: (message) => Message.GotConnectionsMessage({ message }),
    viewInputs: {
      repositoryId,
      state:
        model.navigation.route._tag === "ConnectReturn" ? (model.navigation.route.state ?? "") : "",
      cancelPath: model.connectionCancelPath,
    },
  })
const routeContent = (h: HtmlBuilder<Message>, model: Model): Html => {
  const route = model.navigation.route
  const repositories = Option.getOrElse(model.repositories.repositories, () => [])
  if (route._tag === "Connect" || route._tag === "ConnectReturn")
    return connectionView(h, model, null)
  if (route._tag === "NotFound")
    return h.div(
      [h.Class("p-6 space-y-3")],
      [
        h.h1([h.Class("text-lg font-semibold")], ["Page not found"]),
        h.p(
          [h.Class("text-sm text-muted-foreground")],
          ["This address does not match a page in The Janitor."],
        ),
        h.a([h.Href(Routes.home()), h.Class("text-sm underline")], ["Choose a repository"]),
      ],
    )
  if (
    route._tag === "Home" &&
    Option.isSome(model.repositories.repositories) &&
    repositories.length === 0 &&
    Option.isNone(model.repositories.repositoriesError)
  )
    return h.div(
      [h.Class("policy-empty")],
      [
        Icon.view(h, FileCode2, "size-10 text-muted-foreground"),
        h.h1([h.Class("text-xl font-semibold")], ["Connect your first repository"]),
        h.p(
          [h.Class("text-sm text-muted-foreground max-w-sm")],
          ["Connect a GitHub repository to start building and testing your labeling policies."],
        ),
        h.a(
          [
            h.Href(Routes.connect()),
            h.Class("rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm"),
          ],
          ["Connect repository"],
        ),
      ],
    )
  if (route._tag === "Home")
    return h.div(
      [h.Class("p-6 space-y-3")],
      [
        h.h1([h.Class("text-lg font-semibold")], ["Choose a repository"]),
        Option.isSome(model.repositories.repositoriesError)
          ? h.p([h.Role("alert")], [model.repositories.repositoriesError.value])
          : Option.isNone(model.repositories.repositories)
            ? h.p([h.Role("status")], ["Loading repositories…"])
            : h.div(
                [h.Class("flex flex-col items-start gap-2")],
                repositories
                  .filter((repo) => repo.access === "accessible")
                  .map((repo) =>
                    h.a(
                      [
                        h.Href(Routes.repositoryHome({ repositoryId: repo.repositoryId })),
                        h.Class("text-sm underline"),
                      ],
                      [`${repo.owner}/${repo.repo}`],
                    ),
                  ),
              ),
        Option.isSome(model.repositories.repositories) &&
        !repositories.some((repo) => repo.access === "accessible")
          ? h.p(
              [h.Class("text-sm text-muted-foreground")],
              ["No accessible repositories are available."],
            )
          : h.empty,
      ],
    )
  if (
    Option.isSome(model.repositories.repositories) &&
    !repositories.some(
      (repo) => repo.repositoryId === route.repositoryId && repo.access === "accessible",
    )
  )
    return h.div(
      [h.Class("p-6 space-y-3")],
      [
        h.p(
          [h.Role("alert")],
          [
            Option.isSome(model.connections.inventory) &&
            model.connections.inventory.value.repositories.some(
              (repo) => repo.repositoryId === route.repositoryId && !repo.connected,
            )
              ? "Repository disconnected. Your policies, rules, and history are retained."
              : "This repository is unavailable or you no longer have access.",
          ],
        ),
        h.a([h.Href(Routes.home()), h.Class("text-sm underline")], ["Choose a repository"]),
        h.a([h.Href(Routes.connect()), h.Class("text-sm underline")], ["Connect or repair access"]),
        connectionView(h, model, route.repositoryId),
      ],
    )
  const content = h.submodel({
    slotId: "repositories",
    model: model.repositories,
    view: Repositories.view,
    toParentMessage: (message) => Message.GotRepositoriesMessage({ message }),
  })
  return route._tag === "Settings"
    ? h.div([h.Class("space-y-4 p-4")], [connectionView(h, model, route.repositoryId), content])
    : content
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `${model.navigation.route._tag === "Connect" || model.navigation.route._tag === "ConnectReturn" ? "Connect repository" : model.navigation.route._tag === "Home" ? "Repositories" : model.navigation.route._tag === "NotFound" ? "Page not found" : model.repositories.section} · The Janitor`,
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
