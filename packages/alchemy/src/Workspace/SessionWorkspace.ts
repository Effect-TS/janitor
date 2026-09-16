import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Sandbox } from "../AI/Sandbox.ts"
import { type Checkout, type CheckoutOptions, Checkouts, type GitError } from "../Git/Checkouts.ts"

export class SessionWorkspace extends Context.Service<
  SessionWorkspace,
  {
    readonly checkout: Effect.Effect<Checkout, GitError>
    /** Explicit removal, never a request-scope finalizer. Discards unpublished work. */
    readonly release: Effect.Effect<void, GitError>
  }
>()("@janitor/alchemy/Workspace/SessionWorkspace") {}

/** Build once per session, with a raw sandbox and its matching checkout implementation. */
export const layerSession = (options: Omit<CheckoutOptions, "fresh">) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const sandbox = yield* Sandbox
      const checkouts = yield* Checkouts
      const checkout = checkouts.checkout(options)
      const ready = checkout.pipe(Effect.mapError(String))
      const scopedSandbox = Sandbox.of({
        exec: (command, args, execOptions) =>
          ready.pipe(Effect.andThen(() => sandbox.exec(command, args, execOptions))),
        readFile: (path) => ready.pipe(Effect.andThen(() => sandbox.readFile(path))),
        writeFile: (path, content) =>
          ready.pipe(Effect.andThen(() => sandbox.writeFile(path, content))),
        deleteFile: (path) => ready.pipe(Effect.andThen(() => sandbox.deleteFile(path))),
        mkdir: (path) => ready.pipe(Effect.andThen(() => sandbox.mkdir(path))),
        listFiles: (path) => ready.pipe(Effect.andThen(() => sandbox.listFiles(path))),
        exists: (path) => ready.pipe(Effect.andThen(() => sandbox.exists(path))),
      })
      return Context.make(Sandbox, scopedSandbox).pipe(
        Context.add(SessionWorkspace, {
          checkout,
          release: checkouts.release(options.key),
        }),
      )
    }),
  )
