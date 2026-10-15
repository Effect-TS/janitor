import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Dockerfile from "alchemy/Docker/Dockerfile"
import * as AgentExecutor from "clanka/AgentExecutor"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { sandboxMaxInstances } from "../Config.ts"
import { GitCommandFailed, type Git } from "./Checkout.ts"
import { makeContainerApp, WORKSPACE_DIRECTORY } from "./ContainerApp.ts"
import { SandboxContainer } from "./SandboxContainer.ts"

/**
 * The sandbox container's guest program. Bundled by alchemy into the image;
 * `alchemy.run.ts` provides it so the container application deploys.
 */

// The container runs on Node; cluster code is typed without Node globals.
declare const process: { readonly env: Record<string, string | undefined> }

/** Cloudflare's intercept CA. It exists only once the container runs with HTTPS intercepted. */
const INTERCEPT_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt"
const SYSTEM_BUNDLE = "/etc/ssl/certs/ca-certificates.crt"

/** How long one git command may run before the attempt fails. */
const GIT_TIMEOUT = "2 minutes"

/**
 * Trusts the intercept CA: appended to the system bundle for git, curl and
 * python, and named in `NODE_EXTRA_CA_CERTS` for node (and npm), which reads
 * its own store. Child processes inherit the environment. Idempotent, and a
 * no-op until the CA exists.
 */
const trustInterceptCa = Effect.gen(function* () {
  if (process.env.NODE_EXTRA_CA_CERTS === INTERCEPT_CA) return
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(INTERCEPT_CA))) return
  const ca = yield* fs.readFileString(INTERCEPT_CA)
  if (!(yield* fs.readFileString(SYSTEM_BUNDLE)).includes(ca.trim())) {
    yield* fs.writeFileString(SYSTEM_BUNDLE, `\n${ca}`, { flag: "a" })
  }
  process.env.NODE_EXTRA_CA_CERTS = INTERCEPT_CA
  process.env.REQUESTS_CA_BUNDLE = SYSTEM_BUNDLE
  process.env.PIP_CERT = SYSTEM_BUNDLE
})

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
    return {
      main: import.meta.url,
      runtime: "node" as const,
      instanceType: "standard-1" as const,
      maxInstances: yield* sandboxMaxInstances,
      // photon-node loads its wasm from its own directory, so it can't be
      // bundled; clanka imports it only to attach images.
      external: ["@silvia-odwyer/photon-node"],
      autoInstallExternals: false,
      dockerfile: Dockerfile.inline`
        FROM node:24-bookworm-slim
        RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl g++ git make python3 ripgrep && rm -rf /var/lib/apt/lists/*
        RUN git config --system core.hooksPath /dev/null
        RUN mkdir -p /app /workspace
        RUN cd /app && npm install --no-save --no-audit --no-fund @silvia-odwyer/photon-node@0.3.4
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
    const spawner = yield* node(ChildProcessSpawner)
    const http = yield* RpcServer.makeProtocolWithHttpEffect().pipe(
      Effect.provide(RpcSerialization.layerNdjson),
    )
    yield* Layer.build(
      AgentExecutor.layerRpcServer({ directory: WORKSPACE_DIRECTORY }).pipe(
        Layer.provide(Layer.succeed(RpcServer.Protocol, http.protocol)),
        Layer.provide(Layer.succeedContext(services)),
        Layer.provide(FetchHttpClient.layer),
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
          Effect.catch((error) => Effect.logWarning("Could not prepare the workspace", error)),
        ),
      }),
    })
  }),
)
