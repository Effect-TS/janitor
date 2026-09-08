import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { ReconciliationIdentity } from "@janitor/domain/Labeling/Reconciliation"
import * as Schema from "effect/Schema"
import { GitHubTransport, type GitHubRequest } from "../../src/GitHub/Transport.ts"
import {
  LabelingConfiguration,
  LabelingConfigurationError,
} from "../../src/Labeling/Configuration.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { ReconcileEntity, ReconcileEntityLayer } from "../../src/Labeling/ReconcileEntity.ts"
import { SnapshotHandoff, RECONCILE_ENTITY_TAG } from "../../src/Labeling/SnapshotHandoff.ts"
import { LabelingSyncIntegrationLayer } from "../../src/Labeling/SyncIntegration.ts"
import { SyncIntegration } from "../../src/SyncIntegration.ts"
import { SyncTargets } from "../../src/SyncTargets.ts"
import { RulesetActivation } from "../../src/Labeling/Activation.ts"
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
} from "./support.ts"

const writes: Array<GitHubRequest> = []
let afterLoad: Effect.Effect<unknown, LabelingConfigurationError> | undefined
// Only the workflow's configuration service is intercepted. A publication can
// commit after its snapshot loads, just as it can during a slow classifier call.
const EvaluationConfiguration = Layer.effect(
  LabelingConfiguration,
  Effect.map(LabelingConfiguration, (configuration) => ({
    ...configuration,
    load: (repositoryId, revision) =>
      configuration.load(repositoryId, revision).pipe(
        Effect.tap(() =>
          Effect.suspend(() => {
            const pending = afterLoad
            afterLoad = undefined
            return pending ?? Effect.void
          }),
        ),
        Effect.mapError(
          (error) =>
            new LabelingConfigurationError({ operation: "testLoad", message: String(error) }),
        ),
      ),
  })),
)
const Transport = Layer.succeed(GitHubTransport, {
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
})
const Services = Layer.mergeAll(ReconcileEntityLayer, LabelingSyncIntegrationLayer).pipe(
  Layer.provideMerge(LabelingLayer),
  Layer.provideMerge(Transport),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(MigratedPostgresLayer),
)
const number = 5
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
const handoff = Effect.gen(function* () {
  const generation = yield* verifyEntity
  const result = yield* (yield* SnapshotHandoff).publish({
    repositoryId,
    number,
    generation,
    sequence: seq,
  })
  assert.strictEqual(result._tag, "Published")
  if (result._tag !== "Published") throw new Error("Expected a qualified entity")
  return result.identity
})
const latestQueued = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ payload: unknown }>`
    SELECT payload FROM workflow_outbox WHERE workflow_tag = ${RECONCILE_ENTITY_TAG}
    ORDER BY (payload->>'rulesRevision')::bigint DESC, (payload->>'snapshotGeneration')::bigint DESC LIMIT 1
  `
  return yield* Schema.decodeUnknownEffect(ReconciliationIdentity)(row?.payload)
})
const work = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    targets:
      yield* sql`SELECT scope_key, requested_generation::text FROM sync_target ORDER BY scope_key`,
    outbox: yield* sql`SELECT execution_key FROM workflow_outbox ORDER BY execution_key`,
  }
})

