import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { LABEL_ITEM_TAG, LabelItem } from "../../src/Labeling/DirectLabeling.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { RepositoryConnections } from "../../src/RepositoryConnections.ts"
import { RepositoryEligibility } from "../../src/RepositoryEligibility.ts"
import { SyncStatus } from "../../src/SyncStatus.ts"
import { SyncTargets } from "../../src/SyncTargets.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import { TestPayloadCipher } from "../support/PayloadCipher.ts"
import {
  actor,
  admit,
  baseMain,
  bug,
  DirectLabelingLayer,
  feature,
  github,
  installationId,
  label,
  LabelingLayer,
  repositoryId,
  seed,
  seedPullRequests,
  verifyTrack,
} from "./support.ts"

const Services = Layer.mergeAll(
  DirectLabelingLayer,
  RepositoryConnections.layer,
  SyncStatus.layer,
).pipe(
  Layer.provideMerge(TestPayloadCipher),
  Layer.provideMerge(LabelingLayer),
  Layer.provideMerge(github.layer),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(MigratedPostgresLayer),
)

const titleIsHello = {
  target: "issue",
  matchesWhen: { fact: "title", operator: "equals", value: "Hello" },
} as const

/** Pull requests against main get `bug`; issues titled Hello get `feature`. */
const configure = Effect.gen(function* () {
  const policies = yield* Policies
  const rules = yield* LabelingRules
  for (const [name, source, labelId] of [
    ["Main", baseMain, bug],
    ["Hello", titleIsHello, feature],
  ] as const) {
    const draft = yield* policies.create(repositoryId, { name, description: "", source }, actor)
    yield* policies.publish(repositoryId, draft.policy.policyId, draft.policy.version, actor)
    yield* rules.create(
      repositoryId,
      {
        policyId: draft.policy.policyId,
        labelId,
        onMatch: "ensure-present",
        onNoMatch: "ensure-absent",
        group: null,
        priority: 0,
        enabled: true,
      },
      actor,
    )
  }
})

const labelsOn = (number: number) => github.issues.get(number)!.labels.map((label) => label.name)

const queuedLabelWork = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ execution_key: string }>`
    SELECT execution_key FROM workflow_outbox WHERE workflow_tag = ${LABEL_ITEM_TAG} ORDER BY execution_key`,
)

