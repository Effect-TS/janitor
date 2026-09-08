import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"

const GitHubDatabaseIdString = Schema.NonEmptyString.check(
  Schema.isPattern(/^[1-9][0-9]*$/),
).annotate({ identifier: "GitHubDatabaseIdString" })

const GitHubDatabaseIdNumber = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  identifier: "GitHubDatabaseIdNumber",
})

export const GitHubAccountDatabaseId = GitHubDatabaseIdString.pipe(
  Schema.brand("GitHubAccountDatabaseId"),
).annotate({ identifier: "GitHubAccountDatabaseId" })
export type GitHubAccountDatabaseId = typeof GitHubAccountDatabaseId.Type

export const GitHubAccountDatabaseIdFromNumber = GitHubDatabaseIdNumber.pipe(
  Schema.decodeTo(GitHubDatabaseIdString, SchemaTransformation.numberFromString.flip()),
  Schema.brand("GitHubAccountDatabaseId"),
).annotate({ identifier: "GitHubAccountDatabaseIdFromNumber" })

export const GitHubAccountDatabaseIdFromStringOrNumber = Schema.Union([
  GitHubAccountDatabaseIdFromNumber,
  GitHubAccountDatabaseId,
]).annotate({ identifier: "GitHubAccountDatabaseIdFromStringOrNumber" })

export const GitHubInstallationId = GitHubDatabaseIdString.pipe(
  Schema.brand("GitHubInstallationId"),
).annotate({ identifier: "GitHubInstallationId" })
export type GitHubInstallationId = typeof GitHubInstallationId.Type

export const GitHubInstallationIdFromNumber = GitHubDatabaseIdNumber.pipe(
  Schema.decodeTo(GitHubDatabaseIdString, SchemaTransformation.numberFromString.flip()),
  Schema.brand("GitHubInstallationId"),
).annotate({ identifier: "GitHubInstallationIdFromNumber" })

export const GitHubInstallationIdFromStringOrNumber = Schema.Union([
  GitHubInstallationIdFromNumber,
  GitHubInstallationId,
]).annotate({ identifier: "GitHubInstallationIdFromStringOrNumber" })

export const GitHubRepositoryDatabaseId = GitHubDatabaseIdString.pipe(
  Schema.brand("GitHubRepositoryDatabaseId"),
).annotate({ identifier: "GitHubRepositoryDatabaseId" })
export type GitHubRepositoryDatabaseId = typeof GitHubRepositoryDatabaseId.Type

export const GitHubRepositoryDatabaseIdFromNumber = GitHubDatabaseIdNumber.pipe(
  Schema.decodeTo(GitHubDatabaseIdString, SchemaTransformation.numberFromString.flip()),
  Schema.brand("GitHubRepositoryDatabaseId"),
).annotate({ identifier: "GitHubRepositoryDatabaseIdFromNumber" })

export const GitHubRepositoryDatabaseIdFromStringOrNumber = Schema.Union([
  GitHubRepositoryDatabaseIdFromNumber,
  GitHubRepositoryDatabaseId,
]).annotate({ identifier: "GitHubRepositoryDatabaseIdFromStringOrNumber" })

export const GitHubUserDatabaseId = GitHubDatabaseIdString.pipe(
  Schema.brand("GitHubUserDatabaseId"),
).annotate({ identifier: "GitHubUserDatabaseId" })
export type GitHubUserDatabaseId = typeof GitHubUserDatabaseId.Type

export const GitHubUserDatabaseIdFromNumber = GitHubDatabaseIdNumber.pipe(
  Schema.decodeTo(GitHubDatabaseIdString, SchemaTransformation.numberFromString.flip()),
  Schema.brand("GitHubUserDatabaseId"),
).annotate({ identifier: "GitHubUserDatabaseIdFromNumber" })

export const GitHubUserDatabaseIdFromStringOrNumber = Schema.Union([
  GitHubUserDatabaseIdFromNumber,
  GitHubUserDatabaseId,
]).annotate({ identifier: "GitHubUserDatabaseIdFromStringOrNumber" })

