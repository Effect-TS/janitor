import type { GitHubIssueApi } from "@janitor/domain/GitHub/Api"
import type { GitHubRepositoryDatabaseId, GitHubWebhookDeliveryId } from "@janitor/domain/GitHub/Id"
import type { IssueCommentWebhookEvent } from "@janitor/domain/GitHub/WebhookEvent/Comment"
import type { PullRequest } from "@janitor/domain/GitHub/WebhookEvent/PullRequest"
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
      readonly deliveryId: GitHubWebhookDeliveryId
    }) => Effect.Effect<void, Error>
    /** An `issue_comment` delivery for a connected repository, after the pause fence admitted it. */
    readonly issueCommentEvent: (request: {
      readonly repositoryId: GitHubRepositoryDatabaseId
      readonly payload: (typeof IssueCommentWebhookEvent.Type)["payload"]
      readonly deliveryId: GitHubWebhookDeliveryId
      readonly receivedAt: Date | undefined
    }) => Effect.Effect<void, Error>
    /** A `pull_request` delivery for a known repository, after the pause fence admitted it. */
    readonly pullRequestEvent: (request: {
      readonly repositoryId: GitHubRepositoryDatabaseId
      readonly pullRequest: PullRequest
      readonly sequence: GitHubWebhookJournalSequence
    }) => Effect.Effect<void, Error>
  }
>()("@janitor/cluster/AutomationIntegration") {
  /** Explicitly used by projection tests and deployments without labeling. */
  static readonly noop = Layer.succeed(this, {
    issueEvent: () => Effect.void,
    issueCommentEvent: () => Effect.void,
    pullRequestEvent: () => Effect.void,
  })
}
