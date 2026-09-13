import * as Schema from "effect/Schema"
import { BaseGitHubWebhookEvent } from "./Base.ts"
import { GitHubUserDatabaseIdFromStringOrNumber as Id } from "../Id.ts"

const Comment = Schema.Struct({
  id: Id,
  body: Schema.String,
  user: Schema.Struct({ id: Id, login: Schema.String, type: Schema.String }),
  pull_request_review_id: Schema.optionalKey(Schema.NullOr(Id)),
  in_reply_to_id: Schema.optionalKey(Schema.NullOr(Id)),
})
const payload = {
  action: Schema.Literals(["created", "edited", "deleted"]),
  repository: Schema.Struct({ id: Id }),
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
