import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { LabelingRevision } from "@janitor/domain/Labeling/Policy/Configuration"
import { RulesetActivation } from "../../src/Labeling/Activation.ts"
import { LabelingOverview } from "../../src/Labeling/Overview.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { ReconcileEntity, ReconcileEntityLayer } from "../../src/Labeling/ReconcileEntity.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { RECONCILE_ENTITY_TAG, SnapshotHandoff } from "../../src/Labeling/SnapshotHandoff.ts"
import { type GitHubRequest, GitHubTransport } from "../../src/GitHub/Transport.ts"
import { SyncTargets } from "../../src/SyncTargets.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import {
  actor,
  baseMain,
  bug,
  LabelingLayer,
  repositoryId,
  seed,
  seedPullRequests,
  seq,
  verifyTrack,
} from "./support.ts"

/** Records every GitHub write and answers 200, so the apply activity can be observed. */
const seenRequests: Array<GitHubRequest> = []
const TransportStub = Layer.succeed(GitHubTransport, {
  request: (request) =>
    Effect.sync(() => {
      seenRequests.push(request)
      return {
        _tag: "Ok" as const,
        status: 200,
        body: {},
        etag: Option.none(),
        link: Option.none(),
        requestId: Option.none(),
      }
    }),
})

const Services = Layer.mergeAll(LabelingOverview.layer, ReconcileEntityLayer).pipe(
  Layer.provideMerge(LabelingLayer),
  Layer.provideMerge(TransportStub),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(MigratedPostgresLayer),
)

const number = 5

/** Verifies the entity scope once and returns the verified generation. */
const verifyEntity = Effect.gen(function* () {
  const targets = yield* SyncTargets
  const scope = { _tag: "Entity", repositoryId, number } as const
  const { generation } = yield* targets.invalidate({ scope, sequence: Option.some(seq) })
  yield* targets.begin(scope, generation)
  yield* targets.complete({
    scope,
    generation,
    outcome: { _tag: "Verified", watermark: Option.none() },
  })
  return generation
})

const outboxKeys = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ execution_key: string }>`
    SELECT execution_key FROM workflow_outbox WHERE workflow_tag = ${RECONCILE_ENTITY_TAG}
    ORDER BY execution_key
  `,
)

