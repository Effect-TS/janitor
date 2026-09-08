import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  GitHubAccountDatabaseIdFromStringOrNumber,
  GitHubInstallationIdFromStringOrNumber,
  GitHubRepositoryDatabaseIdFromStringOrNumber,
  GitHubRepositoryNodeId,
  GitHubUserDatabaseIdFromStringOrNumber,
} from "./Id.ts"
import { GitHubRepositoryFullNameFromString } from "./Repository.ts"
const GitHubRepositoryCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
  identifier: "GitHubRepositoryCount",
})

export const GitHubAccountType = Schema.Literals(["Enterprise", "Organization", "User"]).annotate({
  identifier: "GitHubAccountType",
})
export type GitHubAccountType = typeof GitHubAccountType.Type

export const GitHubInstallationRepositorySelection = Schema.Literals(["all", "selected"]).annotate({
  identifier: "GitHubInstallationRepositorySelection",
})
export type GitHubInstallationRepositorySelection =
  typeof GitHubInstallationRepositorySelection.Type

const GitHubInstallationUserOrOrganizationAccount = Schema.Struct({
  id: GitHubAccountDatabaseIdFromStringOrNumber,
  login: Schema.NonEmptyString,
  type: Schema.Literals(["Organization", "User"]),
}).annotate({ identifier: "GitHubInstallationUserOrOrganizationAccount" })

const GitHubInstallationEnterpriseAccountApi = Schema.Struct({
  id: GitHubAccountDatabaseIdFromStringOrNumber,
  slug: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
}).annotate({ identifier: "GitHubInstallationEnterpriseAccountApi" })

const GitHubInstallationEnterpriseAccount = GitHubInstallationEnterpriseAccountApi.pipe(
  Schema.extendTo(
    { type: Schema.Literal("Enterprise") },
    { type: () => Option.some<"Enterprise">("Enterprise") },
  ),
).annotate({ identifier: "GitHubInstallationEnterpriseAccount" })

const GitHubInstallationAccount = Schema.Union([
  GitHubInstallationUserOrOrganizationAccount,
  GitHubInstallationEnterpriseAccount,
]).annotate({ identifier: "GitHubInstallationAccount" })

export const GitHubInstallationSuspendingUser = Schema.Struct({
  id: GitHubUserDatabaseIdFromStringOrNumber,
  login: Schema.NonEmptyString,
}).annotate({ identifier: "GitHubInstallationSuspendingUser" })
export type GitHubInstallationSuspendingUser = typeof GitHubInstallationSuspendingUser.Type

export const GitHubInstallationSummary = Schema.Struct({
  id: GitHubInstallationIdFromStringOrNumber,
  account: GitHubInstallationAccount,
  repositorySelection: GitHubInstallationRepositorySelection,
  htmlUrl: Schema.NonEmptyString,
  suspendedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  suspendedBy: Schema.optionalKey(Schema.NullOr(GitHubInstallationSuspendingUser)),
})
  .pipe(
    Schema.encodeKeys({
      repositorySelection: "repository_selection",
      htmlUrl: "html_url",
      suspendedAt: "suspended_at",
      suspendedBy: "suspended_by",
    }),
  )
  .annotate({ identifier: "GitHubInstallationSummary" })
export type GitHubInstallationSummary = typeof GitHubInstallationSummary.Type

export const GitHubInstallationRepository = Schema.Struct({
  id: GitHubRepositoryDatabaseIdFromStringOrNumber,
  nodeId: Schema.optionalKey(GitHubRepositoryNodeId),
  fullName: GitHubRepositoryFullNameFromString,
  isPrivate: Schema.Boolean,
})
  .pipe(Schema.encodeKeys({ nodeId: "node_id", fullName: "full_name", isPrivate: "private" }))
  .annotate({ identifier: "GitHubInstallationRepository" })
export type GitHubInstallationRepository = typeof GitHubInstallationRepository.Type

export const GitHubInstallationRepositoriesResponse = Schema.Struct({
  totalCount: GitHubRepositoryCount,
  repositorySelection: Schema.optionalKey(GitHubInstallationRepositorySelection),
  repositories: Schema.Array(GitHubInstallationRepository),
})
  .pipe(
    Schema.encodeKeys({
      totalCount: "total_count",
      repositorySelection: "repository_selection",
    }),
  )
  .annotate({ identifier: "GitHubInstallationRepositoriesResponse" })
export type GitHubInstallationRepositoriesResponse =
  typeof GitHubInstallationRepositoriesResponse.Type
