import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { makeWorkspaceClient } from "../Workspace/WorkspaceClient.ts"
import { Sandbox } from "./Sandbox.ts"

/** The host resolves the key to a checkout root before each operation. */
export const layerHttp = (options: {
  readonly url: string | Effect.Effect<string | undefined>
  readonly key: string
}) =>
  Layer.effect(
    Sandbox,
    Effect.gen(function* () {
      const client = yield* makeWorkspaceClient(options.url)
      const key = options.key
      return Sandbox.of({
        exec: Effect.fnUntraced(function* (command, args, execOptions) {
          return yield* (yield* client).exec(key, command, args ?? [], execOptions ?? {})
        }, Effect.mapError(String)),
        readFile: Effect.fnUntraced(function* (path) {
          return yield* (yield* client).readFile(key, path)
        }, Effect.mapError(String)),
        writeFile: Effect.fnUntraced(function* (path, content) {
          yield* (yield* client).writeFile(key, path, content)
        }, Effect.mapError(String)),
        deleteFile: Effect.fnUntraced(function* (path) {
          yield* (yield* client).deleteFile(key, path)
        }, Effect.mapError(String)),
        mkdir: Effect.fnUntraced(function* (path) {
          yield* (yield* client).mkdir(key, path)
        }, Effect.mapError(String)),
        listFiles: Effect.fnUntraced(function* (path) {
          return yield* (yield* client).listFiles(key, path ?? ".")
        }, Effect.mapError(String)),
        exists: Effect.fnUntraced(function* (path) {
          return yield* (yield* client).exists(key, path)
        }, Effect.mapError(String)),
      })
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))
