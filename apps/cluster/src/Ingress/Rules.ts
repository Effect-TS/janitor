import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { ReconciliationRecord, RepositoryOverview } from "@janitor/domain/Labeling/Reconciliation"
import { PolicyId } from "@janitor/domain/Labeling/Policy/Condition"
import {
  AiConsent,
  AuditEntry,
  ConfigurationView,
  CreatePolicyRequest,
  CreateRuleRequest,
  PatchRuleRequest,
  PolicyDetail,
  PolicyRecord,
  PolicyVersionRecord,
  PublishPolicyRequest,
  RuleIssue,
  SetAiConsentRequest,
  RuleRecord,
  SavePolicyRequest,
  ValidatePolicyRequest,
  ValidatePolicyResponse,
} from "@janitor/domain/Labeling/Policy/Configuration"
import { describeCatalog, FactDescription } from "@janitor/domain/Labeling/Policy/Facts"
import { RuleId } from "@janitor/domain/Labeling/Policy/Plan"
import { TestEntity, TestRequest, TestResponse } from "@janitor/domain/Labeling/Policy/Test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import type * as HttpBody from "effect/unstable/http/HttpBody"
import type * as HttpServerError from "effect/unstable/http/HttpServerError"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { AiConsentService } from "../Labeling/Classifier.ts"
import { LabelingConfiguration, type RepositoryNotFound } from "../Labeling/Configuration.ts"
import { LabelingOverview } from "../Labeling/Overview.ts"
import {
  Policies,
  type PolicyConflict,
  type PolicyInUse,
  type PolicyInvalid,
  type PolicyNameTaken,
  type PolicyNotFound,
} from "../Labeling/Policies.ts"
import {
  LabelingRules,
  type RuleConflict,
  type RuleInvalid,
  type RuleNotFound,
} from "../Labeling/Rules.ts"
import { LabelingTest } from "../Labeling/Test.ts"
import { CurrentAccessIdentity } from "./Middleware.ts"
import { SameOriginMiddleware } from "./Sync.ts"

const RepositoryPath = Schema.Struct({ repositoryId: GitHubRepositoryDatabaseId })
const PolicyPath = Schema.Struct({ repositoryId: GitHubRepositoryDatabaseId, policyId: PolicyId })
const RulePath = Schema.Struct({ repositoryId: GitHubRepositoryDatabaseId, ruleId: RuleId })
const VersionQuery = Schema.Struct({ version: Schema.FiniteFromString })

const repositoryPath = HttpRouter.schemaPathParams(RepositoryPath)
const policyPath = HttpRouter.schemaPathParams(PolicyPath)
const rulePath = HttpRouter.schemaPathParams(RulePath)
const versionQuery = HttpRouter.schemaParams(VersionQuery)

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

const respondIssues = json(Schema.Struct({ issues: Schema.Array(RuleIssue) }))
const respondMessage = json(Schema.Struct({ message: Schema.String }))

/**
 * Every route sits behind the Access assertion; writes also require same
 * origin. Domain failures map to statuses here; anything else is a 503.
 */
type Handled =
  | Schema.SchemaError
  | HttpServerError.HttpServerError
  | RepositoryNotFound
  | PolicyNotFound
  | PolicyConflict
  | PolicyInvalid
  | PolicyNameTaken
  | PolicyInUse
  | RuleNotFound
  | RuleConflict
  | RuleInvalid

