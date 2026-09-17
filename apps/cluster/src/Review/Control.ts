import { isTerminalReviewStatus } from "@janitor/domain/Review/Run"
import { GITHUB_WORKSPACE_ID, type TeammateId } from "@janitor/domain/Team/Account"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { GitHubTransport } from "../GitHub/Transport.ts"
import { repositoryTarget, withBriefWaits } from "../Labeling/GitHubIssue.ts"
import { RepositoryEligibility } from "../RepositoryEligibility.ts"
import { describeError } from "../SqlErrors.ts"
import type { RunSnapshot } from "./Agent.ts"
import { effectivePermission } from "./Authority.ts"
import { IssueReviewScheduler } from "./Scheduler.ts"
import { IssueReviewError, IssueReviewStore } from "./Store.ts"

/**
 * Frontend control of review runs (ADR 0007: "Cancel run"). The teammate
 * proves a linked GitHub identity, and their current effective write or
 * admin permission on the repository is checked on GitHub at the moment
 * of the request. Cancelling one run leaves the issue's other queued runs
 * in place.
 */

export class ReviewRunNotFound extends Schema.TaggedError<ReviewRunNotFound>()(
  "ReviewRunNotFound",
  { runId: Schema.String },
) {}

export class ReviewForbidden extends Schema.TaggedError<ReviewForbidden>()("ReviewForbidden", {
  message: Schema.String,
}) {}

export class ReviewRunFinished extends Schema.TaggedError<ReviewRunFinished>()(
  "ReviewRunFinished",
  { runId: Schema.String, status: Schema.String },
) {}

export const forbiddenReasons = {
  unlinked: "Connect your GitHub account on the Account page to control review runs.",
  repository: "This repository cannot be worked on right now.",
} as const

const LinkRow = Schema.Struct({ account_id: Schema.String, display_name: Schema.String })

export class IssueReviewControl extends Context.Service<
  IssueReviewControl,
  {
    readonly cancel: (
      repositoryId: string,
      runId: string,
      teammateId: TeammateId,
      reason: string | undefined,
    ) => Effect.Effect<
      RunSnapshot,
      ReviewRunNotFound | ReviewRunFinished | ReviewForbidden | IssueReviewError
    >
  }
>()("@janitor/cluster/Review/IssueReviewControl", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const store = yield* IssueReviewStore
    const eligibility = yield* RepositoryEligibility
    const scheduler = yield* IssueReviewScheduler
    const transport = yield* GitHubTransport
    const storeError = (operation: string) => (error: { readonly message: string }) =>
      new IssueReviewError({ operation, message: describeError(error) })

    const githubLink = (teammateId: TeammateId) =>
      sql`SELECT account_id, display_name FROM teammate_link
        WHERE teammate_id::text = ${teammateId} AND platform = 'github'
          AND workspace_id = ${GITHUB_WORKSPACE_ID} AND status = 'active' LIMIT 1`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LinkRow))),
        Effect.mapError(storeError("githubLink")),
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
      )

    const cancel = Effect.fn("IssueReviewControl.cancel")(function* (
      repositoryId: string,
      runId: string,
      teammateId: TeammateId,
      reason: string | undefined,
    ) {
      const run = yield* store.run(runId)
      if (Option.isNone(run) || run.value.repositoryId !== repositoryId)
        return yield* new ReviewRunNotFound({ runId })
      if (isTerminalReviewStatus(run.value.status))
        return yield* new ReviewRunFinished({ runId, status: run.value.status })
      const link = yield* githubLink(teammateId)
      if (Option.isNone(link))
        return yield* new ReviewForbidden({ message: forbiddenReasons.unlinked })
      const repository = yield* eligibility
        .get(repositoryId)
        .pipe(
          Effect.mapError((error) =>
            error._tag === "@janitor/cluster/RepositoryEligibility/RepositoryBlocked"
              ? new ReviewForbidden({ message: error.reason })
              : storeError("eligibility")(error),
          ),
        )
      const permission = yield* withBriefWaits(
        effectivePermission(
          repositoryTarget(repository),
          link.value.display_name,
          link.value.account_id,
        ),
      ).pipe(
        Effect.provideService(GitHubTransport, transport),
        Effect.mapError((error) => new ReviewForbidden({ message: error.message })),
      )
      if (permission._tag === "Insufficient")
        return yield* new ReviewForbidden({ message: permission.reason })
      const now = yield* DateTime.now
      const cancelled = yield* scheduler.cancel(
        { repositoryId, runId },
        {
          messageId: `user:${teammateId}:${DateTime.toEpochMillis(now)}`,
          reason: reason?.trim() ? reason.trim() : `Cancelled by ${permission.login}.`,
          actor: permission.login,
        },
      )
      // Nothing matched: the run finished between the read and the write.
      const snapshot = cancelled[0]
      if (snapshot === undefined) return yield* new ReviewRunFinished({ runId, status: "finished" })
      return snapshot
    })

    return { cancel }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
