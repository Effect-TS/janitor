import type { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import type { SyncGeneration } from "@janitor/domain/GitHub/Sync"
import type { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

export type CollectionTrack = "changed_files" | "checks" | "reviews"

/** Explicit application hooks keep synchronization independent of labeling. */
export class SyncIntegration extends Context.Service<
  SyncIntegration,
  {
    readonly requiredCollections: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<ReadonlyArray<CollectionTrack>, Error>
    readonly trackVerified: (repositoryId: GitHubRepositoryDatabaseId) => Effect.Effect<void, Error>
    readonly entityVerified: (request: {
      repositoryId: GitHubRepositoryDatabaseId
      number: number
      generation: SyncGeneration
      sequence: GitHubWebhookJournalSequence
    }) => Effect.Effect<void, Error>
  }
>()("@janitor/cluster/SyncIntegration") {
  /** Explicitly used by standalone sync tests and deployments without labeling. */
  static readonly noop = Layer.succeed(this, {
    requiredCollections: () => Effect.succeed([]),
    trackVerified: () => Effect.void,
    entityVerified: () => Effect.void,
  })
}
