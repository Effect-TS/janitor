import type { Providers } from "alchemy/Cloudflare"
import * as Container from "alchemy/Cloudflare/Containers"
import { DurableObjectState } from "alchemy/Cloudflare/Workers"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { Sandbox } from "../../AI/Sandbox.ts"

/** The guest exposes the seven required sandbox methods over container RPC. */
export type SandboxContainerShape = Omit<Sandbox["Service"], "pty" | "lifecycle">

/** Provide this declaration's .make() runtime on the stack to deploy the guest. */
export class SandboxContainerImage extends Container.Container<
  SandboxContainerImage,
  SandboxContainerShape
>()("SandboxContainer") {}

const makeContainer = Effect.gen(function* () {
  const sandbox = yield* SandboxContainerImage
  return Sandbox.of({
    exec: (command, args, execOptions) => sandbox.exec(command, args, execOptions),
    readFile: (path) => sandbox.readFile(path),
    writeFile: (path, content) => sandbox.writeFile(path, content),
    deleteFile: (path) => sandbox.deleteFile(path),
    mkdir: (path) => sandbox.mkdir(path),
    listFiles: (path) => sandbox.listFiles(path),
    exists: (path) => sandbox.exists(path),
  })
})

/** A sandbox backed by the calling Durable Object's container. Disk is ephemeral. */
export const layerContainer = (
  options?: Container.ContainerStartupOptions,
): Layer.Layer<
  Sandbox,
  never,
  Container.Container.Application<SandboxContainerImage> | Providers
> =>
  Layer.effect(Sandbox, makeContainer).pipe(
    Layer.provide(Container.layer(SandboxContainerImage, options)),
  )

const containers = new WeakMap<
  object,
  Effect.Effect<Container.Container.Instance<SandboxContainerImage>>
>()

const makeContainerSession = Effect.fnUntraced(function* (
  options?: Container.ContainerStartupOptions,
) {
  const context = yield* Effect.context<
    Container.Container.Application<SandboxContainerImage> | Providers
  >()

  const sandbox = Effect.gen(function* () {
    const state = yield* Effect.serviceOption(DurableObjectState)

    if (Option.isNone(state)) {
      return yield* Effect.fail(
        "Sandbox session requires the calling Durable Object's state. " +
          "Provide DurableObjectState when invoking sandbox methods.",
      )
    }

    const existing = containers.get(state.value)
    if (existing !== undefined) {
      return yield* existing
    }

    const started = yield* Effect.cached(
      // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context
      Container.startContainer(SandboxContainerImage, options).pipe(
        Effect.provide(context),
        Effect.orDie,
      ) as Effect.Effect<Container.Container.Instance<SandboxContainerImage>>,
    )

    // Publish before starting so concurrent calls share the same initialization.
    containers.set(state.value, started)

    return yield* started
  })

  const withSandbox = <A>(use: (instance: Sandbox["Service"]) => Effect.Effect<A, string>) =>
    Effect.flatMap(sandbox, use)

  return Sandbox.of({
    exec: (command, args, execOptions) =>
      withSandbox((instance) => instance.exec(command, args, execOptions)),
    readFile: (path) => withSandbox((instance) => instance.readFile(path)),
    writeFile: (path, content) => withSandbox((instance) => instance.writeFile(path, content)),
    deleteFile: (path) => withSandbox((instance) => instance.deleteFile(path)),
    mkdir: (path) => withSandbox((instance) => instance.mkdir(path)),
    listFiles: (path) => withSandbox((instance) => instance.listFiles(path)),
    exists: (path) => withSandbox((instance) => instance.exists(path)),
  })
})

/** Resolve and start the calling session's container on first use, not layer construction. */
export const layerContainerSession = (
  options?: Container.ContainerStartupOptions,
): Layer.Layer<
  Sandbox,
  never,
  Container.Container.Application<SandboxContainerImage> | Providers
> => Layer.effect(Sandbox, makeContainerSession(options))
