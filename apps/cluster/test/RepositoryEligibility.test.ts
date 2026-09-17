import { assert, layer } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { RepositoryConnections } from "../src/RepositoryConnections.ts"
import { RepositoryEligibility, changedReason } from "../src/RepositoryEligibility.ts"
import { SyncTargets } from "../src/SyncTargets.ts"
import { ContentPurge } from "../src/ContentPurge.ts"
import { GitHubTransport } from "../src/GitHub/Transport.ts"
import { TestPayloadCipher } from "./support/PayloadCipher.ts"
import { Services, actor, repositoryId } from "./Labeling/support.ts"

const permissions = { metadata: "read", issues: "write", pull_requests: "read", checks: "read" }
let granted = { ...permissions }
let suspendedAt: string | null = null
let installationId = 77
let fullName = "effect/one"
const installation = () => ({
  id: installationId,
  account: { id: 1, login: "effect", type: "Organization" },
  repository_selection: "all",
  html_url: "https://github.com/settings/installations/77",
  suspended_at: suspendedAt,
  permissions: granted,
})
const services = Layer.mergeAll(
  RepositoryConnections.layer,
  RepositoryEligibility.layer,
  ContentPurge.layer,
).pipe(
  Layer.provideMerge(TestPayloadCipher),
  Layer.provideMerge(Services),
  Layer.provide(
    Layer.succeed(GitHubTransport, {
      request: (request) =>
        Effect.succeed({
          _tag: "Ok" as const,
          status: 200,
          body: request.url.startsWith("/app/installations?")
            ? [installation()]
            : request.url.startsWith("/app/installations/")
              ? installation()
              : request.url.startsWith("/installation/repositories")
                ? {
                    total_count: 1,
                    repositories: [{ id: 701, full_name: fullName, private: false }],
                  }
                : { id: 701 },
          etag: Option.none(),
          link: Option.none(),
          requestId: Option.none(),
        }),
    }),
  ),
)

