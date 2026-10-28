import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Dockerfile from "@alchemy.run/docker/Dockerfile"
import * as AgentExecutor from "clanka/AgentExecutor"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as References from "effect/References"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import * as Scope from "effect/Scope"
import { WORKSPACE_DIRECTORY } from "../../PullRequestReview/Sandbox/ContainerApp.ts"
import { COMMAND_OUTPUT_CHARS } from "../../PullRequestReview/Sandbox/ExecutorOptions.ts"
import { REVIEW_IMAGE, trustInterceptCa } from "../../PullRequestReview/Sandbox/Image.ts"
import { chatCommandTimeout, chatSandboxMaxInstances } from "../Config.ts"
import { ChatSandbox } from "./ChatSandbox.ts"
import { makeChatContainerApp } from "./ContainerApp.ts"
import { MULTICA_CLI_SHA256, MULTICA_CLI_VERSION } from "./MulticaCli.ts"
import { applyProvision } from "./Provision.ts"

/**
 * The chat sandbox container's guest program and image (EFF-3016). Bundled
 * by alchemy into the image.
 */

// The container runs on Node; cluster code is typed without Node globals.
declare const process: { readonly env: Record<string, string | undefined> }

/**
 * Keeps pnpm's store on the same filesystem as /workspace for hardlinks,
 * and holds clanka's user skills.
 */
const HOME = "/root"

const GH_VERSION = "2.103.3"
const BUN_VERSION = "1.4.4"
const DENO_VERSION = "2.9.6"

/**
 * PR review's image, plus `gh`, the pinned `multica` CLI (its checksum
 * verified), bun and deno. No nix: the model installs anything else it needs.
 */
const chatImage = (commandTimeout: Duration.Duration) => `
${REVIEW_IMAGE}
ENV HOME=${HOME}
RUN curl -fsSL https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz | tar -xz -C /tmp && mv /tmp/gh_${GH_VERSION}_linux_amd64/bin/gh /usr/local/bin/gh && rm -rf /tmp/gh_${GH_VERSION}_linux_amd64
RUN curl -fsSLo /tmp/multica.tar.gz https://github.com/multica-ai/multica/releases/download/v${MULTICA_CLI_VERSION}/multica-cli-${MULTICA_CLI_VERSION}-linux-amd64.tar.gz && echo "${MULTICA_CLI_SHA256}  /tmp/multica.tar.gz" | sha256sum -c - && tar -xzf /tmp/multica.tar.gz -C /usr/local/bin multica && rm /tmp/multica.tar.gz
RUN npm install -g --no-audit --no-fund bun@${BUN_VERSION} deno@${DENO_VERSION}
ENV CHAT_COMMAND_TIMEOUT_SECONDS=${String(Duration.toSeconds(commandTimeout))}
`

export default ChatSandbox.make(
  Effect.gen(function* () {
    const commandTimeout = yield* chatCommandTimeout
    return {
      main: import.meta.url,
      runtime: "node" as const,
      // 2 vCPU, as PR review's: a cold `pnpm install` of Effect-TS/effect
      // takes over two minutes on standard-1's half vCPU.
      instanceType: "standard-3" as const,
      maxInstances: yield* chatSandboxMaxInstances,
      // photon-node loads its wasm from its own directory, so it can't be
      // bundled; clanka imports it only to attach images.
      external: ["@silvia-odwyer/photon-node"],
      autoInstallExternals: false,
      dockerfile: Dockerfile.inline`${chatImage(commandTimeout)}`,
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
    const commandTimeout = yield* chatCommandTimeout
    const http = yield* RpcServer.makeProtocolWithHttpEffect().pipe(
      Effect.provide(RpcSerialization.layerNdjson),
    )
    yield* Layer.build(
      AgentExecutor.layerRpcServer({
        directory: WORKSPACE_DIRECTORY,
        // Every built-in tool, `gh`, `delegate`, `fetchMarkdown` and `webSearch` included.
        limits: {
          commandTimeout,
          scriptTimeout: commandTimeout,
          commandOutputChars: COMMAND_OUTPUT_CHARS,
        },
      }).pipe(
        Layer.provide(Layer.succeed(RpcServer.Protocol, http.protocol)),
        Layer.provide(Layer.succeedContext(services)),
        Layer.provide(FetchHttpClient.layer),
        // clanka logs each tool call's arguments at Info: commands, paths and
        // search text from the conversation, which never go in logs.
        Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
      ),
    ).pipe(Scope.provide(scope))

    return ChatSandbox.of({
      fetch: makeChatContainerApp({
        rpc: http.httpEffect,
        // The intercepts are registered by the time the workspace provisions.
        provision: (request) =>
          node(
            Effect.andThen(
              trustInterceptCa,
              applyProvision({
                request,
                env: process.env,
                home: process.env.HOME ?? HOME,
                workspace: WORKSPACE_DIRECTORY,
              }),
            ),
          ),
        writeFile: (path, content) =>
          node(
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem
              yield* fs.makeDirectory((yield* Path.Path).dirname(path), { recursive: true })
              yield* fs.writeFile(path, content)
            }),
          ),
      }),
    })
  }),
)
