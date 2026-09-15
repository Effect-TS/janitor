import { SlackProcessor } from "../../src/Slack/Processor.ts"
import { assert, it } from "@effect/vitest"
import { RuntimeContext } from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { SlackWebhookRoutes } from "../../src/Ingress/SlackWebhook.ts"
import { SlackWebhook } from "../../src/Slack/Webhook.ts"
import { SlackInteractivity } from "../../src/Slack/Interactivity.ts"
import { SlackWake } from "../../src/Slack/Conversation.ts"
import { processingRequest } from "../../src/Slack/ProcessingRequest.ts"
import { WorkflowDispatcher } from "../../src/WorkflowDispatcher.ts"

it.effect(
  "returns the HTTP receipt while platform-owned dispatch and acknowledgement sending are still running",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(SlackWebhookRoutes, { disableLogger: true })),
      ({ handler }) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          const pending: Promise<unknown>[] = []
          const work = processingRequest("session", "1")
          const dispatched: unknown[] = []
          const execution = Cloudflare.Workers.fromExecutionContext({
            waitUntil: (promise) => {
              pending.push(promise)
            },
            passThroughOnException: () => {},
            props: {},
            get tracing(): never {
              throw new Error("This route does not use native tracing")
            },
          })
          const context = Context.make(SlackWebhook, {
            receive: () => Effect.succeed({ status: 200, body: "Accepted", work }),
          }).pipe(
            Context.add(SlackInteractivity, {
              receive: () => Effect.succeed({ status: 200, body: "Accepted" }),
            }),
            Context.add(SlackProcessor, {
              process: () => Effect.void,
              processDue: Effect.void,
              onboardDue: Effect.void,
            }),
            Context.add(SlackWake, Deferred.await(gate)),
            Context.add(Cloudflare.Workers.WorkerExecutionContext, execution),
            Context.add(RuntimeContext, {
              Type: "test",
              id: "test",
              env: {},
              get: () => Effect.succeed(undefined),
              set: (id) => Effect.succeed(id),
            }),
            Context.add(WorkflowDispatcher, {
              dispatchDue: (options) =>
                Effect.gen(function* () {
                  dispatched.push(options)
                  yield* Deferred.await(gate)
                  return { claimed: 1, accepted: 1, released: 0 }
                }),
            }),
          )
          const response = yield* Effect.promise(() =>
            handler(
              new Request("https://janitor.test/api/v1/webhooks/slack", {
                method: "POST",
                body: "{}",
              }),
              context,
            ),
          )
          assert.strictEqual(response.status, 200)
          assert.strictEqual(pending.length, 1)
          yield* Deferred.succeed(gate, undefined)
          yield* Effect.promise(() => Promise.all(pending))
          assert.deepEqual(dispatched, [{ only: work, limit: 1 }])
        }),
      ({ dispose }) => Effect.promise(dispose),
    ),
)
