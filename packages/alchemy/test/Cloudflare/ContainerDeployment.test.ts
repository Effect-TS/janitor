import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, it } from "@effect/vitest"
import { Credentials, apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials"
import * as Alchemy from "alchemy"
import { AlchemyContext } from "alchemy/AlchemyContext"
import { provideFreshArtifactStore } from "alchemy/Artifacts"
import { LoggingCli } from "alchemy/Cli/LoggingCli"
import * as Cloudflare from "alchemy/Cloudflare"
import { findProvider } from "alchemy/Provider"
import { evalStack } from "alchemy/Stack"
import { inMemoryState } from "alchemy/State"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Result from "effect/Result"
import * as Redacted from "effect/Redacted"
import * as TestClock from "effect/testing/TestClock"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

const image = `registry.cloudflare.com/test/review@sha256:${"a".repeat(64)}`
const stack = Alchemy.Stack(
  "ContainerDeploymentTest",
  {
    providers: Cloudflare.providers(),
    state: inMemoryState(),
  },
  Effect.void,
)

for (const scenario of [
  {
    name: "attaches a container after the concurrent Worker upload enables its namespace",
    failures: 2,
    code: 1607,
    message: '{"error":"DURABLE_OBJECT_NOT_CONTAINER_ENABLED"}',
    attempts: 3,
    error: undefined,
  },
  {
    name: "stops retrying when the namespace never becomes container-enabled",
    failures: Infinity,
    code: 1607,
    message: '{"error":"DURABLE_OBJECT_NOT_CONTAINER_ENABLED"}',
    attempts: 21,
    error: "DurableObjectNotContainerEnabled",
  },
  {
    name: "does not retry unrelated container creation errors",
    failures: Infinity,
    code: 7003,
    message: "Could not route",
    attempts: 1,
    error: "InvalidRoute",
  },
]) {
  it.effect(scenario.name, () =>
    Effect.gen(function* () {
      let attempts = 0
      const started = yield* Deferred.make<void>()
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          assert.include(request.url, "/containers/applications")
          const failed = request.method === "POST" && ++attempts <= scenario.failures
          const result =
            request.method === "GET"
              ? []
              : {
                  id: "application-id",
                  name: "review",
                  account_id: "test",
                  scheduling_policy: "default",
                  instances: 0,
                  max_instances: 20,
                  configuration: { image },
                  durable_objects: { namespace_id: "review-id" },
                  created_at: "2026-09-18T00:00:00Z",
                  version: 1,
                }
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify(
                failed
                  ? {
                      success: false,
                      errors: [{ code: scenario.code, message: scenario.message }],
                    }
                  : { success: true, errors: [], result },
              ),
              { status: failed ? 400 : 200 },
            ),
          )
        }),
      )
      const signaledHttp = http.pipe(
        HttpClient.transformResponse(
          Effect.tap((response) =>
            response.request.method === "POST" ? Deferred.succeed(started, undefined) : Effect.void,
          ),
        ),
      )
      const deploy = evalStack(
        stack,
        () =>
          Effect.gen(function* () {
            const provider = yield* findProvider(Cloudflare.Containers.ContainerPlatform, "live")
            return yield* provider
              .reconcile({
                id: "ReviewSandboxContainer",
                fqn: "ReviewSandboxContainer",
                instanceId: "test",
                news: { name: "review", image },
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
                Effect.provideService(HttpClient.HttpClient, signaledHttp),
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
        Effect.provide([LoggingCli, inMemoryState()]),
        Effect.provideService(AlchemyContext, {
          dotAlchemy: "/tmp/janitor-container-deployment-test",
          dev: false,
          adopt: false,
        }),
        Effect.provide(NodeServices.layer),
      )
      const fiber = yield* Effect.forkChild(Effect.result(deploy))
      yield* Deferred.await(started)
      yield* TestClock.adjust("2 minutes")
      const result = yield* Fiber.join(fiber)
      if (scenario.error === undefined) {
        assert.isTrue(Result.isSuccess(result))
        if (Result.isSuccess(result)) {
          assert.equal(result.success.applicationId, "application-id")
          assert.deepStrictEqual(result.success.durableObjects, { namespaceId: "review-id" })
        }
      } else {
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) assert.equal(result.failure._tag, scenario.error)
      }
      assert.equal(attempts, scenario.attempts)
    }),
  )
}
