import { GitHubInstallationId } from "@janitor/domain/GitHub/Id"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { GitHubTransport } from "../GitHub/Transport.ts"
import type { Eligibility } from "../RepositoryEligibility.ts"

export interface SummaryComment {
  readonly id: string
  readonly body: string
}

/** Only summary comment reads and writes cross this publication boundary. */
export class ReviewComments extends Context.Service<
  ReviewComments,
  {
    readonly checkLinks: (
      repository: Eligibility,
      body: string,
      permitted: ReadonlyArray<string>,
    ) => Effect.Effect<boolean, unknown>
    readonly list: (
      repository: Eligibility,
      issue: number,
    ) => Effect.Effect<ReadonlyArray<SummaryComment>, unknown>
    readonly get: (
      repository: Eligibility,
      id: string,
    ) => Effect.Effect<SummaryComment | null, unknown>
    readonly write: (
      repository: Eligibility,
      issue: number,
      id: string | null,
      body: string,
    ) => Effect.Effect<SummaryComment, unknown>
  }
>()("Review/Comments") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const transport = yield* GitHubTransport
      const Comment = Schema.Struct({
        id: Schema.Int,
        body: Schema.String,
        performed_via_github_app: Schema.NullOr(Schema.Struct({ id: Schema.Int })),
      })
      const appId = Effect.gen(function* () {
        const response = yield* transport.request({
          scope: { _tag: "App" },
          priority: "foreground",
          method: "GET",
          url: "/app",
        })
        if (response._tag !== "Ok") return yield* Effect.fail("Cannot verify summary ownership.")
        return (yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Int }))(response.body))
          .id
      })
      const request = (
        repository: Eligibility,
        method: "GET" | "POST" | "PATCH",
        path: string,
        body?: string,
      ) =>
        transport.request({
          scope: {
            _tag: "Installation",
            installationId: GitHubInstallationId.make(repository.installationId),
          },
          priority: "foreground",
          method,
          url: `/repos/${repository.name}/${path}`,
          repositoryPermission: {
            repositoryId: repository.repositoryId,
            issues: method === "GET" ? "read" : "write",
          },
          ...(body === undefined ? {} : { body: { body } }),
        })
      return {
        checkLinks: (repository, body, permitted) =>
          Effect.gen(function* () {
            // Repository-defined autolinks cannot be inferred from Markdown text.
            // Ask GitHub to render in this repository's context, then allow only evidence links.
            const response = yield* transport.request({
              scope: {
                _tag: "Installation",
                installationId: GitHubInstallationId.make(repository.installationId),
              },
              priority: "foreground",
              method: "POST",
              url: "/markdown",
              repositoryPermission: {
                repositoryId: repository.repositoryId,
                issues: "read",
                contents: "read",
              },
              body: { text: body, mode: "gfm", context: repository.name },
            })
            if (response._tag !== "Ok" || typeof response.body !== "string")
              return yield* Effect.fail("Cannot validate rendered summary links.")
            const links = [...response.body.matchAll(/\b(?:href|src)\s*=\s*["']([^"']*)["']/gi)]
            return links.every(([, url]) =>
              permitted.includes(url!.replace(/#L\d+(?:-L\d+)?$/, "")),
            )
          }),
        list: (repository, issue) =>
          Effect.gen(function* () {
            const owner = yield* appId
            const comments: Array<SummaryComment> = []
            for (let page = 1; ; page++) {
              const response = yield* request(
                repository,
                "GET",
                `issues/${issue}/comments?per_page=100&page=${page}`,
              )
              if (response._tag !== "Ok")
                return yield* Effect.fail("Cannot reconcile summary comments.")
              const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Comment))(response.body)
              comments.push(
                ...rows
                  .filter((c) => c.performed_via_github_app?.id === owner)
                  .map((c) => ({ id: String(c.id), body: c.body })),
              )
              if (rows.length < 100) return comments
            }
          }),
        get: (repository, id) =>
          Effect.gen(function* () {
            const owner = yield* appId
            const response = yield* request(
              repository,
              "GET",
              `issues/comments/${encodeURIComponent(id)}`,
            )
            if (response._tag === "Failed" && response.status === 404) return null
            if (response._tag !== "Ok") return yield* Effect.fail("Cannot read summary comment.")
            const comment = yield* Schema.decodeUnknownEffect(Comment)(response.body)
            if (comment.performed_via_github_app?.id !== owner)
              return yield* Effect.fail("Summary ownership changed.")
            return { id: String(comment.id), body: comment.body }
          }),
        write: (repository, issue, id, body) =>
          Effect.gen(function* () {
            const response = yield* request(
              repository,
              id === null ? "POST" : "PATCH",
              id === null
                ? `issues/${issue}/comments`
                : `issues/comments/${encodeURIComponent(id)}`,
              body,
            )
            if (response._tag !== "Ok")
              return yield* Effect.fail("GitHub did not confirm the summary write.")
            const comment = yield* Schema.decodeUnknownEffect(Comment)(response.body)
            return { id: String(comment.id), body: comment.body }
          }),
      }
    }),
  )
}
