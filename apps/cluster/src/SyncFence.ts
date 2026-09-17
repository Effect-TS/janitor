import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Serialize a cache write with the repository's control changes. The write
 * runs while the repository's cache may refresh (`sync_scope_enabled`) and,
 * when the write describes a response requested at a known time, only if
 * that request postdates the admission boundary a pause, resumption or
 * access change set. Nothing here decides whether automation may run.
 */
export const withSyncScope = <A, E, R>(
  sql: SqlClient.SqlClient,
  repositoryId: string,
  effect: Effect.Effect<A, E, R>,
  requestedAt?: Date,
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const [row] = yield* sql<{ enabled: boolean; webhooks_after: Date | null }>`
        SELECT sync_scope_enabled(jsonb_build_object('_tag', 'RepositoryTrack', 'repositoryId', repository_id)) AS enabled,
          webhooks_after
        FROM github_repository WHERE repository_id = ${repositoryId} FOR NO KEY UPDATE`
      if (
        row &&
        (!row.enabled ||
          (requestedAt !== undefined &&
            row.webhooks_after !== null &&
            requestedAt <= row.webhooks_after))
      )
        return Option.none<A>()
      return Option.some(yield* effect)
    }),
  )
