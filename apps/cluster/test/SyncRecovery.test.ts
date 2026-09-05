import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Duration from "effect/Duration"
import * as Exit from "effect/Exit"
import * as Workflow from "effect/unstable/workflow/Workflow"
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
  it.effect(
    "resumes an accepted execution whose result was lost instead of leaving it pending",
    () =>
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine
        let resumed = 0
        yield* recoverSyncExecutions.pipe(
          Effect.provideService(WorkflowEngine.WorkflowEngine, {
            ...engine,
            poll: () => Effect.succeed(Option.none()),
            resume: (workflow) =>
              Effect.sync(() => {
                assert.strictEqual(workflow._tag, DiscoverInstallations._tag)
                resumed++
              }),
          }),
        )
        assert.strictEqual(resumed, 1)
      }).pipe(Effect.provide(WorkflowEngine.layerMemory)),
  )
  it.effect("interrupts a hung live execution before recovering its target", () =>
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      const sql = yield* SqlClient.SqlClient
      const previous = Option.getOrThrow(yield* targets.get(scope))
      yield* targets.complete({
        scope,
        generation: previous.requestedGeneration,
        outcome: { _tag: "Verified", watermark: Option.none() },
      })
      const next = yield* targets.invalidate({ scope, sequence: Option.none() })
      yield* targets.begin(scope, next.generation)
      yield* sql`UPDATE workflow_outbox SET accepted_at = CLOCK_TIMESTAMP() WHERE execution_key = ${`app:installations:${next.generation}`}`
      const current = Option.getOrThrow(yield* targets.get(scope))
      yield* DiscoverInstallations.execute(
        { scope, generation: current.dispatchedGeneration },
        { discard: true },
      )
      yield* Effect.yieldNow
      yield* sql`UPDATE sync_target SET progressed_at = CLOCK_TIMESTAMP() - INTERVAL '10 minutes',
        no_result_since = CLOCK_TIMESTAMP() - INTERVAL '3 minutes' WHERE scope_key = 'app:installations'`
      const engine = yield* WorkflowEngine.WorkflowEngine
      let interrupted = false
      yield* recoverSyncExecutions.pipe(
        Effect.provideService(WorkflowEngine.WorkflowEngine, {
          ...engine,
          interruptUnsafe: (workflow, id) =>
            engine.interruptUnsafe(workflow, id).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  interrupted = true
                }),
              ),
            ),
          // Cloudflare persists Complete after interruptUnsafe; the memory engine throws its interrupt cause.
          poll: (workflow, id) =>
            interrupted
              ? Effect.succeed(Option.some(new Workflow.Complete({ exit: Exit.interrupt() })))
              : engine.poll(workflow, id),
        }),
      )
      assert.isTrue(interrupted)
      const recovered = Option.getOrThrow(yield* targets.get(scope))
      assert.strictEqual(recovered.completedGeneration, current.dispatchedGeneration)
      assert.include(recovered.lastError ?? "", "terminated")
    }).pipe(
      Effect.provide(
        DiscoverInstallations.toLayer(() => Effect.never).pipe(Layer.provideMerge(EngineLayer)),
      ),
    ),
  )
})
