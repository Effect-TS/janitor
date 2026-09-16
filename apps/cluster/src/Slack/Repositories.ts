import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as Request from "effect/unstable/http/HttpClientRequest"
import * as Response from "effect/unstable/http/HttpClientResponse"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { GitHubAppAuth } from "../GitHub/AppAuth.ts"

export const Repository = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  installation: Schema.NonEmptyString,
})
export type Repository = typeof Repository.Type

export class Repositories extends Context.Service<
  Repositories,
  {
    readonly list: Effect.Effect<ReadonlyArray<Repository>, string>
    readonly get: (id: string) => Effect.Effect<Repository, string>
    readonly credentials: (id: string) => Effect.Effect<Redacted.Redacted<string>, string>
  }
>()("Slack/Repositories") {}

export const layerRepositories = Layer.effect(
  Repositories,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const auth = yield* GitHubAppAuth
    const http = yield* HttpClient.HttpClient
    const list = sql`SELECT repository_id::text AS id, owner || '/' || repo AS name,
    installation_id::text AS installation FROM github_repository
    WHERE connected AND repository_block_reason(repository_id) IS NULL ORDER BY owner, repo`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Repository))),
      Effect.mapError(() => "I couldn't read the connected repositories. Try again shortly."),
    )
    const get = Effect.fnUntraced(function* (id: string) {
      const repository = (yield* list).find(
        (entry) => entry.id === id || entry.name.toLowerCase() === id.toLowerCase(),
      )
      if (repository === undefined)
        return yield* Effect.fail(
          "That repository is unavailable for agent work. Check its connection, access and synchronization status in Janitor, or choose one from listRepositories.",
        )
      return repository
    })
    const credentials = Effect.fnUntraced(
      function* (id: string) {
        const repository = yield* get(id)
        const numericId = yield* Schema.decodeEffect(
          Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
        )(repository.id)
        const jwt = yield* auth.appJwt
        const response = yield* Request.post(
          `https://api.github.com/app/installations/${repository.installation}/access_tokens`,
        ).pipe(
          Request.bearerToken(Redacted.value(jwt)),
          Request.setHeaders({
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "janitor",
          }),
          Request.bodyJson({ repository_ids: [numericId], permissions: { contents: "read" } }),
          Effect.flatMap(http.execute),
          Effect.flatMap(Response.filterStatusOk),
          Effect.flatMap(
            Response.schemaBodyJson(
              Schema.Struct({ token: Schema.RedactedFromValue(Schema.NonEmptyString) }),
            ),
          ),
        )
        return response.token
      },
      Effect.mapError(
        () =>
          "GitHub repository credentials are unavailable. Check the app's installation and repository access.",
      ),
    )
    return Repositories.of({ list, get, credentials })
  }),
)