layer(Services, { timeout: "2 minutes" })("SnapshotHandoff against Postgres", (it) => {
  it.effect("skips without an active revision or a verified entity, then publishes once", () =>
    Effect.gen(function* () {
      yield* seed
      yield* seedPullRequests
      const handoff = yield* SnapshotHandoff
      const policies = yield* Policies
      const rules = yield* LabelingRules
      const activation = yield* RulesetActivation
      const overview = yield* LabelingOverview
      const sql = yield* SqlClient.SqlClient

      const generation = yield* verifyEntity
      const noRevision = yield* handoff.publish({ repositoryId, number, generation, sequence: seq })
      assert.deepStrictEqual(noRevision, { _tag: "Skipped", reason: "no-active-revision" })

      const policy = yield* policies.create(
        repositoryId,
        { name: "Base is main", description: "", source: baseMain },
        actor,
      )
      yield* policies.publish(repositoryId, policy.policy.policyId, 1, actor)
      yield* rules.create(
        repositoryId,
        {
          labelId: bug,
          policyId: policy.policy.policyId,
          onNoMatch: "ensure-absent",
          group: null,
          priority: 0,
          enabled: true,
        },
        actor,
      )
      yield* verifyTrack("pull_requests")
      assert.isTrue(Option.isNone(yield* activation.promote(repositoryId)))
      const revision = LabelingRevision.make(2)

      const unknown = yield* handoff.publish({
        repositoryId,
        number: 404,
        generation,
        sequence: seq,
      })
      assert.deepStrictEqual(unknown, { _tag: "Skipped", reason: "no-entity" })

      const published = yield* handoff.publish({ repositoryId, number, generation, sequence: seq })
      assert.strictEqual(published._tag, "Published")
      // A retried activity is a no-op on the same identity.
      const again = yield* handoff.publish({ repositoryId, number, generation, sequence: seq })
      assert.strictEqual(again._tag, "Published")
      // Publication and rule enablement did not enqueue any existing entities.
      assert.deepStrictEqual(
        (yield* outboxKeys).map((row) => row.execution_key),
        [`reconcile:${repositoryId}:${number}:${generation}:${revision}`],
      )
      const pending = yield* overview.reconciliations(repositoryId)
      assert.strictEqual(pending.length, 1)
      assert.isNull(pending[0]?.outcome)

      // The workflow re-qualifies the snapshot, evaluates every rule, and records the plan.
      const identity = {
        repositoryId,
        number,
        snapshotGeneration: generation,
        rulesRevision: revision,
      }
      const result = yield* ReconcileEntity.execute(identity)
      assert.strictEqual(result.outcome, "evaluated")
      const done = yield* overview.reconciliations(repositoryId)
      assert.strictEqual(done[0]?.detail, "1 change planned")
      assert.deepStrictEqual(
        done[0]?.plan?.actions.map((action) => [action.labelId, action.action]),
        [[bug, "add"]],
      )
      assert.deepStrictEqual(
        done[0]?.plan?.rules.map((rule) => [rule.outcome, rule.selected]),
        [["match", true]],
      )
      const evaluations = yield* sql<{ outcome: string; selected: boolean }>`
        SELECT outcome, selected FROM labeling_rule_evaluation WHERE repository_id = ${repositoryId} AND number = ${number}
      `
      assert.deepStrictEqual(evaluations, [{ outcome: "match", selected: true }])
      // The apply activity wrote the label through GitHub and settled the action.
      const actions = yield* sql<{
        label_id: string
        action: string
        status: string
        detail: string | null
      }>`
        SELECT label_id, action, status, detail FROM labeling_label_action WHERE repository_id = ${repositoryId} AND number = ${number}
      `
      assert.deepStrictEqual(actions, [
        { label_id: bug, action: "add", status: "applied", detail: null },
      ])
      assert.deepStrictEqual(
        seenRequests.map((request) => [request.method, request.url, request.body]),
        [["POST", "/repos/effect/one/issues/5/labels", { labels: ["bug"] }]],
      )
      assert.deepStrictEqual(
        done[0]?.actions.map((action) => action.status),
        ["applied"],
      )

      // Resubmitting the same identity returns the stored result.
      const duplicate = yield* ReconcileEntity.execute(identity)
      assert.strictEqual(duplicate.outcome, "evaluated")

      // A newer verified generation supersedes an identity built on the old one.
      const newer = yield* verifyEntity
      const republished = yield* handoff.publish({
        repositoryId,
        number,
        generation: newer,
        sequence: seq,
      })
      assert.strictEqual(republished._tag, "Published")
      yield* verifyEntity
      const superseded = yield* ReconcileEntity.execute({ ...identity, snapshotGeneration: newer })
      assert.strictEqual(superseded.outcome, "superseded")

      // A later sync verification hands off only that entity.
      const targets = yield* SyncTargets
      const scope6 = { _tag: "Entity", repositoryId, number: 6 } as const
      const six = yield* targets.invalidate({ scope: scope6, sequence: Option.some(seq) })
      yield* targets.begin(scope6, six.generation)
      yield* targets.complete({
        scope: scope6,
        generation: six.generation,
        outcome: { _tag: "Verified", watermark: Option.none() },
      })
      yield* handoff.publish({ repositoryId, number: 6, generation: six.generation, sequence: seq })
      assert.include(
        (yield* outboxKeys).map((row) => row.execution_key),
        `reconcile:${repositoryId}:6:${six.generation}:${revision}`,
      )

      const repositories = yield* overview.repositories
      assert.deepStrictEqual(
        repositories.map((row) => [row.repo, row.configuredRevision, row.activeRevision]),
        [["one", revision, revision]],
      )
    }),
  )
})
