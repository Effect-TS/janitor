import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, it } from "@effect/vitest"
import { Credentials, apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials"
import * as Alchemy from "alchemy"
import { AlchemyContext } from "alchemy/AlchemyContext"
import { provideFreshArtifactStore } from "alchemy/Artifacts"
import { LoggingCli } from "alchemy/Cli/LoggingCli"
import * as Interaction from "alchemy/Interaction"
import * as Cloudflare from "alchemy/Cloudflare"
import { findProvider } from "alchemy/Provider"
import { evalStack } from "alchemy/Stack"
import { inMemoryState } from "alchemy/State"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

const image = `registry.cloudflare.com/test/review@sha256:${"a".repeat(64)}`
const stack = Alchemy.Stack(
  "ContainerSizingTest",
  { providers: Cloudflare.providers(), state: inMemoryState() },
  Effect.void,
)
for (const updating of [false, true]) {
  it.effect(
    `sends numeric resource sizes when ${updating ? "updating and rolling out" : "creating"} a container`,
    () =>
      Effect.gen(function* () {
        const writes: Array<{
          configuration?: Record<string, unknown>
          target_configuration?: Record<string, unknown>
        }> = []
        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            if (request.method !== "GET" && request.body._tag === "Uint8Array")
              writes.push(JSON.parse(new TextDecoder().decode(request.body.body)))
            const application = {
              id: "application-id",
              name: "review",
              account_id: "test",
              scheduling_policy: "default",
              instances: 0,
              max_instances: 20,
              configuration: { image, instance_type: "lite", memory_mib: 256, vcpu: 0.0625 },
              durable_objects: { namespace_id: "review-id" },
              created_at: "2026-09-18T00:00:00Z",
              version: 1,
            }
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  success: true,
                  errors: [],
                  result: request.method === "GET" ? (updating ? [application] : []) : application,
                }),
              ),
            )
          }),
        )
        yield* evalStack(
          stack,
          () =>
            Effect.gen(function* () {
              const provider = yield* findProvider(Cloudflare.Containers.ContainerPlatform, "live")
              return yield* provider
                .reconcile({
                  id: "ReviewSandboxContainer",
                  fqn: "ReviewSandboxContainer",
                  instanceId: "test",
                  news: {
                    name: "review",
                    image,
                    vcpu: 2,
                    memoryMib: 6144,
                    disk: { size_mb: 8000 },
                  },
                  olds: undefined,
                  output: undefined,
                  bindings: [
                    {
                      sid: "ReviewWorkspace",
                      data: { durableObjects: { namespaceId: "review-id" } },
                    },
                  ],
                  session: {
                    note: () => Effect.void,
                    emit: () => Effect.void,
                    done: () => Effect.void,
                  },
                })
                .pipe(
                  Effect.provideService(HttpClient.HttpClient, http),
                  Effect.provideService(
                    Credentials,
                    Effect.succeed(apiTokenCredentials({ apiToken: "test" })),
                  ),
                  Effect.provideService(
                    Cloudflare.CloudflareEnvironment,
                    Effect.succeed({
                      type: "apiToken",
                      apiToken: Redacted.make("test"),
                      accountId: "test",
                      source: { type: "env" },
                    }),
                  ),
                )
            }),
          { stage: "test" },
        ).pipe(
          provideFreshArtifactStore,
          Effect.provide([LoggingCli, Interaction.layerNonInteractive(), inMemoryState()]),
          Effect.provideService(AlchemyContext, {
            dotAlchemy: "/tmp/janitor-container-sizing-test",
            dev: false,
            adopt: false,
          }),
          Effect.provide(NodeServices.layer),
        )
        assert.equal(writes.length, updating ? 2 : 1)
        for (const write of writes) {
          const config = write.configuration ?? write.target_configuration!
          assert.equal(config.vcpu, 2)
          assert.equal(
            config.memory_mib,
            6144,
            "must send memory_mib rather than leave Cloudflare at 256 MiB",
          )
          assert.deepStrictEqual(config.disk, { size_mb: 8000 })
          assert.notProperty(config, "instance_type")
        }
      }),
  )
}
