import type { GitHubInstallationId } from "@janitor/domain/GitHub/Id"
import type { PullRequestFile } from "@janitor/domain/PullRequestReview/Diff"
import type { Fingerprint, HeadBlob } from "@janitor/domain/PullRequestReview/Fingerprint"
import {
  parseFingerprintMarker,
  type CheckRunOutput,
} from "@janitor/domain/PullRequestReview/Render"
import {
  ancestorDirectories,
  countedSize,
  type Gitattributes,
  type Size,
} from "@janitor/domain/PullRequestReview/Size"
import * as Clock from "effect/Clock"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import { GraphQLClient, GraphQLClientError, GraphQLProtocol } from "effect/graphql"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { GitHubAppAuth } from "../GitHub/AppAuth.ts"
import { nextLink } from "../GitHub/Link.ts"
import { GitHubTransport, type GitHubRequest } from "../GitHub/Transport.ts"
import * as ReviewGraphQL from "./GitHub.graphql.ts"

/**
 * The GitHub reads and writes of one PR review run, through the shared
 * transport. Rate limits are waited out here, mutations are spaced at least a
 * second apart, and permission lookups are cached for the run.
 */

export class PullRequestGitHubError extends Data.TaggedError("PullRequestGitHubError")<{
  readonly operation: string
  readonly message: string
  readonly status?: number
}> {}

/** GitHub answered 403, or a GraphQL `FORBIDDEN` error. */
export class Forbidden extends Data.TaggedError("PullRequestGitHubForbidden")<{
  readonly operation: string
  readonly message: string
}> {}

/** GitHub answered 404, or a GraphQL `NOT_FOUND` error. */
export class NotFound extends Data.TaggedError("PullRequestGitHubNotFound")<{
  readonly operation: string
  readonly message: string
}> {}

/**
 * GitHub answered 422, or a GraphQL `UNPROCESSABLE` error, other than for a
 * thread line outside the diff.
 */
export class Unprocessable extends Data.TaggedError("PullRequestGitHubUnprocessable")<{
  readonly operation: string
  readonly message: string
}> {}

/** GitHub asked for a wait longer than a run waits inline; retry after `until`. */
export class RateLimited extends Data.TaggedError("PullRequestGitHubRateLimited")<{
  readonly operation: string
  readonly until: DateTime.Utc
}> {}

export type PullRequestGitHubFailure =
  | PullRequestGitHubError
  | Forbidden
  | NotFound
  | Unprocessable
  | RateLimited

/** A directory read would go past its file bound, so reading it whole is refused. */
export class DirectoryTooLarge extends Data.TaggedError("PullRequestGitHubDirectoryTooLarge")<{
  readonly path: string
  readonly limit: number
}> {}

/** GitHub refused a review thread whose line isn't part of the diff. */
export class UnresolvableLine extends Data.TaggedError("UnresolvableLine")<{
  readonly path: string
  readonly line: number
  readonly message: string
}> {}

/** Dismissal was forbidden: janitor is not on the branch's dismissal allow-list. */
export class NotOnDismissalAllowList extends Data.TaggedError("NotOnDismissalAllowList")<{
  readonly reviewId: string
}> {}

export interface PullRequestTarget {
  readonly installationId: GitHubInstallationId
  readonly owner: string
  readonly repo: string
  readonly number: number
}

export interface PullRequest {
  readonly nodeId: string
  readonly state: "open" | "closed"
  readonly draft: boolean
  readonly headSha: string
  readonly baseSha: string
  readonly baseRef: string
  /** Absent for a deleted account. `type` is GitHub's account type, such as `User` or `Bot`. */
  readonly author: Option.Option<{ readonly login: string; readonly type: string }>
  readonly title: string
  readonly body: string
  readonly visibility: "public" | "private" | "internal"
}

export type ChangedFile = PullRequestFile & {
  readonly additions: number
  readonly deletions: number
}

export interface ChangedFiles {
  readonly files: ReadonlyArray<ChangedFile>
  /** GitHub's file listing stops at 3,000 files. */
  readonly truncated: boolean
  /**
   * What the oversized check counts: changed lines and files, leaving out
   * lockfiles, `linguist-generated` files at the base SHA and `.changeset/*`.
   */
  readonly size: Size
}

/** How the last reviewed SHA relates to the head, and what changed between them. */
export interface Comparison {
  /** The last reviewed SHA is the head or one of its ancestors. */
  readonly ancestor: boolean
  readonly files: ReadonlyArray<ChangedFile>
  /** The compare API lists at most 300 files. */
  readonly truncated: boolean
}

export interface ThreadComment {
  readonly id: string
  readonly author: string
  /** Written by janitor's App rather than a human. */
  readonly byJanitor: boolean
  readonly viewerCanMinimize: boolean
  readonly isMinimized: boolean
  readonly body: string
  readonly createdAt: DateTime.Utc
  /** The comment's page on GitHub, when GitHub sent it. */
  readonly url?: string
}

/** A review thread janitor's App opened, recognised by the fingerprint marker in its root. */
export interface JanitorThread {
  readonly id: string
  readonly path: string
  readonly line: number | null
  readonly startLine: number | null
  readonly isResolved: boolean
  readonly isOutdated: boolean
  /** The login that resolved the thread. */
  readonly resolvedBy: Option.Option<string>
  readonly fingerprint: Fingerprint
  /** The root comment first, then the replies in order. */
  readonly comments: ReadonlyArray<ThreadComment>
}

/** A review janitor's App submitted. */
export interface JanitorReview {
  readonly id: string
  readonly databaseId: number
  readonly state: string
  /** The commit the review was pinned to; none once a force push removed it. */
  readonly reviewedSha: Option.Option<string>
}

export type RepositoryPermission = "admin" | "maintain" | "write" | "triage" | "read" | "none"

/** An issue comment, such as a `/janitor` command. */
export interface IssueComment {
  readonly id: string
  readonly body: string
  readonly author: Option.Option<{ readonly login: string; readonly type: string }>
  readonly createdAt: DateTime.Utc
  readonly updatedAt: DateTime.Utc
}

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT"

