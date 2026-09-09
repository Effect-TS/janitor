import { GitHubInstallationSummary } from "@janitor/domain/GitHub/Installation"
import { SyncGeneration } from "@janitor/domain/GitHub/Sync"
import {
  GitHubWebhookJournalSequence,
  GitHubWebhookJournalSequenceZero,
} from "@janitor/domain/GitHub/WebhookJournal"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Activity from "effect/unstable/workflow/Activity"
import * as Workflow from "effect/unstable/workflow/Workflow"
import { DISCOVER_INSTALLATIONS_TAG } from "../SyncRequests.ts"
import { SyncTargets } from "../SyncTargets.ts"
import type { WorkflowRegistration } from "../WorkflowDispatcher.ts"
import { GitHubReadModel } from "./ReadModel.ts"
import { SyncActivityError, completeRun, failure, paginate } from "./SyncSupport.ts"

const Payload = Schema.Struct({
  scope: Schema.TaggedStruct("AppInventory", {}),
  generation: SyncGeneration,
})
export const DiscoverInstallations = Workflow.make(DISCOVER_INSTALLATIONS_TAG, {
  payload: Payload,
  success: Schema.Void,
  error: SyncActivityError,
  idempotencyKey: ({ generation }) => generation,
})
export const DiscoverInstallationsLayer = DiscoverInstallations.toLayer(
  Effect.fnUntraced(function* ({ scope, generation }) {
    const targets = yield* SyncTargets
    const readModel = yield* GitHubReadModel
    const begun = yield* Activity.make({
      name: "DiscoverInstallations/Begin",
      success: Schema.NullOr(
        Schema.Struct({
          generation: SyncGeneration,
          sequence: Schema.NullOr(GitHubWebhookJournalSequence),
        }),
      ),
      error: SyncActivityError,
      execute: targets.begin(scope, generation).pipe(
        Effect.map((run) =>
          run._tag === "Superseded"
            ? null
            : { generation: run.generation, sequence: Option.getOrNull(run.sequence) },
        ),
        Effect.mapError((error) => failure(error.message)),
      ),
    })
    if (begun === null) return
    const pages = yield* paginate({
      name: "DiscoverInstallations/List",
      firstUrl: "/app/installations?per_page=100",
      request: { scope: { _tag: "App" }, priority: "background" },
      page: Schema.Array(GitHubInstallationSummary),
      items: (items) => items,
      collect: false,
      onPage: (installations, ordinal) =>
        Activity.make({
          name: `DiscoverInstallations/Apply/${ordinal}`,
          error: SyncActivityError,
          execute: targets
            .withRun(
              scope,
              begun.generation,
              Effect.gen(function* () {
                for (const installation of installations) {
                  const existing = yield* readModel.getInstallation(installation.id)
                  if (Option.isNone(existing))
                    yield* readModel.applyInstallation({
                      installation,
                      status: installation.suspendedAt === null ? "active" : "suspended",
                      sequence: begun.sequence ?? GitHubWebhookJournalSequenceZero,
                      authoritative: true,
                    })
                  yield* targets.invalidate({
                    scope: { _tag: "InstallationInventory", installationId: installation.id },
                    sequence: Option.none(),
                    immediate: true,
                  })
                }
              }),
            )
            .pipe(
              Effect.asVoid,
              Effect.mapError((error) => failure(error.message)),
            ),
        }),
    })
    yield* completeRun(
      "DiscoverInstallations",
      scope,
      begun.generation,
      pages._tag === "Complete"
        ? { _tag: "Verified", watermark: Option.none() }
        : { _tag: "Failed", error: pages._tag === "Failed" ? pages.message : pages.reason },
    )
  }),
)
export const DiscoverInstallationsRegistration: WorkflowRegistration = {
  tag: DISCOVER_INSTALLATIONS_TAG,
  submit: (payload) =>
    Schema.decodeUnknownEffect(Payload)(payload).pipe(
      Effect.flatMap((decoded) => DiscoverInstallations.execute(decoded, { discard: true })),
      Effect.asVoid,
    ),
}
