import * as ClusterSchema from "effect/cluster/ClusterSchema"
import * as Entity from "effect/cluster/Entity"
import * as Rpc from "effect/rpc/Rpc"
import * as Schema from "effect/Schema"
import { GitHubCommitSha, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { RunId, SkipReason, Trigger } from "@janitor/domain/PullRequestReview/Run"

/**
 * The message protocol of the PR review run entity, one entity per run with
 * the run id as its entity id (EFF-1651 point 5). The per-PR scheduler mints
 * the run id, sends `Start` and `Cancel`, and hears back through its own
 * `RunFinished` whenever the run reaches a final state: published, quiet,
 * skipped, cancelled or errored. Payloads carry ids only, never pull request
 * or invoker text (EFF-1848 point 10).
 */

const run = {
  runId: RunId,
  repositoryId: GitHubRepositoryDatabaseId,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  headSha: GitHubCommitSha,
  trigger: Trigger,
}

/**
 * Reviews the pull request at `headSha`. The handler checks it is still open
 * and not a draft. Each message is keyed by its run, so the scheduler can
 * send it again after a crash without the run entity seeing it twice.
 */
export const Start = Rpc.make("Start", {
  payload: run,
  primaryKey: ({ runId }) => `start:${runId}`,
})

/** Stops the run. A run that is publishing finishes its batch first. */
export const Cancel = Rpc.make("Cancel", {
  payload: { runId: RunId },
  primaryKey: ({ runId }) => `cancel:${runId}`,
})

/**
 * Records a run the scheduler won't start: the `skipped` row and the neutral
 * `janitor/review` check run. The scheduler does no GitHub I/O, so the run
 * entity writes both. It sends no `RunFinished`: a skipped run never became
 * the active run.
 */
export const Skip = Rpc.make("Skip", {
  payload: { ...run, reason: SkipReason },
  primaryKey: ({ runId }) => `skip:${runId}`,
})

export const PullRequestReviewRun = Entity.make("PullRequestReviewRun", [
  Start,
  Cancel,
  Skip,
]).annotateRpcs(ClusterSchema.Persisted, true)