/** A new `RIGHT`-side thread; `startLine` only for a multi-line range. */
export interface NewThread {
  readonly path: string
  readonly line: number
  readonly startLine?: number
  readonly body: string
}

/**
 * Janitor's pending review on the pull request and what it holds so far. A
 * user has at most one pending review per pull request, so after Publish
 * clears leftovers this is the current run's, and a write cut off mid-request
 * can be checked here before it is retried.
 */
export interface PendingReview {
  readonly id: string
  readonly databaseId: number
  /** Threads the review opens, recognised by the fingerprint marker in their root. */
  readonly threads: ReadonlyArray<{
    readonly threadId: string
    readonly path: string
    readonly line: number | null
    readonly fingerprint: Fingerprint
  }>
  /** Replies the review adds to earlier threads. */
  readonly replies: ReadonlyArray<{ readonly threadId: string; readonly commentId: string }>
}

export const CHECK_RUN_NAME = "janitor/review"

export type CheckRunState =
  | { readonly status: "in_progress" }
  | {
      readonly status: "completed"
      readonly conclusion: "success" | "failure" | "neutral" | "cancelled"
    }

export interface CheckRunLink {
  readonly id: string
  readonly url: string
}

export interface PullRequestGitHub {
  readonly pullRequest: Effect.Effect<PullRequest, PullRequestGitHubFailure>
  /** The changed files with their patches, paginated, and the size count. */
  readonly changedFiles: (options: {
    readonly baseSha: string
    readonly lockfiles: ReadonlyArray<string>
  }) => Effect.Effect<ChangedFiles, PullRequestGitHubFailure>
  /** A file at `ref`; missing or over the contents API's 1 MB cap is `Unreadable`. */
  readonly readFile: (
    ref: string,
    path: string,
  ) => Effect.Effect<HeadBlob, PullRequestGitHubFailure>
  /**
   * Every file under a directory at `ref`, recursively; a missing directory has
   * none. Past 500 files it fails rather than return part of the directory.
   */
  readonly readDirectory: (
    ref: string,
    path: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly path: string; readonly blob: HeadBlob }>,
    PullRequestGitHubFailure | DirectoryTooLarge
  >
  readonly compare: (
    lastReviewedSha: string,
    headSha: string,
  ) => Effect.Effect<Comparison, PullRequestGitHubFailure>
  /** Janitor's earlier threads and reviews; everyone else's are left out. */
  readonly janitorHistory: Effect.Effect<
    {
      readonly threads: ReadonlyArray<JanitorThread>
      readonly reviews: ReadonlyArray<JanitorReview>
    },
    PullRequestGitHubFailure
  >
  /** Janitor's review `reviewId` once submitted, so a retry doesn't post twice. */
  readonly findReview: (
    reviewId: string,
  ) => Effect.Effect<Option.Option<JanitorReview>, PullRequestGitHubFailure>
  /** A login's repository permission, cached for the run. */
  readonly permission: (
    login: string,
  ) => Effect.Effect<RepositoryPermission, PullRequestGitHubFailure>
  /** An issue comment on this pull request, by id. */
  readonly issueComment: (
    commentId: string,
  ) => Effect.Effect<IssueComment, PullRequestGitHubFailure>
  /** Creates or updates the `janitor/review` check run on `headSha`. */
  readonly upsertCheckRun: (options: {
    readonly headSha: string
    readonly state: CheckRunState
    readonly output: CheckRunOutput
    /** The check run this run created earlier, when it knows it. */
    readonly checkRunId?: string
  }) => Effect.Effect<CheckRunLink, PullRequestGitHubFailure>
  /** Janitor's pending review, if it has one. */
  readonly pendingReview: Effect.Effect<Option.Option<PendingReview>, PullRequestGitHubFailure>
  /** Deletes janitor's pending review, if it has one. */
  readonly deletePendingReview: Effect.Effect<void, PullRequestGitHubFailure>
  /** Starts a pending review pinned to `commitId`, the reviewed head SHA. */
  readonly createPendingReview: (
    commitId: string,
  ) => Effect.Effect<{ readonly id: string; readonly databaseId: number }, PullRequestGitHubFailure>
  readonly addThread: (
    reviewId: string,
    thread: NewThread,
  ) => Effect.Effect<{ readonly threadId: string }, PullRequestGitHubFailure | UnresolvableLine>
  readonly addReply: (
    reviewId: string,
    reply: { readonly threadId: string; readonly body: string },
  ) => Effect.Effect<{ readonly commentId: string }, PullRequestGitHubFailure>
  readonly submitPendingReview: (
    reviewId: string,
    submission: { readonly event: ReviewEvent; readonly body: string },
  ) => Effect.Effect<void, PullRequestGitHubFailure>
  /** Resolves an earlier review thread without adding a comment. */
  readonly resolveThread: (threadId: string) => Effect.Effect<void, PullRequestGitHubFailure>
  /** Hides an addressed comment with GitHub's RESOLVED classifier. */
  readonly minimizeComment: (commentId: string) => Effect.Effect<void, PullRequestGitHubFailure>
  readonly dismissReview: (
    review: { readonly id: string; readonly databaseId: number },
    message: string,
  ) => Effect.Effect<void, PullRequestGitHubFailure | NotOnDismissalAllowList>
}

/** The gap GitHub asks for between content-creating requests (EFF-1643 section 6). */
const MUTATION_SPACING = Duration.seconds(1)
/** Longer rate-limit waits go back to the caller as `RateLimited`. */
const MAX_INLINE_WAIT = Duration.minutes(2)
const MAX_RATE_LIMIT_WAITS = 5
/** A GraphQL rate limit doesn't say when it resets. */
const GRAPHQL_RATE_LIMIT_WAIT = Duration.minutes(1)
const PAGE = 100
const MAX_CHANGED_FILES = 3000
const MAX_COMPARE_FILES = 300
/** Bounds a recursive directory read and a GraphQL connection walk. */
const MAX_DIRECTORY_FILES = 500
const MAX_CONNECTION_PAGES = 50

