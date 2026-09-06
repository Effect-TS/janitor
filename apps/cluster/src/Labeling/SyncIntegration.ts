import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { SyncIntegration, type CollectionTrack } from "../SyncIntegration.ts"
import { LabelingConfiguration, LabelingConfigurationError } from "./Configuration.ts"
import { SnapshotHandoff } from "./SnapshotHandoff.ts"

export const LabelingSyncIntegrationLayer = Layer.effect(
  SyncIntegration,
  Effect.gen(function* () {
    const configuration = yield* LabelingConfiguration
    const handoff = yield* SnapshotHandoff
    return {
      requiredCollections: (repositoryId) =>
        Effect.gen(function* () {
          const view = yield* configuration.view(repositoryId)
          if (view.configuredRevision === 0) return []
          const snapshot = yield* configuration.load(repositoryId, view.configuredRevision)
          if (Option.isNone(snapshot))
            return yield* new LabelingConfigurationError({
              operation: "requiredCollections",
              message: "Configured labeling revision is missing",
            })
          const tracks = new Set<CollectionTrack>()
          for (const track of snapshot.value.requiredTracks) {
            if (track === "changed_files" || track === "checks" || track === "reviews")
              tracks.add(track)
          }
          return [...tracks]
        }),
      trackVerified: () => Effect.void,
      entityVerified: (request) => handoff.publish(request).pipe(Effect.asVoid),
    }
  }),
)
