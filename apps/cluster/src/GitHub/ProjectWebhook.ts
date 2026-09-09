import { RepositoryActivity } from "../RepositoryActivity.ts"
import * as DateTime from "effect/DateTime"
import { GitHubWebhookDeliveryId, type GitHubInstallationId } from "@janitor/domain/GitHub/Id"
import { GitHubWebhookEvent } from "@janitor/domain/GitHub/WebhookEvent"
import {
  GitHubWebhookProjectionStatus,
  type GitHubWebhookJournalSequence,
} from "@janitor/domain/GitHub/WebhookJournal"
import { PayloadCipher } from "../PayloadCipher.ts"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Activity from "effect/unstable/workflow/Activity"
import * as Workflow from "effect/unstable/workflow/Workflow"
import { PROJECT_GITHUB_WEBHOOK_TAG } from "./ProjectWebhookRequest.ts"
import { ContentPurge, type ContentPurgeError } from "../ContentPurge.ts"
import { SyncTargets, type SyncTargetError } from "../SyncTargets.ts"
import { GitHubReadModel, type GitHubReadModelError } from "./ReadModel.ts"
import { logWorkflowFailure } from "./SyncSupport.ts"
import { GitHubWebhookJournal } from "./WebhookJournal.ts"
import type { WorkflowRegistration } from "../WorkflowDispatcher.ts"

export const ProjectGitHubWebhookPayload = Schema.Struct({
  deliveryId: GitHubWebhookDeliveryId,
})
export type ProjectGitHubWebhookPayload = typeof ProjectGitHubWebhookPayload.Type

export const ProjectGitHubWebhookResult = Schema.Struct({
  deliveryId: GitHubWebhookDeliveryId,
  status: GitHubWebhookProjectionStatus,
})
export type ProjectGitHubWebhookResult = typeof ProjectGitHubWebhookResult.Type

export class ProjectGitHubWebhookError extends Schema.TaggedError<ProjectGitHubWebhookError>()(
  "@janitor/cluster/GitHub/ProjectWebhook/ProjectGitHubWebhookError",
  {
    deliveryId: GitHubWebhookDeliveryId,
    message: Schema.String,
  },
) {}

export const ProjectGitHubWebhook = Workflow.make(PROJECT_GITHUB_WEBHOOK_TAG, {
  payload: ProjectGitHubWebhookPayload,
  success: ProjectGitHubWebhookResult,
  error: ProjectGitHubWebhookError,
  idempotencyKey: ({ deliveryId }) => deliveryId,
})

const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const decodeEvent = Schema.decodeUnknownEffect(GitHubWebhookEvent)

/**
 * Applies one decoded event to the mirror. Events with nothing to mirror yet
 * (ping, checks, statuses, reviews) succeed without writes. Explicit removals
 * mark access lost rather than deleting identity.
 */
/** The installation a decoded event belongs to, when the payload names one. */
export const installationOf = (event: GitHubWebhookEvent): Option.Option<GitHubInstallationId> => {
  switch (event.name) {
    case "installation":
    case "installation_repositories":
    case "pull_request":
      return Option.some(event.payload.installation.id)
    default:
      return Option.none()
  }
}

export const applyEvent = (
  event: GitHubWebhookEvent,
  sequence: GitHubWebhookJournalSequence,
): Effect.Effect<
  void,
  GitHubReadModelError | SyncTargetError | ContentPurgeError,
  GitHubReadModel | SyncTargets | ContentPurge
> =>
  Effect.gen(function* () {
    const readModel = yield* GitHubReadModel
    const targets = yield* SyncTargets
    const purge = yield* ContentPurge
    const invalidateInventory = (installationId: GitHubInstallationId) =>
      targets.invalidate({
        scope: { _tag: "InstallationInventory", installationId },
        sequence: Option.some(sequence),
      })
    switch (event.name) {
      case "installation": {
        const { payload } = event
        const status =
          payload.action === "deleted"
            ? "deleted"
            : payload.action === "suspend" || payload.installation.suspendedAt !== null
              ? "suspended"
              : "active"
        yield* readModel.applyInstallation({ installation: payload.installation, status, sequence })
        const repositories = payload.repositories ?? []
        if (payload.action === "deleted") {
          yield* readModel.markRepositoriesLost({
            installationId: payload.installation.id,
            repositories,
            sequence,
          })
          yield* purge.schedule(
            { _tag: "installation", installationId: payload.installation.id },
            "installation-deleted",
          )
          return
        }
        // Access is back (created, unsuspended, permissions accepted): keep content.
        yield* purge.cancel({ _tag: "installation", installationId: payload.installation.id })
        yield* readModel.applyRepositories({
          installationId: payload.installation.id,
          repositories,
          sequence,
        })
        // Webhooks describe the change; a verified inventory confirms the whole set.
        yield* invalidateInventory(payload.installation.id)
        return
      }
      case "installation_repositories": {
        const { payload } = event
        const installationId = payload.installation.id
        yield* readModel.applyRepositories({
          installationId,
          repositories: payload.repositoriesAdded,
          sequence,
        })
        yield* readModel.markRepositoriesLost({
          installationId,
          repositories: payload.repositoriesRemoved,
          sequence,
        })
        for (const repository of payload.repositoriesRemoved) {
          yield* purge.schedule(
            { _tag: "repository", repositoryId: repository.id },
            "repository-removed",
          )
        }
        for (const repository of payload.repositoriesAdded) {
          yield* purge.cancel({ _tag: "repository", repositoryId: repository.id })
        }
        yield* invalidateInventory(installationId)
        return
      }
      case "pull_request": {
        const { payload } = event
        yield* readModel.applyPullRequest({
          installationId: payload.installation.id,
          repository: payload.repository,
          pullRequest: payload.pullRequest,
          sequence,
        })
        // The projection is a fast observation; a targeted refresh verifies it
        // against GitHub. Only enabled repositories earn that API budget.
        const repository = yield* readModel.getRepository(payload.repository.id)
        if (Option.isSome(repository) && repository.value.enabled) {
          yield* targets.invalidate({
            scope: {
              _tag: "Entity",
              repositoryId: payload.repository.id,
              number: payload.pullRequest.number,
            },
            sequence: Option.some(sequence),
          })
        }
        return
      }
      default:
        return
    }
  })

