import { SyncGeneration, SyncScope, syncScopeKey } from "@janitor/domain/GitHub/Sync"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Workflow from "effect/unstable/workflow/Workflow"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { SyncTargets } from "./SyncTargets.ts"
import { RefreshEntity } from "./GitHub/RefreshEntity.ts"
import { SyncRepositoryTrack } from "./GitHub/SyncRepositoryTrack.ts"
import { SyncInstallationInventory } from "./GitHub/SyncInstallationInventory.ts"
import { DiscoverInstallations } from "./GitHub/DiscoverInstallations.ts"

const Pending = Schema.Array(
  Schema.Struct({
    scope: SyncScope,
    execution_generation: SyncGeneration,
    stalled: Schema.Boolean,
  }),
)

/** Resume evicted executions. Interrupt confirmed stalls before replacing their generation. */
export const recoverSyncExecutions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const targets = yield* SyncTargets
  const engine = yield* WorkflowEngine.WorkflowEngine
  const rows = yield* sql`
    SELECT t.scope, t.execution_generation::text,
      COALESCE(t.no_result_since < CLOCK_TIMESTAMP() - INTERVAL '2 minutes'
        AND COALESCE(t.progressed_at,o.accepted_at) < CLOCK_TIMESTAMP() - INTERVAL '5 minutes', FALSE) AS stalled
    FROM sync_target t
    JOIN workflow_outbox o ON o.execution_key = t.scope_key || ':' || t.execution_generation
    WHERE t.dispatched_generation > t.completed_generation AND o.accepted_at IS NOT NULL
    ORDER BY t.inspected_at NULLS FIRST LIMIT 100
  `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Pending)))
  yield* Effect.forEach(
    rows,
    (row) =>
      Effect.gen(function* () {
        const { scope } = row
        const generation = row.execution_generation
        const inspect = (
          workflow: Workflow.Any,
          executionId: string,
          poll: Effect.Effect<
            Option.Option<{ readonly _tag: string }>,
            never,
            WorkflowEngine.WorkflowEngine
          >,
        ) =>
          Effect.gen(function* () {
            let result = yield* poll
            if (Option.isNone(result)) {
              if (row.stalled) {
                // This RPC waits for the old fiber's interruption. A timeout never grants a takeover.
                yield* engine.interruptUnsafe(workflow, executionId)
                result = yield* poll
                yield* Effect.logWarning("Interrupted stalled GitHub sync", {
                  scope: syncScopeKey(scope),
                  generation,
                })
              } else {
                yield* engine.resume(workflow, executionId)
              }
            }
            if (Option.isSome(result) && result.value._tag === "Complete") {
              yield* targets.recoverTerminal(scope, generation)
            }
            // Inspection is not progress. Suspended workflows retain their durable clock.
            yield* sql`UPDATE sync_target SET inspected_at = CLOCK_TIMESTAMP(),
        no_result_since = CASE WHEN ${Option.isNone(result)}
          THEN COALESCE(no_result_since,CLOCK_TIMESTAMP()) ELSE NULL END
        WHERE scope_key = ${syncScopeKey(scope)} AND execution_generation = ${generation}`
          })
        switch (scope._tag) {
          case "AppInventory": {
            const id = yield* DiscoverInstallations.executionId({ scope, generation })
            yield* inspect(DiscoverInstallations, id, DiscoverInstallations.poll(id))
            break
          }
          case "InstallationInventory": {
            const id = yield* SyncInstallationInventory.executionId({ scope, generation })
            yield* inspect(SyncInstallationInventory, id, SyncInstallationInventory.poll(id))
            break
          }
          case "RepositoryTrack": {
            const id = yield* SyncRepositoryTrack.executionId({ scope, generation })
            yield* inspect(SyncRepositoryTrack, id, SyncRepositoryTrack.poll(id))
            break
          }
          case "Entity": {
            const id = yield* RefreshEntity.executionId({ scope, generation })
            yield* inspect(RefreshEntity, id, RefreshEntity.poll(id))
            break
          }
        }
      }).pipe(
        Effect.timeout("20 seconds"),
        Effect.catchCause((cause) => Effect.logError("Sync execution recovery failed", cause)),
      ),
    { concurrency: 4, discard: true },
  )
})
