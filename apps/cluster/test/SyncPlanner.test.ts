import { assert, layer } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
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
import { RepairPolicy, SyncPlanner, staggerOffset } from "../src/SyncPlanner.ts"
import { SyncTargets } from "../src/SyncTargets.ts"
import { WorkflowOutbox } from "../src/WorkflowOutbox.ts"
import { MigratedPostgresLayer } from "./support/Postgres.ts"

const PlannerLayer = SyncPlanner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(SyncTargets.layer, GitHubReadModel.layer)),
  Layer.provideMerge(WorkflowOutbox.layer),
  Layer.provideMerge(MigratedPostgresLayer),
)

const installationId = GitHubInstallationId.make("321")
const repositoryId = GitHubRepositoryDatabaseId.make("654")
const seq = GitHubWebhookJournalSequence.make("1")

const pendingScopes = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ scope_key: string; full_requested: boolean }>`
    SELECT scope_key, full_requested FROM sync_target
    WHERE requested_generation > completed_generation ORDER BY scope_key
  `,
)

layer(PlannerLayer, { timeout: "2 minutes" })("SyncPlanner against Postgres", (it) => {
  it.effect("plans inventory for active installations and bootstraps enabled repositories", () =>
    Effect.gen(function* () {
      const planner = yield* SyncPlanner
      const readModel = yield* GitHubReadModel
      const now = yield* DateTime.now

      yield* readModel.applyInstallation({
        installation: {
          id: installationId,
          account: { id: GitHubAccountDatabaseId.make("1"), login: "effect", type: "Organization" },
          repositorySelection: "all",
          htmlUrl: "https://github.com/settings/installations/321",
          permissions: { metadata: "read", issues: "write", pull_requests: "read", checks: "read" },
          suspendedAt: null,
        },
        status: "active",
        sequence: seq,
      })
      yield* readModel.applyRepositories({
        installationId,
        repositories: [
          { id: repositoryId, fullName: { owner: "effect", repo: "janitor" }, isPrivate: false },
        ],
        sequence: seq,
      })

      const first = yield* planner.plan(now)
      assert.deepStrictEqual(first, { planned: true, created: 2 })
      assert.deepStrictEqual(
        (yield* pendingScopes).map((row) => row.scope_key),
        ["app:installations", "installation:321"],
      )

      // Not yet due for another pass.
      const again = yield* planner.plan(DateTime.addDuration(now, Duration.minutes(1)))
      assert.deepStrictEqual(again, { planned: false, created: 0 })

      yield* planner.setRepositoryEnabled(repositoryId, true)
      assert.deepStrictEqual(
        (yield* pendingScopes).map((row) => [row.scope_key, row.full_requested]),
        [
          ["app:installations", false],
          ["installation:321", false],
          ["repository:654:entities", true],
          ["repository:654:labels", true],
          ["repository:654:pull_requests", true],
        ],
      )

      // Enabling twice is a no-op; pending tracks are not re-requested by planning.
      yield* planner.setRepositoryEnabled(repositoryId, true)
      const later = yield* planner.plan(DateTime.addDuration(now, Duration.minutes(10)))
      assert.deepStrictEqual(later, { planned: true, created: 0 })
    }),
  )

  it.effect("requests a full entity repair once the weekly window elapses", () =>
    Effect.gen(function* () {
      const planner = yield* SyncPlanner
      const targets = yield* SyncTargets
      const now = yield* DateTime.now
      const scope = { _tag: "RepositoryTrack" as const, repositoryId, track: "entities" as const }

      // Complete the pending bootstrap run with an old watermark.
      const begun = yield* targets.begin(
        scope,
        (yield* targets.get(scope)).pipe(
          Option.map((t) => t.requestedGeneration),
          Option.getOrThrow,
        ),
      )
      assert.strictEqual(begun._tag, "Run")
      if (begun._tag !== "Run") return
      assert.isTrue(begun.full)
      yield* targets.complete({
        scope,
        generation: begun.generation,
        outcome: {
          _tag: "Verified",
          watermark: Option.some(DateTime.subtractDuration(now, Duration.days(8))),
        },
      })
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE sync_target SET verified_at = CLOCK_TIMESTAMP(), last_full_at = ${DateTime.toDateUtc(DateTime.subtractDuration(now, Duration.days(8)))}, scan_watermark = ${DateTime.toDateUtc(now)} WHERE scope_key = ${"repository:654:entities"}`

      const summary = yield* planner.plan(DateTime.addDuration(now, Duration.hours(2)))
      assert.isTrue(summary.planned)
      const target = Option.getOrThrow(yield* targets.get(scope))
      assert.isTrue(BigInt(target.requestedGeneration) > BigInt(target.completedGeneration))
      const begunAgain = yield* targets.begin(scope, target.requestedGeneration)
      assert.strictEqual(begunAgain._tag, "Run")
      if (begunAgain._tag === "Run") {
        assert.isTrue(begunAgain.full)
        assert.deepStrictEqual(begunAgain.watermark._tag, "Some")
      }
    }),
  )

  it("staggers installations deterministically inside the window", () => {
    const a = staggerOffset("1", RepairPolicy.stagger)
    const b = staggerOffset("2", RepairPolicy.stagger)
    assert.deepStrictEqual(a, staggerOffset("1", RepairPolicy.stagger))
    assert.isTrue(Duration.toMillis(a) < Duration.toMillis(RepairPolicy.stagger))
    assert.isTrue(Duration.toMillis(b) < Duration.toMillis(RepairPolicy.stagger))
    assert.notDeepEqual(a, b)
  })
})
