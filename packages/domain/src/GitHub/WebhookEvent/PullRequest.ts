import * as Schema from "effect/Schema"
import {
  GitHubCommitSha,
  GitHubInstallationIdFromStringOrNumber,
  GitHubLabelDatabaseIdFromStringOrNumber,
  GitHubLabelNodeId,
  GitHubPullRequestDatabaseIdFromStringOrNumber,
  GitHubPullRequestNodeId,
  GitHubRepositoryDatabaseIdFromStringOrNumber,
  GitHubRepositoryNodeId,
  GitHubUserDatabaseIdFromStringOrNumber,
} from "../Id.ts"
import { GitHubRepositoryFullNameFromString } from "../Repository.ts"
import { BaseGitHubWebhookEvent } from "./Base.ts"

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  identifier: "PositiveInteger",
})
const PullRequestUser = Schema.Struct({
  id: Schema.optionalKey(GitHubUserDatabaseIdFromStringOrNumber),
  login: Schema.NonEmptyString,
}).annotate({ identifier: "PullRequestUser" })

const PullRequestHead = Schema.Struct({
  sha: GitHubCommitSha,
}).annotate({ identifier: "PullRequestHead" })

const PullRequestBase = Schema.Struct({
  ref: Schema.NonEmptyString,
}).annotate({ identifier: "PullRequestBase" })

export const PullRequestLabel = Schema.Struct({
  color: Schema.optionalKey(Schema.String),
  id: GitHubLabelDatabaseIdFromStringOrNumber,
  nodeId: Schema.optionalKey(GitHubLabelNodeId),
  name: Schema.NonEmptyString,
})
  .pipe(Schema.encodeKeys({ nodeId: "node_id" }))
  .annotate({ identifier: "PullRequestLabel" })
export type PullRequestLabel = typeof PullRequestLabel.Type

export const PullRequestState = Schema.Literals(["open", "closed"]).annotate({
  identifier: "PullRequestState",
})
export type PullRequestState = typeof PullRequestState.Type

export const PullRequest = Schema.Struct({
  id: GitHubPullRequestDatabaseIdFromStringOrNumber,
  number: PositiveInteger,
  nodeId: GitHubPullRequestNodeId,
  title: Schema.NonEmptyString,
  body: Schema.Union([Schema.String, Schema.Null]),
  state: PullRequestState,
  draft: Schema.Boolean,
  merged: Schema.Boolean,
  updatedAt: Schema.DateTimeUtcFromString,
  labels: Schema.Array(PullRequestLabel),
  user: PullRequestUser,
  head: PullRequestHead,
  base: PullRequestBase,
})
  .pipe(Schema.encodeKeys({ nodeId: "node_id", updatedAt: "updated_at" }))
  .annotate({ identifier: "PullRequest" })
export type PullRequest = typeof PullRequest.Type

export const PullRequestRepository = Schema.Struct({
  id: GitHubRepositoryDatabaseIdFromStringOrNumber,
  nodeId: Schema.optionalKey(GitHubRepositoryNodeId),
  fullName: GitHubRepositoryFullNameFromString,
})
  .pipe(Schema.encodeKeys({ nodeId: "node_id", fullName: "full_name" }))
  .annotate({ identifier: "PullRequestRepository" })
export type PullRequestRepository = typeof PullRequestRepository.Type

const PullRequestInstallation = Schema.Struct({
  id: GitHubInstallationIdFromStringOrNumber,
}).annotate({ identifier: "PullRequestInstallation" })

const PullRequestSender = Schema.Struct({
  id: GitHubUserDatabaseIdFromStringOrNumber,
  login: Schema.NonEmptyString,
}).annotate({ identifier: "PullRequestSender" })

const PullRequestStringChange = Schema.Struct({
  from: Schema.String,
}).annotate({ identifier: "PullRequestStringChange" })

const PullRequestNullableStringChange = Schema.Struct({
  from: Schema.Union([Schema.String, Schema.Null]),
}).annotate({ identifier: "PullRequestNullableStringChange" })

const PullRequestBaseChange = Schema.Struct({
  ref: PullRequestStringChange,
  sha: PullRequestStringChange,
}).annotate({ identifier: "PullRequestBaseChange" })

const PullRequestChanges = Schema.Struct({
  title: Schema.optionalKey(PullRequestStringChange),
  body: Schema.optionalKey(PullRequestNullableStringChange),
  base: Schema.optionalKey(PullRequestBaseChange),
}).annotate({ identifier: "PullRequestChanges" })

export const PullRequestWebhookPayloadBase = Schema.Struct({
  pullRequest: PullRequest,
  repository: PullRequestRepository,
  installation: PullRequestInstallation,
  sender: PullRequestSender,
})

const BasePullRequestPayloadStruct = PullRequestWebhookPayloadBase.pipe(
  Schema.fieldsAssign({ number: PositiveInteger }),
)

