import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { LabelingRevision, Preparation } from "@janitor/domain/Labeling/Policy/Configuration"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describeError } from "../SqlErrors.ts"

export class RulesetActivationError extends Data.TaggedError("RulesetActivationError")<{
  readonly operation: string
  readonly message: string
}> {}

const RevisionFromText = Schema.FiniteFromString.pipe(Schema.decodeTo(LabelingRevision))

const PendingRow = Schema.Struct({
  repository_id: GitHubRepositoryDatabaseId,
  configured_revision: RevisionFromText,
  required_tracks: Preparation,
})

const PromotedRow = Schema.Struct({ repository_id: GitHubRepositoryDatabaseId })

/** Repairs legacy configured/active pointers without scheduling evaluations. */
export class RulesetActivation extends Context.Service<
  RulesetActivation,
  {
    /** Returns the revision that became active, if promotion happened now. */
    readonly promote: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<Option.Option<LabelingRevision>, RulesetActivationError>
    /** Promotes every repository whose configured revision is ready. Returns which. */
    readonly promoteAll: Effect.Effect<
      ReadonlyArray<GitHubRepositoryDatabaseId>,
      RulesetActivationError
    >
  }
>()("@janitor/cluster/Labeling/Activation/RulesetActivation", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const decodePending = Schema.decodeUnknownEffect(Schema.Array(PendingRow))
    const decodePromoted = Schema.decodeUnknownEffect(Schema.Array(PromotedRow))

    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new RulesetActivationError({ operation, message: describeError(error) }),
        )

    const promoteReady = (repositoryId: Option.Option<GitHubRepositoryDatabaseId>) =>
      sql`
        UPDATE labeling_repository_rules r
        SET active_revision = r.configured_revision,
            activated_at = CLOCK_TIMESTAMP(),
            updated_at = CLOCK_TIMESTAMP()
        WHERE r.active_revision IS DISTINCT FROM r.configured_revision
          AND (${Option.getOrNull(repositoryId)}::text IS NULL
               OR r.repository_id = ${Option.getOrNull(repositoryId)})
        RETURNING r.repository_id
      `.pipe(Effect.flatMap(decodePromoted))

    const promote = Effect.fn("RulesetActivation.promote")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
    ) {
      const promoted = yield* promoteReady(Option.some(repositoryId)).pipe(wrap("promote"))
      if (promoted.length === 0) {
        return Option.none()
      }
      const rows = yield* sql`
        SELECT repository_id, active_revision::text AS configured_revision, '{}'::jsonb AS required_tracks
        FROM labeling_repository_rules WHERE repository_id = ${repositoryId}
      `.pipe(Effect.flatMap(decodePending), wrap("promote"))
      const revision = rows[0]?.configured_revision
      if (revision === undefined) {
        return Option.none()
      }
      yield* Effect.logInfo("Activated auto-labeling ruleset revision").pipe(
        Effect.annotateLogs({ repositoryId, revision }),
      )
      return Option.some(revision)
    })

    const promoteAll = promoteReady(Option.none()).pipe(
      wrap("promoteAll"),
      Effect.tap((promoted) =>
        promoted.length === 0
          ? Effect.void
          : Effect.logInfo("Activated auto-labeling ruleset revisions").pipe(
              Effect.annotateLogs({
                repositories: promoted.map((row) => row.repository_id).join(","),
              }),
            ),
      ),
      Effect.map((promoted) => promoted.map((row) => row.repository_id)),
      Effect.withSpan("RulesetActivation.promoteAll"),
    )

    return { promote, promoteAll }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