layer(Services, { timeout: "2 minutes" })("Event-driven labeling", (it) => {
  it.effect(
    "publishes and edits rules without scheduling sync or reconciliation, including collection policies",
    () =>
      Effect.gen(function* () {
        yield* seed
        yield* seedPullRequests
        yield* verifyEntity
        const before = yield* work
        const policies = yield* Policies
        const rules = yield* LabelingRules
        const configuration = yield* LabelingConfiguration
        let policy = yield* policies.create(
          repositoryId,
          {
            name: "Event policy",
            description: "",
            source: {
              target: "pull_request",
              matchesWhen: {
                some: "changedFiles",
                where: { fact: "path", operator: "matchesGlob", value: "src/**" },
              },
            },
          },
          actor,
        )
        policy = yield* policies.publish(
          repositoryId,
          policy.policy.policyId,
          policy.policy.version,
          actor,
        )
        let rule = yield* rules.create(
          repositoryId,
          {
            labelId: bug,
            policyId: policy.policy.policyId,
            onNoMatch: "preserve",
            group: null,
            priority: 0,
            enabled: true,
          },
          actor,
        )
        const view = yield* configuration.view(repositoryId)
        assert.strictEqual(view.activeRevision, view.configuredRevision)
        assert.deepStrictEqual(view.pendingTracks, [])
        assert.include(
          yield* (yield* SyncIntegration).requiredCollections(repositoryId),
          "changed_files",
        )
        assert.deepStrictEqual(yield* work, before)
        rule = yield* rules.patch(
          repositoryId,
          rule.id,
          { version: rule.version, enabled: false },
          actor,
        )
        rule = yield* rules.patch(
          repositoryId,
          rule.id,
          { version: rule.version, enabled: true },
          actor,
        )
        policy = yield* policies.save(
          repositoryId,
          policy.policy.policyId,
          { version: policy.policy.version, source: baseMain },
          actor,
        )
        yield* policies.publish(repositoryId, policy.policy.policyId, policy.policy.version, actor)
        assert.deepStrictEqual(
          yield* (yield* SyncIntegration).requiredCollections(repositoryId),
          [],
        )
        assert.deepStrictEqual(yield* work, before)
      }),
  )

  it.effect("redirects an older queued evaluation to the newly published policy", () =>
    Effect.gen(function* () {
      const queued = yield* handoff
      const policies = yield* Policies
      const policy = (yield* policies.list(repositoryId))[0]!
      const saved = yield* policies.save(
        repositoryId,
        policy.policyId,
        {
          version: policy.version,
          source: {
            target: "pull_request",
            matchesWhen: { fact: "baseRef", operator: "equals", value: "develop" },
          },
        },
        actor,
      )
      const before = yield* work
      const published = yield* policies.publish(
        repositoryId,
        policy.policyId,
        saved.policy.version,
        actor,
      )
      assert.deepStrictEqual(yield* work, before)
      assert.strictEqual((yield* ReconcileEntity.execute(queued)).outcome, "superseded")
      const current = yield* latestQueued
      assert.isAbove(current.rulesRevision, queued.rulesRevision)
      const result = yield* ReconcileEntity.execute(current)
      assert.strictEqual(result.outcome, "evaluated")
      assert.deepStrictEqual(
        result.plan?.rules.map((rule) => rule.outcome),
        ["no-match"],
      )
      assert.deepStrictEqual(writes, [])
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{
        policy_version_id: string
      }>`SELECT policy_version_id FROM labeling_rule_evaluation WHERE rules_revision = ${current.rulesRevision}`
      assert.deepStrictEqual(
        rows.map((row) => row.policy_version_id),
        [published.published!.versionId],
      )
    }),
  )

  it.effect(
    "uses newly enabled rules and latest publication for background sync with an old event sequence",
    () =>
      Effect.gen(function* () {
        const rules = yield* LabelingRules
        const policies = yield* Policies
        let rule = (yield* rules.list(repositoryId))[0]!
        rule = yield* rules.patch(
          repositoryId,
          rule.id,
          { version: rule.version, enabled: false },
          actor,
        )
        const queuedWhileDisabled = yield* handoff
        rule = yield* rules.patch(
          repositoryId,
          rule.id,
          { version: rule.version, enabled: true },
          actor,
        )
        const policy = (yield* policies.list(repositoryId))[0]!
        const saved = yield* policies.save(
          repositoryId,
          policy.policyId,
          { version: policy.version, source: baseMain },
          actor,
        )
        yield* policies.publish(repositoryId, policy.policyId, saved.policy.version, actor)
        assert.strictEqual(
          (yield* ReconcileEntity.execute(queuedWhileDisabled)).outcome,
          "superseded",
        )
        const latest = yield* latestQueued
        const result = yield* ReconcileEntity.execute(latest)
        assert.deepStrictEqual(
          result.plan?.actions.map((action) => [action.labelId, action.action]),
          [[bug, "add"]],
        )
        assert.strictEqual(writes.length, 1)
        const generation = yield* verifyEntity
        yield* (yield* SyncIntegration).entityVerified({
          repositoryId,
          number,
          generation,
          sequence: seq,
        })
        const background = yield* latestQueued
        assert.strictEqual(background.rulesRevision, latest.rulesRevision)
        assert.strictEqual(background.snapshotGeneration, generation)
        assert.strictEqual((yield* ReconcileEntity.execute(background)).outcome, "evaluated")
        const targets = yield* SyncTargets
        assert.strictEqual(
          Option.getOrThrow(yield* targets.get({ _tag: "Entity", repositoryId, number }))
            .verifiedSequence,
          seq,
        )
      }),
  )

  it.effect("does not apply a queued rule that has since been disabled", () =>
    Effect.gen(function* () {
      const queued = yield* handoff
      const rules = yield* LabelingRules
      const rule = (yield* rules.list(repositoryId))[0]!
      const before = yield* work
      yield* rules.patch(repositoryId, rule.id, { version: rule.version, enabled: false }, actor)
      assert.deepStrictEqual(yield* work, before)
      const writesBefore = writes.length
      assert.strictEqual((yield* ReconcileEntity.execute(queued)).outcome, "superseded")
      const result = yield* ReconcileEntity.execute(yield* latestQueued)
      assert.deepStrictEqual(result.plan?.rules, [])
      assert.strictEqual(writes.length, writesBefore)
    }),
  )

  it.effect("re-evaluates an empty plan when a publication overlaps evaluation", () =>
    Effect.gen(function* () {
      const rules = yield* LabelingRules
      const policies = yield* Policies
      const rule = (yield* rules.list(repositoryId))[0]!
      yield* rules.patch(repositoryId, rule.id, { version: rule.version, enabled: true }, actor)
      const policy = (yield* policies.list(repositoryId))[0]!
      let detail = yield* policies.save(
        repositoryId,
        policy.policyId,
        {
          version: policy.version,
          source: {
            target: "pull_request",
            matchesWhen: { fact: "baseRef", operator: "equals", value: "develop" },
          },
        },
        actor,
      )
      detail = yield* policies.publish(repositoryId, policy.policyId, detail.policy.version, actor)
      const queued = yield* handoff
      detail = yield* policies.save(
        repositoryId,
        policy.policyId,
        { version: detail.policy.version, source: baseMain },
        actor,
      )
      const writesBefore = writes.length
      afterLoad = policies
        .publish(repositoryId, policy.policyId, detail.policy.version, actor)
        .pipe(
          Effect.mapError(
            (error) =>
              new LabelingConfigurationError({ operation: "testPublish", message: String(error) }),
          ),
        )
      const old = yield* ReconcileEntity.execute(queued).pipe(
        Effect.provide(EvaluationConfiguration),
      )
      assert.strictEqual(old.outcome, "superseded")
      assert.isNull(old.plan)
      assert.strictEqual(writes.length, writesBefore)
      const current = yield* ReconcileEntity.execute(yield* latestQueued)
      assert.deepStrictEqual(
        current.plan?.actions.map((action) => action.action),
        ["add"],
      )
      assert.strictEqual(writes.length, writesBefore + 1)
    }),
  )

  it.effect("removes rules and unbound policies without scheduling evaluations", () =>
    Effect.gen(function* () {
      const rules = yield* LabelingRules
      const policies = yield* Policies
      const rule = (yield* rules.list(repositoryId))[0]!
      const before = yield* work
      yield* rules.remove(repositoryId, rule.id, rule.version, actor)
      const created = yield* policies.create(
        repositoryId,
        { name: "Unused", description: "", source: baseMain },
        actor,
      )
      const published = yield* policies.publish(
        repositoryId,
        created.policy.policyId,
        created.policy.version,
        actor,
      )
      yield* policies.remove(repositoryId, created.policy.policyId, published.policy.version, actor)
      assert.deepStrictEqual(yield* work, before)
    }),
  )

  it.effect(
    "uses legacy pending configurations and repairs their pointers without a backfill",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE labeling_configuration SET preparation = '{"pull_requests":"999"}'::jsonb
        WHERE repository_id = ${repositoryId} AND revision = (
          SELECT configured_revision FROM labeling_repository_rules WHERE repository_id = ${repositoryId}
        )`
        yield* sql`UPDATE labeling_repository_rules SET active_revision = NULL WHERE repository_id = ${repositoryId}`
        const queued = yield* handoff
        assert.strictEqual(
          queued.rulesRevision,
          (yield* (yield* LabelingConfiguration).view(repositoryId)).configuredRevision,
        )
        const before = yield* work
        yield* (yield* RulesetActivation).promoteAll
        const view = yield* (yield* LabelingConfiguration).view(repositoryId)
        assert.strictEqual(view.activeRevision, view.configuredRevision)
        assert.deepStrictEqual(yield* work, before)
      }),
  )
})
