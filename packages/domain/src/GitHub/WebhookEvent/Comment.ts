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
export const IssueCommentWebhookEvent = Schema.Struct({
  ...BaseGitHubWebhookEvent.fields,
  name: Schema.Literal("issue_comment"),
  payload: Schema.Struct({
    ...payload,
    issue: Schema.Struct({ number: Schema.Int, pull_request: Schema.optionalKey(Schema.Unknown) }),
  }),
})
