import * as Context from "effect/Context"

/**
 * The development gate (ticket 13): issue review stays unavailable in a
 * deployment until the complete review path and the synchronization
 * migration are verified. While it is off, settings cannot enable review
 * and admission denies every invocation, without bypassing the
 * per-repository opt-in once it is on.
 */
export const IssueReviewAvailable = Context.Reference<boolean>("Review/IssueReviewAvailable", {
  defaultValue: () => false,
})

export const unavailableReason = "Issue review is not available in this deployment yet."
export const disabledReason = "Issue review is not enabled for this repository."
export const disabledNowReason = "Issue review was disabled for this repository."
