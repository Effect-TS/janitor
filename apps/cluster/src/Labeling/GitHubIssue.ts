import { GitHubIssueApi, GitHubLabelApi } from "@janitor/domain/GitHub/Api"
import type { GitHubInstallationId } from "@janitor/domain/GitHub/Id"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { nextLink } from "../GitHub/Link.ts"
import {
  describeFailed,
  rateLimitedOrFailure,
  SyncActivityError,
  SyncRateLimited,
} from "../GitHub/SyncSupport.ts"
import { GitHubTransport, type GitHubRequest, type GitHubResponse } from "../GitHub/Transport.ts"

/**
 * Current item facts read straight from GitHub (ADR 0006). Nothing here
 * touches the read model. Rate limits surface as `SyncRateLimited` so the
 * caller chooses how to wait: durably inside a workflow, briefly in a test
 * bench.
 */

/**
 * How a caller waits out a throttle or a transient failure of one read.
 * `name` distinguishes durable clocks, so a caller passes a unique one per
 * read. `X` is what the waiting itself requires (a workflow instance for
 * durable waits, nothing for brief ones).
 */
export type Waits<X = never> = <A, R>(
  name: string,
  effect: Effect.Effect<A, SyncRateLimited | SyncActivityError, R>,
) => Effect.Effect<A, SyncActivityError, R | X>

export interface RepositoryTarget {
  readonly installationId: GitHubInstallationId
  readonly owner: string
  readonly repo: string
}

export type IssueFetch =
  | { readonly _tag: "Found"; readonly issue: GitHubIssueApi }
  /** GitHub answered without the issue: gone, forbidden, or renamed away. */
  | { readonly _tag: "Unavailable"; readonly status: number; readonly message: string }

const PAGE = 100
/** Bounds the label catalog one write attempt reads. */
const MAX_LABEL_PAGES = 20

const request = (
  repository: RepositoryTarget,
  priority: GitHubRequest["priority"],
  method: GitHubRequest["method"],
  url: string,
  body?: unknown,
): GitHubRequest => ({
  scope: { _tag: "Installation", installationId: repository.installationId },
  priority,
  method,
  url,
  ...(body === undefined ? {} : { body }),
})

export const repositoryPath = (repository: RepositoryTarget) =>
  `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`

export type Fetched<A> =
  | { readonly _tag: "Ok"; readonly body: A; readonly next: Option.Option<string> }
  | { readonly _tag: "Failed"; readonly status: number; readonly message: string }

export const get = <S extends Schema.Top>(
  target: GitHubRequest,
  schema: S,
): Effect.Effect<
  Fetched<S["Type"]>,
  SyncRateLimited | SyncActivityError,
  GitHubTransport | S["DecodingServices"]
> =>
  Effect.gen(function* () {
    const transport = yield* GitHubTransport
    const response = yield* transport.request(target).pipe(rateLimitedOrFailure)
    switch (response._tag) {
      case "Ok": {
        const body = yield* Schema.decodeUnknownEffect(schema)(response.body).pipe(
          Effect.mapError(
            (error) =>
              new SyncActivityError({ message: `${target.url} did not decode: ${error.message}` }),
          ),
        )
        return {
          _tag: "Ok",
          body,
          next: Option.flatMap(response.link, nextLink),
        } satisfies Fetched<S["Type"]>
      }
      case "NotModified":
        return yield* new SyncActivityError({
          message: "Unexpected 304 without a conditional request",
        })
      case "Failed":
        if (response.status >= 500)
          return yield* new SyncActivityError({
            message: describeFailed(response),
            retryable: true,
          })
        return {
          _tag: "Failed",
          status: response.status,
          message: describeFailed(response),
        } satisfies Fetched<S["Type"]>
    }
  })

export type Pages<A> =
  | { readonly _tag: "Ok"; readonly items: ReadonlyArray<A>; readonly truncated: boolean }
  | { readonly _tag: "Failed"; readonly status: number; readonly message: string }

/**
 * Follows `Link: rel="next"` from `firstUrl`, waiting per page, for at most
 * `maxPages` pages; `truncated` says more remained. Pages stay in memory:
 * repository content never becomes a durable workflow result.
 */
export const fetchPages = <X, S extends Schema.Top, A>(options: {
  readonly name: string
  readonly repository: RepositoryTarget
  readonly firstUrl: string
  readonly page: S
  readonly items: (body: S["Type"]) => ReadonlyArray<A>
  readonly maxPages: number
  readonly waits: Waits<X>
}): Effect.Effect<Pages<A>, SyncActivityError, GitHubTransport | S["DecodingServices"] | X> =>
  Effect.gen(function* () {
    const items: Array<A> = []
    let url: string | null = options.firstUrl
    for (let ordinal = 0; url !== null; ordinal++) {
      if (ordinal >= options.maxPages) return { _tag: "Ok", items, truncated: true } as const
      const response: Fetched<S["Type"]> = yield* options.waits(
        `${options.name}/${ordinal}`,
        get(request(options.repository, "foreground", "GET", url), options.page),
      )
      if (response._tag === "Failed") return response
      items.push(...options.items(response.body))
      url = Option.getOrNull(response.next)
    }
    return { _tag: "Ok", items, truncated: false } as const
  })

