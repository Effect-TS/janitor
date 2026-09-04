import {
  GitHubInstallationRepositoriesResponse,
  GitHubInstallationRepository,
  GitHubInstallationSummary,
} from "@janitor/domain/GitHub/Installation"
import { GitHubInstallationId } from "@janitor/domain/GitHub/Id"
import { SyncGeneration, type SyncScope } from "@janitor/domain/GitHub/Sync"
import {
  GitHubWebhookJournalSequence,
  GitHubWebhookJournalSequenceZero,
} from "@janitor/domain/GitHub/WebhookJournal"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Activity from "effect/unstable/workflow/Activity"
import * as Workflow from "effect/unstable/workflow/Workflow"
import { SYNC_INSTALLATION_INVENTORY_TAG } from "../SyncRequests.ts"
import { SyncTargets } from "../SyncTargets.ts"
import type { WorkflowRegistration } from "../WorkflowDispatcher.ts"
import { GitHubReadModel } from "./ReadModel.ts"
import {
  SyncActivityError,
  SyncActivityFailure,
  SyncRunOutcome,
  completeRun,
  failure,
  fetchJson,
  logWorkflowFailure,
  paginate,
  withRateLimitWaits,
} from "./SyncSupport.ts"

export const SyncInstallationInventoryPayload = Schema.Struct({
  scope: Schema.TaggedStruct("InstallationInventory", { installationId: GitHubInstallationId }),
  generation: SyncGeneration,
})
export type SyncInstallationInventoryPayload = typeof SyncInstallationInventoryPayload.Type

export const SyncInstallationInventoryResult = Schema.Struct({
  installationId: GitHubInstallationId,
  generation: SyncGeneration,
  outcome: SyncRunOutcome,
  repositoryCount: Schema.Int,
})

export const SyncInstallationInventory = Workflow.make(SYNC_INSTALLATION_INVENTORY_TAG, {
  payload: SyncInstallationInventoryPayload,
  success: SyncInstallationInventoryResult,
  error: SyncActivityError,
  idempotencyKey: ({ scope, generation }) => `${scope.installationId}:${generation}`,
})

const BeginActivityResult = Schema.Union([
  Schema.TaggedStruct("Run", {
    generation: SyncGeneration,
    sequence: Schema.NullOr(GitHubWebhookJournalSequence),
  }),
  Schema.TaggedStruct("Superseded", {}),
])

const FetchInstallationResult = Schema.Union([
  Schema.TaggedStruct("Found", { installation: GitHubInstallationSummary }),
  Schema.TaggedStruct("Blocked", { reason: Schema.String }),
])

/**
 * Verifies one installation and its accessible repositories. Repositories the
 * complete listing omits become suspect; only explicit events mark them lost.
 */
