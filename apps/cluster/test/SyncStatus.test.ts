import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import {
  GitHubAccountDatabaseId,
  GitHubInstallationId,
  GitHubRepositoryDatabaseId,
} from "@janitor/domain/GitHub/Id"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import { GitHubReadModel } from "../src/GitHub/ReadModel.ts"
import { SyncPlanner } from "../src/SyncPlanner.ts"
import { SyncStatus } from "../src/SyncStatus.ts"
import { SyncTargets } from "../src/SyncTargets.ts"
import { WorkflowOutbox } from "../src/WorkflowOutbox.ts"
import { MigratedPostgresLayer } from "./support/Postgres.ts"

const StatusLayer = Layer.mergeAll(SyncStatus.layer, SyncPlanner.layer).pipe(
  Layer.provideMerge(Layer.mergeAll(SyncTargets.layer, GitHubReadModel.layer)),
  Layer.provideMerge(WorkflowOutbox.layer),
  Layer.provideMerge(MigratedPostgresLayer),
)

const installationId = GitHubInstallationId.make("77")
const enabledRepository = GitHubRepositoryDatabaseId.make("701")
const pausedRepository = GitHubRepositoryDatabaseId.make("702")
const seq = GitHubWebhookJournalSequence.make("1")

const targetRows = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ scope_key: string; requested_generation: string }>`
    SELECT scope_key, requested_generation::text FROM sync_target ORDER BY scope_key
  `,
)

const seed = Effect.gen(function* () {
  const readModel = yield* GitHubReadModel
  const planner = yield* SyncPlanner
  yield* readModel.applyInstallation({
    installation: {
      id: installationId,
      account: { id: GitHubAccountDatabaseId.make("1"), login: "effect", type: "Organization" },
      repositorySelection: "all",
      htmlUrl: "https://github.com/settings/installations/77",
      suspendedAt: null,
    },
    status: "active",
    sequence: seq,
  })
  yield* readModel.applyRepositories({
    installationId,
    repositories: [
      { id: enabledRepository, fullName: { owner: "effect", repo: "one" }, isPrivate: false },
      { id: pausedRepository, fullName: { owner: "effect", repo: "two" }, isPrivate: false },
    ],
    sequence: seq,
  })
  yield* planner.setRepositoryEnabled(enabledRepository, true)
})

layer(StatusLayer, { timeout: "2 minutes" })("SyncStatus against Postgres", (it) => {
  it.effect("summarizes an empty system as idle", () =>
    Effect.gen(function* () {
      const status = yield* SyncStatus
      assert.deepStrictEqual(yield* status.summary, {
        state: "idle",
        lastVerifiedAt: null,
        pendingTargets: 0,
        blockedTargets: 0,
        failedTargets: 0,
      })
    }),
  )

  it.effect("requests one generation per active scope and reports it as syncing", () =>
    Effect.gen(function* () {
      yield* seed
      const status = yield* SyncStatus
      const targets = yield* SyncTargets

      const result = yield* status.requestAll
      // Inventory plus three tracks for the enabled repository; the paused one is skipped.
      assert.strictEqual(result.requested, 5)
      assert.strictEqual(result.summary.state, "syncing")
      assert.strictEqual(result.summary.pendingTargets, 5)
      assert.deepStrictEqual(
        (yield* targetRows).map((row) => [row.scope_key, row.requested_generation]),
        [
          ["app:installations", "1"],
          ["installation:77", "1"],
          ["repository:701:entities", "2"],
          ["repository:701:labels", "2"],
          ["repository:701:pull_requests", "2"],
        ],
      )

      // Verifying every scope returns the system to idle with a last-verified time.
      for (const row of yield* targetRows) {
        const record = Option.getOrThrow(yield* targets.get(scopeOf(row.scope_key)))
        yield* targets.begin(record.scope, record.dispatchedGeneration)
        yield* targets.complete({
          scope: record.scope,
          generation: record.requestedGeneration,
          outcome: { _tag: "Verified", watermark: Option.none() },
        })
      }
      const idle = yield* status.summary
      assert.strictEqual(idle.state, "idle")
      assert.strictEqual(idle.pendingTargets, 0)
      assert.isNotNull(idle.lastVerifiedAt)

      // A blocked scope shows as blocked once nothing is pending.
      const labels = {
        _tag: "RepositoryTrack",
        repositoryId: enabledRepository,
        track: "labels",
      } as const
      const blocked = yield* targets.invalidate({ scope: labels, sequence: Option.none() })
      yield* targets.begin(labels, blocked.generation)
      yield* targets.complete({
        scope: labels,
        generation: blocked.generation,
        outcome: { _tag: "Blocked", reason: "http-404" },
      })
      const summary = yield* status.summary
      assert.strictEqual(summary.state, "blocked")
      assert.strictEqual(summary.blockedTargets, 1)
    }),
  )
  it.effect("reports failed runs instead of claiming success and retains old pending runs", () =>
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      const status = yield* SyncStatus
      const sql = yield* SqlClient.SqlClient
      const scope = { _tag: "InstallationInventory" as const, installationId }
      const requested = yield* targets.invalidate({ scope, sequence: Option.none() })
      yield* targets.begin(scope, requested.generation)
      yield* targets.complete({
        scope,
        generation: requested.generation,
        outcome: { _tag: "Failed", error: "network down" },
      })
      const failed = yield* status.summary
      assert.strictEqual(failed.state, "failed")
      assert.strictEqual(failed.failedTargets, 1)
      yield* targets.invalidate({ scope, sequence: Option.none() })
      yield* sql`UPDATE sync_target SET updated_at = CLOCK_TIMESTAMP() - INTERVAL '2 hours' WHERE scope_key = 'installation:77'`
      const pending = yield* status.summary
      assert.strictEqual(pending.state, "syncing")
      assert.strictEqual(pending.pendingTargets, 1)
    }),
  )
})

const scopeOf = (key: string) => {
  if (key === "app:installations") return { _tag: "AppInventory" } as const
  const parts = key.split(":")
  if (parts[0] === "installation") {
    return {
      _tag: "InstallationInventory",
      installationId: GitHubInstallationId.make(parts[1]!),
    } as const
  }
  return {
    _tag: "RepositoryTrack",
    repositoryId: GitHubRepositoryDatabaseId.make(parts[1]!),
    track: parts[2] as "labels" | "entities" | "pull_requests",
  } as const
}
