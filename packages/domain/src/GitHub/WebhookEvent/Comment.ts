import * as Schema from "effect/Schema"
import { BaseGitHubWebhookEvent } from "./Base.ts"
import {
  GitHubCommentDatabaseIdFromStringOrNumber as CommentId,
  GitHubRepositoryDatabaseIdFromStringOrNumber as RepositoryId,
  GitHubUserDatabaseIdFromStringOrNumber as UserId,
} from "../Id.ts"

const Comment = Schema.Struct({
  id: CommentId,
  body: Schema.String,
  user: Schema.Struct({ id: UserId, login: Schema.String, type: Schema.String }),
  pull_request_review_id: Schema.optionalKey(Schema.NullOr(CommentId)),
  in_reply_to_id: Schema.optionalKey(Schema.NullOr(CommentId)),
})
const payload = {
  action: Schema.Literals(["created", "edited", "deleted"]),
  repository: Schema.Struct({ id: RepositoryId }),
  comment: Comment,
}
export const PullRequestReviewCommentWebhookEvent = Schema.Struct({
  ...BaseGitHubWebhookEvent.fields,
  name: Schema.Literal("pull_request_review_comment"),
  payload: Schema.Struct({ ...payload, pull_request: Schema.Struct({ number: Schema.Int }) }),
})
export const IssueCommentPayload = Schema.Struct({
  ...payload,
  repository: Schema.Struct({ id: RepositoryId, private: Schema.optionalKey(Schema.Boolean) }),
  issue: Schema.Struct({
    number: Schema.Int,
    /** Set when the issue is a pull request. */
    pull_request: Schema.optionalKey(Schema.Unknown),
    state: Schema.optionalKey(Schema.Literals(["open", "closed"])),
    draft: Schema.optionalKey(Schema.Boolean),
  }),
})
export type IssueCommentPayload = typeof IssueCommentPayload.Type
export const IssueCommentWebhookEvent = Schema.Struct({
  ...BaseGitHubWebhookEvent.fields,
  name: Schema.Literal("issue_comment"),
  payload: IssueCommentPayload,
})
