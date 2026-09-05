import { SyncGeneration, SyncScope, syncScopeKey } from "@janitor/domain/GitHub/Sync"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { SyncTargets } from "./SyncTargets.ts"
import { RefreshEntity } from "./GitHub/RefreshEntity.ts"
import { SyncRepositoryTrack } from "./GitHub/SyncRepositoryTrack.ts"
import { SyncInstallationInventory } from "./GitHub/SyncInstallationInventory.ts"
import { DiscoverInstallations } from "./GitHub/DiscoverInstallations.ts"

const isTerminal = (result: Option.Option<{ readonly _tag: string }>) =>
  result._tag === "Some" && result.value._tag === "Complete"

const Pending = Schema.Array(
  Schema.Struct({ scope: SyncScope, execution_generation: SyncGeneration }),
)

/** Resume executions lost during eviction; leave persisted rate-limit sleeps alone. */
export const recoverSyncExecutions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const targets = yield* SyncTargets
  const rows = yield* sql`
    SELECT t.scope, t.execution_generation::text FROM sync_target t
    JOIN workflow_outbox o ON o.execution_key = t.scope_key || ':' || t.execution_generation
    WHERE t.dispatched_generation > t.completed_generation AND o.accepted_at IS NOT NULL
    ORDER BY t.updated_at LIMIT 100
  `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Pending)))
  for (const row of rows) {
    yield* Effect.gen(function* () {
      const { scope } = row
      const generation = row.execution_generation
      const poll = (() => {
        switch (scope._tag) {
          case "AppInventory":
            return DiscoverInstallations.executionId({ scope, generation }).pipe(
              Effect.flatMap((executionId) =>
                DiscoverInstallations.poll(executionId).pipe(
                  Effect.tap((result) =>
                    Option.isNone(result) ? DiscoverInstallations.resume(executionId) : Effect.void,
                  ),
                ),
              ),
              Effect.tap((result) =>
                Effect.logDebug("Sync execution state", {
                  scope: syncScopeKey(scope),
                  state: Option.isSome(result) ? result.value._tag : "NoResult",
                }),
              ),
              Effect.map(isTerminal),
            )
          case "InstallationInventory":
            return SyncInstallationInventory.executionId({ scope, generation }).pipe(
              Effect.flatMap((executionId) =>
                SyncInstallationInventory.poll(executionId).pipe(
                  Effect.tap((result) =>
                    Option.isNone(result)
                      ? SyncInstallationInventory.resume(executionId)
                      : Effect.void,
                  ),
                ),
              ),
              Effect.tap((result) =>
                Effect.logDebug("Sync execution state", {
                  scope: syncScopeKey(scope),
                  state: Option.isSome(result) ? result.value._tag : "NoResult",
                }),
              ),
              Effect.map(isTerminal),
            )
          case "RepositoryTrack":
            return SyncRepositoryTrack.executionId({ scope, generation }).pipe(
              Effect.flatMap((executionId) =>
                SyncRepositoryTrack.poll(executionId).pipe(
                  Effect.tap((result) =>
                    Option.isNone(result) ? SyncRepositoryTrack.resume(executionId) : Effect.void,
                  ),
                ),
              ),
              Effect.tap((result) =>
                Effect.logDebug("Sync execution state", {
                  scope: syncScopeKey(scope),
                  state: Option.isSome(result) ? result.value._tag : "NoResult",
                }),
              ),
              Effect.map(isTerminal),
            )
          case "Entity":
            return RefreshEntity.executionId({ scope, generation }).pipe(
              Effect.flatMap((executionId) =>
                RefreshEntity.poll(executionId).pipe(
                  Effect.tap((result) =>
                    Option.isNone(result) ? RefreshEntity.resume(executionId) : Effect.void,
                  ),
                ),
              ),
              Effect.tap((result) =>
                Effect.logDebug("Sync execution state", {
                  scope: syncScopeKey(scope),
                  state: Option.isSome(result) ? result.value._tag : "NoResult",
                }),
              ),
              Effect.map(isTerminal),
            )
        }
      })()
      const result = yield* poll
      if (result) {
        yield* targets.recoverTerminal(scope, generation)
      }
      yield* sql`UPDATE sync_target SET updated_at = CLOCK_TIMESTAMP() WHERE scope_key = ${syncScopeKey(row.scope)}`
    }).pipe(Effect.catchCause((cause) => Effect.logError("Sync execution recovery failed", cause)))
  }
})
