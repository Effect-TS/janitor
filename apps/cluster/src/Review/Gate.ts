import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"

/** Deployment opt-in, separate from each repository's review settings. */
export const issueReviewEnabled = Config.Boolean("JANITOR_ISSUE_REVIEW_ENABLED").pipe(
  Config.withDefault(false),
)

/** Declare this in Worker props so flag-only changes participate in deployment diffing. */
export const issueReviewDeploymentEnv = issueReviewEnabled.pipe(
  Effect.map((enabled) => ({ JANITOR_ISSUE_REVIEW_ENABLED: String(enabled) })),
)

/**
 * While the deployment gate is off, settings cannot enable review and
 * admission denies every invocation. Opening this gate still requires
 * per-repository opt-in; it never enables a repository by itself.
 */
export const IssueReviewAvailable = Context.Reference<boolean>("Review/IssueReviewAvailable", {
  defaultValue: () => false,
})

export const unavailableReason = "Issue review is not available in this deployment yet."
export const disabledReason = "Issue review is not enabled for this repository."
export const disabledNowReason = "Issue review was disabled for this repository."
