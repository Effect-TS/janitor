import { PATCH_BYTES, TreeEntry } from "./Patch.ts"
import { GitHubIssueApi } from "@janitor/domain/GitHub/Api"
import { GitHubUserDatabaseIdFromStringOrNumber } from "@janitor/domain/GitHub/Id"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { SyncActivityError, type SyncRateLimited } from "../GitHub/SyncSupport.ts"
import type { GitHubTransport } from "../GitHub/Transport.ts"
import { get, type RepositoryTarget, repositoryPath, type Waits } from "../Labeling/GitHubIssue.ts"

/**
 * Evidence a review run reads from GitHub (ADR 0007): the default branch and
 * its current commit, the issue with its comments, and other issues and
 * pull requests of the same repository. Every operation is typed and bound
 * to the repository the run belongs to; the model names numbers and search
 * terms, never repositories or URLs. Everything here is evidence, so sizes
 * are bounded before anything reaches a prompt or a database row.
 */

const ISSUE_BODY_LIMIT = 20_000
const COMMENT_LIMIT = 4_000
const SNIPPET_LIMIT = 600
const SEARCH_LIMIT = 10
const COMMENT_PAGE = 100

const RepositoryApi = Schema.Struct({
  id: Schema.Int,
  defaultBranch: Schema.String,
}).pipe(Schema.encodeKeys({ defaultBranch: "default_branch" }))

const BranchApi = Schema.Struct({
  name: Schema.String,
  commit: Schema.Struct({ sha: Schema.String }),
})

const CommentApi = Schema.Struct({
  id: Schema.Int,
  body: Schema.NullOr(Schema.String),
  user: Schema.NullOr(
    Schema.Struct({
      id: GitHubUserDatabaseIdFromStringOrNumber,
      login: Schema.String,
      type: Schema.String,
    }),
  ),
  createdAt: Schema.DateTimeUtcFromString,
}).pipe(Schema.encodeKeys({ createdAt: "created_at" }))

const SearchApi = Schema.Struct({
  totalCount: Schema.Int,
  items: Schema.Array(GitHubIssueApi),
}).pipe(Schema.encodeKeys({ totalCount: "total_count" }))

export interface Revision {
  readonly defaultBranch: string
  readonly commitSha: string
}

export interface CommentEvidence {
  readonly id: string
  readonly author: string
  /** GitHub's account type: `User`, `Bot`, ... */
  readonly authorType: string
  readonly createdAt: string
  readonly body: string
}

export interface IssueEvidence {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly author: string
  readonly labels: ReadonlyArray<string>
  readonly body: string
  readonly comments: ReadonlyArray<CommentEvidence>
  readonly commentsTruncated: boolean
}

export interface ItemSummary {
  readonly number: number
  readonly kind: "issue" | "pull_request"
  readonly title: string
  readonly state: string
  readonly author: string
  readonly labels: ReadonlyArray<string>
  readonly snippet: string
  readonly updatedAt: string
}

export type Read<A> =
  | { readonly _tag: "Ok"; readonly value: A }
  | { readonly _tag: "Failed"; readonly message: string }

const ok = <A>(value: A): Read<A> => ({ _tag: "Ok", value })
const failed = <A>(message: string): Read<A> => ({ _tag: "Failed", message })

