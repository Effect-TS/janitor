import type { GitHubIssueApi } from "@janitor/domain/GitHub/Api"
import type { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import type {
  IssueCommentPayload,
  PullRequestReviewCommentPayload,
} from "@janitor/domain/GitHub/WebhookEvent/Comment"
import type {
  PullRequest,
  PullRequestRepository,
  PullRequestWebhookPayload,
} from "@janitor/domain/GitHub/WebhookEvent/PullRequest"
import type { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

/**
 * Explicit application hooks keep webhook projection independent of
 * automation. Projection mirrors the event into the UI cache; automation
 * decides on its own whether the event admits work, inside the same
 * transaction and repository fence.
 */
export class AutomationIntegration extends Context.Service<
  AutomationIntegration,
  {
    /** An `issues` delivery for a connected repository, after the pause fence admitted it. */
    readonly issueEvent: (request: {
      readonly repositoryId: GitHubRepositoryDatabaseId
      readonly issue: GitHubIssueApi
      readonly sequence: GitHubWebhookJournalSequence
    }) => Effect.Effect<void, Error>
    /** A `pull_request` delivery for a known repository, after the pause fence admitted it. */
    readonly pullRequestEvent: (request: {
      readonly repositoryId: GitHubRepositoryDatabaseId
      readonly repository: PullRequestRepository
      readonly action: PullRequestWebhookPayload["action"]
      readonly sender: PullRequestWebhookPayload["sender"]
      readonly pullRequest: PullRequest
      readonly sequence: GitHubWebhookJournalSequence
    }) => Effect.Effect<void, Error>
    /** An `issue_comment` delivery for a known repository, after the pause fence admitted it. */
    readonly issueCommentEvent: (request: {
      readonly repositoryId: GitHubRepositoryDatabaseId
      readonly payload: IssueCommentPayload
      readonly sequence: GitHubWebhookJournalSequence
    }) => Effect.Effect<void, Error>
    /** A review-thread comment, inside the same repository fence and transaction. */
    readonly reviewCommentEvent: (request: {
      readonly repositoryId: GitHubRepositoryDatabaseId
      readonly payload: PullRequestReviewCommentPayload
      readonly sequence: GitHubWebhookJournalSequence
    }) => Effect.Effect<void, Error>
  }
>()("@janitor/cluster/AutomationIntegration") {
  /** Explicitly used by projection tests and deployments without labeling. */
  static readonly noop = Layer.succeed(this, {
    issueEvent: () => Effect.void,
    pullRequestEvent: () => Effect.void,
    issueCommentEvent: () => Effect.void,
    reviewCommentEvent: () => Effect.void,
  })

  /** Runs every automation's hooks for each event, in order. */
  static readonly combine = <
    const Layers extends ReadonlyArray<Layer.Layer<AutomationIntegration, any, any>>,
  >(
    ...layers: Layers
  ): Layer.Layer<
    AutomationIntegration,
    Layer.Error<Layers[number]>,
    Layer.Services<Layers[number]>
  > =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const hooks = yield* Effect.forEach(layers, (layer) =>
          Layer.build(layer).pipe(Effect.map(Context.get(AutomationIntegration))),
        )
        return {
          issueEvent: (request) =>
            Effect.forEach(hooks, (hook) => hook.issueEvent(request), { discard: true }),
          pullRequestEvent: (request) =>
            Effect.forEach(hooks, (hook) => hook.pullRequestEvent(request), { discard: true }),
          issueCommentEvent: (request) =>
            Effect.forEach(hooks, (hook) => hook.issueCommentEvent(request), { discard: true }),
          reviewCommentEvent: (request) =>
            Effect.forEach(hooks, (hook) => hook.reviewCommentEvent(request), { discard: true }),
        }
      }),
    )
}
