import { LabelingRevision } from "@janitor/domain/Labeling/Policy/Configuration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { SyncIntegration, type CollectionTrack } from "../SyncIntegration.ts"
import { LabelingConfiguration } from "./Configuration.ts"
import { RulesetActivation } from "./Activation.ts"
import { SnapshotHandoff, backfillAfterActivation } from "./SnapshotHandoff.ts"

export const LabelingSyncIntegrationLayer = Layer.effect(
  SyncIntegration,
  Effect.gen(function* () {
    const configuration = yield* LabelingConfiguration
    const activation = yield* RulesetActivation
    const handoff = yield* SnapshotHandoff
    return {
      requiredCollections: (repositoryId) =>
        Effect.gen(function* () {
          const view = yield* configuration.view(repositoryId)
          // Both active and preparing revisions must have the facts they need.
          const tracks = new Set<CollectionTrack>()
          for (const revision of new Set([view.configuredRevision, view.activeRevision ?? 0])) {
            if (revision === 0) continue
            const snapshot = yield* configuration.load(
              repositoryId,
              LabelingRevision.make(revision),
            )
            if (Option.isNone(snapshot))
              return yield* Effect.fail(new Error("Configured labeling revision is missing"))
            for (const track of snapshot.value.requiredTracks) {
              if (track === "changed_files" || track === "checks" || track === "reviews")
                tracks.add(track)
            }
          }
          return [...tracks]
        }),
      trackVerified: (repositoryId) =>
        Effect.gen(function* () {
          const promoted = yield* activation.promote(repositoryId)
          if (Option.isSome(promoted)) yield* backfillAfterActivation(repositoryId)
        }),
      entityVerified: (request) => handoff.publish(request).pipe(Effect.asVoid),
    }
  }),
)