export const truncate = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}\n[truncated after ${limit} characters]` : text

const request = (repository: RepositoryTarget, url: string, resource?: string) => ({
  scope: { _tag: "Installation" as const, installationId: repository.installationId },
  priority: "foreground" as const,
  method: "GET" as const,
  url,
  ...(resource === undefined ? {} : { resource }),
})

const summarize = (item: GitHubIssueApi): ItemSummary => ({
  number: item.number,
  kind: item.pullRequest === undefined ? "issue" : "pull_request",
  title: item.title,
  state: item.state,
  author: item.user?.login ?? "unknown",
  labels: item.labels.map((label) => label.name),
  snippet: truncate(item.body ?? "", SNIPPET_LIMIT),
  updatedAt: DateTime.formatIso(item.updatedAt),
})

/** The default branch and the commit at its head right now. */
export const fetchRevision = (
  repository: RepositoryTarget,
): Effect.Effect<Read<Revision>, SyncRateLimited | SyncActivityError, GitHubTransport> =>
  Effect.gen(function* () {
    const repo = yield* get(request(repository, repositoryPath(repository)), RepositoryApi)
    if (repo._tag === "Failed") return failed<Revision>(repo.message)
    const branch = yield* get(
      request(
        repository,
        `${repositoryPath(repository)}/branches/${encodeURIComponent(repo.body.defaultBranch)}`,
      ),
      BranchApi,
    )
    if (branch._tag === "Failed") return failed<Revision>(branch.message)
    return ok({ defaultBranch: repo.body.defaultBranch, commitSha: branch.body.commit.sha })
  })

const fetchComments = (
  repository: RepositoryTarget,
  number: number,
): Effect.Effect<
  Read<{ readonly comments: ReadonlyArray<CommentEvidence>; readonly truncated: boolean }>,
  SyncRateLimited | SyncActivityError,
  GitHubTransport
> =>
  Effect.gen(function* () {
    const comments = yield* get(
      request(
        repository,
        `${repositoryPath(repository)}/issues/${number}/comments?per_page=${COMMENT_PAGE}`,
      ),
      Schema.Array(CommentApi),
    )
    if (comments._tag === "Failed") return failed(comments.message)
    return ok({
      comments: comments.body.map((comment) => ({
        id: String(comment.id),
        author: comment.user?.login ?? "unknown",
        authorType: comment.user?.type ?? "unknown",
        createdAt: DateTime.formatIso(comment.createdAt),
        body: truncate(comment.body ?? "", COMMENT_LIMIT),
      })),
      truncated: Option.isSome(comments.next),
    })
  })

/** The issue and its first page of comments, bounded. */
export const fetchIssueEvidence = (
  repository: RepositoryTarget,
  number: number,
): Effect.Effect<Read<IssueEvidence>, SyncRateLimited | SyncActivityError, GitHubTransport> =>
  Effect.gen(function* () {
    const issue = yield* get(
      request(repository, `${repositoryPath(repository)}/issues/${number}`),
      GitHubIssueApi,
    )
    if (issue._tag === "Failed") return failed<IssueEvidence>(issue.message)
    const comments = yield* fetchComments(repository, number)
    if (comments._tag === "Failed") return failed<IssueEvidence>(comments.message)
    return ok<IssueEvidence>({
      number: issue.body.number,
      title: issue.body.title,
      state: issue.body.state,
      author: issue.body.user?.login ?? "unknown",
      labels: issue.body.labels.map((label) => label.name),
      body: truncate(issue.body.body ?? "", ISSUE_BODY_LIMIT),
      comments: comments.value.comments,
      commentsTruncated: comments.value.truncated,
    })
  })

/** Open and closed issues and pull requests of this repository matching the terms. */
export const searchItems = (
  repository: RepositoryTarget,
  terms: string,
): Effect.Effect<
  Read<ReadonlyArray<ItemSummary>>,
  SyncRateLimited | SyncActivityError,
  GitHubTransport
> =>
  Effect.gen(function* () {
    const query = `repo:${repository.owner}/${repository.repo} ${terms.trim()}`.slice(0, 256)
    const response = yield* get(
      request(
        repository,
        `/search/issues?q=${encodeURIComponent(query)}&per_page=${SEARCH_LIMIT}&advanced_search=true`,
        "search",
      ),
      SearchApi,
    )
    if (response._tag === "Failed") return failed<ReadonlyArray<ItemSummary>>(response.message)
    return ok(response.body.items.map(summarize))
  })

export interface ItemEvidence extends ItemSummary {
  readonly body: string
  readonly comments: ReadonlyArray<CommentEvidence>
  readonly commentsTruncated: boolean
}

/** One issue or pull request of this repository with its discussion, bounded. */
export const fetchItem = (
  repository: RepositoryTarget,
  number: number,
): Effect.Effect<Read<ItemEvidence>, SyncRateLimited | SyncActivityError, GitHubTransport> =>
  Effect.gen(function* () {
    const issue = yield* get(
      request(repository, `${repositoryPath(repository)}/issues/${number}`),
      GitHubIssueApi,
    )
    if (issue._tag === "Failed") return failed<ItemEvidence>(issue.message)
    const comments = yield* fetchComments(repository, number)
    if (comments._tag === "Failed") return failed<ItemEvidence>(comments.message)
    return ok<ItemEvidence>({
      ...summarize(issue.body),
      body: truncate(issue.body.body ?? "", ISSUE_BODY_LIMIT),
      comments: comments.value.comments,
      commentsTruncated: comments.value.truncated,
    })
  })

const MAX_TRANSIENT_RETRIES = 2

/**
 * Waits for GitHub inside a run: a throttle is honoured only while the run's
 * deadline leaves room for it, and transient failures retry briefly. Nothing
 * here suspends durably; an action that is interrupted runs again.
 */
export const waitsWithin =
  (deadline: DateTime.Utc): Waits =>
  (_name, effect) =>
    Effect.gen(function* () {
      let transientRetries = 0
      for (;;) {
        const result = yield* effect.pipe(Effect.result)
        if (result._tag === "Success") return result.success
        if (result.failure._tag === "SyncActivityError") {
          if (!result.failure.retryable || transientRetries >= MAX_TRANSIENT_RETRIES)
            return yield* result.failure
          yield* Effect.sleep(Duration.seconds(2 ** transientRetries++))
          continue
        }
        const now = yield* DateTime.now
        const until = DateTime.max(
          result.failure.until,
          DateTime.addDuration(now, Duration.seconds(1)),
        )
        if (DateTime.isGreaterThan(until, deadline))
          return yield* new SyncActivityError({
            message: "GitHub is rate limiting requests beyond the run's deadline.",
          })
        yield* Effect.sleep(DateTime.distance(now, until))
      }
    })

/** Complete tree from GitHub, independent of any scripts run in the guest. */
export const fetchTree = (repository: RepositoryTarget, commit: string) =>
  get(
    request(repository, `${repositoryPath(repository)}/git/trees/${commit}?recursive=1`),
    Schema.Struct({ truncated: Schema.Boolean, tree: Schema.Array(TreeEntry) }),
  ).pipe(
    Effect.flatMap((result) =>
      result._tag === "Failed"
        ? Effect.fail(new SyncActivityError({ message: result.message }))
        : result.body.truncated
          ? Effect.fail(
              new SyncActivityError({
                message: "Repository tree is truncated; test scope cannot be established.",
              }),
            )
          : Effect.succeed(result.body.tree),
    ),
  )

export const fetchBlob = (repository: RepositoryTarget, sha: string) =>
  get(
    request(repository, `${repositoryPath(repository)}/git/blobs/${sha}`),
    Schema.Struct({ encoding: Schema.String, content: Schema.String, size: Schema.Int }),
  ).pipe(
    Effect.flatMap((result) => {
      if (result._tag === "Failed")
        return Effect.fail(new SyncActivityError({ message: result.message }))
      if (result.body.encoding !== "base64" || result.body.size > PATCH_BYTES)
        return Effect.fail(
          new SyncActivityError({
            message: "Base file is too large or has unsupported encoding.",
          }),
        )
      return Effect.try({
        try: () =>
          new TextDecoder("utf-8", { fatal: true }).decode(
            Uint8Array.from(atob(result.body.content.replace(/\s/g, "")), (char) =>
              char.charCodeAt(0),
            ),
          ),
        catch: () =>
          new SyncActivityError({
            message: "Base file is not UTF-8 text.",
          }),
      })
    }),
  )
