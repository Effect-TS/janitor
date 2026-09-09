import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Serialize repository work with pause, including the full external-write attempt. */
export const withRepositoryActivity = <A, E, R>(
  sql: SqlClient.SqlClient,
  repositoryId: string,
  effect: Effect.Effect<A, E, R>,
  receivedAt?: Date,
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const [row] = yield* sql<{
        enabled: boolean
        connected: boolean
        webhooks_after: Date | null
      }>`
        SELECT enabled, connected, webhooks_after FROM github_repository
        WHERE repository_id = ${repositoryId} FOR NO KEY UPDATE`
      if (
        row &&
        (!row.enabled ||
          !row.connected ||
          (receivedAt !== undefined &&
            row.webhooks_after !== null &&
            receivedAt <= row.webhooks_after))
      )
        return Option.none<A>()
      return Option.some(yield* effect)
    }),
  )

/** Ingress uses the same database fence as synchronization and automation. */
export class RepositoryActivity extends Context.Service<RepositoryActivity>()(
  "RepositoryActivity",
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return {
        run: <A, E, R>(repositoryId: string, effect: Effect.Effect<A, E, R>, receivedAt?: Date) =>
          withRepositoryActivity(sql, repositoryId, effect, receivedAt),
      }
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
}
