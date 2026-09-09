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
layer(ApiServices, { timeout: "2 minutes" })("Labeling group API", (it) => {
  it.effect(
    "reserves disabled priorities, rejects target changes, and atomically swaps with concurrency checks",
    () =>
      withHandler((handler, policyId) =>
        Effect.gen(function* () {
          const send = (method: string, path: string, body: unknown) =>
            Effect.promise(() => handler(request(method, path, body)))
          const first = yield* send("POST", base + "/rules", {
            labelId: "11",
            policyId,
            group: "kind",
            priority: 10,
            enabled: false,
          })
          assert.strictEqual(first.status, 201)
          const a = yield* Effect.promise(() => first.json())
          const duplicate = yield* send("POST", base + "/rules", {
            labelId: "12",
            policyId,
            group: "kind",
            priority: 10,
          })
          assert.strictEqual(duplicate.status, 422)
          assert.strictEqual(
            (yield* Effect.promise(() => duplicate.json())).issues[0].code,
            "duplicate-priority",
          )
          const mixed = yield* send("POST", base + "/rules", {
            labelId: "12",
            ai: { target: "issue", prompt: "Read {{fact:title}}", minimumConfidence: 0.8 },
            group: "kind",
            priority: 20,
          })
          assert.strictEqual(mixed.status, 422)
          const second = yield* send("POST", base + "/rules", {
            labelId: "12",
            ai: { target: "pull_request", prompt: "Read {{fact:title}}", minimumConfidence: 0.8 },
            group: "kind",
            priority: 20,
          })
          assert.strictEqual(second.status, 201)
          const b = yield* Effect.promise(() => second.json())
          const targetChange = yield* send("PATCH", base + "/rules/" + b.id, {
            version: b.version,
            ai: { target: "issue", prompt: "Read {{fact:title}}", minimumConfidence: 0.8 },
          })
          assert.strictEqual(targetChange.status, 422)
          const policies = yield* Policies
          const current = yield* policies.get(repositoryId, a.policyId)
          const invalidDraft = yield* send("PUT", base + "/policies/" + a.policyId, {
            version: current.policy.version,
            source: {
              target: "issue",
              matchesWhen: { fact: "title", operator: "contains", value: "x" },
            },
          })
          assert.strictEqual(invalidDraft.status, 422)
          const reorder = {
            group: "kind",
            rules: [
              { id: a.id, version: a.version, priority: 20 },
              { id: b.id, version: b.version, priority: 10 },
            ],
          }
          const concurrent = yield* Effect.all(
            [
              send("POST", base + "/rules/reorder", reorder),
              send("POST", base + "/rules/reorder", reorder),
            ],
            { concurrency: "unbounded" },
          )
          assert.deepStrictEqual(concurrent.map((response) => response.status).sort(), [200, 409])
          const rules = yield* LabelingRules
          const after = yield* rules.list(repositoryId)
          assert.deepStrictEqual(
            after.map((rule) => [rule.priority, rule.version, rule.enabled]),
            [
              [20, 2, false],
              [10, 2, true],
            ],
          )
          const invalid = yield* send("POST", base + "/rules/reorder", {
            group: "kind",
            rules: after.map((rule) => ({ id: rule.id, version: rule.version, priority: 0 })),
          })
          assert.strictEqual(invalid.status, 422)
          const missing = yield* send("POST", base + "/rules/reorder", {
            group: "kind",
            rules: [{ id: a.id, version: 2, priority: 30 }],
          })
          assert.strictEqual(missing.status, 409)
          assert.deepStrictEqual(yield* rules.list(repositoryId), after)
        }),
      ),
  )
})