const ChangedFileApi = Schema.Struct({
  filename: Schema.NonEmptyString,
  status: Schema.Literals([
    "added",
    "removed",
    "modified",
    "renamed",
    "copied",
    "changed",
    "unchanged",
  ]),
  previous_filename: Schema.optionalKey(Schema.String),
  patch: Schema.optionalKey(Schema.String),
  additions: Schema.Int,
  deletions: Schema.Int,
})

const AccountApi = Schema.NullOr(Schema.Struct({ login: Schema.String, type: Schema.String }))

const PullRequestApi = Schema.Struct({
  node_id: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  draft: Schema.Boolean,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  user: AccountApi,
  head: Schema.Struct({ sha: Schema.String }),
  base: Schema.Struct({
    ref: Schema.String,
    sha: Schema.String,
    repo: Schema.Struct({
      private: Schema.Boolean,
      visibility: Schema.optionalKey(Schema.String),
    }),
  }),
})

const ContentsApi = Schema.Union([
  Schema.Array(Schema.Struct({ type: Schema.String, path: Schema.String })),
  Schema.Struct({
    type: Schema.String,
    encoding: Schema.optionalKey(Schema.String),
    content: Schema.optionalKey(Schema.String),
  }),
])

type Contents = typeof ContentsApi.Type
const isListing = (contents: Contents): contents is Extract<Contents, ReadonlyArray<unknown>> =>
  Array.isArray(contents)

const CompareApi = Schema.Struct({
  status: Schema.Literals(["diverged", "ahead", "behind", "identical"]),
  files: Schema.optionalKey(Schema.Array(ChangedFileApi)),
})

const PermissionApi = Schema.Struct({
  permission: Schema.String,
  role_name: Schema.optionalKey(Schema.String),
})

const IssueCommentApi = Schema.Struct({
  id: Schema.Int,
  body: Schema.NullOr(Schema.String),
  user: AccountApi,
  created_at: Schema.DateTimeUtcFromString,
  updated_at: Schema.DateTimeUtcFromString,
  issue_url: Schema.String,
})

const CheckRunApi = Schema.Struct({ id: Schema.Int, html_url: Schema.NullOr(Schema.String) })

const CheckRunsApi = Schema.Struct({ check_runs: Schema.Array(CheckRunApi) })

const AppApi = Schema.Struct({ id: Schema.Int })

/** A response schema that decodes without services. */
type Plain = Schema.Top & { readonly DecodingServices: never }

interface Page<A> {
  readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null }
  readonly nodes: ReadonlyArray<A>
}

type ThreadCommentNode = ReviewGraphQL.ThreadComment

/** A review thread with the first page of its comments. */
type Thread = Omit<ReviewGraphQL.NodesPullRequestReviewThread, "comments"> & {
  readonly comments: Page<ThreadCommentNode>
}

const TreeApi = Schema.Struct({
  truncated: Schema.Boolean,
  tree: Schema.Array(Schema.Struct({ path: Schema.String })),
})

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/")

const UNREADABLE: HeadBlob = { _tag: "Unreadable" }

/**
 * A contents API answer as a blob. Over 1 MB it comes without the content
 * (`encoding: "none"`); a directory or anything else isn't a readable file.
 */
const blobOf = (contents: Contents): HeadBlob => {
  if (
    isListing(contents) ||
    contents.type !== "file" ||
    contents.encoding !== "base64" ||
    contents.content === undefined
  ) {
    return UNREADABLE
  }
  const text = Base64.decodeString(contents.content.replace(/\s+/g, ""))
  return Result.isSuccess(text) ? { _tag: "Read", text: text.success } : UNREADABLE
}

/**
 * A non-2xx answer as a typed failure. The message names the operation and
 * the status only: GitHub's own message can quote what the request carried,
 * such as review or pull request text, and errors get logged.
 */
const failed = (
  operation: string,
  status: number,
): PullRequestGitHubError | Forbidden | NotFound | Unprocessable => {
  const message = `${operation}: GitHub responded ${status}`
  if (status === 403) return new Forbidden({ operation, message })
  if (status === 404) return new NotFound({ operation, message })
  if (status === 422) return new Unprocessable({ operation, message })
  return new PullRequestGitHubError({ operation, message, status })
}

/** GitHub's category for a GraphQL error, such as `NOT_FOUND`, beside the spec's fields. */
const errorType = (error: GraphQLClientError.GraphQLError) =>
  typeof error["type"] === "string" ? error["type"] : undefined

/** A GraphQL error as a typed failure; like `failed`, its message leaves out GitHub's text. */
const graphQLFailure = (
  operation: string,
  error: GraphQLClientError.GraphQLError | undefined,
): PullRequestGitHubError | Forbidden | NotFound | Unprocessable => {
  const type = error === undefined ? undefined : errorType(error)
  const message = `${operation}: GitHub refused it (${type ?? "error"})`
  if (type === "FORBIDDEN") return new Forbidden({ operation, message })
  if (type === "NOT_FOUND") return new NotFound({ operation, message })
  if (type === "UNPROCESSABLE") return new Unprocessable({ operation, message })
  return new PullRequestGitHubError({ operation, message })
}

const unexpected = (operation: string) =>
  new PullRequestGitHubError({ operation, message: `${operation}: unexpected response` })

/** A review the App submitted or holds pending; GitHub's schema allows no database id, which it always sends. */
const janitorReview = (operation: string, review: ReviewGraphQL.Review) =>
  review.databaseId === null
    ? Effect.fail(unexpected(operation))
    : Effect.succeed<JanitorReview>({
        id: review.id,
        databaseId: review.databaseId,
        state: review.state,
        reviewedSha: Option.fromNullishOr(review.commit?.oid),
      })

