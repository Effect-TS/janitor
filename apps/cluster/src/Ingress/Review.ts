import { SavedPublication } from "@janitor/domain/Review/Publication"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import {
  CancelReviewRequest,
  ReviewHistory,
  ReviewSettings,
  SetReviewSettingsRequest,
} from "@janitor/domain/Review/Run"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { RunSnapshot } from "../Review/Agent.ts"
import { IssueReviewControl } from "../Review/Control.ts"
import { IssueReviewSettings } from "../Review/Settings.ts"
import { IssueReviewStore } from "../Review/Store.ts"
import { CurrentAccessIdentity, CurrentTeammate } from "./Middleware.ts"
import { SameOriginMiddleware } from "./Sync.ts"

/**
 * Issue review from the frontend: settings behind the ordinary teammate
 * authorization, the run history, and Cancel run, which additionally needs
 * the teammate's linked GitHub identity to hold write or admin permission
 * on the repository right now.
 */

const RepositoryPath = Schema.Struct({ repositoryId: GitHubRepositoryDatabaseId })
const RunPath = Schema.Struct({
  repositoryId: GitHubRepositoryDatabaseId,
  runId: Schema.NonEmptyString,
})
const json = HttpServerResponse.schemaJson
const respondMessage = json(Schema.Struct({ message: Schema.String }))
const badRequest = HttpServerResponse.text("Bad Request", { status: 400 })
const notFound = HttpServerResponse.empty({ status: 404 })
const unavailableResponse = HttpServerResponse.text("Service Unavailable", {
  status: 503,
  headers: { "Retry-After": "10" },
})

const handled =
  (operation: string) =>
  <A, E, R>(route: Effect.Effect<A, E, R>) =>
    route.pipe(
      Effect.catch(
        (
          error: E,
        ): Effect.Effect<HttpServerResponse.HttpServerResponse, E | HttpBody.HttpBodyError> => {
          const tagged = error as { readonly _tag?: string; readonly message?: string }
          switch (tagged._tag) {
            case "SchemaError":
            case "HttpServerError":
              return Effect.succeed(badRequest)
            case "ReviewRepositoryMissing":
            case "ReviewRunNotFound":
              return Effect.succeed(notFound)
            case "ReviewUnavailable":
            case "ReviewRunFinished":
              return respondMessage(
                {
                  message:
                    tagged._tag === "ReviewRunFinished"
                      ? "This run already finished."
                      : String(tagged.message),
                },
                { status: 409 },
              )
            case "ReviewForbidden":
              return respondMessage({ message: String(tagged.message) }, { status: 403 })
            default:
              return Effect.fail(error)
          }
        },
      ),
      Effect.catchCause((cause) =>
        Effect.logError(`Issue review ${operation} failed`, cause).pipe(
          Effect.as(unavailableResponse),
        ),
      ),
    )

const reads = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/repositories/:repositoryId/issue-review",
    Effect.gen(function* () {
      const { repositoryId } = yield* HttpRouter.schemaPathParams(RepositoryPath)
      return yield* json(ReviewSettings)(yield* (yield* IssueReviewSettings).get(repositoryId))
    }).pipe(handled("settings")),
  ),
  HttpRouter.route(
    "GET",
    "/repositories/:repositoryId/reviews",
    Effect.gen(function* () {
      const { repositoryId } = yield* HttpRouter.schemaPathParams(RepositoryPath)
      // Settings first: an unknown repository is a 404, not an empty history.
      yield* (yield* IssueReviewSettings).get(repositoryId)
      const runs = yield* (yield* IssueReviewStore).history(repositoryId)
      const teammate = yield* CurrentTeammate
      const control = yield* IssueReviewControl
      const eligible = yield* Effect.forEach(runs, (run) =>
        run.dryRun && run.status === "completed" && run.savedPublication == null
          ? control
              .canPublish(repositoryId, run.runId, teammate.teammateId)
              .pipe(Effect.map((canPublish) => ({ ...run, canPublish })))
          : Effect.succeed({ ...run, canPublish: false }),
      )
      return yield* json(ReviewHistory)({ runs: eligible })
    }).pipe(handled("history")),
  ),
])

const writes = HttpRouter.addAll([
  HttpRouter.route(
    "POST",
    "/repositories/:repositoryId/reviews/:runId/publish",
    Effect.gen(function* () {
      const { repositoryId, runId } = yield* HttpRouter.schemaPathParams(RunPath)
      const teammate = yield* CurrentTeammate
      return yield* json(SavedPublication)(
        yield* (yield* IssueReviewControl).publish(repositoryId, runId, teammate.teammateId),
      )
    }).pipe(handled("publish")),
  ),

  HttpRouter.route(
    "PUT",
    "/repositories/:repositoryId/issue-review",
    Effect.gen(function* () {
      const { repositoryId } = yield* HttpRouter.schemaPathParams(RepositoryPath)
      const request = yield* HttpServerRequest.schemaBodyJson(SetReviewSettingsRequest)
      const identity = yield* CurrentAccessIdentity
      const settings = yield* (yield* IssueReviewSettings).set(repositoryId, request, {
        issuer: identity.issuer,
        subject: identity.subject,
      })
      return yield* json(ReviewSettings)(settings)
    }).pipe(handled("settings change")),
  ),
  HttpRouter.route(
    "POST",
    "/repositories/:repositoryId/reviews/:runId/cancel",
    Effect.gen(function* () {
      const { repositoryId, runId } = yield* HttpRouter.schemaPathParams(RunPath)
      const request = yield* HttpServerRequest.schemaBodyJson(CancelReviewRequest)
      const teammate = yield* CurrentTeammate
      const snapshot = yield* (yield* IssueReviewControl).cancel(
        repositoryId,
        runId,
        teammate.teammateId,
        request.reason,
      )
      return yield* json(RunSnapshot)(snapshot)
    }).pipe(handled("cancel")),
  ),
]).pipe(Layer.provide(SameOriginMiddleware))

export const ReviewRoutesLayer = Layer.mergeAll(reads, writes)
