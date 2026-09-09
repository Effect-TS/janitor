import { assert, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { CurrentAccessIdentity } from "../../src/Ingress/Middleware.ts"
import { RulesRoutesLayer } from "../../src/Ingress/Rules.ts"
import { AiConsentService, ClassifierProvider } from "../../src/Labeling/Classifier.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { LabelingConfiguration } from "../../src/Labeling/Configuration.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { LabelingTest } from "../../src/Labeling/Test.ts"
import { RuleTestJobs } from "../../src/Labeling/RuleTestJob.ts"
import { LabelingOverview } from "../../src/Labeling/Overview.ts"
import { ActivityReader } from "../../src/Labeling/Activity.ts"
import { actor, baseMain, repositoryId, seed, Services } from "./support.ts"

const ApiServices = Layer.mergeAll(
  RuleTestJobs.layer,
  LabelingOverview.layer,
  ActivityReader.layer,
  AiConsentService.layer,
).pipe(Layer.provideMerge(Services), Layer.provide(ClassifierProvider.unavailable))

const withHandler = <A, E, R>(
  use: (
    handler: (request: Request) => Promise<Response>,
    policyId: string,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    yield* seed
    const policies = yield* Policies
    const policy = yield* policies.create(
      repositoryId,
      { name: "Main", description: "", source: baseMain },
      actor,
    )
    yield* policies.publish(repositoryId, policy.policy.policyId, 1, actor)
    const services = yield* Effect.context<
      | Policies
      | LabelingRules
      | LabelingConfiguration
      | LabelingTest
      | RuleTestJobs
      | LabelingOverview
      | ActivityReader
      | AiConsentService
    >()
    const context = Context.add(services, CurrentAccessIdentity, {
      ...actor,
      email: undefined,
      expiresAt: DateTime.makeUnsafe("2026-09-03T12:00:00.000Z"),
    })
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(RulesRoutesLayer, { disableLogger: true })),
      ({ handler }) => use((request) => handler(request, context), policy.policy.policyId),
      ({ dispose }) => Effect.promise(dispose),
    )
  })

const request = (method: string, path: string, body: unknown) =>
  new Request(`https://janitor.example${path}`, {
    method,
    headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify(body),
  })
const base = `/repositories/${repositoryId}`
layer(ApiServices, { timeout: "2 minutes" })("Rule action API", (it) => {
  it.effect(
    "accepts independent actions, defaults legacy creates, and rejects invalid actions",
    () =>
      withHandler((handler, policyId) =>
        Effect.gen(function* () {
          const created = yield* Effect.promise(() =>
            handler(
              request("POST", `${base}/rules`, {
                labelId: "11",
                ai: {
                  target: "pull_request",
                  prompt: "Read {{fact:title}}",
                  minimumConfidence: 0.8,
                },
                onMatch: "ensure-absent",
                onNoMatch: "ensure-present",
              }),
            ),
          )
          assert.strictEqual(created.status, 201)
          const body = yield* Effect.promise(() => created.json())
          assert.strictEqual(body.onMatch, "ensure-absent")
          assert.strictEqual(body.onNoMatch, "ensure-present")
          const patched = yield* Effect.promise(() =>
            handler(
              request("PATCH", `${base}/rules/${body.id}`, {
                version: 1,
                onMatch: "no-action",
                onNoMatch: "no-action",
              }),
            ),
          )
          assert.strictEqual(patched.status, 200)
          const next = yield* Effect.promise(() => patched.json())
          assert.strictEqual(next.onMatch, "no-action")
          assert.strictEqual(next.onNoMatch, "no-action")
          const defaults = yield* Effect.promise(() =>
            handler(request("POST", `${base}/rules`, { labelId: "11", policyId })),
          )
          assert.strictEqual(defaults.status, 201)
          const defaultBody = yield* Effect.promise(() => defaults.json())
          assert.strictEqual(defaultBody.onMatch, "ensure-present")
          assert.strictEqual(defaultBody.onNoMatch, "no-action")
          for (const field of ["onMatch", "onNoMatch"]) {
            const invalid = yield* Effect.promise(() =>
              handler(
                request("POST", `${base}/rules`, { labelId: "11", policyId, [field]: "invalid" }),
              ),
            )
            assert.strictEqual(invalid.status, 400)
          }
        }),
      ),
  )
})
