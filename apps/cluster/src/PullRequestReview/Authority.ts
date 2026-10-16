import { GitHubUserDatabaseIdFromStringOrNumber } from "@janitor/domain/GitHub/Id"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { SyncActivityError, SyncRateLimited } from "../GitHub/SyncSupport.ts"
import type { GitHubTransport } from "../GitHub/Transport.ts"
import { get, type RepositoryTarget, repositoryPath } from "../Labeling/GitHubIssue.ts"

/**
 * Whether a `/janitor` invoker may start a review (EFF-1644), ported from the
 * issue review's `effectivePermission` at janitor `7ec1d68`. Identities match
 * by stable numeric ID, and a failed lookup denies.
 */

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

export type Permission =
  | { readonly _tag: "Sufficient"; readonly login: string }
  | { readonly _tag: "Insufficient"; readonly reason: string }

export const deniedReasons = {
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
    {
      scope: { _tag: "Installation", installationId: repository.installationId },
      priority: "foreground",
      method: "GET",
      url: `${repositoryPath(repository)}/collaborators/${encodeURIComponent(login)}/permission`,
    },
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
