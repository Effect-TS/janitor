import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"

const GitHubRepositoryNameSegment = Schema.NonEmptyString.check(
  Schema.isPattern(/^[^/\s]+$/),
).annotate({ identifier: "GitHubRepositoryNameSegment" })

export const GitHubRepositoryFullName = Schema.Struct({
  owner: GitHubRepositoryNameSegment,
  repo: GitHubRepositoryNameSegment,
}).annotate({ identifier: "GitHubRepositoryFullName" })
export type GitHubRepositoryFullName = typeof GitHubRepositoryFullName.Type

export const GitHubRepositoryFullNameFromString = Schema.TemplateLiteralParser([
  GitHubRepositoryNameSegment,
  Schema.Literal("/"),
  GitHubRepositoryNameSegment,
])
  .pipe(
    Schema.decodeTo(GitHubRepositoryFullName, {
      decode: SchemaGetter.transform(([owner, _, repo]) => ({ owner, repo })),
      encode: SchemaGetter.transform(({ owner, repo }) => [owner, "/", repo]),
    }),
  )
  .annotate({ identifier: "GitHubRepositoryFullNameFromString" })
