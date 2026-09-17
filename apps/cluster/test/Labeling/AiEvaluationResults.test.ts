import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { GitHubLabelDatabaseId, GitHubLabelNodeId } from "@janitor/domain/GitHub/Id"
import { GitHubReadModel } from "../../src/GitHub/ReadModel.ts"
import {
  AiClassifier,
  AiConsentService,
  ClassifierProvider,
  ClassifierProviderError,
} from "../../src/Labeling/Classifier.ts"
import { activityPage } from "../../src/Labeling/Activity.ts"
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
  seq,
} from "./support.ts"

const services = DirectLabelingLayer.pipe(
  Layer.provideMerge(LabelingLayer),
  Layer.provideMerge(AiClassifier.layer),
  Layer.provideMerge(AiConsentService.layer),
  Layer.provideMerge(
    Layer.succeed(ClassifierProvider, {
      identity: { provider: "test", model: "test" },
      ask: () =>
        Effect.fail(
          new ClassifierProviderError({
            message: "Provider unavailable. Try again later.",
            cause: null,
          }),
        ),
    }),
  ),
  Layer.provideMerge(github.layer),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(MigratedPostgresLayer),
)

layer(services, { timeout: "2 minutes" })("AI evaluation results", (it) => {
  it.effect(
    "preserves group labels on provider failure, applies unrelated rules, and records evaluation failure separately from writes",
    () =>
      Effect.gen(function* () {
        yield* seed
        yield* seedPullRequests
        const readModel = yield* GitHubReadModel
        const independentLabel = GitHubLabelDatabaseId.make("13")
        yield* readModel.applyLabelCatalog({
          repositoryId,
          sequence: seq,
          labels: [
            { id: bug, nodeId: GitHubLabelNodeId.make("LA_bug"), name: "bug" },
            { id: feature, nodeId: GitHubLabelNodeId.make("LA_feature"), name: "feature" },
            {
              id: independentLabel,
              nodeId: GitHubLabelNodeId.make("LA_independent"),
              name: "review",
            },
          ],
        })
        github.labels.push({ id: 13, name: "review" })
        github.issues.get(5)!.labels = [
          { id: 11, name: "bug" },
          { id: 12, name: "feature" },
        ]
        const rules = yield* LabelingRules
        const ai = yield* rules.create(
          repositoryId,
          {
            ai: { target: "pull_request", prompt: "Read {{fact:title}}", minimumConfidence: 0.8 },
            labelId: bug,
            onMatch: "ensure-present",
            onNoMatch: "no-action",
            group: "kind",
            priority: 0,
            enabled: true,
          },
          actor,
        )
        const policies = yield* Policies
        const createPolicyRule = (
          name: string,
          value: string,
          labelId: GitHubLabelDatabaseId,
          group: string | null,
        ) =>
          Effect.gen(function* () {
            const policy = yield* policies.create(
              repositoryId,
              {
                name,
                description: "",
                source: {
                  target: "pull_request",
                  matchesWhen: { fact: "title", operator: "equals", value },
                },
              },
              actor,
            )
            yield* policies.publish(repositoryId, policy.policy.policyId, 1, actor)
            return yield* rules.create(
              repositoryId,
              {
                policyId: policy.policy.policyId,
                labelId,
                onMatch: "ensure-present",
                onNoMatch: "ensure-absent",
                group,
                priority: 1,
                enabled: true,
              },
              actor,
            )
          })
        const peer = yield* createPolicyRule("Other kind", "Not this change", feature, "kind")
        const independent = yield* createPolicyRule(
          "Review change",
          "Change 5",
          independentLabel,
          null,
        )
        yield* (yield* AiConsentService).set(repositoryId, true, actor)
        const test = yield* (yield* LabelingTest).run(repositoryId, {
          subject: { _tag: "Policy", policyId: ai.policyId },
          numbers: [5],
        })
        assert.strictEqual(test._tag, "Evaluated")
        if (test._tag !== "Evaluated") return
        assert.strictEqual(test.entities[0]?.evaluation?.outcome, "failed")
        assert.include(test.entities[0]!.evaluation!.reason, "Try again")
        assert.deepStrictEqual(github.writes, [])
        const result = yield* label(5)
        assert.deepStrictEqual(result.plan?.actions, [
          { ruleId: independent.id, labelId: independentLabel, action: "add" },
        ])
        assert.strictEqual(github.writes.length, 1)
        assert.strictEqual(github.writes[0]?.method, "POST")
        const activity = (yield* activityPage(repositoryId, {
          search: "",
          target: "all",
          cursor: null,
        })).entries[0]!
        assert.strictEqual(
          activity.evaluations?.find((entry) => entry.ruleId === ai.id)?.outcome,
          "failed",
        )
        assert.include(
          activity.evaluations!.find((entry) => entry.ruleId === ai.id)!.reason,
          "Try again",
        )
        assert.strictEqual(
          activity.evaluations?.find((entry) => entry.ruleId === peer.id)?.outcome,
          "no-match",
        )
        assert.deepStrictEqual(
          activity.actions.map((action) => [action.labelId, action.status]),
          [[independentLabel, "applied"]],
        )
        assert.deepStrictEqual(
          activity.plan?.rules.filter((rule) => rule.selected).map((rule) => rule.ruleId),
          [independent.id],
        )
      }),
  )
})
