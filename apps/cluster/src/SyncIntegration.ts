import type { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

export type CollectionTrack = "changed_files" | "checks" | "reviews"

/**
 * Explicit application hooks keep synchronization independent of labeling.
 * Synchronization is a UI cache (ADR 0006): labeling only tells it which
 * collections to mirror; a completed refresh tells labeling nothing.
 */
export class SyncIntegration extends Context.Service<
  SyncIntegration,
  {
    readonly requiredCollections: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<ReadonlyArray<CollectionTrack>, Error>
  }
>()("@janitor/cluster/SyncIntegration") {
  /** Explicitly used by standalone sync tests and deployments without labeling. */
  static readonly noop = Layer.succeed(this, {
    requiredCollections: () => Effect.succeed([]),
  })
}