export const GitHubIssueDatabaseId = GitHubDatabaseIdString.pipe(
  Schema.brand("GitHubIssueDatabaseId"),
).annotate({ identifier: "GitHubIssueDatabaseId" })
export type GitHubIssueDatabaseId = typeof GitHubIssueDatabaseId.Type

export const GitHubIssueDatabaseIdFromNumber = GitHubDatabaseIdNumber.pipe(
  Schema.decodeTo(GitHubDatabaseIdString, SchemaTransformation.numberFromString.flip()),
  Schema.brand("GitHubIssueDatabaseId"),
).annotate({ identifier: "GitHubIssueDatabaseIdFromNumber" })

export const GitHubIssueDatabaseIdFromStringOrNumber = Schema.Union([
  GitHubIssueDatabaseIdFromNumber,
  GitHubIssueDatabaseId,
]).annotate({ identifier: "GitHubIssueDatabaseIdFromStringOrNumber" })

export const GitHubPullRequestDatabaseId = GitHubDatabaseIdString.pipe(
  Schema.brand("GitHubPullRequestDatabaseId"),
).annotate({ identifier: "GitHubPullRequestDatabaseId" })
export type GitHubPullRequestDatabaseId = typeof GitHubPullRequestDatabaseId.Type

export const GitHubPullRequestDatabaseIdFromNumber = GitHubDatabaseIdNumber.pipe(
  Schema.decodeTo(GitHubDatabaseIdString, SchemaTransformation.numberFromString.flip()),
  Schema.brand("GitHubPullRequestDatabaseId"),
).annotate({ identifier: "GitHubPullRequestDatabaseIdFromNumber" })

export const GitHubPullRequestDatabaseIdFromStringOrNumber = Schema.Union([
  GitHubPullRequestDatabaseIdFromNumber,
  GitHubPullRequestDatabaseId,
]).annotate({ identifier: "GitHubPullRequestDatabaseIdFromStringOrNumber" })

export const GitHubPullRequestReviewDatabaseId = GitHubDatabaseIdString.pipe(
  Schema.brand("GitHubPullRequestReviewDatabaseId"),
).annotate({ identifier: "GitHubPullRequestReviewDatabaseId" })
export type GitHubPullRequestReviewDatabaseId = typeof GitHubPullRequestReviewDatabaseId.Type

export const GitHubPullRequestReviewDatabaseIdFromNumber = GitHubDatabaseIdNumber.pipe(
  Schema.decodeTo(GitHubDatabaseIdString, SchemaTransformation.numberFromString.flip()),
  Schema.brand("GitHubPullRequestReviewDatabaseId"),
).annotate({ identifier: "GitHubPullRequestReviewDatabaseIdFromNumber" })

export const GitHubPullRequestReviewDatabaseIdFromStringOrNumber = Schema.Union([
  GitHubPullRequestReviewDatabaseIdFromNumber,
  GitHubPullRequestReviewDatabaseId,
]).annotate({ identifier: "GitHubPullRequestReviewDatabaseIdFromStringOrNumber" })

export const GitHubLabelDatabaseId = GitHubDatabaseIdString.pipe(
  Schema.brand("GitHubLabelDatabaseId"),
).annotate({ identifier: "GitHubLabelDatabaseId" })
export type GitHubLabelDatabaseId = typeof GitHubLabelDatabaseId.Type

export const GitHubLabelDatabaseIdFromNumber = GitHubDatabaseIdNumber.pipe(
  Schema.decodeTo(GitHubDatabaseIdString, SchemaTransformation.numberFromString.flip()),
  Schema.brand("GitHubLabelDatabaseId"),
).annotate({ identifier: "GitHubLabelDatabaseIdFromNumber" })

export const GitHubLabelDatabaseIdFromStringOrNumber = Schema.Union([
  GitHubLabelDatabaseIdFromNumber,
  GitHubLabelDatabaseId,
]).annotate({ identifier: "GitHubLabelDatabaseIdFromStringOrNumber" })