/** One issue by number. Pull requests come back too; the caller decides their scope. */
export const fetchIssue = (
  repository: RepositoryTarget,
  number: number,
  priority: GitHubRequest["priority"],
): Effect.Effect<IssueFetch, SyncRateLimited | SyncActivityError, GitHubTransport> =>
  get(
    request(repository, priority, "GET", `${repositoryPath(repository)}/issues/${number}`),
    GitHubIssueApi,
  ).pipe(
    Effect.map((response) =>
      response._tag === "Ok"
        ? { _tag: "Found", issue: response.body }
        : { _tag: "Unavailable", status: response.status, message: response.message },
    ),
  )

/** The most recently updated open items, issues and pull requests alike. */
export const fetchOpenItems = (
  repository: RepositoryTarget,
  limit: number,
): Effect.Effect<
  ReadonlyArray<GitHubIssueApi>,
  SyncRateLimited | SyncActivityError,
  GitHubTransport
> =>
  get(
    request(
      repository,
      "foreground",
      "GET",
      `${repositoryPath(repository)}/issues?state=open&sort=updated&direction=desc&per_page=${Math.min(limit, PAGE)}`,
    ),
    Schema.Array(GitHubIssueApi),
  ).pipe(
    Effect.flatMap((response) =>
      response._tag === "Ok"
        ? Effect.succeed(response.body.slice(0, limit))
        : Effect.fail(new SyncActivityError({ message: response.message })),
    ),
  )

/** The repository's current label catalog, so a write can name a label by its stable ID. */
export const fetchLabelCatalog = (
  repository: RepositoryTarget,
): Effect.Effect<
  ReadonlyArray<GitHubLabelApi>,
  SyncRateLimited | SyncActivityError,
  GitHubTransport
> =>
  Effect.gen(function* () {
    const labels: Array<GitHubLabelApi> = []
    let url: string | null = `${repositoryPath(repository)}/labels?per_page=${PAGE}`
    for (let page = 0; url !== null && page < MAX_LABEL_PAGES; page++) {
      const response: Fetched<ReadonlyArray<GitHubLabelApi>> = yield* get(
        request(repository, "foreground", "GET", url),
        Schema.Array(GitHubLabelApi),
      )
      if (response._tag === "Failed")
        return yield* new SyncActivityError({ message: response.message })
      labels.push(...response.body)
      url = Option.getOrNull(response.next)
    }
    return labels
  })

export type LabelWrite =
  | { readonly _tag: "Written" }
  /** GitHub does not know the label (add) or the issue (either). */
  | { readonly _tag: "Missing"; readonly status: number; readonly message: string }
  | { readonly _tag: "Refused"; readonly status: number; readonly message: string }

const interpret = (response: GitHubResponse): LabelWrite => {
  if (response._tag !== "Failed") return { _tag: "Written" }
  const message = describeFailed(response)
  return response.status === 404
    ? { _tag: "Missing", status: response.status, message }
    : { _tag: "Refused", status: response.status, message }
}

export const addLabel = (
  repository: RepositoryTarget,
  number: number,
  name: string,
): Effect.Effect<LabelWrite, SyncRateLimited | SyncActivityError, GitHubTransport> =>
  Effect.flatMap(GitHubTransport, (transport) =>
    transport
      .request(
        request(
          repository,
          "foreground",
          "POST",
          `${repositoryPath(repository)}/issues/${number}/labels`,
          {
            labels: [name],
          },
        ),
      )
      .pipe(rateLimitedOrFailure, Effect.map(interpret)),
  )

export const removeLabel = (
  repository: RepositoryTarget,
  number: number,
  name: string,
): Effect.Effect<LabelWrite, SyncRateLimited | SyncActivityError, GitHubTransport> =>
  Effect.flatMap(GitHubTransport, (transport) =>
    transport
      .request(
        request(
          repository,
          "foreground",
          "DELETE",
          `${repositoryPath(repository)}/issues/${number}/labels/${encodeURIComponent(name)}`,
        ),
      )
      .pipe(rateLimitedOrFailure, Effect.map(interpret)),
  )

const MAX_BRIEF_WAITS = 3
const MAX_BRIEF_WAIT = Duration.seconds(30)

/**
 * Waits briefly, without a durable clock, for callers outside a workflow such
 * as the test bench. GitHub's stated reset is honoured up to a short cap;
 * beyond that the caller reports the throttle rather than hanging a request.
 */
export const withBriefWaits = <A, R>(
  effect: Effect.Effect<A, SyncRateLimited | SyncActivityError, R>,
): Effect.Effect<A, SyncActivityError, R> =>
  Effect.gen(function* () {
    let transientRetries = 0
    for (let attempt = 0; ; attempt++) {
      const result = yield* effect.pipe(Effect.result)
      if (result._tag === "Success") return result.success
      if (result.failure._tag === "SyncActivityError") {
        if (!result.failure.retryable || transientRetries >= 2) return yield* result.failure
        yield* Effect.sleep(Duration.seconds(2 ** transientRetries++))
        continue
      }
      if (attempt >= MAX_BRIEF_WAITS)
        return yield* new SyncActivityError({
          message: "GitHub is rate limiting requests. Try again in a few minutes.",
        })
      const now = yield* DateTime.now
      const wait = Duration.millis(
        DateTime.toEpochMillis(result.failure.until) - DateTime.toEpochMillis(now),
      )
      if (Duration.isGreaterThan(wait, MAX_BRIEF_WAIT))
        return yield* new SyncActivityError({
          message: "GitHub is rate limiting requests. Try again in a few minutes.",
        })
      yield* Effect.sleep(Duration.max(wait, Duration.seconds(1)))
    }
  })

/** Brief waits for callers outside a workflow. */
export const briefWaits: Waits = (_name, effect) => withBriefWaits(effect)
