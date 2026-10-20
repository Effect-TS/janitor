import { ActivityCursor, ActivityPage } from "@janitor/domain/Labeling/Activity"
import { ActivityReader } from "../Labeling/Activity.ts"
import { AiInputDetails } from "@janitor/domain/Labeling/Policy/AiInput"
import { RuleTestJobs, RuleTestJob } from "../Labeling/RuleTestJob.ts"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { ReconciliationRecord, RepositoryOverview } from "@janitor/domain/Labeling/Reconciliation"
import {
  AiConsent,
  AuditEntry,
  ConfigurationView,
  SetAiConsentRequest,
} from "@janitor/domain/Labeling/Policy/Configuration"
import { describeCatalog, FactDescription } from "@janitor/domain/Labeling/Policy/Facts"
import { TestEntity, TestRequest, TestResponse } from "@janitor/domain/Labeling/Policy/Test"
import { RepositoryBlocked, type RepositoryNotFound } from "@janitor/domain/GitHub/Repository"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as HttpRouter from "effect/http/HttpRouter"
import type * as HttpBody from "effect/http/HttpBody"
import type * as HttpServerError from "effect/http/HttpServerError"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { AiConsentService } from "../Labeling/Classifier.ts"
import { LabelingConfiguration } from "../Labeling/Configuration.ts"
import { LabelingOverview } from "../Labeling/Overview.ts"
import { Policies } from "../Labeling/Policies.ts"
import { LabelingRules } from "../Labeling/Rules.ts"
import { LabelingTest } from "../Labeling/Test.ts"
import { CurrentAccessIdentity, SameOriginMiddleware } from "./Middleware.ts"

const RepositoryPath = Schema.Struct({ repositoryId: GitHubRepositoryDatabaseId })

const repositoryPath = HttpRouter.schemaPathParams(RepositoryPath)

const json = HttpServerResponse.schemaJson
const body = HttpServerRequest.schemaBodyJson

const badRequest = HttpServerResponse.text("Bad Request", { status: 400 })
const notFound = HttpServerResponse.empty({ status: 404 })
const unavailableResponse = HttpServerResponse.text("Service Unavailable", {
  status: 503,
  headers: { "Retry-After": "10" },
})

const unavailable = (operation: string) =>
  Effect.fnUntraced(function* (cause: unknown) {
    yield* Effect.logError(`Labeling ${operation} failed`, cause)
    return unavailableResponse
  })

const actor = Effect.map(CurrentAccessIdentity, (identity) => ({
  issuer: identity.issuer,
  subject: identity.subject,
}))

const respondMessage = json(Schema.Struct({ message: Schema.String }))

/**
 * Every route sits behind the Access assertion; writes also require same
 * origin. Domain failures map to statuses here; anything else is a 503.
 */
type Handled =
  | Schema.SchemaError
  | HttpServerError.HttpServerError
  | RepositoryNotFound
  | RepositoryBlocked

const handledTags: ReadonlySet<string> = new Set([
  "SchemaError",
  "HttpServerError",
  "RepositoryNotFound",
  "RepositoryBlocked",
])

const isHandled = (error: unknown): error is Handled =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  typeof error._tag === "string" &&
  handledTags.has(error._tag)

const respond = (error: Handled) => {
  switch (error._tag) {
    case "SchemaError":
    case "HttpServerError":
      return Effect.succeed(badRequest)
    case "RepositoryNotFound":
      return Effect.succeed(notFound)
    case "RepositoryBlocked":
      return json(RepositoryBlocked)(error, { status: 409 })
  }
}

const handled =
  (operation: string) =>
  <A, E, R>(route: Effect.Effect<A, E, R>) =>
    route.pipe(
      Effect.catch(
        (
          error: E,
        ): Effect.Effect<HttpServerResponse.HttpServerResponse, E | HttpBody.HttpBodyError> =>
          isHandled(error) ? respond(error) : Effect.fail(error),
      ),
      Effect.catchCause(unavailable(operation)),
    )

const catalog = describeCatalog()

