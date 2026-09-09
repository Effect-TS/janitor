import * as Schema from "effect/Schema"
import { PingWebhookEvent } from "./WebhookEvent/Ping.ts"
import {
  InstallationRepositoriesWebhookEvent,
  InstallationWebhookEvent,
} from "./WebhookEvent/Installation.ts"
import { PullRequestWebhookEvent } from "./WebhookEvent/PullRequest.ts"
import { PullRequestReviewWebhookEvent } from "./WebhookEvent/PullRequestReview.ts"
import { CheckRunWebhookEvent } from "./WebhookEvent/CheckRun.ts"
import { CheckSuiteWebhookEvent } from "./WebhookEvent/CheckSuite.ts"
import { CommitStatusWebhookEvent } from "./WebhookEvent/CommitStatus.ts"
import { IssueWebhookEvent } from "./WebhookEvent/Issue.ts"
import { GitHubInstallationRepository } from "./Installation.ts"
import { BaseGitHubWebhookEvent } from "./WebhookEvent/Base.ts"

const RepositoryWebhookEvent = Schema.Struct({
  ...BaseGitHubWebhookEvent.fields,
  name: Schema.Literal("repository"),
  payload: Schema.Struct({
    action: Schema.Literals(["renamed", "transferred", "publicized", "privatized"]),
    repository: GitHubInstallationRepository,
  }),
})

export const GitHubWebhookEvent = Schema.Union([
  PingWebhookEvent,
  InstallationWebhookEvent,
  InstallationRepositoriesWebhookEvent,
  PullRequestWebhookEvent,
  IssueWebhookEvent,
  PullRequestReviewWebhookEvent,
  CheckRunWebhookEvent,
  CheckSuiteWebhookEvent,
  CommitStatusWebhookEvent,
  RepositoryWebhookEvent,
])
  .annotate({ identifier: "GitHubWebhookEvent" })
  .pipe(Schema.toTaggedUnion("name"))
export type GitHubWebhookEvent = typeof GitHubWebhookEvent.Type

export const GitHubWebhookEventName = Schema.Literals(GitHubWebhookEvent.discriminants).annotate({
  identifier: "GitHubWebhookEventName",
})
export type GitHubWebhookEventName = typeof GitHubWebhookEventName.Type
