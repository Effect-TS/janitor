import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { GitHubIssueApi } from "@janitor/domain/GitHub/Api"
import { GitHubLabelDatabaseId, GitHubLabelNodeId } from "@janitor/domain/GitHub/Id"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import { GitHubReadModel } from "../../src/GitHub/ReadModel.ts"
import { GitHubTransport, type GitHubRequest } from "../../src/GitHub/Transport.ts"
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
import { ReconcileEntity, ReconcileEntityLayer } from "../../src/Labeling/ReconcileEntity.ts"
import { SnapshotHandoff } from "../../src/Labeling/SnapshotHandoff.ts"
import { SyncTargets } from "../../src/SyncTargets.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import {
  actor,
  bug,
  feature,
  LabelingLayer,
  repositoryId,
  seed,
  seedPullRequests,
} from "./support.ts"

const writes: Array<GitHubRequest> = []
const services = ReconcileEntityLayer.pipe(
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
  Layer.provideMerge(
    Layer.succeed(GitHubTransport, {
      request: (request) =>
        Effect.sync(() => {
          writes.push(request)
          return {
            _tag: "Ok" as const,
            status: 200,
            body: {},
            etag: Option.none(),
            link: Option.none(),
            requestId: Option.none(),
          }
        }),
    }),
  ),
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
        writes.length = 0
        const readModel = yield* GitHubReadModel
        const sequence = GitHubWebhookJournalSequence.make("2")
        const independentLabel = GitHubLabelDatabaseId.make("13")
        yield* readModel.applyLabelCatalog({
          repositoryId,
          sequence,
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
        yield* readModel.applyIssue({
          repositoryId,
          sequence,
          issue: yield* Schema.decodeUnknownEffect(GitHubIssueApi)({
            id: 1005,
            node_id: "I_5",
            number: 5,
            title: "Change 5",
            body: null,
            state: "open",
            user: { id: 9, login: "octocat" },
            updated_at: "2026-09-03T15:00:00Z",
            labels: [
              { id: 11, node_id: "LA_bug", name: "bug" },
              { id: 12, node_id: "LA_feature", name: "feature" },
            ],
            pull_request: { url: "https://api.github.com/x" },
          }),
        })
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
        assert.deepStrictEqual(writes, [])

        const targets = yield* SyncTargets
        const scope = { _tag: "Entity" as const, repositoryId, number: 5 }
        const { generation } = yield* targets.invalidate({ scope, sequence: Option.some(sequence) })
        yield* targets.begin(scope, generation)
        yield* targets.complete({
          scope,
          generation,
          outcome: { _tag: "Verified", watermark: Option.none() },
        })
        const published = yield* (yield* SnapshotHandoff).publish({
          repositoryId,
          number: 5,
          generation,
          sequence,
        })
        assert.strictEqual(published._tag, "Published")
        if (published._tag !== "Published") return
        const result = yield* ReconcileEntity.execute(published.identity)
        assert.deepStrictEqual(result.plan?.actions, [
          { ruleId: independent.id, labelId: independentLabel, action: "add" },
        ])
        assert.strictEqual(writes.length, 1)
        assert.strictEqual(writes[0]?.method, "POST")
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
