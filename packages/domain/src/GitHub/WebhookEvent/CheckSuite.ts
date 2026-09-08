import * as Schema from "effect/Schema"
import { GitHubCommitSha } from "../Id.ts"
import { BaseGitHubWebhookEvent } from "./Base.ts"
import { PullRequestWebhookPayloadBase } from "./PullRequest.ts"

const Payload = Schema.Struct({
  action: Schema.Literals(["requested", "rerequested", "completed"]),
  check_suite: Schema.Struct({
    head_sha: GitHubCommitSha,
    pull_requests: Schema.optionalKey(Schema.Array(Schema.Struct({ number: Schema.Int }))),
  }),
  repository: PullRequestWebhookPayloadBase.fields.repository,
  installation: PullRequestWebhookPayloadBase.fields.installation,
})

export const CheckSuiteWebhookEvent = Schema.Struct({
  ...BaseGitHubWebhookEvent.fields,
  name: Schema.Literal("check_suite"),
  payload: Payload,
})
export type CheckSuiteWebhookEvent = typeof CheckSuiteWebhookEvent.Type
