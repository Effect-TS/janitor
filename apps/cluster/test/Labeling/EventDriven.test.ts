import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import * as Schema from "effect/Schema"
import {
  LabelingConfiguration,
  LabelingConfigurationError,
} from "../../src/Labeling/Configuration.ts"
import { DirectLabelingIdentity, LABEL_ITEM_TAG } from "../../src/Labeling/DirectLabeling.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { LabelingSyncIntegrationLayer } from "../../src/Labeling/SyncIntegration.ts"
import { SyncIntegration } from "../../src/SyncIntegration.ts"
import { RulesetActivation } from "../../src/Labeling/Activation.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import {
  actor,
  admit,
  baseMain,
  bug,
  DirectLabelingLayer,
  executeAndReadActivity,
  github,
  LabelingLayer,
  repositoryId,
  seedReady as seed,
  seedPullRequests,
} from "./support.ts"

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
const Services = Layer.mergeAll(DirectLabelingLayer, LabelingSyncIntegrationLayer).pipe(
  Layer.provideMerge(LabelingLayer),
  Layer.provideMerge(github.layer),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(MigratedPostgresLayer),
)
const number = 5
/** Admits pull request #5 as a new event would. */
const handoff = admit(number)
const latestQueued = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ payload: unknown }>`
    SELECT payload FROM workflow_outbox WHERE workflow_tag = ${LABEL_ITEM_TAG}
    ORDER BY (payload->>'rulesRevision')::bigint DESC, (payload->>'snapshotGeneration')::bigint DESC LIMIT 1
  `
  return yield* Schema.decodeUnknownEffect(DirectLabelingIdentity)(row?.payload)
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
            onMatch: "ensure-present",
            onNoMatch: "no-action",
            group: null,
            priority: 0,
            enabled: true,
          },
          actor,
        )
        const view = yield* configuration.view(repositoryId)
        assert.strictEqual(view.activeRevision, view.configuredRevision)
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
      assert.strictEqual((yield* executeAndReadActivity(queued)).outcome, "superseded")
      const current = yield* latestQueued
      assert.isAbove(current.rulesRevision, queued.rulesRevision)
      const result = yield* executeAndReadActivity(current)
      assert.strictEqual(result.outcome, "evaluated")
      assert.deepStrictEqual(
        result.plan?.rules.map((rule) => rule.outcome),
        ["no-match"],
      )
      assert.deepStrictEqual(github.writes, [])
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

  it.effect("uses newly enabled rules and the latest publication for an older event", () =>
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
      assert.strictEqual((yield* executeAndReadActivity(queuedWhileDisabled)).outcome, "superseded")
      const latest = yield* latestQueued
      const result = yield* executeAndReadActivity(latest)
      assert.deepStrictEqual(
        result.plan?.actions.map((action) => [action.labelId, action.action]),
        [[bug, "add"]],
      )
      assert.strictEqual(github.writes.length, 1)
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
      const writesBefore = github.writes.length
      assert.strictEqual((yield* executeAndReadActivity(queued)).outcome, "superseded")
      const result = yield* executeAndReadActivity(yield* latestQueued)
      assert.deepStrictEqual(result.plan?.rules, [])
      assert.strictEqual(github.writes.length, writesBefore)
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
      // The label written earlier is gone again, so the plan has something to add.
      github.issues.get(number)!.labels = []
      const queued = yield* handoff
      detail = yield* policies.save(
        repositoryId,
        policy.policyId,
        { version: detail.policy.version, source: baseMain },
        actor,
      )
      const writesBefore = github.writes.length
      afterLoad = policies
        .publish(repositoryId, policy.policyId, detail.policy.version, actor)
        .pipe(
          Effect.mapError(
            (error) =>
              new LabelingConfigurationError({ operation: "testPublish", message: String(error) }),
          ),
        )
      const old = yield* executeAndReadActivity(queued).pipe(
        Effect.provide(EvaluationConfiguration),
      )
      assert.strictEqual(old.outcome, "superseded")
      assert.isNull(old.plan)
      assert.strictEqual(github.writes.length, writesBefore)
      const current = yield* executeAndReadActivity(yield* latestQueued)
      assert.deepStrictEqual(
        current.plan?.actions.map((action) => action.action),
        ["add"],
      )
      assert.strictEqual(github.writes.length, writesBefore + 1)
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
