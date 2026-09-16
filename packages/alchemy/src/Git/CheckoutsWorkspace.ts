import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { makeWorkspaceClient } from "../Workspace/WorkspaceClient.ts"
import { Checkout, Checkouts, GitError, failure } from "./Checkouts.ts"

const remoteError = (command: string) => (error: unknown) => {
  const decoded = Schema.decodeUnknownOption(GitError)(error)
  return Option.isSome(decoded) ? decoded.value : failure(command)(error)
}

export const layerWorkspace = (url: string | Effect.Effect<string | undefined>) =>
  Layer.effect(
    Checkouts,
    Effect.gen(function* () {
      const client = yield* makeWorkspaceClient(url)
      return Checkouts.of({
        checkout: Effect.fnUntraced(
          function* (options) {
            const value = yield* (yield* client).workspaceEnsure(options)
            return yield* Schema.decodeEffect(Checkout)(value)
          },
          Effect.mapError(remoteError("workspaceEnsure")),
        ),
        get: Effect.fnUntraced(
          function* (key) {
            const value = yield* (yield* client).workspaceGet(key)
            return Option.fromNullishOr(yield* Schema.decodeEffect(Schema.NullOr(Checkout))(value))
          },
          Effect.mapError(remoteError("workspaceGet")),
        ),
        release: Effect.fnUntraced(
          function* (key) {
            yield* (yield* client).workspaceDrop(key)
          },
          Effect.mapError(remoteError("workspaceDrop")),
        ),
      })
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))
