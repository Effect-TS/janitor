import type { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { type SyncGeneration, type SyncScope, syncScopeKey } from "@janitor/domain/GitHub/Sync"
import * as Cause from "effect/Cause"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Activity from "effect/unstable/workflow/Activity"
import * as DurableClock from "effect/unstable/workflow/DurableClock"
import { GITHUB_API_BASE_URL, gitHubApiScopeKey } from "@janitor/domain/GitHub/Api"
import { SyncTargets, type SyncOutcome } from "../SyncTargets.ts"
import { GitHubHttpCache } from "./HttpCache.ts"
import { nextLink } from "./Link.ts"
import { GitHubReadModel } from "./ReadModel.ts"
import {
  GitHubTransport,
  type GitHubRequest,
  type GitHubResponse,
  type GitHubTransportFailure,
} from "./Transport.ts"
import { SyncIntegration } from "../SyncIntegration.ts"

export const SyncRunOutcome = Schema.Literals(["verified", "blocked", "failed", "superseded"])
export type SyncRunOutcome = typeof SyncRunOutcome.Type

/** GitHub asked us to wait. The workflow sleeps durably and retries the activity. */
export class SyncRateLimited extends Schema.TaggedError<SyncRateLimited>()("SyncRateLimited", {
  until: Schema.DateTimeUtcFromString,
}) {}

export class SyncActivityError extends Schema.TaggedError<SyncActivityError>()(
  "SyncActivityError",
  {
    message: Schema.String,
    retryable: Schema.optional(Schema.Boolean),
  },
) {}

export const SyncActivityFailure = Schema.Union([SyncRateLimited, SyncActivityError])

export const failure = (message: string) => new SyncActivityError({ message })

export const describeFailed = (response: Extract<GitHubResponse, { _tag: "Failed" }>) =>
  `GitHub responded ${response.status}` +
  (Option.isSome(response.requestId) ? ` (request ${response.requestId.value})` : "")

export const rateLimitedOrFailure = <A, R>(effect: Effect.Effect<A, GitHubTransportFailure, R>) =>
  Effect.mapError(effect, (error): SyncRateLimited | SyncActivityError =>
    error._tag === "GitHubRateLimited"
      ? new SyncRateLimited({ until: error.until })
      : new SyncActivityError({
          message: error.message,
          retryable:
            error._tag === "@janitor/cluster/GitHub/RateBudget/GitHubBudgetError" ||
            (error._tag === "GitHubTransportError" &&
              error.stage !== undefined &&
              error.stage !== "authentication"),
        }),
  )

const MAX_RATE_LIMIT_WAITS = 24

/**
 * Runs `make(attempt)` and, when GitHub rate limits it, sleeps on a uniquely
 * named durable clock until the budget says to try again. Each attempt is its
 * own activity so a replay after eviction resumes at the right step.
 */
export const withRateLimitWaits = <A, R>(
  name: string,
  make: (attempt: number) => Effect.Effect<A, SyncRateLimited | SyncActivityError, R>,
) =>
  Effect.gen(function* () {
    let transientRetries = 0
    for (let attempt = 0; attempt < MAX_RATE_LIMIT_WAITS; attempt++) {
      const result = yield* make(attempt).pipe(Effect.result)
      if (result._tag === "Success") {
        return result.success
      }
      if (result.failure._tag === "SyncActivityError") {
        if (!result.failure.retryable || transientRetries >= 3) return yield* result.failure
        // Stable jitter keeps workflow replay deterministic without another activity.
        const jitter =
          name.split("").reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % 1000
        yield* DurableClock.sleep({
          name: `${name}/retry-${attempt}`,
          duration: Duration.millis(2000 * 2 ** transientRetries++ + jitter),
        })
        continue
      }
      const now = yield* DateTime.now
      const wait = Duration.max(
        Duration.millis(DateTime.toEpochMillis(result.failure.until) - DateTime.toEpochMillis(now)),
        Duration.seconds(1),
      )
      yield* DurableClock.sleep({ name: `${name}/wait-${attempt}`, duration: wait })
    }
    return yield* failure(`Rate limited ${MAX_RATE_LIMIT_WAITS} times while running ${name}`)
  })

export interface CacheOptions {
  /** Lets access-loss purges remove pages holding this repository's content. */
  readonly repositoryId: Option.Option<GitHubRepositoryDatabaseId>
}

const absoluteUrl = (url: string) =>
  url.startsWith("https://") ? url : `${GITHUB_API_BASE_URL}${url}`

/**
 * Sends one request through the transport and decodes a 200 body with
 * `schema`. With `cache`, the stored ETag makes the request conditional and a
 * `304` serves the stored representation, which still validates only that
 * exact page.
 */
export const fetchJson = <S extends Schema.Top>(
  request: GitHubRequest,
  schema: S,
  cache?: CacheOptions,
) =>
  Effect.gen(function* () {
    const transport = yield* GitHubTransport
    const httpCache = yield* GitHubHttpCache
    const key = {
      scopeKey: gitHubApiScopeKey(request.scope),
      method: request.method,
      url: absoluteUrl(request.url),
    }
    const cached =
      cache === undefined
        ? Option.none()
        : yield* httpCache.get(key).pipe(Effect.mapError((error) => failure(error.message)))
    const response = yield* transport
      .request({
        ...request,
        etag: Option.getOrUndefined(Option.map(cached, (entry) => entry.etag)),
      })
      .pipe(rateLimitedOrFailure)
    switch (response._tag) {
      case "Ok": {
        const body = yield* Schema.decodeUnknownEffect(schema)(response.body).pipe(
          Effect.mapError((error) => failure(`${request.url} did not decode: ${error.message}`)),
        )
        const next = Option.flatMap(response.link, nextLink)
        if (cache !== undefined && Option.isSome(response.etag)) {
          yield* httpCache
            .put({
              ...key,
              etag: response.etag.value,
              body: response.body,
              next,
              repositoryId: cache.repositoryId,
            })
            .pipe(Effect.mapError((error) => failure(error.message)))
        }
        return { _tag: "Ok" as const, body, next, fromCache: false }
      }
      case "NotModified": {
        if (Option.isNone(cached)) {
          return yield* failure("Unexpected 304 without a conditional request")
        }
        const body = yield* Schema.decodeUnknownEffect(schema)(cached.value.body).pipe(
          Effect.mapError((error) =>
            failure(`${request.url} cached page did not decode: ${error.message}`),
          ),
        )
        return { _tag: "Ok" as const, body, next: cached.value.next, fromCache: true }
      }
      case "Failed":
        if (request.method === "GET" && response.status >= 500) {
          return yield* new SyncActivityError({
            message: describeFailed(response),
            retryable: true,
          })
        }
        return {
          _tag: "Failed" as const,
          status: response.status,
          message: describeFailed(response),
        }
    }
  })

/** The URL of the page after `url`, for probing beyond a formerly full final page. */
export const probeUrl = (url: string): string => {
  const parsed = new URL(absoluteUrl(url))
  const page = Number(parsed.searchParams.get("page") ?? "1")
  parsed.searchParams.set("page", String(Number.isFinite(page) && page > 0 ? page + 1 : 2))
  return parsed.toString()
}

export const PAGE_SIZE = 100

export const MAX_PAGES = 200

/**
 * Follows `Link: rel="next"` from `firstUrl`, running one uniquely named
 * activity per page. Returns every item, or a failure describing the page.
 */
export const paginate = <A, S extends Schema.Top, E = never, R = never>(options: {
  readonly name: string
  readonly firstUrl: string
  readonly request: Omit<GitHubRequest, "url" | "method">
  readonly page: S
  readonly items: (body: S["Type"]) => ReadonlyArray<A>
  readonly itemSchema: Schema.Codec<A, unknown>
  readonly onFailed?: ((status: number) => SyncRunOutcome | undefined) | undefined
  readonly cache?: CacheOptions | undefined
  /** Stop only after inspecting the unfiltered page. */
  readonly stopAfter?: (body: S["Type"]) => boolean
  readonly onPage?: (items: ReadonlyArray<A>, ordinal: number) => Effect.Effect<void, E, R>
  readonly collect?: boolean
  readonly allowTruncate?: boolean
  readonly maxPages?: number
}) =>
  Effect.gen(function* () {
    const collected: Array<A> = []
    let count = 0
    let next: string | null = options.firstUrl
    const pageSchema = Schema.Struct({
      items: Schema.Array(options.itemSchema),
      next: Schema.NullOr(Schema.String),
    })
    const limit = options.maxPages ?? MAX_PAGES
    type Stop = { _tag: "Failed"; message: string } | { _tag: "Blocked"; reason: string }
    let stopped:
      | { _tag: "Failed"; message: string }
      | { _tag: "Blocked"; reason: string }
      | undefined
    yield* Stream.paginate({ url: options.firstUrl, ordinal: 0 }, ({ url, ordinal }) =>
      Effect.gen(function* () {
        const result = yield* withRateLimitWaits(`${options.name}/${ordinal}`, (attempt) =>
          Activity.make({
            name: `${options.name}/${ordinal}/${attempt}`,
            success: Schema.Union([
              Schema.TaggedStruct("Page", pageSchema.fields),
              Schema.TaggedStruct("Failed", { status: Schema.Int, message: Schema.String }),
            ]),
            error: SyncActivityFailure,
            execute: Effect.gen(function* () {
              const response = yield* fetchJson(
                { ...options.request, method: "GET", url },
                options.page,
                options.cache,
              )
              if (response._tag === "Failed") {
                return {
                  _tag: "Failed" as const,
                  status: response.status,
                  message: response.message,
                }
              }
              const items = options.items(response.body)
              // A 304 on a page that was full when stored proves nothing about
              // pages after it, so probe one further rather than trust the cached end.
              const next =
                response.fromCache && Option.isNone(response.next) && items.length >= PAGE_SIZE
                  ? Option.some(probeUrl(url))
                  : response.next
              return {
                _tag: "Page" as const,
                items,
                next: options.stopAfter?.(response.body) ? null : Option.getOrNull(next),
              }
            }),
          }),
        ).pipe(Effect.result)
        if (result._tag === "Failure") {
          return [
            [{ _tag: "Failed" as const, message: result.failure.message }] as ReadonlyArray<Stop>,
            Option.none(),
          ] as const
        }
        if (result.success._tag === "Failed") {
          const blocked = options.onFailed?.(result.success.status)
          return [
            [
              blocked === "blocked"
                ? { _tag: "Blocked" as const, reason: `http-${result.success.status}` }
                : { _tag: "Failed" as const, message: result.success.message },
            ] as ReadonlyArray<Stop>,
            Option.none(),
          ] as const
        }
        if (options.onPage) yield* options.onPage(result.success.items, ordinal)
        count += result.success.items.length
        if (options.collect !== false) collected.push(...result.success.items)
        next = result.success.next
        return [
          [] as ReadonlyArray<Stop>,
          next !== null && ordinal + 1 < limit
            ? Option.some({ url: next, ordinal: ordinal + 1 })
            : Option.none(),
        ] as const
      }),
    ).pipe(
      Stream.runForEach((result) =>
        Effect.sync(() => {
          stopped = result
        }),
      ),
    )
    if (stopped) return stopped
    if (next !== null && !options.allowTruncate) {
      return { _tag: "Failed" as const, message: `${options.name} exceeded ${limit} pages` }
    }
    return {
      _tag: "Complete" as const,
      items: collected as ReadonlyArray<A>,
      count,
      complete: next === null,
    }
  })

/** Records the run outcome on the target inside its own activity. */
export const completeRun = (
  name: string,
  scope: SyncScope,
  generation: SyncGeneration,
  outcome: SyncOutcome,
) =>
  Activity.make({
    name: `${name}/Complete/${outcome._tag}`,
    error: SyncActivityError,
    execute: Effect.gen(function* () {
      const targets = yield* SyncTargets
      const accepted = yield* targets
        .complete({ scope, generation, outcome })
        .pipe(Effect.mapError((error) => failure(error.message)))
      if (accepted && outcome._tag === "Verified" && scope._tag === "RepositoryTrack") {
        const integration = yield* SyncIntegration
        yield* integration
          .trackVerified(scope.repositoryId)
          .pipe(Effect.mapError((error) => failure(error.message)))
      }
      const detail =
        outcome._tag === "Failed"
          ? outcome.error
          : outcome._tag === "Blocked"
            ? outcome.reason
            : undefined
      yield* Effect.logWithLevel(outcome._tag === "Verified" ? "Info" : "Warn")(
        "Completed GitHub sync run",
      ).pipe(
        Effect.annotateLogs({
          workflow: name,
          scope: syncScopeKey(scope),
          generation,
          outcome: outcome._tag,
          accepted,
          ...(detail === undefined ? {} : { detail }),
        }),
      )
    }),
  })

/**
 * Workflow bodies run inside the engine, which records a failed exit without
 * surfacing it. Log the cause so a dead run is visible in Worker logs.
 */
export const logWorkflowFailure =
  (name: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.tapCause(effect, (cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logError(`${name} workflow failed`, cause).pipe(
            Effect.annotateLogs({ workflow: name }),
          ),
    )

/** Resolves the repository a track belongs to, or the reason it cannot be scanned. */
export const resolveRepository = (repositoryId: GitHubRepositoryDatabaseId) =>
  Effect.gen(function* () {
    const readModel = yield* GitHubReadModel
    const repository = yield* readModel
      .getRepository(repositoryId)
      .pipe(Effect.mapError((error) => failure(error.message)))
    if (Option.isNone(repository)) {
      return { _tag: "Blocked" as const, reason: "repository-unknown" }
    }
    if (!repository.value.enabled)
      return { _tag: "Blocked" as const, reason: "repository-disabled" }
    if (repository.value.access !== "accessible") {
      return { _tag: "Blocked" as const, reason: `repository-access-${repository.value.access}` }
    }
    return { _tag: "Found" as const, repository: repository.value }
  })

/** Each HTTP request has its own durable result; later rate limits do not repeat it. */
export const fetchInActivity = <S extends Schema.Top>(
  name: string,
  request: GitHubRequest,
  schema: S,
) =>
  withRateLimitWaits(name, (attempt) =>
    Activity.make({
      name: `${name}/${attempt}`,
      success: Schema.Union([
        Schema.TaggedStruct("Ok", { body: schema }),
        Schema.TaggedStruct("Failed", { status: Schema.Int, message: Schema.String }),
      ]),
      error: SyncActivityFailure,
      execute: fetchJson(request, schema).pipe(
        Effect.map((response) =>
          response._tag === "Failed" ? response : { _tag: "Ok" as const, body: response.body },
        ),
      ),
    }),
  )