layer(Services, { timeout: "2 minutes" })("Labeling independence from the cache", (it) => {
  it.effect("labels items from GitHub while the cache is stale, absent, failed or off", () =>
    Effect.gen(function* () {
      yield* seed
      yield* seedPullRequests
      yield* configure
      const sql = yield* SqlClient.SqlClient
      const targets = yield* SyncTargets
      const connections = yield* RepositoryConnections
      const eligibility = yield* RepositoryEligibility
      // The cache disagrees with GitHub about both pull requests.
      yield* sql`UPDATE github_pull_request SET base_ref = CASE number WHEN 5 THEN 'develop' ELSE 'main' END
        WHERE repository_id = ${repositoryId}`
      github.issues.get(6)!.labels = [{ id: 11, name: "bug" }]
      // The labels track failed and the installation's cache refresh is off.
      const labels = { _tag: "RepositoryTrack", repositoryId, track: "labels" } as const
      const { generation } = yield* targets.invalidate({ scope: labels, sequence: Option.none() })
      yield* targets.begin(labels, generation)
      yield* targets.complete({
        scope: labels,
        generation,
        outcome: { _tag: "Failed", error: "GitHub timeout" },
      })
      yield* sql`UPDATE github_installation SET sync_enabled = FALSE WHERE installation_id = ${installationId}`
      const inventory = (yield* connections.inventory).repositories[0]!
      assert.strictEqual(inventory.syncState, "disabled")
      assert.isNull(inventory.blockReason)
      assert.isNull((yield* eligibility.get(repositoryId)).blockReason)

      assert.strictEqual((yield* label(5)).outcome, "evaluated")
      assert.deepStrictEqual(labelsOn(5), ["bug"])
      assert.strictEqual((yield* label(6)).outcome, "evaluated")
      assert.deepStrictEqual(labelsOn(6), [])
      // Items the cache has never seen.
      github.put({ number: 7, title: "Change 7", state: "open", labels: [], pullRequest: true })
      github.put({ number: 30, title: "Hello", state: "open", labels: [] })
      assert.strictEqual((yield* label(7)).outcome, "evaluated")
      assert.deepStrictEqual(labelsOn(7), ["bug"])
      assert.strictEqual((yield* label(30)).outcome, "evaluated")
      assert.deepStrictEqual(labelsOn(30), ["feature"])
      assert.lengthOf(
        yield* sql`SELECT 1 FROM github_entity WHERE repository_id = ${repositoryId} AND number IN (7, 30)`,
        0,
      )
      // The cache's own controls report the cache, not the repository.
      const refused = yield* Effect.flip((yield* SyncStatus).requestRepository(repositoryId))
      assert.include(refused.message, "turned off")
      yield* sql`UPDATE github_installation SET sync_enabled = TRUE WHERE installation_id = ${installationId}`
    }),
  )

  it.effect("cache refreshes never admit labeling; only control changes fence admitted work", () =>
    Effect.gen(function* () {
      // The suite shares one database: the configuration above persists.
      yield* seed
      yield* seedPullRequests
      const sql = yield* SqlClient.SqlClient
      const status = yield* SyncStatus
      const initial = yield* queuedLabelWork
      const accepted = yield* admit(5)
      const before = yield* queuedLabelWork
      assert.lengthOf(before, initial.length + 1)
      // A manual refresh and every verified track leave the queue unchanged.
      yield* status.requestRepository(repositoryId)
      for (const track of ["labels", "entities", "pull_requests"] as const)
        yield* verifyTrack(track)
      yield* sql`UPDATE github_installation SET sync_enabled = FALSE WHERE installation_id = ${installationId}`
      yield* sql`UPDATE github_installation SET sync_enabled = TRUE WHERE installation_id = ${installationId}`
      assert.deepStrictEqual(yield* queuedLabelWork, before)
      const [unfenced] = yield* sql<{ webhooks_after: Date | null }>`
        SELECT webhooks_after FROM github_repository WHERE repository_id = ${repositoryId}`
      // Lost installation access discards the queued work and moves the
      // admission boundary; restoration asks the cache for a full refresh and
      // never revives what was accepted under the old generation.
      yield* sql`UPDATE github_installation SET access_error = 'Permissions changed' WHERE installation_id = ${installationId}`
      assert.lengthOf(yield* queuedLabelWork, 0)
      const [fenced] = yield* sql<{ webhooks_after: Date | null }>`
        SELECT webhooks_after FROM github_repository WHERE repository_id = ${repositoryId}`
      assert.notDeepEqual(fenced!.webhooks_after, unfenced!.webhooks_after)
      yield* sql`UPDATE github_installation SET access_error = NULL WHERE installation_id = ${installationId}`
      assert.deepStrictEqual(
        yield* sql`SELECT count(*)::int AS tracks FROM sync_target WHERE scope->>'repositoryId' = ${repositoryId}
          AND scope->>'_tag' = 'RepositoryTrack' AND full_requested AND retry_at IS NOT NULL`,
        [{ tracks: 3 }],
      )
      assert.strictEqual((yield* LabelItem.execute(accepted)).outcome, "not-qualified")
      assert.deepStrictEqual(labelsOn(5), [])
      assert.strictEqual((yield* label(5)).outcome, "evaluated")
      assert.deepStrictEqual(labelsOn(5), ["bug"])
      // A transfer keeps the identity but fences work accepted under the old installation.
      const transferred = yield* admit(5)
      yield* sql`INSERT INTO github_installation (installation_id, account_database_id, account_handle, account_type,
          repository_selection, status, html_url, projected_sequence, access_error)
        SELECT '88', '2', 'new-owner', account_type, repository_selection, status, html_url, projected_sequence, NULL
        FROM github_installation WHERE installation_id = ${installationId}`
      yield* sql`UPDATE github_repository SET installation_id = '88' WHERE repository_id = ${repositoryId}`
      assert.lengthOf(yield* queuedLabelWork, 0)
      assert.strictEqual((yield* LabelItem.execute(transferred)).outcome, "not-qualified")
      github.issues.get(5)!.labels = []
      assert.strictEqual((yield* label(5)).outcome, "evaluated")
      assert.deepStrictEqual(labelsOn(5), ["bug"])
    }),
  )
})
