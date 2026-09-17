import type { ReviewSettings, SetReviewSettingsRequest } from "@janitor/domain/Review/Run"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describeError } from "../SqlErrors.ts"
import { IssueReviewAvailable, unavailableReason } from "./Gate.ts"
import { IssueReviewScheduler } from "./Scheduler.ts"
import { IssueReviewError, IssueReviewStore } from "./Store.ts"

/**
 * Per-repository review settings. Any active teammate behind Access may
 * change them; there is no separate repository-admin check (spec: "Review
 * settings use existing frontend authorization"). Disabling review stops
 * the repository's active runs and cancels queued ones; enabling it again
 * never revives them.
 */

export class ReviewRepositoryMissing extends Schema.TaggedError<ReviewRepositoryMissing>()(
  "ReviewRepositoryMissing",
  { repositoryId: Schema.String },
) {}

export class ReviewUnavailable extends Schema.TaggedError<ReviewUnavailable>()(
  "ReviewUnavailable",
  { message: Schema.String },
) {}

export const disabledReason = "Issue review was disabled for this repository."

export class IssueReviewSettings extends Context.Service<
  IssueReviewSettings,
  {
    readonly get: (
      repositoryId: string,
    ) => Effect.Effect<ReviewSettings, ReviewRepositoryMissing | IssueReviewError>
    readonly set: (
      repositoryId: string,
      request: SetReviewSettingsRequest,
      actor: { readonly issuer: string; readonly subject: string },
    ) => Effect.Effect<
      ReviewSettings,
      ReviewRepositoryMissing | ReviewUnavailable | IssueReviewError
    >
  }
>()("@janitor/cluster/Review/IssueReviewSettings", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const store = yield* IssueReviewStore
    const scheduler = yield* IssueReviewScheduler
    const available = yield* IssueReviewAvailable

    const requireConnected = (repositoryId: string) =>
      sql`SELECT repository_id FROM github_repository WHERE repository_id = ${repositoryId} AND connected`.pipe(
        Effect.mapError(
          (error) =>
            new IssueReviewError({ operation: "repository", message: describeError(error) }),
        ),
        Effect.flatMap((rows) =>
          rows.length === 0
            ? Effect.fail(new ReviewRepositoryMissing({ repositoryId }))
            : Effect.void,
        ),
      )

    const view = (repositoryId: string) =>
      store.settings(repositoryId).pipe(
        Effect.map((row): ReviewSettings =>
          Option.match(row, {
            onNone: () => ({
              repositoryId,
              enabled: false,
              dryRun: true,
              available,
              updatedAt: null,
            }),
            onSome: (setting) => ({
              repositoryId,
              enabled: setting.enabled,
              dryRun: setting.dryRun,
              available,
              updatedAt: setting.updatedAt,
            }),
          }),
        ),
      )

    const get = (repositoryId: string) =>
      requireConnected(repositoryId).pipe(Effect.andThen(view(repositoryId)))

    const set = Effect.fn("IssueReviewSettings.set")(function* (
      repositoryId: string,
      request: SetReviewSettingsRequest,
      actor: { readonly issuer: string; readonly subject: string },
    ) {
      yield* requireConnected(repositoryId)
      if (request.enabled && !available)
        return yield* new ReviewUnavailable({ message: unavailableReason })
      const previous = yield* store.settings(repositoryId)
      const updated = yield* store.upsertSettings(repositoryId, request)
      if (Option.exists(previous, (setting) => setting.enabled) && !updated.enabled)
        yield* scheduler.cancel(
          { repositoryId },
          {
            messageId: `review-disabled:${DateTime.toEpochMillis(updated.updatedAt)}`,
            reason: disabledReason,
            actor: null,
          },
        )
      yield* Effect.logInfo("Changed issue review settings").pipe(
        Effect.annotateLogs({
          repositoryId,
          enabled: updated.enabled,
          dryRun: updated.dryRun,
          issuer: actor.issuer,
          subject: actor.subject,
        }),
      )
      return yield* view(repositoryId)
    })

    return { get, set }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