export const BasePullRequestPayload = BasePullRequestPayloadStruct.pipe(
  Schema.encodeKeys({ pullRequest: "pull_request" }),
).annotate({ identifier: "BasePullRequestPayload" })
export type BasePullRequestPayload = typeof BasePullRequestPayload.Type

export const PullRequestOpened = BasePullRequestPayloadStruct.pipe(
  Schema.fieldsAssign({ action: Schema.Literal("opened") }),
)
  .pipe(Schema.encodeKeys({ pullRequest: "pull_request" }))
  .annotate({ identifier: "PullRequestOpened" })
export type PullRequestOpened = typeof PullRequestOpened.Type

export const PullRequestClosed = BasePullRequestPayloadStruct.pipe(
  Schema.fieldsAssign({ action: Schema.Literal("closed") }),
)
  .pipe(Schema.encodeKeys({ pullRequest: "pull_request" }))
  .annotate({ identifier: "PullRequestClosed" })
export type PullRequestClosed = typeof PullRequestClosed.Type

export const PullRequestReopened = BasePullRequestPayloadStruct.pipe(
  Schema.fieldsAssign({ action: Schema.Literal("reopened") }),
)
  .pipe(Schema.encodeKeys({ pullRequest: "pull_request" }))
  .annotate({ identifier: "PullRequestReopened" })
export type PullRequestReopened = typeof PullRequestReopened.Type

export const PullRequestSynchronized = BasePullRequestPayloadStruct.pipe(
  Schema.fieldsAssign({
    action: Schema.Literal("synchronize"),
    before: GitHubCommitSha,
    after: GitHubCommitSha,
  }),
)
  .pipe(Schema.encodeKeys({ pullRequest: "pull_request" }))
  .annotate({ identifier: "PullRequestSynchronized" })
export type PullRequestSynchronized = typeof PullRequestSynchronized.Type

export const PullRequestEdited = BasePullRequestPayloadStruct.pipe(
  Schema.fieldsAssign({
    action: Schema.Literal("edited"),
    changes: PullRequestChanges,
  }),
)
  .pipe(Schema.encodeKeys({ pullRequest: "pull_request" }))
  .annotate({ identifier: "PullRequestEdited" })
export type PullRequestEdited = typeof PullRequestEdited.Type

export const PullRequestReadyForReview = BasePullRequestPayloadStruct.pipe(
  Schema.fieldsAssign({ action: Schema.Literal("ready_for_review") }),
)
  .pipe(Schema.encodeKeys({ pullRequest: "pull_request" }))
  .annotate({ identifier: "PullRequestReadyForReview" })
export type PullRequestReadyForReview = typeof PullRequestReadyForReview.Type

export const PullRequestConvertedToDraft = BasePullRequestPayloadStruct.pipe(
  Schema.fieldsAssign({ action: Schema.Literal("converted_to_draft") }),
)
  .pipe(Schema.encodeKeys({ pullRequest: "pull_request" }))
  .annotate({ identifier: "PullRequestConvertedToDraft" })
export type PullRequestConvertedToDraft = typeof PullRequestConvertedToDraft.Type

export const PullRequestLabeled = BasePullRequestPayloadStruct.pipe(
  Schema.fieldsAssign({
    action: Schema.Literal("labeled"),
    label: PullRequestLabel,
  }),
)
  .pipe(Schema.encodeKeys({ pullRequest: "pull_request" }))
  .annotate({ identifier: "PullRequestLabeled" })
export type PullRequestLabeled = typeof PullRequestLabeled.Type

export const PullRequestUnlabeled = BasePullRequestPayloadStruct.pipe(
  Schema.fieldsAssign({
    action: Schema.Literal("unlabeled"),
    label: PullRequestLabel,
  }),
)
  .pipe(Schema.encodeKeys({ pullRequest: "pull_request" }))
  .annotate({ identifier: "PullRequestUnlabeled" })
export type PullRequestUnlabeled = typeof PullRequestUnlabeled.Type

export const PullRequestWebhookPayload = Schema.Union([
  PullRequestOpened,
  PullRequestClosed,
  PullRequestReopened,
  PullRequestSynchronized,
  PullRequestEdited,
  PullRequestReadyForReview,
  PullRequestConvertedToDraft,
  PullRequestLabeled,
  PullRequestUnlabeled,
])
  .annotate({
    identifier: "PullRequestWebhookPayload",
    message: "Unsupported or malformed pull request webhook action",
  })
  .pipe(Schema.toTaggedUnion("action"))
export type PullRequestWebhookPayload = typeof PullRequestWebhookPayload.Type

export const PullRequestWebhookEvent = BaseGitHubWebhookEvent.pipe(
  Schema.fieldsAssign({
    name: Schema.Literal("pull_request"),
    payload: PullRequestWebhookPayload,
  }),
).annotate({ identifier: "PullRequestWebhookEvent" })
export type PullRequestWebhookEvent = typeof PullRequestWebhookEvent.Type
