import * as Schema from "effect/Schema"
import { GitHubUserDatabaseIdFromStringOrNumber } from "../Id.ts"
import {
  GitHubInstallationRepository,
  GitHubInstallationRepositorySelection,
  GitHubInstallationSummary,
} from "../Installation.ts"
import { BaseGitHubWebhookEvent } from "./Base.ts"

const InstallationWebhookActor = Schema.Struct({
  id: GitHubUserDatabaseIdFromStringOrNumber,
  login: Schema.NonEmptyString,
}).annotate({ identifier: "InstallationWebhookActor" })

const baseInstallationWebhookPayloadFields = {
  installation: GitHubInstallationSummary,
  sender: InstallationWebhookActor,
}

const repositories = Schema.optionalKey(Schema.Array(GitHubInstallationRepository))
const nullRequester = Schema.optionalKey(Schema.Null)

const SuspendedGitHubInstallation = GitHubInstallationSummary.check(
  Schema.makeFilter(
    (installation) => installation.suspendedAt !== null && installation.suspendedBy != null,
    { expected: "a suspended GitHub installation" },
  ),
).annotate({ identifier: "SuspendedGitHubInstallation" })

const UnsuspendedGitHubInstallation = GitHubInstallationSummary.check(
  Schema.makeFilter(
    (installation) => installation.suspendedAt === null && installation.suspendedBy === null,
    { expected: "an unsuspended GitHub installation" },
  ),
).annotate({ identifier: "UnsuspendedGitHubInstallation" })

export const BaseInstallationWebhookPayload = Schema.Struct(
  baseInstallationWebhookPayloadFields,
).annotate({ identifier: "BaseInstallationWebhookPayload" })
export type BaseInstallationWebhookPayload = typeof BaseInstallationWebhookPayload.Type

export const InstallationCreated = Schema.Struct({
  ...baseInstallationWebhookPayloadFields,
  action: Schema.Literal("created"),
  repositories,
  requester: Schema.optionalKey(Schema.NullOr(InstallationWebhookActor)),
}).annotate({ identifier: "InstallationCreated" })
export type InstallationCreated = typeof InstallationCreated.Type

export const InstallationDeleted = Schema.Struct({
  ...baseInstallationWebhookPayloadFields,
  action: Schema.Literal("deleted"),
  repositories,
  requester: nullRequester,
}).annotate({ identifier: "InstallationDeleted" })
export type InstallationDeleted = typeof InstallationDeleted.Type

export const InstallationSuspended = Schema.Struct({
  ...baseInstallationWebhookPayloadFields,
  installation: SuspendedGitHubInstallation,
  action: Schema.Literal("suspend"),
  repositories,
  requester: nullRequester,
}).annotate({ identifier: "InstallationSuspended" })
export type InstallationSuspended = typeof InstallationSuspended.Type

export const InstallationUnsuspended = Schema.Struct({
  ...baseInstallationWebhookPayloadFields,
  installation: UnsuspendedGitHubInstallation,
  action: Schema.Literal("unsuspend"),
  repositories,
  requester: nullRequester,
}).annotate({ identifier: "InstallationUnsuspended" })
export type InstallationUnsuspended = typeof InstallationUnsuspended.Type

export const InstallationNewPermissionsAccepted = Schema.Struct({
  ...baseInstallationWebhookPayloadFields,
  action: Schema.Literal("new_permissions_accepted"),
  repositories,
  requester: nullRequester,
}).annotate({ identifier: "InstallationNewPermissionsAccepted" })
export type InstallationNewPermissionsAccepted = typeof InstallationNewPermissionsAccepted.Type

export const InstallationWebhookPayload = Schema.Union([
  InstallationCreated,
  InstallationDeleted,
  InstallationSuspended,
  InstallationUnsuspended,
  InstallationNewPermissionsAccepted,
])
  .annotate({
    identifier: "InstallationWebhookPayload",
    message: "Unsupported or malformed installation webhook action",
  })
  .pipe(Schema.toTaggedUnion("action"))
export type InstallationWebhookPayload = typeof InstallationWebhookPayload.Type

export const InstallationWebhookEvent = Schema.Struct({
  ...BaseGitHubWebhookEvent.fields,
  name: Schema.Literal("installation"),
  payload: InstallationWebhookPayload,
}).annotate({ identifier: "InstallationWebhookEvent" })
export type InstallationWebhookEvent = typeof InstallationWebhookEvent.Type

const installationRepositoriesWebhookPayloadFields = {
  installation: GitHubInstallationSummary,
  repositorySelection: GitHubInstallationRepositorySelection,
  repositoriesAdded: Schema.Array(GitHubInstallationRepository),
  repositoriesRemoved: Schema.Array(GitHubInstallationRepository),
  requester: Schema.NullOr(InstallationWebhookActor),
  sender: InstallationWebhookActor,
}

export const InstallationRepositoriesAdded = Schema.Struct({
  ...installationRepositoriesWebhookPayloadFields,
  repositoriesRemoved: Schema.Tuple([]),
  action: Schema.Literal("added"),
})
  .pipe(
    Schema.encodeKeys({
      repositorySelection: "repository_selection",
      repositoriesAdded: "repositories_added",
      repositoriesRemoved: "repositories_removed",
    }),
  )
  .annotate({ identifier: "InstallationRepositoriesAdded" })
export type InstallationRepositoriesAdded = typeof InstallationRepositoriesAdded.Type

export const InstallationRepositoriesRemoved = Schema.Struct({
  ...installationRepositoriesWebhookPayloadFields,
  repositoriesAdded: Schema.Tuple([]),
  action: Schema.Literal("removed"),
})
  .pipe(
    Schema.encodeKeys({
      repositorySelection: "repository_selection",
      repositoriesAdded: "repositories_added",
      repositoriesRemoved: "repositories_removed",
    }),
  )
  .annotate({ identifier: "InstallationRepositoriesRemoved" })
export type InstallationRepositoriesRemoved = typeof InstallationRepositoriesRemoved.Type

export const InstallationRepositoriesWebhookPayload = Schema.Union([
  InstallationRepositoriesAdded,
  InstallationRepositoriesRemoved,
])
  .annotate({
    identifier: "InstallationRepositoriesWebhookPayload",
    message: "Unsupported or malformed installation repositories webhook action",
  })
  .pipe(Schema.toTaggedUnion("action"))
export type InstallationRepositoriesWebhookPayload =
  typeof InstallationRepositoriesWebhookPayload.Type

export const InstallationRepositoriesWebhookEvent = Schema.Struct({
  ...BaseGitHubWebhookEvent.fields,
  name: Schema.Literal("installation_repositories"),
  payload: InstallationRepositoriesWebhookPayload,
}).annotate({ identifier: "InstallationRepositoriesWebhookEvent" })
export type InstallationRepositoriesWebhookEvent = typeof InstallationRepositoriesWebhookEvent.Type