const handledTags: ReadonlySet<string> = new Set([
  "SchemaError",
  "HttpServerError",
  "RepositoryNotFound",
  "PolicyNotFound",
  "PolicyConflict",
  "PolicyInvalid",
  "PolicyNameTaken",
  "PolicyInUse",
  "RuleNotFound",
  "RuleConflict",
  "RuleInvalid",
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
    case "PolicyNotFound":
    case "RuleNotFound":
      return Effect.succeed(notFound)
    case "PolicyConflict":
      return json(PolicyDetail)(error.current, { status: 409 })
    case "PolicyInvalid":
      return respondMessage({ message: error.message }, { status: 422 })
    case "PolicyNameTaken":
      return respondMessage(
        { message: `A policy named '${error.name}' already exists` },
        { status: 409 },
      )
    case "PolicyInUse":
      return respondMessage(
        {
          message: `The policy is bound by ${error.rules} rules and referenced by ${error.references} published policy versions, including retained history`,
        },
        { status: 409 },
      )
    case "RuleConflict":
      return json(RuleRecord)(error.current, { status: 409 })
    case "RuleInvalid":
      return respondIssues({ issues: error.issues }, { status: 422 })
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
    "/repositories/:repositoryId/policies",
    Effect.gen(function* () {
      const { repositoryId } = yield* repositoryPath
      const policies = yield* Policies
      return yield* json(Schema.Array(PolicyRecord))(yield* policies.list(repositoryId))
    }).pipe(handled("policies")),
  ),
  HttpRouter.route(
    "GET",
    "/repositories/:repositoryId/policies/:policyId",
    Effect.gen(function* () {
      const { repositoryId, policyId } = yield* policyPath
      const policies = yield* Policies
      return yield* json(PolicyDetail)(yield* policies.get(repositoryId, policyId))
    }).pipe(handled("policy")),
  ),
  HttpRouter.route(
    "GET",
    "/repositories/:repositoryId/policies/:policyId/versions",
    Effect.gen(function* () {
      const { repositoryId, policyId } = yield* policyPath
      const policies = yield* Policies
      return yield* json(Schema.Array(PolicyVersionRecord))(
        yield* policies.versions(repositoryId, policyId),
      )
    }).pipe(handled("versions")),
  ),
  HttpRouter.route(
    "GET",
    "/repositories/:repositoryId/rules",
    Effect.gen(function* () {
      const { repositoryId } = yield* repositoryPath
      const rules = yield* LabelingRules
      return yield* json(Schema.Array(RuleRecord))(yield* rules.list(repositoryId))
    }).pipe(handled("rules")),
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
    "/repositories/:repositoryId/policies",
    Effect.gen(function* () {
      const { repositoryId } = yield* repositoryPath
      const request = yield* body(CreatePolicyRequest)
      const policies = yield* Policies
      return yield* json(PolicyDetail)(
        yield* policies.create(repositoryId, request, yield* actor),
        { status: 201 },
      )
    }).pipe(handled("createPolicy")),
  ),
  HttpRouter.route(
    "PUT",
    "/repositories/:repositoryId/policies/:policyId",
    Effect.gen(function* () {
      const { repositoryId, policyId } = yield* policyPath
      const request = yield* body(SavePolicyRequest)
      const policies = yield* Policies
      return yield* json(PolicyDetail)(
        yield* policies.save(repositoryId, policyId, request, yield* actor),
      )
    }).pipe(handled("savePolicy")),
  ),
  HttpRouter.route(
    "POST",
    "/repositories/:repositoryId/policies/:policyId/publish",
    Effect.gen(function* () {
      const { repositoryId, policyId } = yield* policyPath
      const request = yield* body(PublishPolicyRequest)
      const policies = yield* Policies
      return yield* json(PolicyDetail)(
        yield* policies.publish(repositoryId, policyId, request.version, yield* actor),
      )
    }).pipe(handled("publishPolicy")),
  ),
  HttpRouter.route(
    "DELETE",
    "/repositories/:repositoryId/policies/:policyId",
    Effect.gen(function* () {
      const { repositoryId, policyId } = yield* policyPath
      const { version } = yield* versionQuery
      const policies = yield* Policies
      yield* policies.remove(repositoryId, policyId, version, yield* actor)
      return HttpServerResponse.empty({ status: 204 })
    }).pipe(handled("removePolicy")),
  ),
  HttpRouter.route(
    "POST",
    "/repositories/:repositoryId/policies/validate",
    Effect.gen(function* () {
      const { repositoryId } = yield* repositoryPath
      const request = yield* body(ValidatePolicyRequest)
      const policies = yield* Policies
      return yield* json(ValidatePolicyResponse)(
        yield* policies.validate(repositoryId, request.source, Option.none()),
      )
    }).pipe(handled("validatePolicy")),
  ),
  HttpRouter.route(
    "POST",
    "/repositories/:repositoryId/rules",
    Effect.gen(function* () {
      const { repositoryId } = yield* repositoryPath
      const request = yield* body(CreateRuleRequest)
      const rules = yield* LabelingRules
      return yield* json(RuleRecord)(yield* rules.create(repositoryId, request, yield* actor), {
        status: 201,
      })
    }).pipe(handled("createRule")),
  ),
  HttpRouter.route(
    "PATCH",
    "/repositories/:repositoryId/rules/:ruleId",
    Effect.gen(function* () {
      const { repositoryId, ruleId } = yield* rulePath
      const request = yield* body(PatchRuleRequest)
      const rules = yield* LabelingRules
      return yield* json(RuleRecord)(
        yield* rules.patch(repositoryId, ruleId, request, yield* actor),
      )
    }).pipe(handled("patchRule")),
  ),
  HttpRouter.route(
    "DELETE",
    "/repositories/:repositoryId/rules/:ruleId",
    Effect.gen(function* () {
      const { repositoryId, ruleId } = yield* rulePath
      const { version } = yield* versionQuery
      const rules = yield* LabelingRules
      yield* rules.remove(repositoryId, ruleId, version, yield* actor)
      return HttpServerResponse.empty({ status: 204 })
    }).pipe(handled("removeRule")),
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

export const RulesRoutesLayer = Layer.mergeAll(reads, writes)
