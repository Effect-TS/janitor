import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Singleton from "effect/unstable/cluster/Singleton"
import { ContentPurge } from "./ContentPurge.ts"
import { RulesetActivation } from "./Labeling/Activation.ts"
import { AiConsentService } from "./Labeling/Classifier.ts"
import { backfillAfterActivation } from "./Labeling/SnapshotHandoff.ts"
import { REPAIR_PLANNER_NAME, SyncPlanner } from "./SyncPlanner.ts"
import { recoverSyncExecutions } from "./SyncRecovery.ts"

export const SyncRepairCronName = REPAIR_PLANNER_NAME
const independently = <A, E, R>(name: string, task: Effect.Effect<A, E, R>) =>
  task.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.logError(`${name} failed`, cause)),
  )

/** Each maintenance operation runs even if another operation fails. */
export const SyncRepairCronLayer = Singleton.make(
  SyncRepairCronName,
  Effect.gen(function* () {
    yield* independently("Sync recovery", recoverSyncExecutions)
    yield* independently(
      "Sync planning",
      Effect.gen(function* () {
        const planner = yield* SyncPlanner
        yield* planner.plan(yield* DateTime.now)
      }),
    )
    yield* independently(
      "Ruleset activation",
      Effect.gen(function* () {
        const activation = yield* RulesetActivation
        const promoted = yield* activation.promoteAll
        yield* Effect.forEach(promoted, backfillAfterActivation, { discard: true })
      }),
    )
    yield* independently(
      "AI consent settlement",
      Effect.flatMap(AiConsentService, (consent) => consent.settleDraining),
    )
    yield* independently(
      "Content purge",
      Effect.gen(function* () {
        const purge = yield* ContentPurge
        yield* purge.runDue(yield* DateTime.now)
      }),
    )
  }),
)
