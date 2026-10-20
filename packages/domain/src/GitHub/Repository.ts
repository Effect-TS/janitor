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

/**
 * Why repository work is refused. `changed` is work accepted under an
 * earlier eligibility generation, refused even after restoration.
 */
export const RepositoryBlockReason = Schema.Literals([
  "not-connected",
  "disconnected",
  "access-unavailable",
  "paused",
  "changed",
])
export type RepositoryBlockReason = typeof RepositoryBlockReason.Type

/** Work refused with the concrete repository block reason. */
export class RepositoryBlocked extends Schema.TaggedError<RepositoryBlocked>()(
  "RepositoryBlocked",
  { repositoryId: Schema.String, reason: RepositoryBlockReason },
  { httpApiStatus: 409 },
) {
  override get message() {
    return this.reason
  }
}
