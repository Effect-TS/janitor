import { RepositoryEligibility } from "../../src/RepositoryEligibility.ts"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as WorkflowEngine from "effect/workflow/WorkflowEngine"
import { GitHubWebhookDeliveryId } from "@janitor/domain/GitHub/Id"
import { SyncGeneration } from "@janitor/domain/GitHub/Sync"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import { GitHubWebhookName } from "@janitor/domain/GitHub/WebhookEnvelope"
import type { GitHubWebhookProjectionStatus } from "@janitor/domain/GitHub/WebhookJournal"
import { ProjectGitHubWebhook, ProjectGitHubWebhookLayer } from "../../src/GitHub/ProjectWebhook.ts"
import { GitHubReadModel } from "../../src/GitHub/ReadModel.ts"
import { ContentPurge } from "../../src/ContentPurge.ts"
import { AutomationIntegration } from "../../src/AutomationIntegration.ts"
import { SyncTargets } from "../../src/SyncTargets.ts"
import {
  GitHubWebhookJournal,
  type GitHubWebhookJournaledDelivery,
} from "../../src/GitHub/WebhookJournal.ts"

interface Marked {
  readonly deliveryId: string
  readonly status: GitHubWebhookProjectionStatus
  readonly error: Option.Option<string>
}

/** Journals `payload` as a delivery, pending by default. */
const journaled = (
  deliveryId: GitHubWebhookDeliveryId,
  eventName: string,
  payload: unknown,
  projectionStatus: GitHubWebhookProjectionStatus = "pending",
) =>
  Effect.gen(function* () {
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(payload)
    const delivery: GitHubWebhookJournaledDelivery = {
      deliveryId,
      sequence: GitHubWebhookJournalSequence.make("7"),
      eventName: GitHubWebhookName.make(eventName),
      payload: new TextEncoder().encode(json),
      projectionStatus,
    }
    return delivery
  })

const runWorkflow = (
  deliveryId: GitHubWebhookDeliveryId,
  delivery: Option.Option<GitHubWebhookJournaledDelivery>,
  marked: Array<Marked>,
) =>
  ProjectGitHubWebhook.execute({ deliveryId }).pipe(
    Effect.provide(
      ProjectGitHubWebhookLayer.pipe(
        Layer.provide(
          Layer.succeed(RepositoryEligibility, {
            admit: (_id, effect) => Effect.map(effect, Option.some),
            get: () => Effect.die("unused"),
            list: Effect.die("unused"),
            run: () => Effect.die("unused"),
          }),
        ),
        Layer.provide(
          Layer.succeed(GitHubWebhookJournal, {
            record: () => Effect.die("unused"),
            load: () => Effect.succeed(delivery),
            markProjection: (id, status, error) =>
              Effect.sync(() => void marked.push({ deliveryId: id, status, error })),
          }),
        ),
        Layer.provide(
          Layer.succeed(GitHubReadModel, {
            listOpenEntityNumbersBefore: () => Effect.succeed([]),
            withTransaction: (effect) => effect,
            updateRepositoryIdentity: () => Effect.void,
            markInstallationLost: () => Effect.void,
            applyInstallation: () => Effect.void,
            applyRepositories: () => Effect.void,
            markRepositoriesLost: () => Effect.void,
            markRepositoriesSuspect: () => Effect.void,
            applyPullRequest: () => Effect.succeed({ _tag: "Applied" as const }),
            applyLabelCatalog: () => Effect.void,
            applyPullRequests: () => Effect.succeed([]),
            applyIssues: () => Effect.void,
            applyIssue: () => Effect.succeed({ _tag: "Applied" as const }),
            applyPullRequestDetails: () => Effect.succeed({ _tag: "Applied" as const }),
            getInstallation: () => Effect.succeedNone,
            getRepository: () => Effect.succeedNone,
            getEntity: () => Effect.succeedNone,
            listLabels: () => Effect.succeed([]),
            listOpenEntities: () => Effect.succeed([]),
            applyPullRequestCollections: () => Effect.void,
          }),
        ),
        Layer.provide(
          Layer.succeed(SyncTargets, {
            withRun: (_scope, _generation, effect) => Effect.map(effect, Option.some),
            retryFailedEntities: () => Effect.succeed(0),
            retryDue: Effect.succeed(0),
            recoverTerminal: () => Effect.void,
            invalidate: () =>
              Effect.succeed({ generation: SyncGeneration.make("1"), dispatched: true }),
            begin: () => Effect.succeed({ _tag: "Superseded" as const }),
            complete: () => Effect.succeed(false),
            get: () => Effect.succeedNone,
          }),
        ),
        Layer.provide(
          Layer.succeed(ContentPurge, {
            schedule: () => Effect.void,
            cancel: () => Effect.void,
            runDue: () => Effect.succeed({ purged: 0 }),
          }),
        ),
        Layer.provide(AutomationIntegration.noop),
        Layer.provideMerge(WorkflowEngine.layerMemory),
      ),
    ),
  )

describe("ProjectGitHubWebhook", () => {
  it.effect("decodes and marks a supported delivery projected", () =>
    Effect.gen(function* () {
      const deliveryId = GitHubWebhookDeliveryId.make("delivery-ping")
      const marked: Array<Marked> = []
      const delivery = yield* journaled(deliveryId, "ping", {
        hook_id: 123,
        zen: "Keep it logically awesome.",
      })

      const result = yield* runWorkflow(deliveryId, Option.some(delivery), marked)

      assert.deepStrictEqual(result, { deliveryId, status: "projected" })
      assert.deepStrictEqual(marked, [{ deliveryId, status: "projected", error: Option.none() }])
    }),
  )

  it.effect("marks an undecodable payload unsupported with the decode error", () =>
    Effect.gen(function* () {
      const deliveryId = GitHubWebhookDeliveryId.make("delivery-unsupported")
      const marked: Array<Marked> = []
      const delivery = yield* journaled(deliveryId, "ping", { zen: 1 })

      const result = yield* runWorkflow(deliveryId, Option.some(delivery), marked)

      assert.deepStrictEqual(result, { deliveryId, status: "unsupported" })
      assert.strictEqual(marked[0]?.status, "unsupported")
      assert.isTrue(Option.isSome(marked[0]?.error ?? Option.none()))
    }),
  )

  it.effect("returns the recorded status for an already projected delivery", () =>
    Effect.gen(function* () {
      const deliveryId = GitHubWebhookDeliveryId.make("delivery-done")
      const marked: Array<Marked> = []
      const delivery = yield* journaled(deliveryId, "ping", { hook_id: 1, zen: "z" }, "projected")

      const result = yield* runWorkflow(deliveryId, Option.some(delivery), marked)

      assert.deepStrictEqual(result, { deliveryId, status: "projected" })
      assert.deepStrictEqual(marked, [])
    }),
  )

  it.effect("fails with a typed error when the delivery is not journaled", () =>
    Effect.gen(function* () {
      const deliveryId = GitHubWebhookDeliveryId.make("delivery-missing")

      const exit = yield* runWorkflow(deliveryId, Option.none(), []).pipe(Effect.exit)

      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        assert.include(String(exit.cause), "Delivery is not journaled")
      }
    }),
  )
})
