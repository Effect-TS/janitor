import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
import * as SqlSchema from "effect/sql/SqlSchema"
import type * as SqlError from "effect/sql/SqlError"
import { RepositoryBlocked, RepositoryBlockReason } from "@janitor/domain/GitHub/Repository"

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
  blockReason: Schema.NullOr(RepositoryBlockReason),
})
export type Eligibility = typeof Eligibility.Type

/** The sentence stored and shown for a block reason. */
export const blockReasonText = (reason: RepositoryBlockReason): string => {
  switch (reason) {
    case "not-connected":
      return "This repository is not connected to Janitor."
    case "disconnected":
      return "This repository is disconnected from Janitor."
    case "access-unavailable":
      return "GitHub access to this repository is unavailable. Restore access on GitHub."
    case "paused":
      return "This repository is paused in Janitor. Resume it to continue."
    case "changed":
      return "This repository's connection, pause or GitHub access changed since this work was accepted. Start it again."
  }
}

/**
 * The webhook admission fence. Runs the effect for a repository Janitor does
 * not know yet, or for an eligible repository when the delivery postdates
 * the admission boundary a pause, resumption or access change set. Holds
 * the repository row so a control change waits for the admission to commit.
 * Returns none when the delivery is refused.
 */
export const admitWebhook = <A, E, R>(
  sql: SqlClient.SqlClient,
  repositoryId: string,
  effect: Effect.Effect<A, E, R>,
  receivedAt?: Date,
): Effect.Effect<Option.Option<A>, E | SqlError.SqlError, R> =>
  sql.withTransaction(
    Effect.gen(function* () {
      const [row] = yield* sql<{ reason: string | null; webhooks_after: Date | null }>`
        SELECT repository_block_reason(repository_id) AS reason, webhooks_after
        FROM github_repository WHERE repository_id = ${repositoryId} FOR NO KEY UPDATE`
      if (
        row &&
        (row.reason !== null ||
          (receivedAt !== undefined &&
            row.webhooks_after !== null &&
            receivedAt <= row.webhooks_after))
      )
        return Option.none<A>()
      return Option.some(yield* effect)
    }),
  )

const columns = (sql: SqlClient.SqlClient) => sql`
  r.repository_id::text AS "repositoryId", r.installation_id::text AS "installationId",
  r.owner || '/' || r.repo AS name, r.eligibility_generation::text AS generation,
  r.connected, NOT r.enabled AS paused, repository_access_current(r.repository_id) AS "accessAvailable",
  repository_block_reason(r.repository_id) AS "blockReason"`

const ById = Schema.Struct({ repositoryId: Schema.String })

export class RepositoryEligibility extends Context.Service<RepositoryEligibility>()(
  "RepositoryEligibility",
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const blocked = (repositoryId: string, reason: RepositoryBlockReason | null) =>
        reason === null ? Effect.void : Effect.fail(new RepositoryBlocked({ repositoryId, reason }))
      // Row shapes are fixed by the migrations; a decode failure is a defect.
      const decoded = <A, E, R>(effect: Effect.Effect<A, E | Schema.SchemaError, R>) =>
        Effect.catchTag(effect, "SchemaError", Effect.die)
      const found = (repositoryId: string) => (row: Option.Option<Eligibility>) =>
        Option.isSome(row)
          ? Effect.succeed(row.value)
          : Effect.fail(new RepositoryBlocked({ repositoryId, reason: "not-connected" }))
      /** Every repository Janitor knows, with its current block reason. */
      const list = decoded(
        SqlSchema.findAll({
          Request: Schema.Void,
          Result: Eligibility,
          execute: () =>
            sql`SELECT ${columns(sql)} FROM github_repository r ORDER BY r.owner, r.repo`,
        })(undefined),
      ).pipe(Effect.orDie)
      const lookup = SqlSchema.findOneOption({
        Request: ById,
        Result: Eligibility,
        execute: ({ repositoryId }) =>
          sql`SELECT ${columns(sql)} FROM github_repository r WHERE r.repository_id = ${repositoryId}`,
      })
      const lock = SqlSchema.findOneOption({
        Request: ById,
        Result: Eligibility,
        execute: ({ repositoryId }) =>
          sql`SELECT ${columns(sql)} FROM github_repository r
            WHERE r.repository_id = ${repositoryId} FOR NO KEY UPDATE`,
      })
      /** The repository, or the concrete reason it cannot be worked on. */
      const get = (repositoryId: string) =>
        decoded(lookup({ repositoryId })).pipe(
          Effect.flatMap(found(repositoryId)),
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
            const repository = yield* decoded(lock({ repositoryId })).pipe(
              Effect.flatMap(found(repositoryId)),
            )
            yield* blocked(repositoryId, repository.blockReason)
            if (options?.generation !== undefined && options.generation !== repository.generation)
              return yield* new RepositoryBlocked({ repositoryId, reason: "changed" })
            return yield* effect
          }),
        )
      /** The webhook admission fence; see `admitWebhook`. */
      const admit = <A, E, R>(
        repositoryId: string,
        effect: Effect.Effect<A, E, R>,
        receivedAt?: Date,
      ) => admitWebhook(sql, repositoryId, effect, receivedAt)
      return { list, get, run, admit }
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
}
