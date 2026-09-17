import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as Request from "effect/unstable/http/HttpClientRequest"
import * as Response from "effect/unstable/http/HttpClientResponse"
import { GitHubAppAuth } from "../GitHub/AppAuth.ts"
import {
  type Eligibility,
  RepositoryEligibility,
  changedReason,
  missingReason,
} from "../RepositoryEligibility.ts"

export const Repository = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  installation: Schema.NonEmptyString,
  /** The eligibility generation the repository was observed under. */
  generation: Schema.NonEmptyString,
})
export type Repository = typeof Repository.Type

export class Repositories extends Context.Service<
  Repositories,
  {
    /** Connected repositories that are currently eligible for agent work. */
    readonly list: Effect.Effect<ReadonlyArray<Repository>, string>
    /** A repository by id or `owner/repo`, or the concrete reason it is unavailable. */
    readonly get: (id: string) => Effect.Effect<Repository, string>
    readonly credentials: (id: string) => Effect.Effect<Redacted.Redacted<string>, string>
  }
>()("Slack/Repositories") {}

/**
 * Pins repository lookups to the eligibility generation first observed. Work
 * accepted under one generation is refused once connection, pause or access
 * change, even after restoration; the next input observes the new generation.
 */
export const pinGeneration = (repositories: Repositories["Service"]): Repositories["Service"] => {
  const observed = new Map<string, string>()
  const pinned = (repository: Repository) => {
    const generation = observed.get(repository.id)
    if (generation === undefined) {
      observed.set(repository.id, repository.generation)
      return Effect.succeed(repository)
    }
    return generation === repository.generation
      ? Effect.succeed(repository)
      : Effect.fail(changedReason)
  }
  const get = (id: string) => repositories.get(id).pipe(Effect.flatMap(pinned))
  return {
    list: repositories.list.pipe(Effect.flatMap(Effect.forEach(pinned))),
    get,
    credentials: (id) =>
      get(id).pipe(Effect.flatMap((repository) => repositories.credentials(repository.id))),
  }
}

const unavailableCredentials =
  "GitHub repository credentials are unavailable. Check the app's installation and repository access."

export const layerRepositories = Layer.effect(
  Repositories,
  Effect.gen(function* () {
    const eligibility = yield* RepositoryEligibility
    const auth = yield* GitHubAppAuth
    const http = yield* HttpClient.HttpClient
    const known = eligibility.list.pipe(
      Effect.mapError(() => "I couldn't read the connected repositories. Try again shortly."),
    )
    const repository = (entry: Eligibility): Repository => ({
      id: entry.repositoryId,
      name: entry.name,
      installation: entry.installationId,
      generation: entry.generation,
    })
    const list = known.pipe(
      Effect.map((entries) =>
        entries.filter((entry) => entry.blockReason === null).map(repository),
      ),
    )
    const get = Effect.fnUntraced(function* (id: string) {
      const entry = (yield* known).find(
        (candidate) =>
          candidate.repositoryId === id || candidate.name.toLowerCase() === id.toLowerCase(),
      )
      if (entry === undefined)
        return yield* Effect.fail(`${missingReason} Choose one from listRepositories.`)
      if (entry.blockReason !== null) return yield* Effect.fail(entry.blockReason)
      return repository(entry)
    })
    const credentials = Effect.fnUntraced(function* (id: string) {
      const repository = yield* get(id)
      const numericId = yield* Schema.decodeEffect(
        Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
      )(repository.id).pipe(Effect.orDie)
      const jwt = yield* auth.appJwt.pipe(Effect.mapError(() => unavailableCredentials))
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
        Effect.mapError(() => unavailableCredentials),
      )
      return response.token
    })
    return Repositories.of({ list, get, credentials })
  }),
)
