import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Command from "foldkit/command"
import * as Navigation from "foldkit/navigation"
import * as Url from "foldkit/url"
import { defineMessageUnion } from "foldkit/message"

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
