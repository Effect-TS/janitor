import { provideFreshArtifactStore } from "alchemy/Artifacts"
import { LoggingCli } from "alchemy/Cli/LoggingCli"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, it } from "@effect/vitest"
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { evalStack } from "alchemy/Stack"
import { inMemoryState } from "alchemy/State"
import * as Effect from "effect/Effect"
import { AlchemyContext } from "alchemy/AlchemyContext"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { ReviewSandboxContainerRuntime } from "@janitor/alchemy/Cloudflare/AI/ReviewSandboxContainerRuntime"
import { SandboxContainerRuntime } from "@janitor/alchemy/Cloudflare/AI/SandboxContainerRuntime"
import {
  ReviewWorkspaceObject,
  ReviewWorkspaceObjectLive,
} from "../../src/Review/WorkspaceObject.ts"
import { SlackSession, SessionObjectLive } from "../../src/Slack/SessionObject.ts"
import { SessionRuntime } from "../../src/Slack/SessionRuntime.ts"

class Worker extends Cloudflare.Worker<Worker>()(
  "SandboxBindingsTest",
  { main: import.meta.url },
  Effect.gen(function* () {
    yield* ReviewWorkspaceObject.pipe(Effect.provide(ReviewWorkspaceObjectLive))
    yield* SlackSession.pipe(
      Effect.provide(SessionObjectLive),
      Effect.provideService(SessionRuntime, {
        run: () => Effect.die("Unexpected session execution"),
        post: () => Effect.die("Unexpected Slack write"),
      }),
    )
    return { fetch: Effect.succeed(HttpServerResponse.text("test")) }
  }),
) {}

const stack = Alchemy.Stack(
  "SandboxBindingsTest",
  { providers: Cloudflare.providers(), state: inMemoryState() },
  Worker.pipe(Effect.provide([SandboxContainerRuntime, ReviewSandboxContainerRuntime])),
)

it.live("binds each sandbox container application to just one Durable Object namespace", () =>
  evalStack(
    stack,
    (compiled) =>
      Effect.sync(() => {
        const containers = Object.values(compiled.resources).filter(
          (resource) => resource.Type === "Cloudflare.Container",
        )
        assert.deepStrictEqual(
          Object.fromEntries(
            containers.map((resource) => [
              resource.FQN,
              (compiled.bindings[resource.FQN] ?? []).map((binding) => binding.sid),
            ]),
          ),
          { SandboxContainer: ["SlackSession"], ReviewSandboxContainer: ["ReviewWorkspace"] },
        )
        const workerContainers = (compiled.bindings.SandboxBindingsTest ?? []).flatMap(
          (binding) => binding.data.containers ?? [],
        )
        assert.deepStrictEqual(workerContainers.map((container) => container.className).sort(), [
          "ReviewWorkspace",
          "SlackSession",
        ])
      }),
    { stage: "test" },
  ).pipe(
    provideFreshArtifactStore,
    Effect.provide([LoggingCli, inMemoryState()]),
    Effect.provideService(AlchemyContext, {
      dotAlchemy: "/tmp/janitor-sandbox-bindings-test",
      dev: false,
      adopt: false,
    }),
    Effect.provide(NodeServices.layer),
  ),
)