const isPending = (comment: ThreadCommentNode) => comment.pullRequestReview?.state === "PENDING"

const STANDARD_ROLES = ["admin", "maintain", "write", "triage", "read"] as const

/**
 * `role_name` tells maintain and triage apart, which `permission` folds into
 * write and read; a custom role falls back to `permission`.
 */
const permissionOf = (body: typeof PermissionApi.Type): RepositoryPermission =>
  STANDARD_ROLES.find((role) => role === body.role_name) ??
  STANDARD_ROLES.find((role) => role === body.permission) ??
  "none"

export const make = Effect.fnUntraced(function* (target: PullRequestTarget) {
  const transport = yield* GitHubTransport
  const repository = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`
  const pullPath = `${repository}/pulls/${target.number}`
  const pullVariables = { owner: target.owner, repo: target.repo, number: target.number }

  let lastMutationAt: number | undefined
  const permissions = new Map<string, RepositoryPermission>()
  let appId: number | undefined

  const decode =
    <S extends Plain>(operation: string, schema: S) =>
    (body: unknown) =>
      Schema.decodeUnknownEffect(schema)(body).pipe(Effect.mapError(() => unexpected(operation)))

  /** Waits out a rate limit inline, or hands it back when it is too long or too frequent. */
  const waitOut = (operation: string, until: DateTime.Utc, waits: number) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now
      const wait = Duration.millis(
        Math.max(0, DateTime.toEpochMillis(until) - DateTime.toEpochMillis(now)),
      )
      if (waits >= MAX_RATE_LIMIT_WAITS || Duration.isGreaterThan(wait, MAX_INLINE_WAIT)) {
        return yield* new RateLimited({ operation, until })
      }
      yield* Effect.sleep(wait)
    })

  const spaceMutation = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const spacing = Duration.toMillis(MUTATION_SPACING)
    if (lastMutationAt !== undefined && now - lastMutationAt < spacing) {
      yield* Effect.sleep(Duration.millis(lastMutationAt + spacing - now))
    }
    lastMutationAt = yield* Clock.currentTimeMillis
  })

  /** Sends one request, waiting out rate limits; a 2xx or a `Failed` answer comes back. */
  const send = (
    operation: string,
    request: Pick<GitHubRequest, "method" | "url" | "body" | "resource"> & {
      readonly scope?: GitHubRequest["scope"]
      /** Defaults to any method but `GET`; GraphQL says per query. */
      readonly mutation?: boolean
    },
  ) =>
    Effect.gen(function* () {
      for (let waits = 0; ; waits++) {
        if (request.mutation ?? request.method !== "GET") yield* spaceMutation
        const result = yield* transport
          .request({
            scope: request.scope ?? { _tag: "Installation", installationId: target.installationId },
            priority: "foreground",
            method: request.method,
            url: request.url,
            ...(request.body === undefined ? {} : { body: request.body }),
            ...(request.resource === undefined ? {} : { resource: request.resource }),
          })
          .pipe(Effect.result)
        if (result._tag === "Success") {
          const response = result.success
          if (response._tag === "NotModified") {
            return yield* new PullRequestGitHubError({
              operation,
              message: `${operation}: unexpected 304 without a conditional request`,
            })
          }
          return response
        }
        const error = result.failure
        if (error._tag !== "GitHubRateLimited") {
          return yield* new PullRequestGitHubError({
            operation,
            message: `${operation}: ${error._tag}`,
          })
        }
        yield* waitOut(operation, error.until, waits)
      }
    })

  /** A 2xx body decoded with `schema`; any other answer is a typed failure. */
  const rest = <S extends Plain>(
    operation: string,
    request: {
      readonly url: string
      readonly schema: S
      readonly method?: GitHubRequest["method"]
      readonly body?: unknown
      readonly scope?: GitHubRequest["scope"]
    },
  ) =>
    send(operation, { ...request, method: request.method ?? "GET" }).pipe(
      Effect.flatMap((response) =>
        response._tag === "Failed"
          ? Effect.fail(failed(operation, response.status))
          : decode(
              operation,
              request.schema,
            )(response.body).pipe(
              Effect.map((decoded) => ({ body: decoded, link: response.link })),
            ),
      ),
    )

  /** Like `rest`, with a 404 as `None`. */
  const restOrMissing = <S extends Plain>(
    operation: string,
    request: { readonly url: string; readonly schema: S },
  ) =>
    rest(operation, request).pipe(
      Effect.map(({ body }) => Option.some(body)),
      Effect.catchTag("PullRequestGitHubNotFound", () => Effect.succeed(Option.none<S["Type"]>())),
    )

  const contentsUrl = (ref: string, path: string) =>
    `${repository}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`

  /**
   * GraphQL through `send`, so the transport's authentication, rate budget
   * and limits, and the spacing between mutations, apply as they do for REST.
   * GitHub serves no GraphQL subscriptions.
   */
  const protocol = GraphQLProtocol.GraphQLProtocol.of({
    execute: (request) =>
      send(request.operationName, {
        method: "POST",
        url: "/graphql",
        body: {
          query: request.query,
          operationName: request.operationName,
          variables: request.variables,
        },
        resource: "graphql",
        mutation: request.kind === "mutation",
      }).pipe(
        Effect.mapError(
          (cause) => new GraphQLClientError.TransportError({ description: cause._tag, cause }),
        ),
        Effect.flatMap((response) =>
          response._tag === "Failed"
            ? Effect.fail(
                new GraphQLClientError.TransportError({
                  description: `GitHub responded ${response.status}`,
                  status: response.status,
                }),
              )
            : Effect.succeed({ body: response.body, status: response.status }),
        ),
      ),
    subscribe: () =>
      Stream.fail(
        new GraphQLClientError.TransportError({
          description: "GitHub serves no GraphQL subscriptions",
          fatal: true,
        }),
      ),
  })

  const client = yield* GraphQLClient.make(ReviewGraphQL.GitHubGraphQLGroup).pipe(
    Effect.provideService(GraphQLProtocol.GraphQLProtocol, protocol),
  )

  /** A client failure as a typed one; a GraphQL `errors` answer is read by the caller instead. */
  const clientFailure = (
    operation: string,
    error: GraphQLClientError.GraphQLClientError,
  ): PullRequestGitHubFailure => {
    const reason = error.reason
    if (reason._tag !== "TransportError") return unexpected(operation)
    // `send` already turned the transport's own failures into typed ones.
    if (reason.cause instanceof PullRequestGitHubError || reason.cause instanceof RateLimited) {
      return reason.cause
    }
    return reason.status === undefined
      ? new PullRequestGitHubError({ operation, message: `${operation}: ${reason.description}` })
      : failed(operation, reason.status)
  }

  /**
   * One GraphQL call. Errors come back with the data so a caller can read a
   * specific one; a rate-limited answer is waited out.
   */
  const graphql = <A>(
    operation: string,
    call: Effect.Effect<GraphQLClient.PartialResult<A>, GraphQLClientError.GraphQLClientError>,
  ) =>
    Effect.gen(function* () {
      for (let waits = 0; ; waits++) {
        const result: {
          readonly data: A | null
          readonly errors: ReadonlyArray<GraphQLClientError.GraphQLError>
        } = yield* call.pipe(
          // Without any data GitHub's errors come as a `ResponseError`.
          Effect.catch((error) =>
            error.reason._tag === "ResponseError"
              ? Effect.succeed({ data: null, errors: error.reason.errors })
              : Effect.fail(clientFailure(operation, error)),
          ),
        )
        if (result.errors.some((error) => errorType(error) === "RATE_LIMITED")) {
          const now = yield* DateTime.now
          yield* waitOut(operation, DateTime.addDuration(now, GRAPHQL_RATE_LIMIT_WAIT), waits)
          continue
        }
        return result
      }
    })

  /** GraphQL data, failing on any error. */
  const graphqlData = <A>(
    operation: string,
    call: Effect.Effect<GraphQLClient.PartialResult<A>, GraphQLClientError.GraphQLClientError>,
  ) =>
    graphql(operation, call).pipe(
      Effect.flatMap(({ data, errors }) =>
        errors.length > 0 || data === null
          ? Effect.fail(graphQLFailure(operation, errors[0]))
          : Effect.succeed(data),
      ),
    )

  /** A connection's nodes. GitHub's schema allows `null` for them, which it doesn't send. */
  const nodesOf = <A>(
    operation: string,
    connection: { readonly nodes: ReadonlyArray<A | null> | null } | null,
  ): Effect.Effect<ReadonlyArray<A>, PullRequestGitHubError> =>
    connection !== null &&
    connection.nodes !== null &&
    connection.nodes.every((node): node is A => node !== null)
      ? Effect.succeed(connection.nodes)
      : Effect.fail(unexpected(operation))

  /** One page of a connection, for `walk`. */
  const pageOf = <A>(
    operation: string,
    connection: {
      readonly pageInfo: Page<A>["pageInfo"]
      readonly nodes: ReadonlyArray<A | null> | null
    } | null,
  ): Effect.Effect<Page<A>, PullRequestGitHubError> =>
    connection === null
      ? Effect.fail(unexpected(operation))
      : Effect.map(nodesOf(operation, connection), (nodes) => ({
          pageInfo: connection.pageInfo,
          nodes,
        }))

  const pullRequestOf = <P>(
    operation: string,
    data: { readonly repository: { readonly pullRequest: P | null } | null },
  ) =>
    data.repository === null || data.repository.pullRequest === null
      ? Effect.fail(new NotFound({ operation, message: `${operation}: pull request not found` }))
      : Effect.succeed(data.repository.pullRequest)

  /** Follows a GraphQL connection with `$after` up to its page bound. */
  const walk = <A>(
    page: (after: string | null) => Effect.Effect<Page<A>, PullRequestGitHubFailure>,
  ) =>
    Effect.gen(function* () {
      const nodes: Array<A> = []
      let after: string | null = null
      for (let ordinal = 0; ordinal < MAX_CONNECTION_PAGES; ordinal++) {
        const current: Page<A> = yield* page(after)
        nodes.push(...current.nodes)
        if (!current.pageInfo.hasNextPage || current.pageInfo.endCursor === null) break
        after = current.pageInfo.endCursor
      }
      return nodes
    })

  const pullRequest = rest("pullRequest", { url: pullPath, schema: PullRequestApi }).pipe(
    Effect.map(({ body }): PullRequest => ({
      nodeId: body.node_id,
      state: body.state,
      draft: body.draft,
      headSha: body.head.sha,
      baseSha: body.base.sha,
      baseRef: body.base.ref,
      author: Option.fromNullishOr(body.user),
      title: body.title,
      body: body.body ?? "",
      visibility:
        body.base.repo.visibility === "internal"
          ? "internal"
          : body.base.repo.private
            ? "private"
            : "public",
    })),
  )

  const readFile = (ref: string, path: string) =>
    restOrMissing("readFile", { url: contentsUrl(ref, path), schema: ContentsApi }).pipe(
      Effect.map(Option.match({ onNone: () => UNREADABLE, onSome: blobOf })),
    )

  const readDirectory = (ref: string, path: string) =>
    Effect.gen(function* () {
      const files: Array<{ readonly path: string; readonly blob: HeadBlob }> = []
      const pending = [path]
      while (pending.length > 0) {
        const contents = yield* restOrMissing("readDirectory", {
          url: contentsUrl(ref, pending.shift()!),
          schema: ContentsApi,
        })
        if (Option.isNone(contents) || !isListing(contents.value)) continue
        for (const entry of contents.value) {
          if (entry.type === "dir") pending.push(entry.path)
          else if (entry.type === "file") {
            if (files.length === MAX_DIRECTORY_FILES) {
              return yield* new DirectoryTooLarge({ path, limit: MAX_DIRECTORY_FILES })
            }
            files.push({ path: entry.path, blob: yield* readFile(ref, entry.path) })
          }
        }
      }
      return files
    })

  /** The `.gitattributes` files at `ref` that can apply to `paths`, shallowest first. */
  const gitattributesFor = (ref: string, paths: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      // The tree listing shows which directories have one; a truncated listing can't rule any out.
      const { body: tree } = yield* rest("gitattributes", {
        url: `${repository}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
        schema: TreeApi,
      })
      const listed = new Set(tree.tree.map((entry) => entry.path))
      const found: Array<Gitattributes> = []
      for (const directory of ancestorDirectories(paths)) {
        const path = directory === "" ? ".gitattributes" : `${directory}/.gitattributes`
        if (!tree.truncated && !listed.has(path)) continue
        const blob = yield* readFile(ref, path)
        if (blob._tag === "Read") found.push({ directory, text: blob.text })
      }
      return found
    })

  const changedFiles: PullRequestGitHub["changedFiles"] = (options) =>
    Effect.gen(function* () {
      const files: Array<ChangedFile> = []
      let url: string | null = `${pullPath}/files?per_page=${PAGE}`
      let pages = 0
      while (url !== null && pages < MAX_CHANGED_FILES / PAGE) {
        const page: {
          readonly body: ReadonlyArray<typeof ChangedFileApi.Type>
          readonly link: Option.Option<string>
        } = yield* rest("changedFiles", { url, schema: Schema.Array(ChangedFileApi) })
        files.push(...page.body)
        url = Option.getOrNull(Option.flatMap(page.link, nextLink))
        pages++
      }
      return {
        files,
        // GitHub ends the listing at its cap without a next link, so reaching the cap may hide more.
        truncated: url !== null || files.length >= MAX_CHANGED_FILES,
        size: countedSize(files, {
          lockfiles: options.lockfiles,
          gitattributes: yield* gitattributesFor(
            options.baseSha,
            files.map((file) => file.filename),
          ),
        }),
      } satisfies ChangedFiles
    })

  const compare = (lastReviewedSha: string, headSha: string) =>
    restOrMissing("compare", {
      // The file list comes on the first page only, whatever the commit page size.
      url: `${repository}/compare/${encodeURIComponent(lastReviewedSha)}...${encodeURIComponent(headSha)}?per_page=1`,
      schema: CompareApi,
    }).pipe(
      Effect.map((compared): Comparison => {
        // A force-push can leave the last reviewed SHA unknown to GitHub.
        if (Option.isNone(compared)) return { ancestor: false, files: [], truncated: false }
        const files: ReadonlyArray<ChangedFile> = compared.value.files ?? []
        return {
          ancestor: compared.value.status === "ahead" || compared.value.status === "identical",
          files,
          truncated: files.length >= MAX_COMPARE_FILES,
        }
      }),
    )

  const threadComments = (threadId: string, after: string) =>
    walk((cursor) =>
      graphqlData(
        "threadComments",
        client.threadComments({ id: threadId, after: cursor ?? after }, { partial: true }),
      ).pipe(
        Effect.flatMap(
          ({ node }): Effect.Effect<Page<ThreadCommentNode>, PullRequestGitHubFailure> => {
            if (node === null) {
              return Effect.fail(
                new NotFound({
                  operation: "threadComments",
                  message: "threadComments: thread not found",
                }),
              )
            }
            return node.__typename === "PullRequestReviewThread"
              ? pageOf("threadComments", node.comments)
              : Effect.fail(unexpected("threadComments"))
          },
        ),
      ),
    )

  const janitorReviews = walk((after) =>
    graphqlData(
      "janitorReviews",
      client.janitorReviews({ ...pullVariables, after }, { partial: true }),
    ).pipe(
      Effect.flatMap((data) => pullRequestOf("janitorReviews", data)),
      Effect.flatMap((pull) => pageOf("janitorReviews", pull.reviews)),
    ),
  ).pipe(
    // The App submits reviews only through Publish, so every submitted one it authored is janitor's.
    Effect.flatMap((nodes) =>
      Effect.forEach(
        nodes.filter((review) => review.viewerDidAuthor && review.state !== "PENDING"),
        (review) => janitorReview("janitorReviews", review),
      ),
    ),
  )

  const reviewThreads = walk((after) =>
    graphqlData(
      "reviewThreads",
      client.reviewThreads({ ...pullVariables, after }, { partial: true }),
    ).pipe(
      Effect.flatMap((data) => pullRequestOf("reviewThreads", data)),
      Effect.flatMap((pull) => pageOf("reviewThreads", pull.reviewThreads)),
    ),
  ).pipe(
    Effect.flatMap((threads) =>
      Effect.forEach(threads, (thread) =>
        pageOf("reviewThreads", thread.comments).pipe(
          Effect.map((comments): Thread => ({
            id: thread.id,
            path: thread.path,
            line: thread.line,
            startLine: thread.startLine,
            isResolved: thread.isResolved,
            isOutdated: thread.isOutdated,
            resolvedBy: thread.resolvedBy,
            comments,
          })),
        ),
      ),
    ),
  )

  /** Every comment on a thread; later pages are fetched only when there are any. */
  const allComments = (thread: Thread) =>
    thread.comments.pageInfo.hasNextPage && thread.comments.pageInfo.endCursor !== null
      ? threadComments(thread.id, thread.comments.pageInfo.endCursor).pipe(
          Effect.map((rest) => [...thread.comments.nodes, ...rest]),
        )
      : Effect.succeed(thread.comments.nodes)

  const janitorThreads = Effect.gen(function* () {
    const nodes = yield* reviewThreads
    const threads: Array<JanitorThread> = []
    for (const thread of nodes) {
      const root = thread.comments.nodes[0]
      // Only the App's own root counts: anyone can paste a marker into a comment.
      if (root === undefined || !root.viewerDidAuthor || isPending(root)) continue
      const fingerprint = parseFingerprintMarker(root.body)
      if (Option.isNone(fingerprint)) continue
      const comments = yield* allComments(thread)
      threads.push({
        id: thread.id,
        path: thread.path,
        line: thread.line,
        startLine: thread.startLine,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        resolvedBy: Option.fromNullishOr(thread.resolvedBy?.login),
        fingerprint: fingerprint.value,
        comments: comments
          .filter((comment) => !isPending(comment))
          .map((comment) => ({
            id: comment.id,
            author: comment.author?.login ?? "ghost",
            byJanitor: comment.viewerDidAuthor,
            viewerCanMinimize: comment.viewerCanMinimize,
            isMinimized: comment.isMinimized,
            body: comment.body,
            createdAt: comment.createdAt,
            ...(comment.url === undefined ? {} : { url: comment.url }),
          })),
      })
    }
    return threads
  })

  const janitorHistory = Effect.all(
    { threads: janitorThreads, reviews: janitorReviews },
    { concurrency: 2 },
  )

  const findReview = (reviewId: string) =>
    janitorReviews.pipe(
      Effect.map((reviews) =>
        Option.fromNullishOr(reviews.find((review) => review.id === reviewId)),
      ),
    )

  const permission = (login: string) =>
    Effect.gen(function* () {
      const cached = permissions.get(login)
      if (cached !== undefined) return cached
      const found = yield* restOrMissing("permission", {
        url: `${repository}/collaborators/${encodeURIComponent(login)}/permission`,
        schema: PermissionApi,
      })
      // An unknown login has no access.
      const resolved = Option.match(found, { onNone: () => "none" as const, onSome: permissionOf })
      permissions.set(login, resolved)
      return resolved
    })

  const issueComment = (commentId: string) =>
    rest("issueComment", {
      url: `${repository}/issues/comments/${encodeURIComponent(commentId)}`,
      schema: IssueCommentApi,
    }).pipe(
      Effect.flatMap(({ body }) =>
        // A comment id from elsewhere in the repository is not this pull request's.
        body.issue_url.endsWith(`/issues/${target.number}`)
          ? Effect.succeed<IssueComment>({
              id: String(body.id),
              body: body.body ?? "",
              author: Option.fromNullishOr(body.user),
              createdAt: body.created_at,
              updatedAt: body.updated_at,
            })
          : Effect.fail(
              new NotFound({
                operation: "issueComment",
                message: `issueComment: comment ${commentId} is not on pull request ${target.number}`,
              }),
            ),
      ),
    )

  const ownAppId = Effect.gen(function* () {
    if (appId === undefined) {
      const { body } = yield* rest("appId", { url: "/app", scope: { _tag: "App" }, schema: AppApi })
      appId = body.id
    }
    return appId
  })

  /** Janitor's own latest `janitor/review` check run on `headSha`. */
  const findCheckRun = (headSha: string) =>
    Effect.gen(function* () {
      const app = yield* ownAppId
      const { body } = yield* rest("findCheckRun", {
        url: `${repository}/commits/${encodeURIComponent(headSha)}/check-runs?check_name=${encodeURIComponent(CHECK_RUN_NAME)}&app_id=${app}&filter=latest`,
        schema: CheckRunsApi,
      })
      return body.check_runs[0] === undefined ? undefined : String(body.check_runs[0].id)
    })

  const upsertCheckRun: PullRequestGitHub["upsertCheckRun"] = (options) =>
    Effect.gen(function* () {
      const existing = options.checkRunId ?? (yield* findCheckRun(options.headSha))
      const fields = {
        status: options.state.status,
        ...(options.state.status === "completed" ? { conclusion: options.state.conclusion } : {}),
        output: { title: options.output.title, summary: options.output.summary },
      }
      const { body } = yield* existing === undefined
        ? rest("createCheckRun", {
            method: "POST",
            url: `${repository}/check-runs`,
            schema: CheckRunApi,
            body: { name: CHECK_RUN_NAME, head_sha: options.headSha, ...fields },
          })
        : rest("updateCheckRun", {
            method: "PATCH",
            url: `${repository}/check-runs/${encodeURIComponent(existing)}`,
            schema: CheckRunApi,
            body: fields,
          })
      return { id: String(body.id), url: body.html_url ?? "" }
    })

  const pendingReviews = graphqlData(
    "pendingReviews",
    client.pendingReviews(pullVariables, { partial: true }),
  ).pipe(
    Effect.flatMap((data) => pullRequestOf("pendingReviews", data)),
    Effect.flatMap((pull) =>
      nodesOf("pendingReviews", pull.reviews).pipe(
        // A user has at most one pending review per pull request.
        Effect.map((reviews) => ({
          id: pull.id,
          own: reviews.find((review) => review.viewerDidAuthor && review.state === "PENDING"),
        })),
      ),
    ),
  )

  const pendingReview = Effect.gen(function* () {
    const { own } = yield* pendingReviews
    if (own === undefined) return Option.none<PendingReview>()
    const review = yield* janitorReview("pendingReviews", own)
    const inReview = (comment: ThreadCommentNode) => comment.pullRequestReview?.id === review.id
    const threads: Array<PendingReview["threads"][number]> = []
    const replies: Array<PendingReview["replies"][number]> = []
    for (const thread of yield* reviewThreads) {
      const root = thread.comments.nodes[0]
      // Janitor only opens threads and replies to its own.
      if (root === undefined || !root.viewerDidAuthor) continue
      if (inReview(root)) {
        const fingerprint = parseFingerprintMarker(root.body)
        if (Option.isSome(fingerprint)) {
          threads.push({
            threadId: thread.id,
            path: thread.path,
            line: thread.line,
            fingerprint: fingerprint.value,
          })
        }
        continue
      }
      for (const comment of yield* allComments(thread)) {
        if (inReview(comment)) replies.push({ threadId: thread.id, commentId: comment.id })
      }
    }
    return Option.some<PendingReview>({
      id: review.id,
      databaseId: review.databaseId,
      threads,
      replies,
    })
  })

  const deletePendingReview = Effect.gen(function* () {
    const { own } = yield* pendingReviews
    if (own === undefined) return
    yield* graphqlData(
      "deletePendingReview",
      client.deletePendingReview({ input: { pullRequestReviewId: own.id } }, { partial: true }),
    )
  })

  const createPendingReview = (commitId: string) =>
    Effect.gen(function* () {
      const pull = yield* pendingReviews
      const added = yield* graphqlData(
        "addReview",
        client.addReview(
          { input: { pullRequestId: pull.id, commitOID: commitId } },
          { partial: true },
        ),
      )
      const review = added.addPullRequestReview?.pullRequestReview ?? null
      if (review === null || review.databaseId === null) {
        return yield* new PullRequestGitHubError({
          operation: "addReview",
          message: "addReview: GitHub returned no review",
        })
      }
      return { id: review.id, databaseId: review.databaseId }
    })

  const addThread = (reviewId: string, thread: NewThread) =>
    Effect.gen(function* () {
      const result = yield* graphql(
        "addThread",
        client.addThread(
          {
            input: {
              pullRequestReviewId: reviewId,
              path: thread.path,
              line: thread.line,
              side: "RIGHT",
              ...(thread.startLine === undefined || thread.startLine === thread.line
                ? {}
                : { startLine: thread.startLine, startSide: "RIGHT" as const }),
              body: thread.body,
            },
          },
          { partial: true },
        ),
      )
      const unprocessable = result.errors.find((error) => errorType(error) === "UNPROCESSABLE")
      const created = result.data?.addPullRequestReviewThread?.thread ?? null
      // GitHub may refuse a line outside the diff with an error or with no thread at all.
      if (unprocessable !== undefined || (result.errors.length === 0 && created === null)) {
        return yield* new UnresolvableLine({
          path: thread.path,
          line: thread.line,
          message: unprocessable?.message ?? "GitHub created no thread for this line",
        })
      }
      if (result.errors.length > 0 || created === null) {
        return yield* graphQLFailure("addThread", result.errors[0])
      }
      return { threadId: created.id }
    })

  const addReply: PullRequestGitHub["addReply"] = (reviewId, reply) =>
    Effect.gen(function* () {
      const added = yield* graphqlData(
        "addReply",
        client.addReply(
          {
            input: {
              pullRequestReviewId: reviewId,
              pullRequestReviewThreadId: reply.threadId,
              body: reply.body,
            },
          },
          { partial: true },
        ),
      )
      const comment = added.addPullRequestReviewThreadReply?.comment ?? null
      if (comment === null) {
        return yield* new PullRequestGitHubError({
          operation: "addReply",
          message: "addReply: GitHub returned no comment",
        })
      }
      return { commentId: comment.id }
    })

  const submitPendingReview: PullRequestGitHub["submitPendingReview"] = (reviewId, submission) =>
    graphqlData(
      "submitReview",
      client.submitReview(
        {
          input: { pullRequestReviewId: reviewId, event: submission.event, body: submission.body },
        },
        { partial: true },
      ),
    ).pipe(Effect.asVoid)

  const resolveThread: PullRequestGitHub["resolveThread"] = (threadId) =>
    graphqlData(
      "resolveThread",
      client.resolveThread({ input: { threadId } }, { partial: true }),
    ).pipe(
      Effect.flatMap((data) =>
        data.resolveReviewThread?.thread?.isResolved === true
          ? Effect.void
          : Effect.fail(
              new PullRequestGitHubError({
                operation: "resolveThread",
                message: "resolveThread: GitHub did not resolve the thread",
              }),
            ),
      ),
    )

  const minimizeComment: PullRequestGitHub["minimizeComment"] = (commentId) =>
    graphqlData(
      "minimizeComment",
      client.minimizeComment(
        { input: { subjectId: commentId, classifier: "RESOLVED" } },
        { partial: true },
      ),
    ).pipe(
      Effect.flatMap((data) =>
        data.minimizeComment?.minimizedComment?.isMinimized === true
          ? Effect.void
          : Effect.fail(
              new PullRequestGitHubError({
                operation: "minimizeComment",
                message: "minimizeComment: GitHub did not minimize the comment",
              }),
            ),
      ),
    )

  const dismissReview: PullRequestGitHub["dismissReview"] = (review, message) =>
    send("dismissReview", {
      method: "PUT",
      url: `${pullPath}/reviews/${review.databaseId}/dismissals`,
      body: { message, event: "DISMISS" },
    }).pipe(
      Effect.flatMap(
        (
          response,
        ): Effect.Effect<
          void,
          NotOnDismissalAllowList | PullRequestGitHubError | Forbidden | NotFound | Unprocessable
        > =>
          response._tag !== "Failed"
            ? Effect.void
            : response.status === 403
              ? Effect.fail(new NotOnDismissalAllowList({ reviewId: review.id }))
              : Effect.fail(failed("dismissReview", response.status)),
      ),
    )

  return {
    pullRequest,
    changedFiles,
    readFile,
    readDirectory,
    compare,
    janitorHistory,
    findReview,
    permission,
    issueComment,
    upsertCheckRun,
    pendingReview,
    deletePendingReview,
    createPendingReview,
    addThread,
    addReply,
    resolveThread,
    minimizeComment,
    submitPendingReview,
    dismissReview,
  } satisfies PullRequestGitHub
})

/**
 * Mints the token a sandbox fetches with (EFF-1892 point 3): one repository,
 * `contents: read` only, never cached, so each acquire gets its own. Revoke
 * it with `GitHubAppAuth.revokeInstallationToken` on release.
 */
export const mintSandboxToken = (options: {
  readonly installationId: GitHubInstallationId
  readonly repositoryId: string
}) =>
  GitHubAppAuth.use((auth) =>
    auth.installationToken(options.installationId, {
      repositoryId: options.repositoryId,
      contents: "read",
    }),
  )
