import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Dockerfile from "alchemy/Docker/Dockerfile"
import * as AgentExecutor from "clanka/AgentExecutor"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as References from "effect/References"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { sandboxCommandTimeout, sandboxMaxInstances } from "../Config.ts"
import { errorFields } from "../Log.ts"
import { executorOptions } from "./ExecutorOptions.ts"
import { REVIEW_IMAGE, trustInterceptCa } from "./Image.ts"
import { GitCommandFailed, type Git } from "./Checkout.ts"
import { makeContainerApp, WORKSPACE_DIRECTORY } from "./ContainerApp.ts"
import { SandboxContainer } from "./SandboxContainer.ts"

/**
 * The sandbox container's guest program. Bundled by alchemy into the image;
 * `alchemy.run.ts` provides it so the container application deploys.
 */

/** How long one git command may run before the attempt fails. */
const GIT_TIMEOUT = "2 minutes"

/** Run before each checkout attempt: trusts the CA (the intercepts are registered by now) and empties the workspace. */
const prepareCheckout = Effect.gen(function* () {
  yield* trustInterceptCa
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(WORKSPACE_DIRECTORY, { recursive: true })
  for (const entry of yield* fs.readDirectory(WORKSPACE_DIRECTORY)) {
    yield* fs.remove(path.join(WORKSPACE_DIRECTORY, entry), { recursive: true })
  }
})

const text = <E>(stream: Stream.Stream<Uint8Array, E>) => Stream.mkString(Stream.decodeText(stream))

export default SandboxContainer.make(
  Effect.gen(function* () {
    const commandTimeout = yield* sandboxCommandTimeout
    return {
      main: import.meta.url,
      runtime: "node" as const,
      // 2 vCPU: a cold `pnpm install` of Effect-TS/effect takes over two
      // minutes on standard-1's half vCPU, and about 50 seconds here.
      instanceType: "standard-3" as const,
      maxInstances: yield* sandboxMaxInstances,
      // photon-node loads its wasm from its own directory, so it can't be
      // bundled; clanka imports it only to attach images.
      external: ["@silvia-odwyer/photon-node"],
      autoInstallExternals: false,
      dockerfile: Dockerfile.inline`
        ${REVIEW_IMAGE}
        ENV PR_REVIEW_COMMAND_TIMEOUT_SECONDS=${String(Duration.toSeconds(commandTimeout))}
      `,
    }
  }),
  Effect.gen(function* () {
    // Lives as long as the container's process.
    const scope = yield* Scope.make()
    const services = yield* Layer.build(NodeServices.layer).pipe(Scope.provide(scope))
    const node = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
      Effect.provideContext(effect, services)
    yield* node(trustInterceptCa).pipe(Effect.ignore)
    // The deploy's command timeout, from the image's environment.
    const commandTimeout = yield* sandboxCommandTimeout
    const spawner = yield* node(ChildProcessSpawner)
    const http = yield* RpcServer.makeProtocolWithHttpEffect().pipe(
      Effect.provide(RpcSerialization.layerNdjson),
    )
    yield* Layer.build(
      AgentExecutor.layerRpcServer({
        directory: WORKSPACE_DIRECTORY,
        ...executorOptions(commandTimeout),
      }).pipe(
        Layer.provide(Layer.succeed(RpcServer.Protocol, http.protocol)),
        Layer.provide(Layer.succeedContext(services)),
        Layer.provide(FetchHttpClient.layer),
        // clanka logs each tool call's arguments at Info: commands, paths and
        // search text from the pull request, which never go in logs.
        Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
      ),
    ).pipe(Scope.provide(scope))

    const git: Git = (args) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make("git", args, {
              cwd: WORKSPACE_DIRECTORY,
              env: { GIT_TERMINAL_PROMPT: "0" },
              extendEnv: true,
            }),
          )
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [text(handle.stdout), text(handle.stderr), handle.exitCode],
            { concurrency: "unbounded" },
          )
          if (exitCode !== 0) return yield* new GitCommandFailed({ args, exitCode, stderr })
          return stdout
        }),
      ).pipe(
        Effect.timeoutOrElse({
          duration: GIT_TIMEOUT,
          orElse: () =>
            Effect.fail(new GitCommandFailed({ args, exitCode: -1, stderr: "timed out" })),
        }),
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(new GitCommandFailed({ args, exitCode: -1, stderr: error.message })),
        ),
      )

    return SandboxContainer.of({
      fetch: makeContainerApp({
        rpc: http.httpEffect,
        git,
        reset: node(prepareCheckout).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not prepare the workspace").pipe(
              Effect.annotateLogs(errorFields(error)),
            ),
          ),
        ),
      }),
    })
  }),
)