export const SyncInstallationInventoryLayer = SyncInstallationInventory.toLayer(
  Effect.fnUntraced(function* (payload) {
    const { installationId } = payload.scope
    const scope: SyncScope = payload.scope
    const name = "SyncInstallationInventory"

    const begun = yield* Activity.make({
      name: `${name}/Begin`,
      success: BeginActivityResult,
      error: SyncActivityError,
      execute: Effect.gen(function* () {
        const targets = yield* SyncTargets
        const result = yield* targets
          .begin(scope, payload.generation)
          .pipe(Effect.mapError((error) => failure(error.message)))
        return result._tag === "Run"
          ? {
              _tag: "Run" as const,
              generation: result.generation,
              sequence: Option.getOrNull(result.sequence),
            }
          : { _tag: "Superseded" as const }
      }),
    })

    if (begun._tag === "Superseded") {
      return {
        installationId,
        generation: payload.generation,
        outcome: "superseded" as const,
        repositoryCount: 0,
      }
    }
    const generation = begun.generation
    const sequence = begun.sequence ?? GitHubWebhookJournalSequenceZero
    const result = (outcome: SyncRunOutcome, repositoryCount: number) => ({
      installationId,
      generation,
      outcome,
      repositoryCount,
    })

    const fetched = yield* withRateLimitWaits(`${name}/FetchInstallation`, (attempt) =>
      Activity.make({
        name: `${name}/FetchInstallation/${attempt}`,
        success: FetchInstallationResult,
        error: SyncActivityFailure,
        execute: Effect.gen(function* () {
          const response = yield* fetchJson(
            {
              scope: { _tag: "App" },
              priority: "foreground",
              method: "GET",
              url: `/app/installations/${installationId}`,
            },
            GitHubInstallationSummary,
          )
          if (response._tag === "Failed") {
            return response.status === 404
              ? { _tag: "Blocked" as const, reason: "installation-not-found" }
              : yield* failure(response.message)
          }
          return { _tag: "Found" as const, installation: response.body }
        }),
      }),
    ).pipe(Effect.result)

    if (fetched._tag === "Failure") {
      yield* completeRun(name, scope, generation, {
        _tag: "Failed",
        error: fetched.failure.message,
      })
      return result("failed", 0)
    }
    if (fetched.success._tag === "Blocked") {
      yield* completeRun(name, scope, generation, {
        _tag: "Blocked",
        reason: fetched.success.reason,
      })
      return result("blocked", 0)
    }
    const installation = fetched.success.installation

    if (installation.suspendedAt !== null) {
      yield* Activity.make({
        name: `${name}/ApplySuspended`,
        error: SyncActivityError,
        execute: Effect.gen(function* () {
          const readModel = yield* GitHubReadModel
          const targets = yield* SyncTargets
          yield* targets
            .withRun(
              scope,
              generation,
              readModel.applyInstallation({
                installation,
                status: "suspended",
                sequence,
                authoritative: true,
              }),
            )
            .pipe(Effect.mapError((error) => failure(error.message)))
        }),
      })
      yield* completeRun(name, scope, generation, {
        _tag: "Blocked",
        reason: "installation-suspended",
      })
      return result("blocked", 0)
    }

    const pages = yield* paginate({
      name: `${name}/FetchRepositories`,
      firstUrl: "/installation/repositories?per_page=100",
      request: { scope: { _tag: "Installation", installationId }, priority: "foreground" },
      page: GitHubInstallationRepositoriesResponse,
      items: (body) => body.repositories,
      itemSchema: GitHubInstallationRepository,
      cache: { repositoryId: Option.none() },
    })
    if (pages._tag === "Failed") {
      yield* completeRun(name, scope, generation, { _tag: "Failed", error: pages.message })
      return result("failed", 0)
    }
    if (pages._tag === "Blocked") {
      yield* completeRun(name, scope, generation, { _tag: "Blocked", reason: pages.reason })
      return result("blocked", 0)
    }
    const repositories = pages.items

    yield* Activity.make({
      name: `${name}/Apply`,
      error: SyncActivityError,
      execute: Effect.gen(function* () {
        const readModel = yield* GitHubReadModel
        const targets = yield* SyncTargets
        yield* readModel
          .withTransaction(
            targets.withRun(
              scope,
              generation,
              Effect.gen(function* () {
                yield* readModel.applyInstallation({
                  installation,
                  status: "active",
                  sequence,
                  authoritative: true,
                })
                yield* readModel.applyRepositories({
                  installationId,
                  repositories,
                  sequence,
                  authoritative: true,
                })
                yield* readModel.markRepositoriesSuspect({
                  installationId,
                  present: repositories.map((repository) => repository.id),
                  sequence,
                })
                yield* targets.complete({
                  scope,
                  generation,
                  outcome: { _tag: "Verified", watermark: Option.none() },
                })
              }),
            ),
          )
          .pipe(Effect.mapError((error) => failure(error.message)))
      }),
    })

    return result("verified", repositories.length)
  }, logWorkflowFailure("SyncInstallationInventory")),
)

const decodePayload = Schema.decodeUnknownEffect(SyncInstallationInventoryPayload)

export const SyncInstallationInventoryRegistration: WorkflowRegistration = {
  tag: SYNC_INSTALLATION_INVENTORY_TAG,
  submit: (payload) =>
    decodePayload(payload).pipe(
      Effect.flatMap((decoded) => SyncInstallationInventory.execute(decoded, { discard: true })),
      Effect.asVoid,
    ),
}
