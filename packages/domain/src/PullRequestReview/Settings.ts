import * as Schema from "effect/Schema"
import { GitHubRepositoryDatabaseId } from "../GitHub/Id.ts"
import { FinalStatus, RunId, SkipReason, Trigger, Verdict } from "./Run.ts"

/**
 * What the web app reads and writes for PR review (EFF-1930): the repository
 * flag with the deployment's status, and the repository's runs list.
 */

/** The deployment's PR review settings (EFF-1929 point 3). */
export const DeploymentStatus = Schema.Struct({
  /** Whether `PR_REVIEW_OPENROUTER_API_KEY` is set; without it PR review is unavailable. */
  available: Schema.Boolean,
  model: Schema.String,
  reasoningEffort: Schema.String,
}).annotate({ identifier: "PullRequestReviewDeploymentStatus" })
export type DeploymentStatus = typeof DeploymentStatus.Type

export const RepositorySettings = Schema.Struct({
  repositoryId: GitHubRepositoryDatabaseId,
  /** Off until someone enables it. */
  enabled: Schema.Boolean,
  deployment: DeploymentStatus,
}).annotate({ identifier: "PullRequestReviewRepositorySettings" })
export type RepositorySettings = typeof RepositorySettings.Type

export const SetRepositorySettingsRequest = Schema.Struct({
  enabled: Schema.Boolean,
}).annotate({ identifier: "PullRequestReviewSetRepositorySettingsRequest" })
export type SetRepositorySettingsRequest = typeof SetRepositorySettingsRequest.Type

/** A GitHub object janitor created for a run: its review or its check run. */
export const RunLink = Schema.Struct({ id: Schema.String, url: Schema.String })

const entryFields = {
  runId: RunId,
  number: Schema.Int,
  title: Schema.String,
  headSha: Schema.String,
  trigger: Trigger,
  verdict: Schema.NullOr(Verdict),
  failedGates: Schema.Array(Schema.String),
  review: Schema.NullOr(RunLink),
  checkRun: Schema.NullOr(RunLink),
  startedAt: Schema.DateTimeUtc,
  finishedAt: Schema.NullOr(Schema.DateTimeUtc),
  /** Blocking findings that still stand: new or carried over. */
  blockers: Schema.Int,
  /** Nits that still stand: new or carried over. */
  nits: Schema.Int,
}

/** One row of a repository's runs list; a skipped run carries its reason. */
export const RunEntry = Schema.Union([
  Schema.Struct({ ...entryFields, status: Schema.Union([Schema.Literal("running"), FinalStatus]) }),
  Schema.Struct({ ...entryFields, status: Schema.Literal("skipped"), reason: SkipReason }),
]).annotate({ identifier: "PullRequestReviewRunEntry" })
export type RunEntry = typeof RunEntry.Type

/** A page of runs, newest first. `cursor` fetches the next, older page; null on the last. */
export const RunPage = Schema.Struct({
  runs: Schema.Array(RunEntry),
  cursor: Schema.NullOr(RunId),
}).annotate({ identifier: "PullRequestReviewRunPage" })
export type RunPage = typeof RunPage.Type
