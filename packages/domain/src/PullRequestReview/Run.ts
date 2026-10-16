import * as Schema from "effect/Schema"

/** Identifies one PR review run; the per-PR scheduler assigns it when it starts or skips the run. */
export const RunId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("PullRequestReviewRunId"))
  .annotate({ identifier: "PullRequestReviewRunId" })
export type RunId = typeof RunId.Type

/** The `/janitor` comment that started a run: its author's login and the comment's id. */
const invocation = {
  invoker: Schema.NonEmptyString,
  commentId: Schema.NonEmptyString.check(Schema.isPattern(/^[1-9][0-9]*$/)),
}

/**
 * What started a run: a pull request event, a write-access `/janitor` re-run,
 * or a `/janitor` that forces a review of an oversized pull request.
 */
export const Trigger = Schema.Union([
  Schema.TaggedStruct("Automatic", {}),
  Schema.TaggedStruct("Rerun", invocation),
  Schema.TaggedStruct("Forced", invocation),
]).annotate({ identifier: "PullRequestReviewTrigger" })
export type Trigger = typeof Trigger.Type

/** Why a run was skipped before any agent ran. */
export const SkipReason = Schema.Literals(["oversized", "run_cap"]).annotate({
  identifier: "PullRequestReviewSkipReason",
})
export type SkipReason = typeof SkipReason.Type

/** A run's state once it has ended without being skipped. */
export const FinalStatus = Schema.Literals([
  "approved",
  "changes_requested",
  "commented",
  "partial",
  "failed",
  "cancelled",
]).annotate({ identifier: "PullRequestReviewFinalStatus" })
export type FinalStatus = typeof FinalStatus.Type

/** A run's state; a skipped run always carries its reason. */
export const RunStatus = Schema.Union([
  Schema.Struct({ status: Schema.Union([Schema.Literal("running"), FinalStatus]) }),
  Schema.Struct({ status: Schema.Literal("skipped"), reason: SkipReason }),
]).annotate({ identifier: "PullRequestReviewRunStatus" })
export type RunStatus = typeof RunStatus.Type

/** The GitHub review event a run posted. */
export const Verdict = Schema.Literals(["approve", "request_changes", "comment"]).annotate({
  identifier: "PullRequestReviewVerdict",
})
export type Verdict = typeof Verdict.Type
