import { GitHubIssueApi } from "@janitor/domain/GitHub/Api"
import { GitHubUserDatabaseIdFromStringOrNumber } from "@janitor/domain/GitHub/Id"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { SyncActivityError, SyncRateLimited } from "../GitHub/SyncSupport.ts"
import type { GitHubTransport } from "../GitHub/Transport.ts"
import { get, type RepositoryTarget, repositoryPath } from "../Labeling/GitHubIssue.ts"

/**
 * What GitHub says right now about an invocation (ADR 0007): the repository
 * is the one Janitor connected, the issue is open and not a pull request,
 * the comment exists unchanged, and its author is a human whose effective
 * permission is write or admin. Identities match by stable numeric ID; a
 * failed lookup denies.
 */

const Repository = Schema.Struct({ id: Schema.Int })

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
  updatedAt: Schema.DateTimeUtcFromString,
  issueUrl: Schema.String,
}).pipe(
  Schema.encodeKeys({ createdAt: "created_at", updatedAt: "updated_at", issueUrl: "issue_url" }),
)

const PermissionApi = Schema.Struct({
  permission: Schema.String,
  roleName: Schema.optionalKey(Schema.String),
  user: Schema.NullOr(
    Schema.Struct({
      id: GitHubUserDatabaseIdFromStringOrNumber,
      login: Schema.String,
      permissions: Schema.optionalKey(
        Schema.Struct({
          push: Schema.optionalKey(Schema.Boolean),
          maintain: Schema.optionalKey(Schema.Boolean),
          admin: Schema.optionalKey(Schema.Boolean),
        }),
      ),
    }),
  ),
}).pipe(Schema.encodeKeys({ roleName: "role_name" }))

export interface Invocation {
  readonly issueNumber: number
  readonly commentId: string
  readonly authorId: string
  readonly authorLogin: string
  /** The comment body as the webhook delivered it. */
  readonly body: string
}

export type Authority =
  | {
      readonly _tag: "Authorized"
      readonly issueId: string
      readonly instructions: string
      readonly commentCreatedAt: Date
      readonly login: string
    }
  | { readonly _tag: "Denied"; readonly reason: string }

export type Permission =
  | { readonly _tag: "Sufficient"; readonly login: string }
  | { readonly _tag: "Insufficient"; readonly reason: string }

const request = (repository: RepositoryTarget, url: string) => ({
  scope: { _tag: "Installation" as const, installationId: repository.installationId },
  priority: "foreground" as const,
  method: "GET" as const,
  url,
})

const denied = (reason: string): Authority => ({ _tag: "Denied", reason })

export const deniedReasons = {
  repository: "The repository on GitHub is not the one connected to Janitor.",
  issueMissing: "The issue could not be read from GitHub.",
  issueClosed: "The issue is closed.",
  pullRequest: "Review is invoked on issues, not pull requests.",
  commentMissing: "The invoking comment no longer exists on GitHub.",
  commentEdited: "The invoking comment was edited. Post a new invocation.",
  commentAuthor: "The comment's author on GitHub is not the one the delivery named.",
  bot: "Bots and GitHub Apps cannot invoke review.",
  permission: "The invoker needs write or admin permission on the repository.",
  permissionUnavailable: "The invoker's repository permission could not be verified.",
} as const

/**
 * The author's effective permission on the repository, resolved by login
 * and matched to the expected stable user ID. Custom roles report their
 * base permission here, so `write` covers them.
 */
export const effectivePermission = (
  repository: RepositoryTarget,
  login: string,
  expectedUserId: string,
): Effect.Effect<Permission, SyncRateLimited | SyncActivityError, GitHubTransport> =>
  get(
    request(
      repository,
      `${repositoryPath(repository)}/collaborators/${encodeURIComponent(login)}/permission`,
    ),
    PermissionApi,
  ).pipe(
    Effect.map((response): Permission => {
      if (response._tag === "Failed")
        return { _tag: "Insufficient", reason: deniedReasons.permissionUnavailable }
      const { body } = response
      if (body.user === null || body.user.id !== expectedUserId)
        return { _tag: "Insufficient", reason: deniedReasons.permissionUnavailable }
      const sufficient =
        body.permission === "admin" ||
        body.permission === "write" ||
        body.user.permissions?.push === true ||
        body.user.permissions?.maintain === true ||
        body.user.permissions?.admin === true
      return sufficient
        ? { _tag: "Sufficient", login: body.user.login }
        : { _tag: "Insufficient", reason: deniedReasons.permission }
    }),
  )

/** Every check an invocation must pass before it becomes a run. */
export const checkInvocationSource = (
  repository: RepositoryTarget,
  repositoryId: string,
  invocation: Invocation,
): Effect.Effect<Authority, SyncRateLimited | SyncActivityError, GitHubTransport> =>
  Effect.gen(function* () {
    const repo = yield* get(request(repository, repositoryPath(repository)), Repository)
    if (repo._tag === "Failed" || String(repo.body.id) !== repositoryId)
      return denied(deniedReasons.repository)

    const issue = yield* get(
      request(repository, `${repositoryPath(repository)}/issues/${invocation.issueNumber}`),
      GitHubIssueApi,
    )
    if (issue._tag === "Failed") return denied(deniedReasons.issueMissing)
    if (issue.body.pullRequest !== undefined) return denied(deniedReasons.pullRequest)
    if (issue.body.state !== "open") return denied(deniedReasons.issueClosed)

    const comment = yield* get(
      request(
        repository,
        `${repositoryPath(repository)}/issues/comments/${encodeURIComponent(invocation.commentId)}`,
      ),
      CommentApi,
    )
    if (comment._tag === "Failed") return denied(deniedReasons.commentMissing)
    const current = comment.body
    if (!current.issueUrl.endsWith(`/issues/${invocation.issueNumber}`))
      return denied(deniedReasons.commentMissing)
    if (current.user === null || current.user.id !== invocation.authorId)
      return denied(deniedReasons.commentAuthor)
    if (current.user.type !== "User") return denied(deniedReasons.bot)
    if (
      current.body !== invocation.body ||
      !DateTime.Equivalence(current.createdAt, current.updatedAt)
    )
      return denied(deniedReasons.commentEdited)

    return {
      _tag: "Authorized",
      issueId: issue.body.id,
      instructions: current.body,
      commentCreatedAt: DateTime.toDateUtc(current.createdAt),
      login: current.user.login,
    }
  })

export const checkInvocation = (
  repository: RepositoryTarget,
  repositoryId: string,
  invocation: Invocation,
): Effect.Effect<Authority, SyncRateLimited | SyncActivityError, GitHubTransport> =>
  Effect.gen(function* () {
    const source = yield* checkInvocationSource(repository, repositoryId, invocation)
    if (source._tag === "Denied") return source
    const permission = yield* effectivePermission(repository, source.login, invocation.authorId)
    return permission._tag === "Insufficient" ? denied(permission.reason) : source
  })
