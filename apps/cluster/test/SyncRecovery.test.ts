import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Duration from "effect/Duration"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import * as DurableClock from "effect/unstable/workflow/DurableClock"
import { SyncGeneration } from "@janitor/domain/GitHub/Sync"
import { DiscoverInstallations } from "../src/GitHub/DiscoverInstallations.ts"
import { SyncActivityError } from "../src/GitHub/SyncSupport.ts"
import { recoverSyncExecutions } from "../src/SyncRecovery.ts"
import { SyncTargets } from "../src/SyncTargets.ts"
import { WorkflowOutbox } from "../src/WorkflowOutbox.ts"
import { MigratedPostgresLayer } from "./support/Postgres.ts"

const DataLayer = SyncTargets.layer.pipe(
  Layer.provideMerge(WorkflowOutbox.layer),
  Layer.provideMerge(MigratedPostgresLayer),
)
const scope = { _tag: "AppInventory" } as const
const generation = SyncGeneration.make("1")

// The memory engine ignores the workflow argument. The Cloudflare engine
// needs its name to find the Durable Object, so check that contract here.
const EngineLayer = Layer.effect(
  WorkflowEngine.WorkflowEngine,
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine
    return {
      ...engine,
      poll: (workflow, executionId) => {
        assert.strictEqual<string>(workflow._tag, DiscoverInstallations._tag)
        return engine.poll(workflow, executionId)
      },
    }
  }),
).pipe(Layer.provide(WorkflowEngine.layerMemory))

layer(DataLayer, { timeout: "2 minutes" })("Sync recovery against engine state", (it) => {
  it.effect("recovers terminal failure and leaves a durable sleep alone", () =>
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      const sql = yield* SqlClient.SqlClient
      yield* targets.invalidate({ scope, sequence: Option.none() })
      yield* targets.begin(scope, generation)
      yield* sql`UPDATE workflow_outbox SET accepted_at = CLOCK_TIMESTAMP() WHERE execution_key = 'app:installations:1'`
      yield* Effect.gen(function* () {
        yield* DiscoverInstallations.execute({ scope, generation }).pipe(Effect.result)
        yield* recoverSyncExecutions
      }).pipe(
        Effect.provide(
          DiscoverInstallations.toLayer(() =>
            Effect.fail(new SyncActivityError({ message: "injected terminal failure" })),
          ).pipe(Layer.provideMerge(EngineLayer)),
        ),
      )
      assert.strictEqual(Option.getOrThrow(yield* targets.get(scope)).completedGeneration, "1")

      const next = yield* targets.invalidate({ scope, sequence: Option.none() })
      yield* targets.begin(scope, next.generation)
      yield* sql`UPDATE workflow_outbox SET accepted_at = CLOCK_TIMESTAMP() WHERE execution_key = 'app:installations:2'`
      yield* Effect.gen(function* () {
        yield* DiscoverInstallations.execute(
          { scope, generation: next.generation },
          { discard: true },
        )
        yield* Effect.yieldNow
        yield* sql`UPDATE sync_target SET updated_at = CLOCK_TIMESTAMP() - INTERVAL '2 hours' WHERE scope_key = 'app:installations'`
        yield* recoverSyncExecutions
        const row = Option.getOrThrow(yield* targets.get(scope))
        assert.strictEqual(row.completedGeneration, "1")
        assert.strictEqual(row.requestedGeneration, "2")
      }).pipe(
        Effect.provide(
          DiscoverInstallations.toLayer(() =>
            DurableClock.sleep({ name: "WaitingForBudget", duration: Duration.hours(2) }),
          ).pipe(Layer.provideMerge(EngineLayer)),
        ),
      )
    }),
  )
})
