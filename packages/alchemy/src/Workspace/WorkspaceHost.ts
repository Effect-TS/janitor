import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { type SandboxExecOptions } from "../AI/Sandbox.ts"
import { makeSandboxLocal } from "../AI/SandboxLocal.ts"
import { CheckoutOptions, Checkouts } from "../Git/Checkouts.ts"
import * as Workspace from "./Workspace.ts"

const ExecOptions = Schema.Struct({
  cwd: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  timeout: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
  maxRetainedBytes: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
})
const Key = Schema.NonEmptyString

/** Validate RPC arguments before entering the typed implementation. */
const validated =
  <S extends Schema.Top, A, E>(schema: S, run: (args: S["Type"]) => Effect.Effect<A, E>) =>
  (...args: ReadonlyArray<unknown>) =>
    Schema.decodeEffect(schema, { onExcessProperty: "error" })(args).pipe(
      Effect.mapError(String),
      Effect.flatMap(run),
    )

/** All file and process calls require an acquired checkout key. */
export const makeWorkspaceHost = Effect.gen(function* () {
  const checkouts = yield* Checkouts
  const environment =
    yield* Effect.context<Exclude<Effect.Services<typeof makeSandboxLocal>, Workspace.Workspace>>()
  const sandbox = Effect.fnUntraced(function* (key: string) {
    const checkout = yield* checkouts.get(key).pipe(Effect.mapError(String))
    if (Option.isNone(checkout)) {
      return yield* Effect.fail(`checkout ${key} is not ready; acquire it before using the sandbox`)
    }
    return yield* makeSandboxLocal.pipe(
      Effect.provide(Workspace.fixed(checkout.value.root)),
      Effect.provide(environment),
    )
  })

  return {
    workspaceEnsure: validated(Schema.Tuple([CheckoutOptions]), ([options]) =>
      checkouts.checkout(options),
    ),
    workspaceGet: validated(Schema.Tuple([Key]), ([key]) =>
      checkouts.get(key).pipe(Effect.map(Option.getOrNull)),
    ),
    workspaceDrop: validated(Schema.Tuple([Key]), ([key]) => checkouts.release(key)),
    exec: validated(
      Schema.Tuple([Key, Schema.String, Schema.Array(Schema.String), ExecOptions]),
      Effect.fnUntraced(function* ([key, command, args, options]) {
        return yield* (yield* sandbox(key)).exec(
          command,
          args,
          options satisfies SandboxExecOptions,
        )
      }),
    ),
    readFile: validated(
      Schema.Tuple([Key, Schema.String]),
      Effect.fnUntraced(function* ([key, path]) {
        return yield* (yield* sandbox(key)).readFile(path)
      }),
    ),
    writeFile: validated(
      Schema.Tuple([Key, Schema.String, Schema.String]),
      Effect.fnUntraced(function* ([key, path, content]) {
        return yield* (yield* sandbox(key)).writeFile(path, content)
      }),
    ),
    deleteFile: validated(
      Schema.Tuple([Key, Schema.String]),
      Effect.fnUntraced(function* ([key, path]) {
        return yield* (yield* sandbox(key)).deleteFile(path)
      }),
    ),
    mkdir: validated(
      Schema.Tuple([Key, Schema.String]),
      Effect.fnUntraced(function* ([key, path]) {
        return yield* (yield* sandbox(key)).mkdir(path)
      }),
    ),
    listFiles: validated(
      Schema.Tuple([Key, Schema.String]),
      Effect.fnUntraced(function* ([key, path]) {
        return yield* (yield* sandbox(key)).listFiles(path)
      }),
    ),
    exists: validated(
      Schema.Tuple([Key, Schema.String]),
      Effect.fnUntraced(function* ([key, path]) {
        return yield* (yield* sandbox(key)).exists(path)
      }),
    ),
  }
})

export type WorkspaceHostShape = Effect.Success<typeof makeWorkspaceHost>
