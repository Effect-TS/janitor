import * as Schema from "effect/Schema"
import {
  GitHubCommitSha,
  GitHubPullRequestReviewDatabaseIdFromStringOrNumber,
  GitHubPullRequestReviewNodeId,
  GitHubUserDatabaseIdFromStringOrNumber,
} from "../Id.ts"
import { BaseGitHubWebhookEvent } from "./Base.ts"
import { PullRequestWebhookPayloadBase } from "./PullRequest.ts"

const PullRequestReviewUser = Schema.Struct({
  id: GitHubUserDatabaseIdFromStringOrNumber,
  login: Schema.NonEmptyString,
}).annotate({ identifier: "PullRequestReviewUser" })

const pullRequestReviewFields = {
  id: GitHubPullRequestReviewDatabaseIdFromStringOrNumber,
  nodeId: GitHubPullRequestReviewNodeId,
  user: PullRequestReviewUser,
  body: Schema.Union([Schema.String, Schema.Null]),
  commitId: GitHubCommitSha,
  submittedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  state: Schema.Literals(["commented", "changes_requested", "approved", "dismissed"]),
}
const PullRequestReviewStruct = Schema.Struct(pullRequestReviewFields)

export const PullRequestReview = PullRequestReviewStruct.pipe(
  Schema.encodeKeys({
    nodeId: "node_id",
    commitId: "commit_id",
    submittedAt: "submitted_at",
  }),
).annotate({ identifier: "PullRequestReview" })
export type PullRequestReview = typeof PullRequestReview.Type

const SubmittedPullRequestReview = PullRequestReviewStruct.pipe(
  Schema.fieldsAssign({
    state: Schema.Literals(["commented", "changes_requested", "approved"]),
  }),
  Schema.encodeKeys({
    nodeId: "node_id",
    commitId: "commit_id",
    submittedAt: "submitted_at",
  }),
).annotate({ identifier: "SubmittedPullRequestReview" })

const DismissedPullRequestReview = PullRequestReviewStruct.pipe(
  Schema.fieldsAssign({ state: Schema.Literal("dismissed") }),
  Schema.encodeKeys({
    nodeId: "node_id",
    commitId: "commit_id",
    submittedAt: "submitted_at",
  }),
).annotate({ identifier: "DismissedPullRequestReview" })

const PullRequestReviewChanges = Schema.Struct({
  body: Schema.optionalKey(
    Schema.Struct({
      from: Schema.String,
    }),
  ),
}).annotate({ identifier: "PullRequestReviewChanges" })

const PullRequestReviewPayloadBase = PullRequestWebhookPayloadBase.pipe(
  Schema.fieldsAssign({ review: PullRequestReview }),
)

export const PullRequestReviewSubmitted = PullRequestReviewPayloadBase.pipe(
  Schema.fieldsAssign({
    action: Schema.Literal("submitted"),
    review: SubmittedPullRequestReview,
  }),
  Schema.encodeKeys({ pullRequest: "pull_request" }),
).annotate({ identifier: "PullRequestReviewSubmitted" })
export type PullRequestReviewSubmitted = typeof PullRequestReviewSubmitted.Type

export const PullRequestReviewEdited = PullRequestReviewPayloadBase.pipe(
  Schema.fieldsAssign({
    action: Schema.Literal("edited"),
    changes: PullRequestReviewChanges,
  }),
  Schema.encodeKeys({ pullRequest: "pull_request" }),
).annotate({ identifier: "PullRequestReviewEdited" })
export type PullRequestReviewEdited = typeof PullRequestReviewEdited.Type

export const PullRequestReviewDismissed = PullRequestReviewPayloadBase.pipe(
  Schema.fieldsAssign({
    action: Schema.Literal("dismissed"),
    review: DismissedPullRequestReview,
  }),
  Schema.encodeKeys({ pullRequest: "pull_request" }),
).annotate({ identifier: "PullRequestReviewDismissed" })
export type PullRequestReviewDismissed = typeof PullRequestReviewDismissed.Type

export const PullRequestReviewWebhookPayload = Schema.Union([
  PullRequestReviewSubmitted,
  PullRequestReviewEdited,
  PullRequestReviewDismissed,
])
  .annotate({
    identifier: "PullRequestReviewWebhookPayload",
    message: "Unsupported or malformed pull request review webhook action",
  })
  .pipe(Schema.toTaggedUnion("action"))
export type PullRequestReviewWebhookPayload = typeof PullRequestReviewWebhookPayload.Type

export const PullRequestReviewWebhookEvent = BaseGitHubWebhookEvent.pipe(
  Schema.fieldsAssign({
    name: Schema.Literal("pull_request_review"),
    payload: PullRequestReviewWebhookPayload,
  }),
).annotate({ identifier: "PullRequestReviewWebhookEvent" })
export type PullRequestReviewWebhookEvent = typeof PullRequestReviewWebhookEvent.Type
