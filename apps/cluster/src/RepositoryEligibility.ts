import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as SqlError from "effect/unstable/sql/SqlError"

/**
 * Whether repository work may run: connection, pause and current GitHub
 * access. Synchronization is a UI cache and never appears here. Workflows
 * check their own enablement inside the same fence.
 */
export const Eligibility = Schema.Struct({
  repositoryId: Schema.NonEmptyString,
  installationId: Schema.NonEmptyString,
  /** The current `owner/repo` name; the identity survives rename and transfer. */
  name: Schema.NonEmptyString,
  /** Advances on every connection, pause, access or installation change. */
  generation: Schema.String.check(Schema.isPattern(/^\d+$/)),
  connected: Schema.Boolean,
  paused: Schema.Boolean,
  accessAvailable: Schema.Boolean,
  blockReason: Schema.NullOr(Schema.String),
})
export type Eligibility = typeof Eligibility.Type

/** Work refused with the concrete repository block reason. */
export class RepositoryBlocked extends Schema.TaggedError<RepositoryBlocked>()(
  "@janitor/cluster/RepositoryEligibility/RepositoryBlocked",
  { repositoryId: Schema.String, reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

export const missingReason = "This repository is not connected to Janitor."
export const changedReason =
  "This repository's connection, pause or GitHub access changed since this work was accepted. Start it again."

const columns = (sql: SqlClient.SqlClient) => sql`
  r.repository_id::text AS "repositoryId", r.installation_id::text AS "installationId",
  r.owner || '/' || r.repo AS name, r.eligibility_generation::text AS generation,
  r.connected, NOT r.enabled AS paused, repository_access_current(r.repository_id) AS "accessAvailable",
  repository_block_reason(r.repository_id) AS "blockReason"`

export class RepositoryEligibility extends Context.Service<RepositoryEligibility>()(
  "RepositoryEligibility",
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Eligibility))
      const decodeRow = Schema.decodeUnknownEffect(Eligibility)
      const blocked = (repositoryId: string, reason: string | null) =>
        reason === null ? Effect.void : Effect.fail(new RepositoryBlocked({ repositoryId, reason }))
      /** Every repository Janitor knows, with its current block reason. */
      const list =
        sql`SELECT ${columns(sql)} FROM github_repository r ORDER BY r.owner, r.repo`.pipe(
          Effect.flatMap(decodeRows),
          Effect.orDie,
        )
      const lookup = (repositoryId: string) =>
        sql`SELECT ${columns(sql)} FROM github_repository r WHERE r.repository_id = ${repositoryId}`.pipe(
          Effect.flatMap((rows) =>
            rows.length === 0
              ? Effect.fail(new RepositoryBlocked({ repositoryId, reason: missingReason }))
              : decodeRow(rows[0]).pipe(Effect.orDie),
          ),
        )
      /** The repository, or the concrete reason it cannot be worked on. */
      const get = (repositoryId: string) =>
        lookup(repositoryId).pipe(
          Effect.tap((repository) => blocked(repositoryId, repository.blockReason)),
        )
      /**
       * Serialize work with local control changes and hold the fence through
       * the whole effect, including external writes. Work accepted under an
       * earlier generation is refused even after restoration.
       */
      const run = <A, E, R>(
        repositoryId: string,
        effect: Effect.Effect<A, E, R>,
        options?: { readonly generation?: string },
      ): Effect.Effect<A, E | RepositoryBlocked | SqlError.SqlError, R> =>
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql`SELECT ${columns(sql)} FROM github_repository r
              WHERE r.repository_id = ${repositoryId} FOR NO KEY UPDATE`
            if (rows.length === 0)
              return yield* new RepositoryBlocked({ repositoryId, reason: missingReason })
            const repository = yield* decodeRow(rows[0]).pipe(Effect.orDie)
            yield* blocked(repositoryId, repository.blockReason)
            if (options?.generation !== undefined && options.generation !== repository.generation)
              return yield* new RepositoryBlocked({ repositoryId, reason: changedReason })
            return yield* effect
          }),
        )
      return { list, get, run }
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
}
