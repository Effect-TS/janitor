import * as Schema from "effect/Schema"
import {
  GitHubAccountDatabaseId,
  GitHubEntityNodeId,
  GitHubInstallationId,
  GitHubIssueDatabaseId,
  GitHubLabelDatabaseId,
  GitHubLabelNodeId,
  GitHubPullRequestDatabaseId,
  GitHubPullRequestNodeId,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryNodeId,
  GitHubUserDatabaseId,
} from "./Id.ts"
import { GitHubAccountType, GitHubInstallationRepositorySelection } from "./Installation.ts"
import { GitHubRepositoryFullName } from "./Repository.ts"
import { GitHubWebhookJournalSequence } from "./WebhookJournal.ts"

/**
 * Local mirror rows. Stable GitHub IDs are identity; names and handles are
 * mutable attributes. `projectedSequence` is the journal sequence of the last
 * delivery applied, and `githubUpdatedAt` is GitHub's own update clock. Both
 * fence projection writes so an older observation never overwrites a newer one.
 */

export const GitHubInstallationStatus = Schema.Literals([
  "active",
  "suspended",
  "deleted",
]).annotate({ identifier: "GitHubInstallationStatus" })
export type GitHubInstallationStatus = typeof GitHubInstallationStatus.Type

export const GitHubInstallationRecord = Schema.Struct({
  installationId: GitHubInstallationId,
  accountDatabaseId: GitHubAccountDatabaseId,
  accountHandle: Schema.NonEmptyString,
  accountType: GitHubAccountType,
  repositorySelection: GitHubInstallationRepositorySelection,
  status: GitHubInstallationStatus,
  htmlUrl: Schema.NonEmptyString,
  projectedSequence: GitHubWebhookJournalSequence,
  observedAt: Schema.DateTimeUtc,
}).annotate({ identifier: "GitHubInstallationRecord" })
export type GitHubInstallationRecord = typeof GitHubInstallationRecord.Type

/**
 * `suspect` means an inventory scan did not list the repository or the
 * installation was suspended; `lost` means GitHub explicitly removed access.
 * Neither proves deletion.
 */
export const GitHubRepositoryAccess = Schema.Literals(["accessible", "suspect", "lost"]).annotate({
  identifier: "GitHubRepositoryAccess",
})
export type GitHubRepositoryAccess = typeof GitHubRepositoryAccess.Type

export const GitHubRepositoryRecord = Schema.Struct({
  repositoryId: GitHubRepositoryDatabaseId,
  nodeId: Schema.NullOr(GitHubRepositoryNodeId),
  installationId: GitHubInstallationId,
  owner: GitHubRepositoryFullName.fields.owner,
  repo: GitHubRepositoryFullName.fields.repo,
  /** Null until an inventory or repository event states it. */
  isPrivate: Schema.NullOr(Schema.Boolean),
  access: GitHubRepositoryAccess,
  enabled: Schema.Boolean,
  projectedSequence: GitHubWebhookJournalSequence,
  observedAt: Schema.DateTimeUtc,
}).annotate({ identifier: "GitHubRepositoryRecord" })
export type GitHubRepositoryRecord = typeof GitHubRepositoryRecord.Type

export const GitHubLabelAvailability = Schema.Literals([
  "available",
  "suspect",
  "unavailable",
]).annotate({ identifier: "GitHubLabelAvailability" })
export type GitHubLabelAvailability = typeof GitHubLabelAvailability.Type

export const GitHubLabelRecord = Schema.Struct({
  color: Schema.optionalKey(Schema.NullOr(Schema.String)),
  repositoryId: GitHubRepositoryDatabaseId,
  labelId: GitHubLabelDatabaseId,
  nodeId: Schema.NullOr(GitHubLabelNodeId),
  /** Empty once content was purged after access loss; identity remains. */
  name: Schema.String,
  availability: GitHubLabelAvailability,
  projectedSequence: GitHubWebhookJournalSequence,
  observedAt: Schema.DateTimeUtc,
}).annotate({ identifier: "GitHubLabelRecord" })
export type GitHubLabelRecord = typeof GitHubLabelRecord.Type

export const GitHubEntityKind = Schema.Literals(["issue", "pull_request"]).annotate({
  identifier: "GitHubEntityKind",
})
export type GitHubEntityKind = typeof GitHubEntityKind.Type

export const GitHubEntityState = Schema.Literals(["open", "closed"]).annotate({
  identifier: "GitHubEntityState",
})
export type GitHubEntityState = typeof GitHubEntityState.Type

/**
 * Issues and pull requests share this row, keyed by repository and number.
 * Webhooks for pull requests do not carry the issue-side IDs, so those are
 * null until a scan binds them.
 */
export const GitHubEntityRecord = Schema.Struct({
  repositoryId: GitHubRepositoryDatabaseId,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  kind: GitHubEntityKind,
  /** Canonical issue-side IDs, bound by scans. Null when only a pull request webhook was seen. */
  issueId: Schema.NullOr(GitHubIssueDatabaseId),
  issueNodeId: Schema.NullOr(GitHubEntityNodeId),
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  authorLogin: Schema.NonEmptyString,
  authorId: Schema.NullOr(GitHubUserDatabaseId),
  state: GitHubEntityState,
  githubUpdatedAt: Schema.DateTimeUtc,
  projectedSequence: GitHubWebhookJournalSequence,
  observedAt: Schema.DateTimeUtc,
}).annotate({ identifier: "GitHubEntityRecord" })
export type GitHubEntityRecord = typeof GitHubEntityRecord.Type

export const GitHubPullRequestRecord = Schema.Struct({
  repositoryId: GitHubRepositoryDatabaseId,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  pullRequestId: GitHubPullRequestDatabaseId,
  pullRequestNodeId: GitHubPullRequestNodeId,
  baseRef: Schema.NonEmptyString,
  draft: Schema.Boolean,
  headSha: Schema.String,
  merged: Schema.Boolean,
}).annotate({ identifier: "GitHubPullRequestRecord" })
export type GitHubPullRequestRecord = typeof GitHubPullRequestRecord.Type

export const GitHubEntityLabelRecord = Schema.Struct({
  repositoryId: GitHubRepositoryDatabaseId,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  labelId: GitHubLabelDatabaseId,
}).annotate({ identifier: "GitHubEntityLabelRecord" })
export type GitHubEntityLabelRecord = typeof GitHubEntityLabelRecord.Type
