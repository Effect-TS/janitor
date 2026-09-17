import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import {
  AiClassifier,
  AiConsentService,
  ClassifierProvider,
  ClassifierProviderError,
} from "../../src/Labeling/Classifier.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { LabelingTest } from "../../src/Labeling/Test.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import {
  actor,
  bug,
  DirectLabelingLayer,
  feature,
  github,
  label,
  LabelingLayer,
  repositoryId,
  seed,
  seedPullRequests,
} from "./support.ts"

const services = DirectLabelingLayer.pipe(
  Layer.provideMerge(LabelingLayer),
  Layer.provideMerge(AiClassifier.layer),
  Layer.provideMerge(AiConsentService.layer),
  Layer.provideMerge(
    Layer.succeed(ClassifierProvider, {
      identity: { provider: "test", model: "test" },
      ask: (prompt) =>
        prompt.includes("fail")
          ? Effect.fail(
              new ClassifierProviderError({ message: "Provider unavailable", cause: null }),
            )
          : Effect.succeed({
              matches: prompt.includes("Change 5"),
              confidence: 0.95,
              reason: "Accepted answer",
            }),
    }),
  ),
  Layer.provideMerge(github.layer),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(MigratedPostgresLayer),
)

layer(services, { timeout: "2 minutes" })("Labeling group decisions", (it) => {
  it.effect(
    "uses highest presence requests and disabled membership in previews and automatic labeling",
    () =>
      Effect.gen(function* () {
        yield* seed
        yield* seedPullRequests
        const rules = yield* LabelingRules
        const policies = yield* Policies
        const test = yield* LabelingTest
        const policy = yield* policies.create(
          repositoryId,
          {
            name: "Group decisions",
            description: "",
            source: {
              target: "pull_request",
              matchesWhen: { fact: "title", operator: "contains", value: "Change" },
            },
          },
          actor,
        )
        yield* policies.publish(repositoryId, policy.policy.policyId, 1, actor)
        const scoped = yield* policies.create(
          repositoryId,
          {
            name: "Outside scope",
            description: "",
            source: {
              target: "pull_request",
              appliesWhen: { fact: "title", operator: "contains", value: "outside" },
              matchesWhen: { fact: "title", operator: "contains", value: "Change" },
            },
          },
          actor,
        )
        yield* policies.publish(repositoryId, scoped.policy.policyId, 1, actor)
        let a = yield* rules.create(
          repositoryId,
          {
            labelId: bug,
            policyId: policy.policy.policyId,
            group: "kind",
            priority: 1,
            onMatch: "ensure-present",
            onNoMatch: "no-action",
            enabled: true,
          },
          actor,
        )
        let b = yield* rules.create(
          repositoryId,
          {
            labelId: feature,
            policyId: policy.policy.policyId,
            group: "kind",
            priority: 10,
            onMatch: "ensure-present",
            onNoMatch: "no-action",
            enabled: true,
          },
          actor,
        )
        const verify = (expected: Array<[string, string]>) =>
          Effect.gen(function* () {
            // GitHub holds both group labels before every round.
            github.issues.get(5)!.labels = [
              { id: 11, name: "bug" },
              { id: 12, name: "feature" },
            ]
            github.requests.length = 0
            const preview = yield* test.run(repositoryId, {
              subject: { _tag: "Configuration" },
              numbers: [5],
            })
            assert.strictEqual(preview._tag, "Evaluated")
            if (preview._tag !== "Evaluated") return
            assert.deepStrictEqual(
              preview.entities[0]?.plan?.actions.map((action) => [
                String(action.labelId),
                String(action.action),
              ]),
              expected,
            )
            assert.deepStrictEqual(github.writes, [])
            const result = yield* label(5)
            assert.deepStrictEqual(result.plan, preview.entities[0]?.plan)
            assert.strictEqual(github.writes.length, expected.length)
          })
        yield* verify([["11", "remove"]])
        a = yield* rules.patch(repositoryId, a.id, { version: a.version, enabled: false }, actor)
        yield* verify([["11", "remove"]])
        b = yield* rules.patch(
          repositoryId,
          b.id,
          { version: b.version, onMatch: "no-action" },
          actor,
        )
        yield* verify([
          ["11", "remove"],
          ["12", "remove"],
        ])
        b = yield* rules.patch(
          repositoryId,
          b.id,
          { version: b.version, policyId: scoped.policy.policyId },
          actor,
        )
        yield* verify([])
        a = yield* rules.patch(repositoryId, a.id, { version: a.version, enabled: true }, actor)
        yield* verify([["12", "remove"]])
        const miss = yield* policies.create(
          repositoryId,
          {
            name: "Non-match presence",
            description: "",
            source: {
              target: "pull_request",
              matchesWhen: { fact: "title", operator: "contains", value: "absent" },
            },
          },
          actor,
        )
        yield* policies.publish(repositoryId, miss.policy.policyId, 1, actor)
        b = yield* rules.patch(
          repositoryId,
          b.id,
          { version: b.version, policyId: miss.policy.policyId, onNoMatch: "ensure-present" },
          actor,
        )
        yield* verify([["11", "remove"]])
        yield* rules.remove(repositoryId, a.id, a.version, actor)
        a = yield* rules.create(
          repositoryId,
          {
            labelId: bug,
            ai: { target: "pull_request", prompt: "fail {{fact:title}}", minimumConfidence: 0.8 },
            group: "kind",
            priority: 1,
            onMatch: "ensure-present",
            onNoMatch: "ensure-absent",
            enabled: true,
          },
          actor,
        )
        yield* verify([])
        yield* (yield* AiConsentService).set(repositoryId, true, actor)
        yield* verify([])
        a = yield* rules.patch(repositoryId, a.id, { version: a.version, enabled: false }, actor)
        yield* verify([["11", "remove"]])
      }),
  )
})
