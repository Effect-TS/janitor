import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { RepositoryConnections } from "../src/RepositoryConnections.ts"
import { GitHubTransport } from "../src/GitHub/Transport.ts"
import { SyncTargets } from "../src/SyncTargets.ts"
import { Services, actor, repositoryId, seed, verifyTrack } from "./Labeling/support.ts"

const services = RepositoryConnections.layer.pipe(
  Layer.provideMerge(Services),
  Layer.provide(
    Layer.succeed(GitHubTransport, {
      request: () =>
        Effect.succeed({
          _tag: "Ok",
          status: 200,
          body: { id: 701 },
          etag: Option.none(),
          link: Option.none(),
          requestId: Option.none(),
        }),
    }),
  ),
)
layer(services, { timeout: "2 minutes" })("Automation readiness", (it) => {
  it.effect(
    "requires every initial track and every failed target to recover, including after resumption",
    () =>
      Effect.gen(function* () {
        yield* seed
        const connections = yield* RepositoryConnections
        const targets = yield* SyncTargets
        const state = connections.inventory.pipe(
          Effect.map((value) => value.repositories[0]!.syncState),
        )
        assert.strictEqual(yield* state, "syncing")
        yield* verifyTrack("labels")
        yield* verifyTrack("entities")
        assert.strictEqual(yield* state, "syncing")
        yield* verifyTrack("pull_requests")
        assert.strictEqual(yield* state, "ready")
        for (const track of ["labels", "entities"] as const) {
          const scope = { _tag: "RepositoryTrack", repositoryId, track } as const
          const { generation } = yield* targets.invalidate({ scope, sequence: Option.none() })
          yield* targets.begin(scope, generation)
          yield* targets.complete({
            scope,
            generation,
            outcome: { _tag: "Failed", error: "GitHub unavailable" },
          })
        }
        assert.strictEqual(yield* state, "failed")
        assert.strictEqual(
          (yield* connections.inventory).repositories[0]!.syncError,
          "GitHub unavailable",
        )
        // Advance the external scheduler's due time, then use the automatic retry interface.
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE sync_target SET retry_at = CLOCK_TIMESTAMP() WHERE last_error IS NOT NULL`
        assert.strictEqual(yield* targets.retryDue, 2)
        const retry = (track: "labels" | "entities") =>
          Effect.gen(function* () {
            yield* verifyTrack(track)
          })
        yield* retry("labels")
        assert.strictEqual(yield* state, "failed")
        yield* retry("entities")
        assert.strictEqual(yield* state, "ready")
        yield* connections.change(repositoryId, "pause", actor)
        assert.strictEqual(yield* state, "paused")
        yield* connections.change(repositoryId, "resume", actor)
        assert.strictEqual(yield* state, "syncing")
        yield* verifyTrack("labels")
        yield* verifyTrack("entities")
        assert.strictEqual(yield* state, "syncing")
        yield* verifyTrack("pull_requests")
        assert.strictEqual(yield* state, "ready")
      }),
  )
})