layer(services, { timeout: "2 minutes" })("Repository eligibility", (it) => {
  it.effect("is independent of synchronization progress and failure", () =>
    Effect.gen(function* () {
      const connections = yield* RepositoryConnections
      const eligibility = yield* RepositoryEligibility
      const targets = yield* SyncTargets
      const sql = yield* SqlClient.SqlClient
      yield* connections.refresh
      // Installation discovery knows the repository before anyone connects it.
      const discovered = yield* Effect.flip(eligibility.get(repositoryId))
      assert.strictEqual(discovered.reason, "This repository is not connected to Janitor.")
      yield* connections.change(repositoryId, "connect", actor)
      // Initial synchronization is in progress: the UI cache is cold.
      const [row] = yield* sql<{ automation_ready_at: Date | null }>`
        SELECT automation_ready_at FROM github_repository WHERE repository_id = ${repositoryId}`
      assert.isNull(row!.automation_ready_at)
      const eligible = yield* eligibility.get(repositoryId)
      assert.deepStrictEqual(eligible, {
        repositoryId,
        installationId: "77",
        name: "effect/one",
        generation: eligible.generation,
        connected: true,
        paused: false,
        accessAvailable: true,
        blockReason: null,
      })
      // A failed synchronization does not block work either.
      const scope = { _tag: "RepositoryTrack", repositoryId, track: "labels" } as const
      const target = Option.getOrThrow(yield* targets.get(scope))
      const begun = yield* targets.begin(scope, target.dispatchedGeneration)
      assert.strictEqual(begun._tag, "Run")
      if (begun._tag === "Run")
        yield* targets.complete({
          scope,
          generation: begun.generation,
          outcome: { _tag: "Failed", error: "GitHub request timed out" },
        })
      assert.strictEqual((yield* connections.inventory).repositories[0]!.syncState, "failed")
      assert.isNull((yield* eligibility.get(repositoryId)).blockReason)
      assert.strictEqual(yield* eligibility.run(repositoryId, Effect.succeed("ran")), "ran")
    }),
  )

  it.effect("fences work across pause, access loss, disconnection and their restoration", () =>
    Effect.gen(function* () {
      const connections = yield* RepositoryConnections
      const eligibility = yield* RepositoryEligibility
      const sql = yield* SqlClient.SqlClient
      const reason = (repository: string) =>
        eligibility.get(repository).pipe(
          Effect.map(() => null),
          Effect.catchTag("@janitor/cluster/RepositoryEligibility/RepositoryBlocked", (error) =>
            Effect.succeed(error.reason),
          ),
        )
      const accepted = (yield* eligibility.get(repositoryId)).generation
      // A control change racing an operation waits for the operation's fence.
      const held = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const operation = yield* eligibility
        .run(
          repositoryId,
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(held))),
          { generation: accepted },
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const pause = yield* connections.change(repositoryId, "pause", actor).pipe(Effect.forkChild)
      // The pause's own transaction is queued on the repository row lock.
      const waiting = sql<{ waiting: number }>`SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE '%FOR UPDATE OF r%'`.pipe(
        Effect.map((rows) => rows[0]!.waiting),
      )
      while ((yield* waiting) === 0) yield* Effect.yieldNow
      assert.isUndefined(pause.pollUnsafe())
      yield* Deferred.succeed(held, undefined)
      yield* Fiber.join(operation)
      yield* Fiber.join(pause)
      assert.strictEqual(
        yield* reason(repositoryId),
        "This repository is paused in Janitor. Resume it to continue.",
      )
      yield* connections.change(repositoryId, "resume", actor)
      assert.isNull(yield* reason(repositoryId))
      // Restoration never revives work accepted before the pause.
      const stale = yield* Effect.flip(
        eligibility.run(repositoryId, Effect.die("Stale work ran"), { generation: accepted }),
      )
      assert.strictEqual(stale.reason, changedReason)
      const resumed = (yield* eligibility.get(repositoryId)).generation
      assert.strictEqual(
        yield* eligibility.run(repositoryId, Effect.succeed("ran"), { generation: resumed }),
        "ran",
      )
      // Lost access is reported ahead of a pause and needs action on GitHub.
      granted = { ...permissions, issues: "read" }
      yield* connections.refresh.pipe(Effect.ignore)
      assert.strictEqual(
        yield* reason(repositoryId),
        "GitHub access to this repository is unavailable. Restore access on GitHub.",
      )
      yield* connections.change(repositoryId, "pause", actor).pipe(Effect.ignore)
      granted = { ...permissions }
      yield* connections.refresh
      assert.strictEqual(
        yield* reason(repositoryId),
        "This repository is paused in Janitor. Resume it to continue.",
      )
      yield* connections.change(repositoryId, "resume", actor)
      assert.isNull(yield* reason(repositoryId))
      assert.notStrictEqual((yield* eligibility.get(repositoryId)).generation, resumed)
      // Rename keeps the identity; transfer requires revalidated access under the new owner.
      fullName = "effect/renamed"
      yield* connections.refresh
      assert.strictEqual((yield* eligibility.get(repositoryId)).name, "effect/renamed")
      installationId = 88
      fullName = "new-owner/renamed"
      const before = (yield* eligibility.get(repositoryId)).generation
      yield* connections.refresh
      const transferred = yield* eligibility.get(repositoryId)
      assert.strictEqual(transferred.name, "new-owner/renamed")
      assert.strictEqual(transferred.installationId, "88")
      assert.notStrictEqual(transferred.generation, before)
      // Disconnection ends work; reconnection starts a new generation.
      yield* connections.change(repositoryId, "disconnect", actor)
      assert.strictEqual(
        yield* reason(repositoryId),
        "This repository is disconnected from Janitor.",
      )
      yield* connections.change(repositoryId, "connect", actor)
      assert.isNull(yield* reason(repositoryId))
      const reconnected = yield* Effect.flip(
        eligibility.run(repositoryId, Effect.die("Stale work ran"), {
          generation: transferred.generation,
        }),
      )
      assert.strictEqual(reconnected.reason, changedReason)
      assert.strictEqual(yield* reason("999"), "This repository is not connected to Janitor.")
    }),
  )
})
