import * as Option from "effect/Option"
import { evo } from "foldkit/struct"
import type * as Update from "foldkit/update"
import * as Routes from "@/routes"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Command from "foldkit/command"
import * as Navigation from "foldkit/navigation"
import * as Url from "foldkit/url"
import { defineMessageUnion } from "foldkit/message"

/** Accepted location and the state needed to guard browser navigation. */
export const Model = Schema.Struct({
  route: Routes.AppRoute,
  historyIndex: Schema.Int,
  pendingDestination: Schema.Option(Schema.String),
  requestId: Schema.Int,
})
export type Model = typeof Model.Type
export const init = (historyIndex = 0): Model => ({
  route: Routes.AppRoute.Home(),
  historyIndex,
  pendingDestination: Option.none(),
  requestId: 0,
})

/** The workspace supplies these facts; navigation does not inspect editor state. */
export interface Context {
  readonly isSaving: boolean
  readonly hasUnsavedChanges: boolean
}
export interface RequestOptions {
  readonly replace?: boolean
  readonly guard?: boolean
  readonly external?: boolean
}
export const OutMessage = defineMessageUnion({ AcceptedRoute: { route: Routes.AppRoute } })
export type OutMessage = typeof OutMessage.Type

/** Commit the accepted route together with the parent's page transition. */
export const enter = (model: Model, route: Routes.AppRoute): Model =>
  evo(model, { route: () => route, pendingDestination: () => Option.none() })

export const Message = defineMessageUnion({
  RequestedUrl: { request: Navigation.UrlRequest },
  ChangedUrl: { url: Url.Url },
  ResolvedUrl: { url: Url.Url, index: Schema.Int, allowed: Schema.Boolean, requestId: Schema.Int },
  FinishedNavigation: { cancelled: Schema.Boolean },
  InitializedHistory: {},
  AttemptedUnload: {},
})
export type Message = typeof Message.Type
export const historyIndex = (): number =>
  Number.isSafeInteger(window.history.state?.janitorIndex) ? window.history.state.janitorIndex : 0
const markHistory = (index: number) =>
  window.history.replaceState({ ...window.history.state, janitorIndex: index }, "")
const discard = () => window.confirm("Discard your unsaved changes and leave this editor?")

export const InitializeHistory = Command.define("InitializeRoutingHistory", {
  args: { index: Schema.Int },
  messages: [Message.InitializedHistory],
  execute: ({ index }) =>
    Effect.sync(() => {
      markHistory(index)
      return Message.InitializedHistory()
    }),
})

export const Navigate = Command.define("Navigate", {
  args: {
    path: Schema.String,
    index: Schema.Int,
    replace: Schema.Boolean,
    guard: Schema.Boolean,
    external: Schema.Boolean,
  },
  messages: [Message.FinishedNavigation],
  execute: ({ path, index, replace, guard, external }) =>
    Effect.gen(function* () {
      if (guard && !(yield* Effect.sync(discard)))
        return Message.FinishedNavigation({ cancelled: true })
      if (external) yield* Navigation.load(path)
      else {
        yield* replace ? Navigation.replaceUrl(path) : Navigation.pushUrl(path)
        yield* Effect.sync(() => markHistory(replace ? index : index + 1))
      }
      return Message.FinishedNavigation({ cancelled: false })
    }),
})

/** Popstate has already moved the URL. On cancellation, restore its history entry as well as the screen. */
export const CheckHistoryNavigation = Command.define("CheckHistoryNavigation", {
  args: {
    url: Url.Url,
    fromPath: Schema.String,
    fromIndex: Schema.Int,
    guard: Schema.Boolean,
    blocked: Schema.Boolean,
    requestId: Schema.Int,
  },
  messages: [Message.ResolvedUrl],
  execute: ({ url, fromPath, fromIndex, guard, blocked, requestId }) =>
    Effect.gen(function* () {
      const index = yield* Effect.sync(historyIndex)
      const allowed = !blocked && (!guard || (yield* Effect.sync(discard)))
      if (!allowed) {
        if (fromIndex !== index) yield* Effect.sync(() => window.history.go(fromIndex - index))
        else yield* Navigation.replaceUrl(fromPath)
      }
      return Message.ResolvedUrl({ url, index, allowed, requestId })
    }),
})

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

export const request = (
  model: Model,
  path: string,
  context: Context,
  { replace = false, guard = true, external = false }: RequestOptions = {},
): UpdateReturn => {
  if (!external && !replace && path === Routes.path(model.route)) return { model }
  const destination = Option.getOrThrow(Url.fromString(new URL(path, "http://routing.local").href))
  const leavingDocument =
    external || Routes.documentPath(Routes.parse(destination)) !== Routes.documentPath(model.route)
  if (leavingDocument && context.isSaving) return { model }
  return {
    model: evo(model, { pendingDestination: () => Option.some(path) }),
    commands: [
      Navigate({
        path,
        index: model.historyIndex,
        replace,
        external,
        guard: guard && !external && leavingDocument && context.hasUnsavedChanges,
      }),
    ],
  }
}

export const update = (model: Model, message: Message, context: Context): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    RequestedUrl: ({ request: destination }) =>
      destination._tag === "Internal"
        ? request(model, Routes.urlPath(destination.url), context)
        : request(model, destination.href, context, { external: true }),
    ChangedUrl: ({ url }) => {
      const requestId = model.requestId + 1
      return {
        model: evo(model, { requestId: () => requestId }),
        commands: [
          CheckHistoryNavigation({
            url,
            requestId,
            fromPath: Routes.path(model.route),
            fromIndex: model.historyIndex,
            blocked:
              Routes.documentPath(Routes.parse(url)) !== Routes.documentPath(model.route) &&
              context.isSaving,
            guard:
              !Option.contains(model.pendingDestination, Routes.urlPath(url)) &&
              Routes.documentPath(Routes.parse(url)) !== Routes.documentPath(model.route) &&
              context.hasUnsavedChanges,
          }),
        ],
      }
    },
    ResolvedUrl: ({ url, index, allowed, requestId }) =>
      requestId !== model.requestId || !allowed
        ? { model }
        : {
            model: evo(model, {
              historyIndex: () => index,
              pendingDestination: () => Option.none(),
            }),
            outMessage: OutMessage.AcceptedRoute({ route: Routes.parse(url) }),
          },
    FinishedNavigation: ({ cancelled }) =>
      cancelled ? { model: evo(model, { pendingDestination: () => Option.none() }) } : { model },
    InitializedHistory: () => ({ model }),
    AttemptedUnload: () => ({ model }),
  })
