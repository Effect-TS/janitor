import type { GitHubIssueApi } from "@janitor/domain/GitHub/Api"
import type { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
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
  }
>()("@janitor/cluster/AutomationIntegration") {
  /** Explicitly used by projection tests and deployments without labeling. */
  static readonly noop = Layer.succeed(this, { issueEvent: () => Effect.void })
}
