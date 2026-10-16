import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { RunId } from "@janitor/domain/PullRequestReview/Run"
import {
  RepositorySettings,
  RunPage,
  SetRepositorySettingsRequest,
} from "@janitor/domain/PullRequestReview/Settings"
import { GitHubReadModel } from "../GitHub/ReadModel.ts"
import { pullRequestReviewDeployment } from "../PullRequestReview/Config.ts"
import { errorFields } from "../PullRequestReview/Log.ts"
import { RepositoryDisabler } from "../PullRequestReview/Scheduler.ts"
import { PullRequestReviewStore } from "../PullRequestReview/Store.ts"
import { SameOriginMiddleware } from "./Sync.ts"

/**
 * PR review's repository settings and runs list (EFF-1930). Every route sits
 * behind the Access assertion; the write also requires same origin.
 */

/** Runs per page, as on Activity. */
const RUN_PAGE_SIZE = 50

const repositoryPath = HttpRouter.schemaPathParams(
  Schema.Struct({ repositoryId: GitHubRepositoryDatabaseId }),
)

const badRequest = HttpServerResponse.text("Bad Request", { status: 400 })
const notFound = HttpServerResponse.empty({ status: 404 })
const unavailableResponse = HttpServerResponse.text("Service Unavailable", {
  status: 503,
  headers: { "Retry-After": "10" },
})

const isBadRequest = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error._tag === "SchemaError" || error._tag === "HttpServerError")

/** Malformed requests are a 400; anything else is a 503. */
const handled =
  (operation: string) =>
  <E, R>(route: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    route.pipe(
      Effect.catchIf(isBadRequest, () => Effect.succeed(badRequest)),
      Effect.catchCause((cause) =>
        Effect.logError(`PR review ${operation} failed`).pipe(
          Effect.annotateLogs(errorFields(Cause.squash(cause))),
          Effect.as(unavailableResponse),
        ),
      ),
    )

/** The repository janitor knows, or none. */
const repository = (repositoryId: GitHubRepositoryDatabaseId) =>
  Effect.flatMap(GitHubReadModel, (readModel) => readModel.getRepository(repositoryId))

const settings = (repositoryId: GitHubRepositoryDatabaseId) =>
  Effect.gen(function* () {
    const store = yield* PullRequestReviewStore
    return {
      repositoryId,
      enabled: yield* store.isEnabled(repositoryId),
      deployment: yield* pullRequestReviewDeployment,
    }
  })

const respondSettings = (repositoryId: GitHubRepositoryDatabaseId) =>
  Effect.flatMap(settings(repositoryId), (value) =>
    HttpServerResponse.schemaJson(RepositorySettings)(value),
  )

const reads = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/repositories/:repositoryId/pull-request-review",
    Effect.gen(function* () {
      const { repositoryId } = yield* repositoryPath
      if (Option.isNone(yield* repository(repositoryId))) return notFound
      return yield* respondSettings(repositoryId)
    }).pipe(handled("settings")),
  ),
  HttpRouter.route(
    "GET",
    "/repositories/:repositoryId/pull-request-review/runs",
    Effect.gen(function* () {
      const { repositoryId } = yield* repositoryPath
      const { cursor } = yield* HttpRouter.schemaParams(
        Schema.Struct({ cursor: Schema.optionalKey(RunId) }),
      )
      if (Option.isNone(yield* repository(repositoryId))) return notFound
      const page = yield* (yield* PullRequestReviewStore).runs(repositoryId, {
        limit: RUN_PAGE_SIZE,
        cursor: Option.fromNullishOr(cursor),
      })
      // Encoding drops the store columns the runs list doesn't show.
      return yield* HttpServerResponse.schemaJson(RunPage)({
        runs: page.runs,
        cursor: Option.getOrNull(page.next),
      })
    }).pipe(handled("runs")),
  ),
])

const writes = HttpRouter.add(
  "PUT",
  "/repositories/:repositoryId/pull-request-review",
  Effect.gen(function* () {
    const { repositoryId } = yield* repositoryPath
    const { enabled } = yield* HttpServerRequest.schemaBodyJson(SetRepositorySettingsRequest)
    const found = yield* repository(repositoryId)
    if (Option.isNone(found)) return notFound
    if (enabled) {
      // Unknown visibility counts as private, as in admission (EFF-1645 point 3).
      if (found.value.isPrivate !== false)
        return yield* HttpServerResponse.schemaJson(Schema.Struct({ message: Schema.String }))(
          { message: "PR review can't be enabled for a private repository." },
          { status: 409 },
        )
      yield* (yield* PullRequestReviewStore).setEnabled(repositoryId, true)
    } else {
      yield* (yield* RepositoryDisabler).disable(repositoryId)
    }
    yield* Effect.logInfo(enabled ? "PR review enabled" : "PR review disabled").pipe(
      Effect.annotateLogs({ repositoryId }),
    )
    return yield* respondSettings(repositoryId)
  }).pipe(handled("setSettings")),
).pipe(Layer.provide(SameOriginMiddleware))

export const PullRequestReviewRoutesLayer = Layer.mergeAll(reads, writes)
