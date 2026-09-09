import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { GitHubIssueApi } from "@janitor/domain/GitHub/Api"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import { GitHubReadModel } from "../../src/GitHub/ReadModel.ts"
import { GitHubTransport, type GitHubRequest } from "../../src/GitHub/Transport.ts"
import {
  AiClassifier,
  AiConsentService,
  ClassifierProvider,
  ClassifierProviderError,
} from "../../src/Labeling/Classifier.ts"
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
  seedReady as seed,
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
        const readModel = yield* GitHubReadModel
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
        let sequenceNumber = 2
        const verify = (expected: Array<[string, string]>) =>
          Effect.gen(function* () {
            writes.length = 0
            const sequence = GitHubWebhookJournalSequence.make(String(sequenceNumber++))
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
            assert.deepStrictEqual(writes, [])
            const targets = yield* SyncTargets
            const scope = { _tag: "Entity" as const, repositoryId, number: 5 }
            const { generation } = yield* targets.invalidate({
              scope,
              sequence: Option.some(sequence),
              webhookReceivedAt: new Date(),
            })
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
            assert.deepStrictEqual(result.plan, preview.entities[0]?.plan)
            assert.strictEqual(writes.length, expected.length)
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