export const GitHubCommitStatusDatabaseId = GitHubDatabaseIdString.pipe(
  Schema.brand("GitHubCommitStatusDatabaseId"),
).annotate({ identifier: "GitHubCommitStatusDatabaseId" })
export type GitHubCommitStatusDatabaseId = typeof GitHubCommitStatusDatabaseId.Type

export const GitHubCommitStatusDatabaseIdFromNumber = GitHubDatabaseIdNumber.pipe(
  Schema.decodeTo(GitHubDatabaseIdString, SchemaTransformation.numberFromString.flip()),
  Schema.brand("GitHubCommitStatusDatabaseId"),
).annotate({ identifier: "GitHubCommitStatusDatabaseIdFromNumber" })

export const GitHubCommitStatusDatabaseIdFromStringOrNumber = Schema.Union([
  GitHubCommitStatusDatabaseIdFromNumber,
  GitHubCommitStatusDatabaseId,
]).annotate({ identifier: "GitHubCommitStatusDatabaseIdFromStringOrNumber" })

export const GitHubWebhookHookId = GitHubDatabaseIdString.pipe(
  Schema.brand("GitHubWebhookHookId"),
).annotate({ identifier: "GitHubWebhookHookId" })
export type GitHubWebhookHookId = typeof GitHubWebhookHookId.Type

export const GitHubWebhookHookIdFromNumber = GitHubDatabaseIdNumber.pipe(
  Schema.decodeTo(GitHubDatabaseIdString, SchemaTransformation.numberFromString.flip()),
  Schema.brand("GitHubWebhookHookId"),
).annotate({ identifier: "GitHubWebhookHookIdFromNumber" })

export const GitHubWebhookHookIdFromStringOrNumber = Schema.Union([
  GitHubWebhookHookIdFromNumber,
  GitHubWebhookHookId,
]).annotate({ identifier: "GitHubWebhookHookIdFromStringOrNumber" })

const GitHubNodeIdString = Schema.NonEmptyString

export const GitHubRepositoryNodeId = GitHubNodeIdString.pipe(
  Schema.brand("GitHubRepositoryNodeId"),
).annotate({ identifier: "GitHubRepositoryNodeId" })
export type GitHubRepositoryNodeId = typeof GitHubRepositoryNodeId.Type

export const GitHubLabelNodeId = GitHubNodeIdString.pipe(
  Schema.brand("GitHubLabelNodeId"),
).annotate({ identifier: "GitHubLabelNodeId" })
export type GitHubLabelNodeId = typeof GitHubLabelNodeId.Type

export const GitHubEntityNodeId = GitHubNodeIdString.pipe(
  Schema.brand("GitHubEntityNodeId"),
).annotate({ identifier: "GitHubEntityNodeId" })
export type GitHubEntityNodeId = typeof GitHubEntityNodeId.Type

export const GitHubPullRequestNodeId = GitHubNodeIdString.pipe(
  Schema.brand("GitHubPullRequestNodeId"),
).annotate({ identifier: "GitHubPullRequestNodeId" })
export type GitHubPullRequestNodeId = typeof GitHubPullRequestNodeId.Type

export const GitHubPullRequestReviewNodeId = GitHubNodeIdString.pipe(
  Schema.brand("GitHubPullRequestReviewNodeId"),
).annotate({ identifier: "GitHubPullRequestReviewNodeId" })
export type GitHubPullRequestReviewNodeId = typeof GitHubPullRequestReviewNodeId.Type

export const GitHubWebhookDeliveryId = Schema.NonEmptyString.pipe(
  Schema.brand("GitHubWebhookDeliveryId"),
).annotate({ identifier: "GitHubWebhookDeliveryId" })
export type GitHubWebhookDeliveryId = typeof GitHubWebhookDeliveryId.Type

export const GitHubCommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/i))
  .pipe(Schema.brand("GitHubCommitSha"))
  .annotate({ identifier: "GitHubCommitSha" })
export type GitHubCommitSha = typeof GitHubCommitSha.Type