/**
 * Decrypts and decodes one journaled delivery, then records the outcome.
 * Journal and cipher failures are typed workflow errors. Undecodable payloads
 * are recorded as `unsupported`, not failed, so repair can revisit them.
 */
export const projectDelivery = Effect.fn("ProjectGitHubWebhook.projectDelivery")(function* (
  deliveryId: GitHubWebhookDeliveryId,
) {
  const journal = yield* GitHubWebhookJournal
  const cipher = yield* PayloadCipher
  const readModel = yield* GitHubReadModel

  const fail = (message: string) => new ProjectGitHubWebhookError({ deliveryId, message })

  const delivery = yield* journal
    .load(deliveryId)
    .pipe(Effect.mapError((error) => fail(error.message)))
  if (Option.isNone(delivery)) {
    return yield* fail("Delivery is not journaled")
  }
  const row = delivery.value
  if (row.projectionStatus !== "pending") {
    return row.projectionStatus
  }
  const record = (status: "projected" | "unsupported" | "failed", detail?: string) =>
    Effect.logInfo("Projected GitHub webhook delivery").pipe(
      Effect.annotateLogs({
        id: deliveryId,
        event: row.eventName,
        sequence: row.sequence,
        status,
        ...(detail === undefined ? {} : { detail }),
      }),
    )

  const plaintext = yield* cipher
    .decrypt(deliveryId, row.encryption, row.payload)
    .pipe(Effect.result)
  if (Result.isFailure(plaintext)) {
    yield* journal
      .markProjection(deliveryId, "failed", Option.some("Payload decryption failed"))
      .pipe(Effect.mapError((error) => fail(error.message)))
    yield* record("failed", "Payload decryption failed")
    return "failed" as const
  }

  const decoded = yield* parseJson(new TextDecoder().decode(plaintext.success)).pipe(
    Effect.flatMap((payload) => decodeEvent({ id: deliveryId, name: row.eventName, payload })),
    Effect.result,
  )
  if (Result.isFailure(decoded)) {
    yield* journal
      .markProjection(deliveryId, "unsupported", Option.some(decoded.failure.message))
      .pipe(Effect.mapError((error) => fail(error.message)))
    yield* record("unsupported", decoded.failure.message)
    return "unsupported" as const
  }

  // Mirror writes and the status change commit together, so a retry after a
  // lost activity result sees either both or neither.
  const projection = readModel
    .withTransaction(
      Effect.gen(function* () {
        yield* applyEvent(decoded.success, row.sequence)
        yield* journal.markProjection(
          deliveryId,
          "projected",
          Option.none(),
          installationOf(decoded.success),
        )
      }),
    )
    .pipe(Effect.mapError((error) => fail(error.message)))
  if (decoded.success.name === "pull_request") {
    const activity = yield* RepositoryActivity
    const projected = yield* activity
      .run(
        decoded.success.payload.repository.id,
        projection,
        row.receivedAt === undefined ? undefined : DateTime.toDateUtc(row.receivedAt),
      )
      .pipe(Effect.mapError((error) => fail(error.message)))
    if (Option.isNone(projected)) {
      yield* journal
        .markProjection(
          deliveryId,
          "unsupported",
          Option.some("Repository paused; event discarded"),
        )
        .pipe(Effect.mapError((error) => fail(error.message)))
      yield* record("unsupported", "Repository paused; event discarded")
      return "unsupported" as const
    }
  } else yield* projection
  yield* record("projected")
  return "projected" as const
})

export const ProjectGitHubWebhookLayer = ProjectGitHubWebhook.toLayer(
  Effect.fnUntraced(function* (payload) {
    const status = yield* Activity.make({
      name: "ProjectGitHubWebhook/Project",
      success: GitHubWebhookProjectionStatus,
      error: ProjectGitHubWebhookError,
      execute: projectDelivery(payload.deliveryId),
    })
    return { deliveryId: payload.deliveryId, status }
  }, logWorkflowFailure("ProjectGitHubWebhook")),
)

const decodePayload = Schema.decodeUnknownEffect(ProjectGitHubWebhookPayload)

export const ProjectGitHubWebhookRegistration: WorkflowRegistration = {
  tag: PROJECT_GITHUB_WEBHOOK_TAG,
  submit: (payload) =>
    decodePayload(payload).pipe(
      Effect.flatMap((decoded) => ProjectGitHubWebhook.execute(decoded, { discard: true })),
      Effect.asVoid,
    ),
}
