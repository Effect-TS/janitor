import { DraftPublication } from "@janitor/domain/Review/Draft"
import { ReviewPublication } from "./Publication.ts"
import { Reproduction } from "@janitor/domain/Review/Reproduction"
import * as Schema from "effect/Schema"
import { ReviewClassification, ReviewEvidence } from "./Findings.ts"

/**
 * Wire shapes for GitHub-invoked issue review (ADR 0007, ADR 0012): the
 * per-repository settings, one review run as the frontend history shows
 * it, and the cancel request a frontend user makes.
 */

export const ReviewRunId = Schema.NonEmptyString.pipe(Schema.brand("ReviewRunId")).annotate({
  identifier: "ReviewRunId",
})
export type ReviewRunId = typeof ReviewRunId.Type

/**
 * Where a run is in its lifecycle. `queued` waits behind an earlier run on
 * the same issue; `running` is the issue's active run. Everything after is
 * terminal: a cancelled run never resumes and further work needs a new
 * invocation.
 */
export const ReviewRunStatus = Schema.Literals([
  "queued",
  "running",
  "completed",
  "cancelled",
  "interrupted",
  "failed",
])
export type ReviewRunStatus = typeof ReviewRunStatus.Type

export const isTerminalReviewStatus = (status: ReviewRunStatus): boolean =>
  status !== "queued" && status !== "running"

export const ReviewSettings = Schema.Struct({
  repositoryId: Schema.String,
  /** Whether authorized mentions in this repository may start review runs. */
  enabled: Schema.Boolean,
  /** Findings stay in the frontend; no GitHub writes happen automatically. */
  dryRun: Schema.Boolean,
  /** Whether this deployment offers issue review at all (the development gate). */
  available: Schema.Boolean,
  updatedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
})
export type ReviewSettings = typeof ReviewSettings.Type

export const SetReviewSettingsRequest = Schema.Struct({
  enabled: Schema.Boolean,
  dryRun: Schema.Boolean,
})
export type SetReviewSettingsRequest = typeof SetReviewSettingsRequest.Type

/** One review run in the repository's history. */
export const ReviewRun = Schema.Struct({
  runId: ReviewRunId,
  repositoryId: Schema.String,
  issueNumber: Schema.Int,
  /** From the UI cache when it holds the issue; GitHub is the authority. */
  issueTitle: Schema.NullOr(Schema.String),
  /** The invoking comment's stable identity on GitHub. */
  commentId: Schema.String,
  invokerId: Schema.String,
  invokerLogin: Schema.String,
  /** The immutable instruction snapshot: the comment body at admission. */
  instructions: Schema.String,
  dryRun: Schema.Boolean,
  status: ReviewRunStatus,
  /** 1 for the issue's active run, larger for runs waiting behind it, null once terminal. */
  queuePosition: Schema.NullOr(Schema.Int),
  acceptedAt: Schema.DateTimeUtcFromString,
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  deadlineAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  finishedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  /** Why a cancelled run stopped, in the words the frontend shows. */
  cancelReason: Schema.NullOr(Schema.String),
  cancelledBy: Schema.NullOr(Schema.String),
  /** The agent's classification once the run concluded. */
  classification: Schema.NullOr(ReviewClassification),
  /** The default branch and its commit the evidence was read from. */
  defaultBranch: Schema.NullOr(Schema.String),
  commitSha: Schema.NullOr(Schema.String),
  /** Agent-authored findings and uncertainty; null until the run concluded. */
  findings: Schema.NullOr(Schema.String),
  uncertainty: Schema.NullOr(Schema.String),
  /** Evidence the run cited, verified against what it observed. */
  evidence: Schema.Array(ReviewEvidence),
  reproduction: Reproduction,
  publication: ReviewPublication,
  draftPublication: Schema.NullOr(DraftPublication),
  /** What ended a run short of a conclusion: the deadline, a lost sandbox, a failure. */
  limitation: Schema.NullOr(Schema.String),
})
export type ReviewRun = typeof ReviewRun.Type

export const ReviewHistory = Schema.Struct({
  runs: Schema.Array(ReviewRun),
})
export type ReviewHistory = typeof ReviewHistory.Type

export const CancelReviewRequest = Schema.Struct({
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
})
export type CancelReviewRequest = typeof CancelReviewRequest.Type
