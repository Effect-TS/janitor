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
} from "../../src/Labeling/Classifier.ts"
import { activityPage } from "../../src/Labeling/Activity.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { LabelingTest } from "../../src/Labeling/Test.ts"
import { ReconcileEntity, ReconcileEntityLayer } from "../../src/Labeling/ReconcileEntity.ts"
import { SnapshotHandoff } from "../../src/Labeling/SnapshotHandoff.ts"
import { SyncTargets } from "../../src/SyncTargets.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import {
  actor,
  bug,
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
        Effect.succeed({
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

layer(services, { timeout: "2 minutes" })("Configured AI label actions", (it) => {
  it.effect(
    "uses the same reversed and no-action rules in testing, automatic labeling, and activity",
    () =>
      Effect.gen(function* () {
        yield* seed
        yield* seedPullRequests
        writes.length = 0
        const readModel = yield* GitHubReadModel
        const sequence = GitHubWebhookJournalSequence.make("2")
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
            labels: [{ id: 11, node_id: "LA_bug", name: "bug" }],
            pull_request: { url: "https://api.github.com/x" },
          }),
        })
        const rules = yield* LabelingRules
        const rule = yield* rules.create(
          repositoryId,
          {
            ai: { target: "pull_request", prompt: "Read {{fact:title}}", minimumConfidence: 0.8 },
            labelId: bug,
            onMatch: "ensure-absent",
            onNoMatch: "ensure-present",
            group: null,
            priority: 0,
            enabled: true,
          },
          actor,
        )
        const test = yield* LabelingTest
        const blocked = yield* test.run(repositoryId, {
          subject: { _tag: "Configuration" },
          numbers: [5, 6],
        })
        assert.strictEqual(blocked._tag, "Evaluated")
        if (blocked._tag !== "Evaluated") return
        assert.deepStrictEqual(
          blocked.entities.map((entity) => entity.plan?.actions),
          [[], []],
        )
        assert.deepStrictEqual(writes, [])
        yield* (yield* AiConsentService).set(repositoryId, true, actor)
        const preview = yield* test.run(repositoryId, {
          subject: { _tag: "Configuration" },
          numbers: [5, 6],
        })
        assert.strictEqual(preview._tag, "Evaluated")
        if (preview._tag !== "Evaluated") return
        assert.deepStrictEqual(
          preview.entities.map((entity) => entity.plan?.actions),
          [
            [{ ruleId: rule.id, labelId: bug, action: "remove" }],
            [{ ruleId: rule.id, labelId: bug, action: "add" }],
          ],
        )
        assert.deepStrictEqual(writes, [])
        const reconcile = (number: number) =>
          Effect.gen(function* () {
            const targets = yield* SyncTargets
            const scope = { _tag: "Entity" as const, repositoryId, number }
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
              number,
              generation,
              sequence,
            })
            assert.strictEqual(published._tag, "Published")
            if (published._tag !== "Published") return null
            return yield* ReconcileEntity.execute(published.identity)
          })
        for (const entity of preview.entities) {
          const result = yield* reconcile(entity.number)
          assert.deepStrictEqual(result?.plan, entity.plan)
        }
        assert.deepStrictEqual(
          writes.map((request) => request.method),
          ["DELETE", "POST"],
        )
        const activity = yield* activityPage(repositoryId, {
          search: "",
          target: "all",
          cursor: null,
        })
        assert.deepStrictEqual(
          activity.entries
            .flatMap((entry) =>
              entry.actions.map((action) => [entry.number, action.action, action.status]),
            )
            .sort(),
          [
            [5, "remove", "applied"],
            [6, "add", "applied"],
          ],
        )
        yield* rules.patch(
          repositoryId,
          rule.id,
          { version: rule.version, onMatch: "no-action", onNoMatch: "no-action" },
          actor,
        )
        assert.strictEqual(writes.length, 2)
        const inactive = yield* test.run(repositoryId, {
          subject: { _tag: "Configuration" },
          numbers: [5, 6],
        })
        assert.strictEqual(inactive._tag, "Evaluated")
        if (inactive._tag !== "Evaluated") return
        assert.deepStrictEqual(
          inactive.entities.map((entity) => entity.plan?.actions),
          [[], []],
        )
        for (const number of [5, 6])
          assert.deepStrictEqual((yield* reconcile(number))?.plan?.actions, [])
        assert.strictEqual(writes.length, 2)
        const history = yield* activityPage(repositoryId, {
          search: "",
          target: "all",
          cursor: null,
        })
        assert.deepStrictEqual(
          history.entries.slice(0, 2).map((entry) => entry.plan?.rules[0]?.requestedAction),
          ["no-action", "no-action"],
        )
      }),
  )
})
