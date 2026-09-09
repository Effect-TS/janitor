import * as Schema from "effect/Schema"
import { GitHubIssueApi } from "../Api.ts"
import { BaseGitHubWebhookEvent } from "./Base.ts"
import { PullRequestWebhookPayloadBase } from "./PullRequest.ts"

export const IssueWebhookEvent = Schema.Struct({
  ...BaseGitHubWebhookEvent.fields,
  name: Schema.Literal("issues"),
  payload: Schema.Struct({
    action: Schema.String,
    issue: GitHubIssueApi,
    repository: PullRequestWebhookPayloadBase.fields.repository,
    installation: PullRequestWebhookPayloadBase.fields.installation,
  }),
})
