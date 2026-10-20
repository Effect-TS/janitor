import * as Prompt from "effect/ai/Prompt"
import * as Schema from "effect/Schema"
import { GitHubRepositoryDatabaseId } from "../GitHub/Id.ts"
import { LoopRecord } from "./Finding.ts"
import { FinalStatus, RunId, SkipReason, Trigger, Verdict } from "./Run.ts"

/**
 * What the web app reads and writes for PR review (EFF-1930): the repository
 * flag with the deployment's status, the repository's runs list, and a run's
 * transcript.
 */

/** The deployment's PR review settings (EFF-1929 point 3). */
export const DeploymentStatus = Schema.Struct({
  /** Whether `PR_REVIEW_AI_API_URL` and `PR_REVIEW_AI_API_KEY` are set; without them PR review is unavailable. */
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

/** PR review can't be enabled for a private repository, or one whose visibility is unknown. */
export class PrivateRepository extends Schema.TaggedError<PrivateRepository>()(
  "PrivateRepository",
  { repositoryId: GitHubRepositoryDatabaseId },
  { httpApiStatus: 409 },
) {}

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

/**
 * A run's transcript (EFF-2445): its runs-list row, what its entity kept of
 * the run, and the agent session as committed so far. The run entity drops
 * all of it at `expiresAt`. Messages and records hold text the pull request
 * controls; show them as plain text, never as HTML or Markdown.
 */
export const RunTranscript = Schema.Struct({
  run: RunEntry,
  /** Acquires after the first. */
  resumeCount: Schema.Int,
  /** Told to wrap up. */
  steered: Schema.Boolean,
  /** Interrupted at its deadline. */
  interrupted: Schema.Boolean,
  /** Why a run that ended without a review ended. */
  errorCategory: Schema.NullOr(Schema.String),
  /** When the transcript is dropped; null while the run is still going. */
  expiresAt: Schema.NullOr(Schema.DateTimeUtc),
  /** The prompt messages in order, without the system message. */
  messages: Schema.Array(Prompt.Message),
  /** Every finding and thread judgement the loop recorded, in order. */
  records: Schema.Array(LoopRecord),
}).annotate({ identifier: "PullRequestReviewRunTranscript" })
export type RunTranscript = typeof RunTranscript.Type

/** No run with this id in the repository. */
export class RunNotFound extends Schema.TaggedError<RunNotFound>()(
  "RunNotFound",
  { runId: RunId },
  { httpApiStatus: 404 },
) {}

/**
 * The run's transcript is no longer kept: it is dropped once the retention
 * period after the run ended has passed, or at once for a cancelled run.
 */
export class TranscriptExpired extends Schema.TaggedError<TranscriptExpired>()(
  "TranscriptExpired",
  { runId: RunId },
  { httpApiStatus: 410 },
) {}