const reads = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/repositories/:repositoryId/rule-tests/:testId/input",
    Effect.gen(function* () {
      const { repositoryId, testId } = yield* HttpRouter.schemaPathParams(
        Schema.Struct({ repositoryId: GitHubRepositoryDatabaseId, testId: Schema.String }),
      )
      const job = yield* (yield* RuleTestJobs).get(repositoryId, testId, true)
      const details =
        job?.response?._tag === "Evaluated"
          ? job.response.entities[0]?.evaluation?.inputDetails
          : undefined
      return details
        ? yield* json(AiInputDetails)(details)
        : HttpServerResponse.text(
            "Input details expired or are unavailable. Run the test again to inspect a new snapshot.",
            { status: 404 },
          )
    }).pipe(handled("ruleTestInput")),
  ),
  HttpRouter.route(
    "GET",
    "/repositories/:repositoryId/rule-tests/:testId",
    Effect.gen(function* () {
      const { repositoryId, testId } = yield* HttpRouter.schemaPathParams(
        Schema.Struct({ repositoryId: GitHubRepositoryDatabaseId, testId: Schema.String }),
      )
      const result = yield* (yield* RuleTestJobs).get(repositoryId, testId)
      return result ? yield* json(RuleTestJob)(result) : notFound
    }).pipe(handled("ruleTest")),
  ),
  HttpRouter.route(
    "GET",
    "/repositories/:repositoryId/test/items",
    Effect.gen(function* () {
      const { repositoryId } = yield* repositoryPath
      const test = yield* LabelingTest
      return yield* json(Schema.Array(TestEntity))(yield* test.items(repositoryId))
    }).pipe(handled("testItems")),
  ),
  HttpRouter.route(
    "GET",
    "/labeling/catalog",
    json(Schema.Array(FactDescription))(catalog).pipe(handled("catalog")),
  ),
  HttpRouter.route(
    "GET",
    "/repositories",
    Effect.gen(function* () {
      const overview = yield* LabelingOverview
      return yield* json(Schema.Array(RepositoryOverview))(yield* overview.repositories)
    }).pipe(handled("repositories")),
  ),
  HttpRouter.route(
    "GET",
    "/repositories/:repositoryId/activity",
    Effect.gen(function* () {
      const { repositoryId } = yield* repositoryPath
      const query = yield* HttpRouter.schemaParams(
        Schema.Struct({
          search: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
          target: Schema.optionalKey(Schema.Literals(["all", "issue", "pull_request"])),
          cursor: Schema.optionalKey(Schema.fromJsonString(ActivityCursor)),
        }),
      )
      return yield* json(ActivityPage)(
        yield* (yield* ActivityReader).page(repositoryId, {
          search: query.search ?? "",
          target: query.target ?? "all",
          cursor: query.cursor ?? null,
        }),
      )
    }).pipe(handled("activity")),
  ),
  HttpRouter.route(
    "GET",
    "/repositories/:repositoryId/reconciliations",
    Effect.gen(function* () {
      const { repositoryId } = yield* repositoryPath
      const overview = yield* LabelingOverview
      return yield* json(Schema.Array(ReconciliationRecord))(
        yield* overview.reconciliations(repositoryId),
      )
    }).pipe(handled("reconciliations")),
  ),
  HttpRouter.route(
    "GET",
    "/repositories/:repositoryId/configuration",
    Effect.gen(function* () {
      const { repositoryId } = yield* repositoryPath
      const configuration = yield* LabelingConfiguration
      return yield* json(ConfigurationView)(yield* configuration.view(repositoryId))
    }).pipe(handled("configuration")),
  ),
  HttpRouter.route(
    "GET",
    "/repositories/:repositoryId/ai-consent",
    Effect.gen(function* () {
      const { repositoryId } = yield* repositoryPath
      const configuration = yield* LabelingConfiguration
      yield* configuration.requireRepository(repositoryId)
      const consent = yield* AiConsentService
      return yield* json(AiConsent)(yield* consent.get(repositoryId))
    }).pipe(handled("aiConsent")),
  ),
  HttpRouter.route(
    "GET",
    "/repositories/:repositoryId/audit",
    Effect.gen(function* () {
      const { repositoryId } = yield* repositoryPath
      const rules = yield* LabelingRules
      return yield* json(Schema.Array(AuditEntry))(yield* rules.audit(repositoryId))
    }).pipe(handled("audit")),
  ),
])

const writes = HttpRouter.addAll([
  HttpRouter.route(
    "POST",
    "/repositories/:repositoryId/rule-tests",
    Effect.gen(function* () {
      const { repositoryId } = yield* repositoryPath
      const request = yield* body(TestRequest)
      if (request.numbers.length !== 1 || request.subject._tag === "Configuration")
        return badRequest
      if (request.subject._tag === "Draft") {
        const validation = yield* (yield* Policies).validate(
          repositoryId,
          request.subject.source,
          Option.none(),
        )
        if (validation._tag === "Invalid")
          return yield* respondMessage({ message: validation.message }, { status: 422 })
      }
      return yield* json(RuleTestJob)(yield* (yield* RuleTestJobs).enqueue(repositoryId, request), {
        status: 202,
        headers: { "Retry-After": "1" },
      })
    }).pipe(handled("enqueueRuleTest")),
  ),
  HttpRouter.route(
    "PUT",
    "/repositories/:repositoryId/ai-consent",
    Effect.gen(function* () {
      const { repositoryId } = yield* repositoryPath
      const request = yield* body(SetAiConsentRequest)
      const configuration = yield* LabelingConfiguration
      yield* configuration.requireRepository(repositoryId)
      const consent = yield* AiConsentService
      return yield* json(AiConsent)(yield* consent.set(repositoryId, request.enabled, yield* actor))
    }).pipe(handled("setAiConsent")),
  ),
  HttpRouter.route(
    "POST",
    "/repositories/:repositoryId/test",
    Effect.gen(function* () {
      const { repositoryId } = yield* repositoryPath
      const request = yield* body(TestRequest)
      const test = yield* LabelingTest
      return yield* json(TestResponse)(yield* test.run(repositoryId, request))
    }).pipe(handled("test")),
  ),
]).pipe(Layer.provide(SameOriginMiddleware))

export const LabelingRoutesLayer = Layer.mergeAll(reads, writes)
