import * as Schema from "effect/Schema"
import {
  GitHubCommitSha,
  GitHubEntityNodeId,
  GitHubInstallationId,
  GitHubIssueDatabaseIdFromStringOrNumber,
  GitHubLabelDatabaseIdFromStringOrNumber,
  GitHubLabelNodeId,
  GitHubPullRequestDatabaseIdFromStringOrNumber,
  GitHubPullRequestNodeId,
  GitHubUserDatabaseIdFromStringOrNumber,
} from "./Id.ts"

export const GITHUB_API_BASE_URL = "https://api.github.com"
export const GITHUB_API_VERSION = "2022-11-28"
/** GitHub rejects requests without a User-Agent with 403. Workers do not add one. */
export const GITHUB_USER_AGENT = "janitor"

/** Which credential a request uses. Cache keys and rate budgets are scoped by it. */
export const GitHubApiScope = Schema.Union([
  Schema.TaggedStruct("App", {}),
  Schema.TaggedStruct("Installation", { installationId: GitHubInstallationId }),
]).annotate({ identifier: "GitHubApiScope" })
export type GitHubApiScope = typeof GitHubApiScope.Type

export const gitHubApiScopeKey = (scope: GitHubApiScope): string =>
  scope._tag === "App" ? "app" : `installation:${scope.installationId}`

/**
 * Highest first. Mutation verification and webhook refresh keep a reserve
 * that background work may not consume.
 */
export const GitHubRequestPriority = Schema.Literals(["foreground", "background"]).annotate({
  identifier: "GitHubRequestPriority",
})
export type GitHubRequestPriority = typeof GitHubRequestPriority.Type

export const GitHubInstallationAccessToken = Schema.Struct({
  token: Schema.RedactedFromValue(Schema.NonEmptyString),
  expiresAt: Schema.DateTimeUtcFromString,
})
  .pipe(Schema.encodeKeys({ expiresAt: "expires_at" }))
  .annotate({ identifier: "GitHubInstallationAccessToken" })
export type GitHubInstallationAccessToken = typeof GitHubInstallationAccessToken.Type

const HeaderInt = Schema.FiniteFromString.check(Schema.isInt())

/** Rate limit state as reported on one response. Absent headers stay absent. */
export const GitHubRateLimitHeaders = Schema.Struct({
  "x-ratelimit-limit": Schema.optional(HeaderInt),
  "x-ratelimit-remaining": Schema.optional(HeaderInt),
  "x-ratelimit-used": Schema.optional(HeaderInt),
  /** Unix seconds. */
  "x-ratelimit-reset": Schema.optional(HeaderInt),
  "x-ratelimit-resource": Schema.optional(Schema.String),
  "x-github-request-id": Schema.optional(Schema.String),
  /** Seconds. GitHub sends it on secondary limit responses. */
  "retry-after": Schema.optional(HeaderInt),
  etag: Schema.optional(Schema.String),
  link: Schema.optional(Schema.String),
}).annotate({ identifier: "GitHubRateLimitHeaders" })
export type GitHubRateLimitHeaders = typeof GitHubRateLimitHeaders.Type

const ApiUser = Schema.Struct({
  id: GitHubUserDatabaseIdFromStringOrNumber,
  login: Schema.NonEmptyString,
}).annotate({ identifier: "GitHubApiUser" })

export const GitHubLabelApi = Schema.Struct({
  id: GitHubLabelDatabaseIdFromStringOrNumber,
  nodeId: GitHubLabelNodeId,
  name: Schema.NonEmptyString,
})
  .pipe(Schema.encodeKeys({ nodeId: "node_id" }))
  .annotate({ identifier: "GitHubLabelApi" })
export type GitHubLabelApi = typeof GitHubLabelApi.Type

export const GitHubIssueState = Schema.Literals(["open", "closed"]).annotate({
  identifier: "GitHubIssueState",
})

/**
 * One item from the issues listing. Pull requests appear here too, marked by
 * the `pull_request` key; their issue-side IDs are the canonical entity IDs.
 */
export const GitHubIssueApi = Schema.Struct({
  id: GitHubIssueDatabaseIdFromStringOrNumber,
  nodeId: GitHubEntityNodeId,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  state: GitHubIssueState,
  user: Schema.NullOr(ApiUser),
  labels: Schema.Array(GitHubLabelApi),
  updatedAt: Schema.DateTimeUtcFromString,
  pullRequest: Schema.optionalKey(Schema.Struct({ url: Schema.String })),
})
  .pipe(
    Schema.encodeKeys({ nodeId: "node_id", updatedAt: "updated_at", pullRequest: "pull_request" }),
  )
  .annotate({ identifier: "GitHubIssueApi" })
export type GitHubIssueApi = typeof GitHubIssueApi.Type

export const GitHubPullRequestApi = Schema.Struct({
  id: GitHubPullRequestDatabaseIdFromStringOrNumber,
  nodeId: GitHubPullRequestNodeId,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  state: GitHubIssueState,
  // Optional so persisted activities from before bulk PR projection still decode.
  title: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.NullOr(Schema.String)),
  user: Schema.optionalKey(Schema.NullOr(ApiUser)),
  labels: Schema.optionalKey(Schema.Array(GitHubLabelApi)),
  draft: Schema.Boolean,
  /** Present on the single pull request endpoint; the list omits it. */
  merged: Schema.optionalKey(Schema.Boolean),
  mergedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  updatedAt: Schema.DateTimeUtcFromString,
  head: Schema.Struct({ sha: GitHubCommitSha }),
  base: Schema.Struct({ ref: Schema.NonEmptyString }),
})
  .pipe(Schema.encodeKeys({ nodeId: "node_id", mergedAt: "merged_at", updatedAt: "updated_at" }))
  .annotate({ identifier: "GitHubPullRequestApi" })
export type GitHubPullRequestApi = typeof GitHubPullRequestApi.Type

/** One changed file from the pull request files listing. */
export const GitHubPullRequestFileApi = Schema.Struct({
  filename: Schema.NonEmptyString,
  status: Schema.String,
}).annotate({ identifier: "GitHubPullRequestFileApi" })
export type GitHubPullRequestFileApi = typeof GitHubPullRequestFileApi.Type

/** The check runs listing for a commit; state folds conclusion over status. */
export const GitHubCheckRunApi = Schema.Struct({
  name: Schema.NonEmptyString,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
}).annotate({ identifier: "GitHubCheckRunApi" })
export type GitHubCheckRunApi = typeof GitHubCheckRunApi.Type

export const GitHubCheckRunsApi = Schema.Struct({
  checkRuns: Schema.Array(GitHubCheckRunApi),
})
  .pipe(Schema.encodeKeys({ checkRuns: "check_runs" }))
  .annotate({ identifier: "GitHubCheckRunsApi" })
export type GitHubCheckRunsApi = typeof GitHubCheckRunsApi.Type

/** One review from the pull request reviews listing. */
export const GitHubPullRequestReviewApi = Schema.Struct({
  id: Schema.Int,
  user: Schema.NullOr(ApiUser),
  state: Schema.String,
}).annotate({ identifier: "GitHubPullRequestReviewApi" })
export type GitHubPullRequestReviewApi = typeof GitHubPullRequestReviewApi.Type
