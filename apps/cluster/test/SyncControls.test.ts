import { assert, layer } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { SyncTargets } from "../src/SyncTargets.ts"
import { SyncStatus } from "../src/SyncStatus.ts"
import { SyncPlanner } from "../src/SyncPlanner.ts"
import { WorkflowOutbox } from "../src/WorkflowOutbox.ts"
import { MigratedPostgresLayer } from "./support/Postgres.ts"

const Services = Layer.mergeAll(SyncStatus.layer, SyncPlanner.layer).pipe(
  Layer.provideMerge(SyncTargets.layer),
  Layer.provideMerge(WorkflowOutbox.layer),
  Layer.provideMerge(MigratedPostgresLayer),
)

layer(Services, { timeout: "2 minutes" })("Repository sync controls", (it) => {
  it.effect("pauses all repository work, fences stale results, and bootstraps on resume", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const targets = yield* SyncTargets
      const status = yield* SyncStatus
      const planner = yield* SyncPlanner
      const repositoryId = GitHubRepositoryDatabaseId.make("9901")
      const scope = { _tag: "RepositoryTrack", repositoryId, track: "labels" } as const
      yield* sql`INSERT INTO github_installation(installation_id,account_database_id,account_handle,account_type,repository_selection,status,html_url,projected_sequence,access_error)
        VALUES('77','1','test','Organization','all','active','https://github.com/settings/installations/77',1,NULL)`
      yield* sql`INSERT INTO github_repository
        (repository_id, installation_id, owner, repo, access, enabled, projected_sequence)
        VALUES (${repositoryId}, '77', 'test', 'offline', 'accessible', TRUE, 1)`
      const old = yield* targets.invalidate({ scope, sequence: Option.none() })
      yield* targets.begin(scope, old.generation)
      yield* planner.setRepositoryEnabled(repositoryId, false)
      assert.deepStrictEqual(
        yield* sql`SELECT enabled, sync_enabled, repo FROM github_repository`,
        [{ enabled: false, sync_enabled: false, repo: "offline" }],
      )
      assert.isTrue(
        Option.isNone(yield* targets.withRun(scope, old.generation, Effect.succeed("stale"))),
      )
      assert.strictEqual((yield* targets.begin(scope, old.generation))._tag, "Superseded")
      const invalidated = yield* targets.invalidate({
        scope,
        sequence: Option.none(),
        immediate: true,
      })
      assert.isFalse(invalidated.dispatched)
      yield* targets.invalidate({
        scope: { _tag: "Entity", repositoryId, number: 1 },
        sequence: Option.none(),
      })
      yield* sql`UPDATE sync_target SET last_error = 'previous failure',
        retry_at = CLOCK_TIMESTAMP() - INTERVAL '1 hour', completed_generation = requested_generation`
      assert.strictEqual(yield* targets.retryDue, 0)
      assert.strictEqual((yield* status.summary).state, "idle")
      assert.strictEqual((yield* status.requestAll).requested, 2)
      yield* planner.plan(yield* DateTime.now)
      assert.deepStrictEqual(yield* sql`SELECT execution_key FROM workflow_outbox`, [
        { execution_key: "app:installations:1" },
        { execution_key: "installation:77:1" },
      ])
      yield* planner.setRepositoryEnabled(repositoryId, true)
      const before = Option.getOrThrow(yield* targets.get(scope)).requestedGeneration
      yield* planner.setRepositoryEnabled(repositoryId, true)
      assert.strictEqual(Option.getOrThrow(yield* targets.get(scope)).requestedGeneration, before)
      assert.strictEqual(
        (yield* sql`SELECT * FROM workflow_outbox WHERE payload->'scope'->>'repositoryId' = ${repositoryId}`)
          .length,
        3,
      )
    }),
  )
})
