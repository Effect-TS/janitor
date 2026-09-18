import { describeResultAction } from "@janitor/domain/Labeling/Policy/Plan"
import * as Live from "./live"
import * as Activity from "@/components/activity"
import * as Reviews from "@/components/reviews"
import { ReviewSettings } from "@janitor/domain/Review/Run"
import * as Menu from "@foldkit/ui/menu"
import * as Effect from "effect/Effect"
import * as Clock from "effect/Clock"
import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage"
import * as FoldkitCommand from "foldkit/command"
import { childAttributes, type Html, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import * as Submodel from "foldkit/submodel"
import * as Subscription from "foldkit/subscription"
import * as Update from "foldkit/update"
import * as Button from "@/components/ui/button"
import * as Icon from "@/lib/icons"
import { Plus, Search, Ellipsis, Pencil } from "lucide"
import { inputGroup, inputGroupAddon, inputGroupInput } from "@/components/ui/input-group"
import { chip } from "@/components/ui/chip"
import { emptyPanel, panel, panelHeader } from "@/components/ui/panel"
import * as Page from "@/components/ui/page"
import * as Blueprint from "@/components/ui/blueprint"
import * as Overlay from "@/components/ui/overlay"
import * as SwitchControl from "@/components/ui/switch"
import * as Table from "@/components/ui/table"
import * as PolicyEditor from "@/components/policy-editor"
import * as RuleEditor from "@/components/rule-editor"
import {
  AiConsent,
  TestCandidates,
  TestEntity,
  testEndpoint,
  aiConsentEndpoint,
  CATALOG_ENDPOINT,
  ConfigurationView,
  configurationEndpoint,
  FactDescription,
  labelName,
  PolicyDetail,
  policyEndpoint,
  policyName,
  PolicyRecord,
  ReconciliationRecord,
  REPOSITORIES_ENDPOINT,
  RepositoryOverview,
  ruleEndpoint,
  RuleRecord,
} from "@/components/labeling-wire"
import { cn } from "@/lib/utils"
import * as Routes from "@/routes"
import * as PolicyStatus from "@/components/policy-status"

export type {
  AiConsent,
  ConfigurationView,
  PolicyDetail,
  ReconciliationRecord,
  RepositoryOverview,
} from "@/components/labeling-wire"
export type { ReviewSettings } from "@janitor/domain/Review/Run"

// MODEL

export const RepositoryDetail = Schema.Struct({
  configuration: ConfigurationView,
  reconciliations: Schema.Array(ReconciliationRecord),
  testCandidates: Schema.optionalKey(TestCandidates),
})
export type RepositoryDetail = typeof RepositoryDetail.Type

/** The open document, rule editor, or configuration test. */
export const Panel = Schema.Union([
  Schema.TaggedStruct("Closed", {}),
  Schema.TaggedStruct("LoadingPolicy", { policyId: Schema.String }),
  Schema.TaggedStruct("Unavailable", { message: Schema.String }),
  Schema.TaggedStruct("PolicyEditor", { editor: PolicyEditor.Model }),
  Schema.TaggedStruct("RuleEditor", { editor: RuleEditor.Model }),
])
export type Panel = typeof Panel.Type

export const Section = Schema.Literals([
  "Overview",
  "Policies",
  "Rules",
  "Activity",
  "Reviews",
  "Settings",
])
export type Section = typeof Section.Type

const Mutation = Schema.Struct({
  operationId: Schema.Int,
  repositoryId: Schema.String,
  subjectId: Schema.String,
  kind: Schema.Literals(["RuleToggle", "PolicyDelete", "RuleDelete", "Consent", "Review"]),
  previousEnabled: Schema.Boolean,
  enabled: Schema.Boolean,
})
type Mutation = typeof Mutation.Type
const ResponseContext = { repositoryId: Schema.String, operationId: Schema.Int }

export const Model = Schema.Struct({
  activity: Activity.Model,
  reviews: Reviews.Model,
  liveTopics: Schema.Array(Live.Topic),
  nextOperationId: Schema.Int,
  pendingMutations: Schema.Array(Mutation),
  nextRequestId: Schema.Int,
  maybeDetailRequest: Schema.Option(Schema.Int),
  maybeConsentRequest: Schema.Option(Schema.Int),
  maybeReviewRequest: Schema.Option(Schema.Int),
  maybeRepositoriesRequest: Schema.Option(Schema.Int),
  consentError: Schema.Option(Schema.String),
  /** The repository's issue review settings, loaded with the consent card. */
  maybeReview: Schema.Option(ReviewSettings),
  reviewError: Schema.Option(Schema.String),
  policySearch: Schema.String,
  ruleSearch: Schema.String,
  /** The rule whose graph and details the rules page shows. */
  selectedRuleId: Schema.NullOr(Schema.String),
  ruleMenus: Schema.Record(Schema.String, Menu.Model),
  repositories: Schema.Option(Schema.Array(RepositoryOverview)),
  repositoriesError: Schema.Option(Schema.String),
  catalog: Schema.Array(FactDescription),
  /** Repository owning the cached detail and its in-flight requests. */
  dataRepositoryId: Schema.Option(Schema.String),
  detail: Schema.Option(RepositoryDetail),
  detailError: Schema.Option(Schema.String),
  maybeConsent: Schema.Option(AiConsent),

  panel: Panel,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  GotActivityMessage: { message: Activity.Message },
  GotReviewsMessage: { message: Reviews.Message },
  GotReview: { repositoryId: Schema.String, settings: ReviewSettings, requestId: Schema.Int },
  FailedReview: { repositoryId: Schema.String, reason: Schema.String, requestId: Schema.Int },
  ClickedRetryReview: {},
  ChangedReview: { enabled: Schema.Boolean, dryRun: Schema.Boolean },
  CompletedSetReview: { ...ResponseContext, settings: ReviewSettings },
  FailedSetReview: { ...ResponseContext, reason: Schema.String },
  UpdatedPolicySearch: { value: Schema.String },
  GotRepositories: { repositories: Schema.Array(RepositoryOverview), requestId: Schema.Int },
  FailedRepositories: { reason: Schema.String, requestId: Schema.Int },
  GotCatalog: { catalog: Schema.Array(FactDescription) },
  Selected: { repositoryId: Schema.String },
  Polled: {},
  LiveChanged: { topics: Schema.Array(Live.Topic), all: Schema.Boolean },
  FlushLive: {},
  GotDetail: { repositoryId: Schema.String, detail: RepositoryDetail, requestId: Schema.Int },
  FailedDetail: { repositoryId: Schema.String, reason: Schema.String, requestId: Schema.Int },
  GotConsent: { repositoryId: Schema.String, consent: AiConsent, requestId: Schema.Int },
  FailedConsent: { repositoryId: Schema.String, reason: Schema.String, requestId: Schema.Int },
  ClickedRetryConsent: {},
  ClickedToggleConsent: {},
  CompletedSetConsent: { ...ResponseContext, consent: AiConsent },
  FailedSetConsent: { ...ResponseContext, reason: Schema.String },
  ClickedNewPolicy: {},
  ClickedEditPolicy: { policyId: Schema.String },
  GotPolicyDetail: { detail: PolicyDetail },
  FailedPolicyDetail: {
    reason: Schema.String,
    repositoryId: Schema.optionalKey(Schema.String),
    policyId: Schema.optionalKey(Schema.String),
  },
  ClickedDeletePolicy: { policyId: Schema.String, version: Schema.Int },
  ClickedNewRule: {},
  UpdatedRuleSearch: { value: Schema.String },
  SelectedRule: { ruleId: Schema.String },
  GotRuleMenuMessage: { ruleId: Schema.String, message: Menu.Message },
  ClickedEditRule: { ruleId: Schema.String },
  ClickedToggleRule: { ruleId: Schema.String },
  ClickedDeleteRule: { ruleId: Schema.String, version: Schema.Int },
  CompletedDelete: {
    ...ResponseContext,
    subjectId: Schema.String,
    what: Schema.Literals(["policy", "rule"]),
  },
  FailedDelete: { ...ResponseContext, subjectId: Schema.String, reason: Schema.String },
  CompletedToggleRule: { ...ResponseContext, rule: RuleRecord },
  FailedToggleRule: { ...ResponseContext, ruleId: Schema.String, reason: Schema.String },
  GotPolicyEditorMessage: { message: PolicyEditor.Message },
  GotRuleEditorMessage: { message: RuleEditor.Message },
})
export type Message = typeof Message.Type

/** Events the shell uses for navigation, notifications, and sync status. */
export const OutMessage = defineMessageUnion({
  Notified: { title: Schema.String, description: Schema.String },
  Failed: { title: Schema.String, reason: Schema.String },
  SyncWorkChanged: {},
  RequestedEditorClose: { section: Schema.Literals(["Policies", "Rules"]) },
  RequestedRule: { ruleId: Schema.String },
  SelectedPolicyTestItem: { number: Schema.Int },
  RuleSaved: { closeEditor: Schema.Boolean },
})
export type OutMessage = typeof OutMessage.Type

// COMMANDS

const describe = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error)

const MessageBody = Schema.Struct({ message: Schema.String })

const getJson = <A, RD>(url: string, schema: Schema.ConstraintDecoder<A, RD>) =>
  HttpClient.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpIncomingMessage.schemaBodyJson(schema)),
  )

export const FetchRepositories = FoldkitCommand.define("FetchRepositories", {
  args: { requestId: Schema.Int },
  messages: [Message.GotRepositories, Message.FailedRepositories],
  execute: ({ requestId }) =>
    getJson(REPOSITORIES_ENDPOINT, Schema.Array(RepositoryOverview)).pipe(
      Effect.map((repositories) => Message.GotRepositories({ repositories, requestId })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedRepositories({ reason: describe(error), requestId })),
      ),
    ),
})

/** The catalog is static; a failure leaves completion empty rather than blocking the page. */
export const FetchCatalog = FoldkitCommand.define("FetchCatalog", {
  messages: [Message.GotCatalog],
  execute: getJson(CATALOG_ENDPOINT, Schema.Array(FactDescription)).pipe(
    Effect.map((catalog) => Message.GotCatalog({ catalog })),
    Effect.catch(() => Effect.succeed(Message.GotCatalog({ catalog: [] }))),
  ),
})

export const FetchDetail = FoldkitCommand.define("FetchDetail", {
  args: { repositoryId: Schema.String, requestId: Schema.Int },
  messages: [Message.GotDetail, Message.FailedDetail],
  execute: ({ repositoryId, requestId }) =>
    Effect.all(
      {
        configuration: getJson(configurationEndpoint(repositoryId), ConfigurationView),
        testCandidates: getJson(
          `${testEndpoint(repositoryId)}/items`,
          Schema.Array(TestEntity),
        ).pipe(
          Effect.map((items) => ({ _tag: "Ready" as const, items })),
          Effect.catch((error) =>
            Effect.succeed({ _tag: "Failed" as const, reason: describe(error) }),
          ),
        ),
        reconciliations: Effect.succeed([]),
      },
      { concurrency: 2 },
    ).pipe(
      Effect.map((detail) => Message.GotDetail({ repositoryId, detail, requestId })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedDetail({ repositoryId, reason: describe(error), requestId })),
      ),
    ),
})

/** Consent is separate from the configuration so a failure here never hides the tables. */
export const FetchConsent = FoldkitCommand.define("FetchConsent", {
  args: { repositoryId: Schema.String, requestId: Schema.Int },
  messages: [Message.GotConsent, Message.FailedConsent],
  execute: ({ repositoryId, requestId }) =>
    getJson(aiConsentEndpoint(repositoryId), AiConsent).pipe(
      Effect.map((consent) => Message.GotConsent({ repositoryId, consent, requestId })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedConsent({ repositoryId, requestId, reason: describe(error) })),
      ),
    ),
})

const reviewEndpoint = (repositoryId: string) =>
  `${REPOSITORIES_ENDPOINT}/${encodeURIComponent(repositoryId)}/issue-review`

export const FetchReview = FoldkitCommand.define("FetchReviewSettings", {
  args: { repositoryId: Schema.String, requestId: Schema.Int },
  messages: [Message.GotReview, Message.FailedReview],
  execute: ({ repositoryId, requestId }) =>
    getJson(reviewEndpoint(repositoryId), ReviewSettings).pipe(
      Effect.map((settings) => Message.GotReview({ repositoryId, settings, requestId })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedReview({ repositoryId, requestId, reason: describe(error) })),
      ),
    ),
})

export const SetReview = FoldkitCommand.define("SetReviewSettings", {
  args: { ...ResponseContext, enabled: Schema.Boolean, dryRun: Schema.Boolean },
  messages: [Message.CompletedSetReview, Message.FailedSetReview],
  execute: ({ repositoryId, enabled, dryRun, operationId }) =>
    HttpClientRequest.put(reviewEndpoint(repositoryId)).pipe(
      HttpClientRequest.bodyJson({ enabled, dryRun }),
      Effect.flatMap(HttpClient.execute),
      Effect.flatMap((response) =>
        response.status === 409 || response.status === 403
          ? HttpIncomingMessage.schemaBodyJson(MessageBody)(response).pipe(
              Effect.flatMap((body) => Effect.fail(body.message)),
            )
          : HttpClientResponse.filterStatusOk(response),
      ),
      Effect.flatMap(HttpIncomingMessage.schemaBodyJson(ReviewSettings)),
      Effect.map((settings) => Message.CompletedSetReview({ repositoryId, settings, operationId })),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedSetReview({ repositoryId, operationId, reason: describe(error) }),
        ),
      ),
    ),
})

export const SetConsent = FoldkitCommand.define("SetConsent", {
  args: { ...ResponseContext, enabled: Schema.Boolean },
  messages: [Message.CompletedSetConsent, Message.FailedSetConsent],
  execute: ({ repositoryId, enabled, operationId }) =>
    HttpClientRequest.put(aiConsentEndpoint(repositoryId)).pipe(
      HttpClientRequest.bodyJson({ enabled }),
      Effect.flatMap(HttpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpIncomingMessage.schemaBodyJson(AiConsent)),
      Effect.map((consent) => Message.CompletedSetConsent({ repositoryId, consent, operationId })),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedSetConsent({ repositoryId, operationId, reason: describe(error) }),
        ),
      ),
    ),
})

export const FetchPolicyDetail = FoldkitCommand.define("FetchPolicyDetail", {
  args: { repositoryId: Schema.String, policyId: Schema.String },
  messages: [Message.GotPolicyDetail, Message.FailedPolicyDetail],
  execute: ({ repositoryId, policyId }) =>
    getJson(policyEndpoint(repositoryId, policyId), PolicyDetail).pipe(
      Effect.map((detail) => Message.GotPolicyDetail({ detail })),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedPolicyDetail({ repositoryId, policyId, reason: describe(error) }),
        ),
      ),
    ),
})

export const DeleteSubject = FoldkitCommand.define("DeleteSubject", {
  args: {
    ...ResponseContext,
    url: Schema.String,
    version: Schema.Int,
    subjectId: Schema.String,
    what: Schema.Literals(["policy", "rule"]),
  },
  messages: [Message.CompletedDelete, Message.FailedDelete],
  execute: ({ url, version, what, repositoryId, operationId, subjectId }) =>
    Effect.gen(function* () {
      const response = yield* HttpClient.execute(
        HttpClientRequest.make("DELETE")(`${url}?version=${version}`),
      )
      switch (response.status) {
        case 204:
          return Message.CompletedDelete({ what, repositoryId, operationId, subjectId })
        case 409: {
          const body = yield* HttpIncomingMessage.schemaBodyJson(
            Schema.Union([MessageBody, PolicyDetail, RuleRecord]),
          )(response)
          return Message.FailedDelete({
            repositoryId,
            operationId,
            subjectId,
            reason:
              "message" in body
                ? body.message
                : "This item changed meanwhile. Review the refreshed version and retry.",
          })
        }
        case 422: {
          const { message } = yield* HttpIncomingMessage.schemaBodyJson(MessageBody)(response)
          return Message.FailedDelete({ repositoryId, operationId, subjectId, reason: message })
        }
        default:
          return Message.FailedDelete({
            repositoryId,
            operationId,
            subjectId,
            reason: `Server answered ${response.status}`,
          })
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedDelete({ repositoryId, operationId, subjectId, reason: describe(error) }),
        ),
      ),
    ),
})

export const ToggleRule = FoldkitCommand.define("ToggleRule", {
  args: {
    operationId: Schema.Int,
    repositoryId: Schema.String,
    ruleId: Schema.String,
    version: Schema.Int,
    enabled: Schema.Boolean,
  },
  messages: [Message.CompletedToggleRule, Message.FailedToggleRule],
  execute: ({ repositoryId, operationId, ruleId, version, enabled }) =>
    HttpClientRequest.patch(ruleEndpoint(repositoryId, ruleId)).pipe(
      HttpClientRequest.bodyJson({ version, enabled }),
      Effect.flatMap(HttpClient.execute),
      Effect.flatMap((response) =>
        response.status === 409
          ? Effect.fail("This rule changed meanwhile. Review the refreshed rule and retry.")
          : response.status === 422
            ? HttpIncomingMessage.schemaBodyJson(
                Schema.Struct({ issues: Schema.Array(Schema.Struct({ message: Schema.String })) }),
              )(response).pipe(
                Effect.flatMap((body) =>
                  Effect.fail(body.issues.map((issue) => issue.message).join("; ")),
                ),
              )
            : HttpClientResponse.filterStatusOk(response),
      ),
      Effect.flatMap(HttpIncomingMessage.schemaBodyJson(RuleRecord)),
      Effect.map((rule) => Message.CompletedToggleRule({ repositoryId, operationId, rule })),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedToggleRule({ repositoryId, operationId, ruleId, reason: describe(error) }),
        ),
      ),
    ),
})

// INIT

export type UpdateReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  HttpClient.HttpClient
>

export const init = (): UpdateReturn => ({
  model: Model.make(
    {
      activity: Activity.init(),
      reviews: Reviews.init(),
      liveTopics: [],
      nextOperationId: 1,
      pendingMutations: [],
      nextRequestId: 1,
      maybeDetailRequest: Option.none(),
      maybeConsentRequest: Option.none(),
      maybeReviewRequest: Option.none(),
      maybeRepositoriesRequest: Option.some(0),
      consentError: Option.none(),
      maybeReview: Option.none(),
      reviewError: Option.none(),
      policySearch: "",
      ruleSearch: "",
      selectedRuleId: null,
      ruleMenus: {},
      repositories: Option.none(),
      repositoriesError: Option.none(),
      catalog: [],
      dataRepositoryId: Option.none(),
      detail: Option.none(),
      detailError: Option.none(),
      maybeConsent: Option.none(),
      panel: { _tag: "Closed" },
    },
    { disableChecks: true },
  ),
  commands: [FetchRepositories({ requestId: 0 }), FetchCatalog()],
})

// UPDATE

type Step = Update.Return<Model, Message, HttpClient.HttpClient>

const closed = (model: Model): Model =>
  evo(model, {
    panel: () => ({ _tag: "Closed" as const }),
  })

const hasMutation = (
  model: Model,
  repositoryId: string,
  subjectId: string,
  kinds: ReadonlyArray<Mutation["kind"]>,
) =>
  model.pendingMutations.some(
    (mutation) =>
      mutation.repositoryId === repositoryId &&
      mutation.subjectId === subjectId &&
      kinds.includes(mutation.kind),
  )

const finishMutation = (model: Model, operationId: number): Model =>
  evo(model, {
    pendingMutations: (mutations) =>
      mutations.filter((mutation) => mutation.operationId !== operationId),
  })

const startMutation = (model: Model, mutation: Omit<Mutation, "operationId">): Model =>
  evo(model, {
    pendingMutations: (mutations) => [
      ...mutations,
      { ...mutation, operationId: model.nextOperationId },
    ],
    nextOperationId: (id) => id + 1,
  })

const refresh = (model: Model, force = true): Step => {
  if (Option.isNone(model.dataRepositoryId)) return { model }
  const repositoryId = model.dataRepositoryId.value
  const detail = force || Option.isNone(model.maybeDetailRequest)
  const consent = force || Option.isNone(model.maybeConsentRequest)
  const review = force || Option.isNone(model.maybeReviewRequest)
  const requestId = model.nextRequestId
  return {
    model: evo(model, {
      nextRequestId: () => requestId + 3,
      maybeDetailRequest: (current) => (detail ? Option.some(requestId) : current),
      maybeConsentRequest: (current) => (consent ? Option.some(requestId + 1) : current),
      maybeReviewRequest: (current) => (review ? Option.some(requestId + 2) : current),
    }),
    commands: [
      ...(detail ? [FetchDetail({ repositoryId, requestId })] : []),
      ...(consent ? [FetchConsent({ repositoryId, requestId: requestId + 1 })] : []),
      ...(review ? [FetchReview({ repositoryId, requestId: requestId + 2 })] : []),
    ],
  }
}

/** Reloads only the issue review settings, when none are in flight. */
const refreshReview = (model: Model): Step => {
  if (Option.isNone(model.dataRepositoryId) || Option.isSome(model.maybeReviewRequest))
    return { model }
  const requestId = model.nextRequestId
  return {
    model: evo(model, {
      nextRequestId: () => requestId + 1,
      maybeReviewRequest: () => Option.some(requestId),
    }),
    commands: [FetchReview({ repositoryId: model.dataRepositoryId.value, requestId })],
  }
}

const foldReviews = Update.foldChild({
  update: Reviews.update,
  read: (model: Model) => Option.some(model.reviews),
  write: (model, reviews) => evo(model, { reviews: () => reviews }),
  toParentMessage: (message) => Message.GotReviewsMessage({ message }),
  toParentOutMessage: (outMessage) =>
    Reviews.OutMessage.match<OutMessage>(outMessage, {
      Notified: ({ title, description }) => OutMessage.Notified({ title, description }),
      Failed: ({ title, reason }) => OutMessage.Failed({ title, reason }),
    }),
})

export const refreshRepositories = (model: Model): Step => ({
  model: evo(model, {
    nextRequestId: (id) => id + 1,
    maybeRepositoriesRequest: () => Option.some(model.nextRequestId),
  }),
  commands: [FetchRepositories({ requestId: model.nextRequestId })],
})

const updateConfiguration = (
  model: Model,
  repositoryId: string,
  transform: (configuration: ConfigurationView) => ConfigurationView,
): Model => {
  if (!Option.contains(model.dataRepositoryId, repositoryId)) return model
  const detail = Option.map(model.detail, (detail) => ({
    ...detail,
    configuration: transform(detail.configuration),
  }))
  return evo(model, {
    detail: () => detail,
    panel: (panel) =>
      panel._tag === "PolicyEditor" && Option.isSome(detail)
        ? {
            ...panel,
            editor: PolicyEditor.reflectConfiguration(panel.editor, detail.value.configuration),
          }
        : panel._tag === "RuleEditor" && Option.isSome(detail)
          ? {
              ...panel,
              editor: RuleEditor.reflectConfiguration(
                panel.editor,
                detail.value.configuration,
                detail.value.testCandidates,
              ),
            }
          : panel,
    repositories: Option.map((rows) =>
      rows.map((row) =>
        row.repositoryId === repositoryId && Option.isSome(detail)
          ? {
              ...row,
              ruleCount: detail.value.configuration.rules.length,
              policyCount: detail.value.configuration.policies.length,
            }
          : row,
      ),
    ),
  })
}

const acceptPolicy = (model: Model, detail: PolicyDetail): Model =>
  updateConfiguration(model, detail.policy.repositoryId, (configuration) => ({
    ...configuration,
    policies: configuration.policies.some((policy) => policy.policyId === detail.policy.policyId)
      ? configuration.policies.map((policy) =>
          policy.policyId === detail.policy.policyId
            ? { ...detail.policy, draftDiffers: detail.draftDiffers }
            : policy,
        )
      : [...configuration.policies, { ...detail.policy, draftDiffers: detail.draftDiffers }],
  }))

const acceptRule = (model: Model, rule: RuleRecord): Model =>
  updateConfiguration(model, rule.repositoryId, (configuration) => ({
    ...configuration,
    rules: configuration.rules.some((current) => current.id === rule.id)
      ? configuration.rules.map((current) => (current.id === rule.id ? rule : current))
      : [...configuration.rules, rule],
  }))

interface Loaded {
  readonly repositoryId: string
  readonly detail: RepositoryDetail
}

const loaded = (model: Model): Option.Option<Loaded> =>
  Option.flatMap(model.dataRepositoryId, (repositoryId) =>
    Option.map(model.detail, (detail) => ({ repositoryId, detail })),
  )

const openPolicyEditor = (model: Model, existing: Option.Option<PolicyDetail>): Model =>
  Option.match(loaded(model), {
    onNone: () => model,
    onSome: ({ repositoryId, detail }) =>
      evo(model, {
        panel: () => ({
          _tag: "PolicyEditor" as const,
          editor: PolicyEditor.init({
            repositoryId,
            configuration: detail.configuration,
            catalog: model.catalog,
            testCandidates: detail.testCandidates,
            existing,
          }),
        }),
      }),
  })

const openRuleEditor = (
  model: Model,
  existing: Option.Option<RuleEditor.Model["identity"]>,
): Model =>
  Option.match(loaded(model), {
    onNone: () => model,
    onSome: ({ repositoryId, detail }) => {
      const rule = Option.flatMap(existing, (identity) =>
        identity._tag === "Existing"
          ? Option.fromNullishOr(
              detail.configuration.rules.find((candidate) => candidate.id === identity.ruleId),
            )
          : Option.none(),
      )
      return evo(model, {
        panel: () => ({
          _tag: "RuleEditor" as const,
          editor: RuleEditor.init({
            repositoryId,
            catalog: model.catalog,
            labels: detail.configuration.labels,
            policies: detail.configuration.policies,
            rules: detail.configuration.rules,
            existing: rule,
            testCandidates: detail.testCandidates,
          }),
        }),
      })
    },
  })

const foldPolicyEditor = Update.foldChild({
  update: PolicyEditor.update,
  read: (model: Model) =>
    model.panel._tag === "PolicyEditor" ? Option.some(model.panel.editor) : Option.none(),
  write: (model, nextEditor) =>
    evo(model, { panel: () => ({ _tag: "PolicyEditor" as const, editor: nextEditor }) }),
  toParentMessage: (message) => Message.GotPolicyEditorMessage({ message }),
  toParentOutMessage: (outMessage) =>
    PolicyEditor.OutMessage.match<OutMessage | undefined>(outMessage, {
      Saved: ({ detail, published }) =>
        OutMessage.Notified({
          title: published
            ? `Published ${detail.policy.name}`
            : `Saved ${detail.policy.name} as a draft`,
          description: published
            ? "Rules use this revision the next time a webhook or sync triggers evaluation."
            : "Publish it to make it available to rules.",
        }),
      Cancelled: () => OutMessage.RequestedEditorClose({ section: "Policies" }),
      RequestedDelete: () => undefined,
      SaveFailed: ({ reason }) => OutMessage.Failed({ title: "The policy was not saved", reason }),
      PersistedDraft: () => undefined,
    }),
  foldOutMessage: (outMessage) => (model) =>
    PolicyEditor.OutMessage.match<Step>(outMessage, {
      Saved: ({ detail }) => refresh(acceptPolicy(model, detail)),
      PersistedDraft: ({ detail }) => refresh(acceptPolicy(model, detail)),
      Cancelled: () => ({ model }),
      RequestedDelete: ({ policyId, version }) => {
        const next = update(model, Message.ClickedDeletePolicy({ policyId, version }))
        return { model: next.model, commands: next.commands ?? [] }
      },
      SaveFailed: () => ({ model }),
    }),
})

const foldRuleEditor = Update.foldChild({
  update: RuleEditor.update,
  read: (model: Model) =>
    model.panel._tag === "RuleEditor" ? Option.some(model.panel.editor) : Option.none(),
  write: (model, nextEditor) =>
    evo(model, { panel: () => ({ _tag: "RuleEditor" as const, editor: nextEditor }) }),
  toParentMessage: (message) => Message.GotRuleEditorMessage({ message }),
  toParentOutMessage: (outMessage) =>
    RuleEditor.OutMessage.match<OutMessage | undefined>(outMessage, {
      Saved: ({ closeEditor }) => OutMessage.RuleSaved({ closeEditor }),
      Cancelled: () => OutMessage.RequestedEditorClose({ section: "Rules" }),
      RequestedDelete: () => undefined,
      SaveFailed: ({ reason }) => OutMessage.Failed({ title: "The rule was not saved", reason }),
    }),
  foldOutMessage: (outMessage) => (model) =>
    RuleEditor.OutMessage.match<Step>(outMessage, {
      Saved: ({ rule, closeEditor }) =>
        refresh(acceptRule(closeEditor ? closed(model) : model, rule)),
      Cancelled: () => ({ model }),
      RequestedDelete: ({ ruleId, version }) => {
        const next = deleteSubject(model, "rule", ruleId, version)
        return { model: next.model, commands: next.commands ?? [] }
      },
      SaveFailed: () => ({ model }),
    }),
})

export const isViewingSubject = (
  model: Model,
  repositoryId: string,
  what: "policy" | "rule",
  subjectId: string,
): boolean => {
  if (!Option.contains(model.dataRepositoryId, repositoryId)) return false
  const panel = model.panel
  return what === "policy"
    ? panel._tag === "PolicyEditor" &&
        panel.editor.identity._tag === "Existing" &&
        panel.editor.identity.policyId === subjectId
    : panel._tag === "RuleEditor" &&
        panel.editor.identity._tag === "Existing" &&
        panel.editor.identity.ruleId === subjectId
}

const deleteSubject = (
  model: Model,
  what: "policy" | "rule",
  subjectId: string,
  version: number,
): UpdateReturn => {
  if (Option.isNone(model.dataRepositoryId)) return { model }
  const repositoryId = model.dataRepositoryId.value
  if (
    hasMutation(
      model,
      repositoryId,
      subjectId,
      what === "policy" ? ["PolicyDelete"] : ["RuleDelete", "RuleToggle"],
    ) ||
    (isViewingSubject(model, repositoryId, what, subjectId) && isSaving(model))
  )
    return { model }
  return {
    model: startMutation(model, {
      repositoryId,
      subjectId,
      kind: what === "policy" ? "PolicyDelete" : "RuleDelete",
      previousEnabled: false,
      enabled: false,
    }),
    commands: [
      DeleteSubject({
        repositoryId,
        operationId: model.nextOperationId,
        subjectId,
        version,
        what,
        url:
          what === "policy"
            ? policyEndpoint(repositoryId, subjectId)
            : ruleEndpoint(repositoryId, subjectId),
      }),
    ],
  }
}

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    UpdatedPolicySearch: ({ value }) => ({ model: evo(model, { policySearch: () => value }) }),
    GotRepositories: ({ repositories, requestId }) => {
      if (!Option.contains(model.maybeRepositoriesRequest, requestId)) return { model }
      const next = evo(model, {
        repositories: () =>
          Option.some(
            repositories.map((row) => {
              const counted =
                Option.contains(model.dataRepositoryId, row.repositoryId) &&
                Option.isSome(model.detail)
                  ? {
                      ...row,
                      policyCount: model.detail.value.configuration.policies.length,
                      ruleCount: model.detail.value.configuration.rules.length,
                    }
                  : row
              return counted
            }),
          ),
        maybeRepositoriesRequest: () => Option.none(),
        repositoriesError: () => Option.none<string>(),
      })
      return { model: next }
    },
    FailedRepositories: ({ reason, requestId }) =>
      !Option.contains(model.maybeRepositoriesRequest, requestId)
        ? { model }
        : {
            model: evo(model, {
              repositoriesError: () => Option.some(reason),
              maybeRepositoriesRequest: () => Option.none(),
            }),
          },
    GotCatalog: ({ catalog }) => ({
      model: evo(model, {
        catalog: () => catalog,
        panel: (panel) =>
          panel._tag === "PolicyEditor"
            ? {
                ...panel,
                editor: evo(panel.editor, {
                  source: (source) => evo(source, { catalog: () => catalog }),
                }),
              }
            : panel._tag === "RuleEditor"
              ? { ...panel, editor: evo(panel.editor, { catalog: () => catalog }) }
              : panel,
      }),
    }),

    GotActivityMessage: ({ message }) => {
      const result = Activity.update(model.activity, message)
      return {
        model: { ...model, activity: result.model },
        commands: FoldkitCommand.mapMessages(result.commands ?? [], (message) =>
          Message.GotActivityMessage({ message }),
        ),
      }
    },
    GotReviewsMessage: ({ message }) => foldReviews(model, message),
    GotReview: ({ repositoryId, settings, requestId }) =>
      Option.contains(model.dataRepositoryId, repositoryId) &&
      Option.contains(model.maybeReviewRequest, requestId)
        ? {
            model: evo(model, {
              maybeReview: () => Option.some(settings),
              reviewError: () => Option.none(),
              maybeReviewRequest: () => Option.none(),
            }),
          }
        : { model },
    FailedReview: ({ repositoryId, reason, requestId }) =>
      Option.contains(model.dataRepositoryId, repositoryId) &&
      Option.contains(model.maybeReviewRequest, requestId)
        ? {
            model: evo(model, {
              reviewError: () => Option.some(reason),
              maybeReviewRequest: () => Option.none(),
            }),
          }
        : { model },
    ClickedRetryReview: () => refreshReview(model),
    ChangedReview: ({ enabled, dryRun }) => {
      if (Option.isNone(model.dataRepositoryId) || Option.isNone(model.maybeReview))
        return { model }
      const repositoryId = model.dataRepositoryId.value
      if (hasMutation(model, repositoryId, repositoryId, ["Review"])) return { model }
      return {
        model: startMutation(model, {
          repositoryId,
          subjectId: repositoryId,
          kind: "Review",
          previousEnabled: model.maybeReview.value.enabled,
          enabled,
        }),
        commands: [
          SetReview({ repositoryId, enabled, dryRun, operationId: model.nextOperationId }),
        ],
      }
    },
    CompletedSetReview: ({ repositoryId, settings, operationId }) => {
      if (
        !model.pendingMutations.some(
          (mutation) =>
            mutation.operationId === operationId &&
            mutation.repositoryId === repositoryId &&
            mutation.kind === "Review",
        )
      )
        return { model }
      const next = evo(finishMutation(model, operationId), {
        maybeReview: (current) =>
          Option.contains(model.dataRepositoryId, repositoryId) ? Option.some(settings) : current,
      })
      return {
        model: next,
        outMessage: OutMessage.Notified({
          title: settings.enabled
            ? settings.dryRun
              ? "Issue review enabled in dry-run"
              : "Issue review enabled"
            : "Issue review disabled",
          description: settings.enabled
            ? settings.dryRun
              ? "Authorized /janitor commands start runs whose findings stay in Janitor."
              : "Authorized /janitor commands start runs that may publish to GitHub."
            : "Active and queued runs were cancelled. New mentions are ignored.",
        }),
      }
    },
    FailedSetReview: ({ repositoryId, operationId, reason }) => {
      if (
        !model.pendingMutations.some(
          (mutation) =>
            mutation.operationId === operationId &&
            mutation.repositoryId === repositoryId &&
            mutation.kind === "Review",
        )
      )
        return { model }
      return {
        ...refreshReview(finishMutation(model, operationId)),
        outMessage: OutMessage.Failed({
          title: "Issue review change could not be confirmed",
          reason,
        }),
      }
    },
    Selected: ({ repositoryId }) =>
      Option.contains(model.dataRepositoryId, repositoryId)
        ? { model }
        : refresh(
            evo(closed(model), {
              dataRepositoryId: () => Option.some(repositoryId),
              policySearch: () => "",
              selectedRuleId: () => null,
              detail: () => Option.none(),
              detailError: () => Option.none(),
              maybeConsent: () => Option.none(),
              consentError: () => Option.none(),
              maybeReview: () => Option.none(),
              reviewError: () => Option.none(),
            }),
          ),
    LiveChanged: ({ topics, all }) => ({
      model: {
        ...model,
        liveTopics: [
          ...new Set([
            ...model.liveTopics,
            ...(all
              ? ([
                  "configuration",
                  "activity",
                  "sync",
                  "candidates",
                  "consent",
                  "test",
                  "repository",
                  "review",
                ] as const)
              : topics),
          ]),
        ],
      },
    }),
    FlushLive: () => {
      const topics = model.liveTopics
      let next: UpdateReturn = { model: { ...model, liveTopics: [] } }
      const append = (result: UpdateReturn) => {
        next = { ...result, commands: [...(next.commands ?? []), ...(result.commands ?? [])] }
      }
      if (topics.includes("repository")) append(refreshRepositories(next.model))
      if (model.activity.active) {
        if (topics.includes("activity")) {
          const result = Activity.update(model.activity, Activity.Message.Polled())
          append({
            model: { ...next.model, activity: result.model },
            commands: FoldkitCommand.mapMessages(result.commands ?? [], (message) =>
              Message.GotActivityMessage({ message }),
            ),
          })
        }
      } else if (topics.some((topic) => ["configuration", "candidates", "consent"].includes(topic)))
        append(refresh(next.model, false))
      if (topics.includes("review")) {
        if (next.model.reviews.active) append(foldReviews(next.model, Reviews.Message.Polled()))
        else append(refreshReview(next.model))
      }
      if (topics.includes("test") && next.model.panel._tag === "RuleEditor")
        append(foldRuleEditor(next.model, RuleEditor.Message.RefreshTest()))
      return next
    },
    Polled: () => refresh(model, false),
    // A late answer for a repository that is no longer selected is dropped.
    GotDetail: ({ repositoryId, detail: received, requestId }) => {
      const detail = {
        ...received,
        configuration: {
          ...received.configuration,
          rules: received.configuration.rules.map((rule) => {
            const pending = model.pendingMutations.find(
              (mutation) =>
                mutation.kind === "RuleToggle" &&
                mutation.repositoryId === repositoryId &&
                mutation.subjectId === rule.id,
            )
            return pending ? { ...rule, enabled: pending.enabled } : rule
          }),
        },
      }
      return Option.contains(model.dataRepositoryId, repositoryId) &&
        Option.contains(model.maybeDetailRequest, requestId)
        ? {
            model: evo(model, {
              detail: () => Option.some(detail),
              maybeDetailRequest: () => Option.none(),
              detailError: () => Option.none<string>(),
              repositories: Option.map((repositories) =>
                repositories.map((repository) =>
                  repository.repositoryId === repositoryId
                    ? {
                        ...repository,
                        ruleCount: detail.configuration.rules.length,
                        policyCount: detail.configuration.policies.length,
                      }
                    : repository,
                ),
              ),
              panel: (panel) =>
                panel._tag === "PolicyEditor"
                  ? {
                      ...panel,
                      editor: PolicyEditor.reflectConfiguration(
                        PolicyEditor.withTestCandidates(
                          panel.editor,
                          detail.testCandidates ?? panel.editor.testCandidates,
                        ),
                        detail.configuration,
                      ),
                    }
                  : panel._tag === "RuleEditor"
                    ? {
                        ...panel,
                        editor: RuleEditor.reflectConfiguration(
                          panel.editor,
                          detail.configuration,
                          detail.testCandidates,
                        ),
                      }
                    : panel,
            }),
          }
        : { model }
    },
    FailedDetail: ({ repositoryId, reason, requestId }) =>
      Option.contains(model.dataRepositoryId, repositoryId) &&
      Option.contains(model.maybeDetailRequest, requestId)
        ? {
            model: evo(model, {
              detailError: () => Option.some(reason),
              maybeDetailRequest: () => Option.none(),
            }),
          }
        : { model },
    GotConsent: ({ repositoryId, consent, requestId }) =>
      Option.contains(model.dataRepositoryId, repositoryId) &&
      Option.contains(model.maybeConsentRequest, requestId)
        ? {
            model: evo(model, {
              maybeConsent: () => Option.some(consent),
              consentError: () => Option.none(),
              maybeConsentRequest: () => Option.none(),
            }),
          }
        : { model },
    FailedConsent: ({ repositoryId, reason, requestId }) =>
      Option.contains(model.dataRepositoryId, repositoryId) &&
      Option.contains(model.maybeConsentRequest, requestId)
        ? {
            model: evo(model, {
              consentError: () => Option.some(reason),
              maybeConsentRequest: () => Option.none(),
            }),
          }
        : { model },
    ClickedRetryConsent: () => refresh(model, false),
    ClickedToggleConsent: () => {
      if (Option.isNone(model.dataRepositoryId) || Option.isNone(model.maybeConsent))
        return { model }
      const repositoryId = model.dataRepositoryId.value
      if (
        hasMutation(model, repositoryId, repositoryId, ["Consent"]) ||
        model.maybeConsent.value.state === "draining"
      )
        return { model }
      const enabled = model.maybeConsent.value.state !== "enabled"
      return {
        model: startMutation(model, {
          repositoryId,
          subjectId: repositoryId,
          kind: "Consent",
          previousEnabled: !enabled,
          enabled,
        }),
        commands: [SetConsent({ repositoryId, enabled, operationId: model.nextOperationId })],
      }
    },
    CompletedSetConsent: ({ repositoryId, consent, operationId }) => {
      if (
        !model.pendingMutations.some(
          (mutation) =>
            mutation.operationId === operationId &&
            mutation.repositoryId === repositoryId &&
            mutation.kind === "Consent",
        )
      )
        return { model }
      const next = evo(finishMutation(model, operationId), {
        maybeConsent: (current) =>
          Option.contains(model.dataRepositoryId, repositoryId) ? Option.some(consent) : current,
      })
      return {
        ...refresh(next),
        outMessage: OutMessage.Notified({
          title:
            consent.state === "enabled"
              ? "AI classification enabled"
              : consent.state === "draining"
                ? "AI classification draining"
                : "AI classification disabled",
          description:
            consent.state === "draining"
              ? String(consent.activeLeases) + " calls still in flight; no new ones start."
              : consent.state === "enabled"
                ? "Classifier policies may send their named evidence to " +
                  consent.provider +
                  " " +
                  consent.model +
                  "."
                : "Classifier policies evaluate as unknown and never remove labels.",
        }),
      }
    },
    FailedSetConsent: ({ repositoryId, operationId, reason }) => {
      if (
        !model.pendingMutations.some(
          (mutation) =>
            mutation.operationId === operationId &&
            mutation.repositoryId === repositoryId &&
            mutation.kind === "Consent",
        )
      )
        return { model }
      return {
        ...refresh(finishMutation(model, operationId)),
        outMessage: OutMessage.Failed({
          title: "AI consent change could not be confirmed",
          reason,
        }),
      }
    },

    ClickedNewPolicy: () => ({
      model:
        model.panel._tag === "PolicyEditor" && model.panel.editor.identity._tag === "New"
          ? model
          : openPolicyEditor(model, Option.none()),
    }),
    ClickedEditPolicy: ({ policyId }) =>
      model.panel._tag === "PolicyEditor" &&
      model.panel.editor.identity._tag === "Existing" &&
      model.panel.editor.identity.policyId === policyId
        ? { model }
        : Option.match(model.dataRepositoryId, {
            onNone: () => ({ model }),
            onSome: (repositoryId) => ({
              model: evo(model, { panel: () => ({ _tag: "LoadingPolicy" as const, policyId }) }),
              commands: [FetchPolicyDetail({ repositoryId, policyId })],
            }),
          }),
    GotPolicyDetail: ({ detail }) =>
      model.panel._tag === "LoadingPolicy" &&
      model.panel.policyId === detail.policy.policyId &&
      Option.contains(model.dataRepositoryId, detail.policy.repositoryId)
        ? { model: openPolicyEditor(model, Option.some(detail)) }
        : { model },
    FailedPolicyDetail: ({ reason, repositoryId, policyId }) =>
      model.panel._tag === "LoadingPolicy" &&
      (repositoryId === undefined || Option.contains(model.dataRepositoryId, repositoryId)) &&
      (policyId === undefined || model.panel.policyId === policyId)
        ? {
            model: evo(model, {
              panel: () => ({
                _tag: "Unavailable" as const,
                message: `This policy could not be opened. It may have been deleted or you may no longer have access. ${reason}`,
              }),
            }),
          }
        : { model },
    ClickedDeletePolicy: ({ policyId, version }) =>
      deleteSubject(model, "policy", policyId, version),
    UpdatedRuleSearch: ({ value }) => ({ model: evo(model, { ruleSearch: () => value }) }),
    SelectedRule: ({ ruleId }) => ({ model: evo(model, { selectedRuleId: () => ruleId }) }),
    GotRuleMenuMessage: ({ ruleId, message }) => foldRuleMenu(ruleId)(model, message),
    ClickedNewRule: () => ({ model: openRuleEditor(model, Option.none()) }),
    ClickedEditRule: ({ ruleId }) =>
      Option.isSome(model.dataRepositoryId) &&
      hasMutation(model, model.dataRepositoryId.value, ruleId, ["RuleToggle", "RuleDelete"])
        ? { model }
        : { model: openRuleEditor(model, Option.some({ _tag: "Existing", ruleId, version: 0 })) },
    ClickedToggleRule: ({ ruleId }) => {
      if (Option.isNone(model.dataRepositoryId) || Option.isNone(model.detail)) return { model }
      const repositoryId = model.dataRepositoryId.value
      const rule = model.detail.value.configuration.rules.find((rule) => rule.id === ruleId)
      if (!rule || hasMutation(model, repositoryId, ruleId, ["RuleToggle", "RuleDelete"]))
        return { model }
      const next = startMutation(model, {
        repositoryId,
        subjectId: ruleId,
        kind: "RuleToggle",
        previousEnabled: rule.enabled,
        enabled: !rule.enabled,
      })
      return {
        model: acceptRule(next, { ...rule, enabled: !rule.enabled }),
        commands: [
          ToggleRule({
            repositoryId,
            operationId: model.nextOperationId,
            ruleId,
            version: rule.version,
            enabled: !rule.enabled,
          }),
        ],
      }
    },
    ClickedDeleteRule: ({ ruleId, version }) => deleteSubject(model, "rule", ruleId, version),
    CompletedDelete: ({ repositoryId, subjectId, what, operationId }) => {
      if (
        !model.pendingMutations.some(
          (mutation) =>
            mutation.operationId === operationId &&
            mutation.repositoryId === repositoryId &&
            mutation.subjectId === subjectId &&
            mutation.kind === (what === "policy" ? "PolicyDelete" : "RuleDelete"),
        )
      )
        return { model }
      let next = updateConfiguration(
        finishMutation(model, operationId),
        repositoryId,
        (configuration) => ({
          ...configuration,
          policies:
            what === "policy"
              ? configuration.policies.filter((policy) => policy.policyId !== subjectId)
              : configuration.policies,
          rules:
            what === "rule"
              ? configuration.rules.filter((rule) => rule.id !== subjectId)
              : configuration.rules,
        }),
      )
      if (isViewingSubject(next, repositoryId, what, subjectId)) next = closed(next)
      return {
        ...refresh(next),
        outMessage: OutMessage.Notified({
          title: "Deleted the " + what,
          description: "The list has been updated.",
        }),
      }
    },
    FailedDelete: ({ repositoryId, operationId, subjectId, reason }) => {
      if (
        !model.pendingMutations.some(
          (mutation) =>
            mutation.operationId === operationId &&
            mutation.repositoryId === repositoryId &&
            mutation.subjectId === subjectId,
        )
      )
        return { model }
      return {
        ...refresh(finishMutation(model, operationId)),
        outMessage: OutMessage.Failed({ title: "Deletion could not be confirmed", reason }),
      }
    },
    CompletedToggleRule: ({ repositoryId, operationId, rule }) => {
      if (
        !model.pendingMutations.some(
          (mutation) =>
            mutation.operationId === operationId &&
            mutation.repositoryId === repositoryId &&
            mutation.kind === "RuleToggle" &&
            mutation.subjectId === rule.id,
        )
      )
        return { model }
      return {
        ...refresh(acceptRule(finishMutation(model, operationId), rule)),
        outMessage: OutMessage.SyncWorkChanged(),
      }
    },
    FailedToggleRule: ({ repositoryId, operationId, ruleId, reason }) => {
      const pending = model.pendingMutations.find(
        (mutation) =>
          mutation.operationId === operationId &&
          mutation.repositoryId === repositoryId &&
          mutation.subjectId === ruleId &&
          mutation.kind === "RuleToggle",
      )
      if (!pending) return { model }
      const next = updateConfiguration(
        finishMutation(model, operationId),
        repositoryId,
        (configuration) => ({
          ...configuration,
          rules: configuration.rules.map((rule) =>
            rule.id === ruleId ? { ...rule, enabled: pending.previousEnabled } : rule,
          ),
        }),
      )
      return {
        ...refresh(next),
        outMessage: OutMessage.Failed({ title: "Rule change could not be confirmed", reason }),
      }
    },

    GotPolicyEditorMessage: ({ message }) => {
      if (model.panel._tag !== "PolicyEditor") return { model }
      const editor = model.panel.editor
      if (
        editor.identity._tag === "Existing" &&
        hasMutation(model, editor.repositoryId, editor.identity.policyId, ["PolicyDelete"])
      )
        return { model }
      if (message._tag === "SelectedTestItem")
        return { model, outMessage: OutMessage.SelectedPolicyTestItem({ number: message.number }) }
      return foldPolicyEditor(model, message)
    },
    GotRuleEditorMessage: ({ message }) =>
      model.panel._tag === "RuleEditor" &&
      model.panel.editor.identity._tag === "Existing" &&
      hasMutation(model, model.panel.editor.repositoryId, model.panel.editor.identity.ruleId, [
        "RuleDelete",
      ])
        ? { model }
        : foldRuleEditor(model, message),
  })

// SUBSCRIPTIONS

const liveRefresh = Subscription.make<Model, Message>()((entry) => ({
  ruleTestDeadline: entry(
    { job: Schema.NullOr(Schema.Struct({ generation: Schema.Int, startedAt: Schema.Number })) },
    {
      modelToDependencies: (model) => {
        const editor = model.panel._tag === "RuleEditor" ? model.panel.editor : undefined
        const job = editor?.testResult._tag === "Running" ? editor.liveJob : null
        return { job: job ? { generation: job.generation, startedAt: job.startedAt } : null }
      },
      dependenciesToStream: ({ job }) =>
        job
          ? Stream.fromEffect(
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis
                yield* Effect.sleep(Math.max(0, job.startedAt + 240_000 - now))
                return Message.GotRuleEditorMessage({
                  message: RuleEditor.Message.FailedTest({
                    generation: job.generation,
                    reason: "The test timed out. Run it again.",
                  }),
                })
              }),
            )
          : Stream.empty,
    },
  ),
  liveRefresh: entry(
    { topics: Schema.Array(Live.Topic), busy: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        topics: model.liveTopics,
        busy:
          Option.isSome(model.maybeDetailRequest) ||
          Option.isSome(model.maybeConsentRequest) ||
          Option.isSome(model.maybeReviewRequest) ||
          model.activity.loading ||
          model.reviews.loading,
      }),
      dependenciesToStream: ({ topics, busy }) =>
        topics.length && !busy ? Stream.succeed(Message.FlushLive()) : Stream.empty,
    },
  ),
}))

export const subscriptions = Subscription.aggregate<Model, Message>()(
  liveRefresh,
  Subscription.lift(Activity.subscriptions)<Model, Message>({
    toChildModel: (model) => model.activity,
    toParentMessage: (message) => Message.GotActivityMessage({ message }),
  }),
)

// VIEW

const policiesSection = (h: HtmlBuilder<Message>, model: Model, view: ConfigurationView): Html => {
  const creating =
    model.panel._tag === "PolicyEditor" && model.panel.editor.identity._tag === "New"
      ? model.panel.editor
      : undefined
  const query = model.policySearch.trim().toLowerCase()
  const policies = view.policies.filter((policy) =>
    `${policy.name} ${policy.description}`.toLowerCase().includes(query),
  )
  const selectedId =
    model.panel._tag === "LoadingPolicy"
      ? model.panel.policyId
      : model.panel._tag === "PolicyEditor" && model.panel.editor.identity._tag === "Existing"
        ? model.panel.editor.identity.policyId
        : undefined
  return h.aside(
    [h.Class("policy-library"), h.AriaLabel("Policy library")],
    [
      h.div(
        [h.Class("policy-library-header")],
        [
          h.div(
            [h.Class("flex items-center justify-between gap-2")],
            [
              h.h2(
                [h.Class("text-caption font-medium text-ink-subtle")],
                [
                  "All policies",
                  h.span(
                    [h.Class("ml-2 font-mono text-mono-xs font-normal")],
                    [String(view.policies.length + (creating ? 1 : 0))],
                  ),
                ],
              ),
              Button.view(h, {
                variant: "ghost",
                size: "icon-sm",
                label: Icon.view(h, Plus),
                onClick: Message.ClickedNewPolicy(),
                attributes: [
                  h.AriaLabel("New policy"),
                  h.Title("New policy"),
                  h.DataAttribute("action", "new-policy"),
                ],
              }),
            ],
          ),
          inputGroup(h, {
            children: [
              inputGroupAddon(h, { children: [Icon.view(h, Search)] }),
              inputGroupInput(h, {
                id: "policy-search",
                ariaLabel: "Search policies",
                placeholder: "Find a policy…",
                value: model.policySearch,
                onInput: (value) => Message.UpdatedPolicySearch({ value }),
              }),
            ],
          }),
        ],
      ),
      h.ul(
        [h.Class("policy-library-list")],
        [
          ...(creating
            ? [
                h.li(
                  [h.DataAttribute("policy-id", "new")],
                  [
                    h.div(
                      [h.Class("policy-library-item is-selected"), h.AriaCurrent("page")],
                      [
                        h.span(
                          [h.Class("policy-library-name")],
                          [
                            (creating.metadataEdits.name ?? creating.name).trim() ||
                              "Untitled policy",
                          ],
                        ),
                        h.span(
                          [h.Class("policy-library-summary")],
                          [
                            (creating.metadataEdits.description ?? creating.description) ||
                              "No description",
                          ],
                        ),
                        h.span(
                          [h.Class("policy-library-meta")],
                          [
                            Option.match(PolicyEditor.parsedSource(creating), {
                              onNone: () => "Policy",
                              onSome: (source) =>
                                source.target === "pull_request" ? "Pull requests" : "Issues",
                            }),
                            h.span([h.Class("text-muted-foreground")], ["Unsaved"]),
                          ],
                        ),
                      ],
                    ),
                  ],
                ),
              ]
            : []),
          ...policies.map((policy) => {
            const deleting = hasMutation(model, view.repositoryId, policy.policyId, [
              "PolicyDelete",
            ])
            const panel = model.panel
            const editor =
              panel._tag === "PolicyEditor" &&
              panel.editor.identity._tag === "Existing" &&
              panel.editor.identity.policyId === policy.policyId
                ? panel.editor
                : undefined
            const status =
              editor === undefined
                ? {
                    published: policy.publishedRevision !== null,
                    revision: policy.publishedRevision,
                    changes: policy.draftDiffers ?? false,
                  }
                : PolicyEditor.publicationStatus(editor)
            return h.li(
              [h.DataAttribute("policy-id", policy.policyId)],
              [
                h.a(
                  [
                    h.Href(
                      Routes.policy({
                        repositoryId: view.repositoryId,
                        policyId: policy.policyId,
                        ...(model.policySearch ? { q: model.policySearch } : {}),
                      }),
                    ),
                    h.Class(
                      cn(
                        "policy-library-item",
                        selectedId === policy.policyId && "is-selected",
                        deleting && "pointer-events-none opacity-60",
                      ),
                    ),
                    h.AriaCurrent(selectedId === policy.policyId ? "page" : "false"),
                    h.DataAttribute("action", "edit-policy"),
                    h.AriaDisabled(deleting),
                    ...(deleting ? [h.Tabindex(-1)] : []),
                  ],
                  [
                    h.span(
                      [h.Class("policy-library-name flex items-center gap-1.5")],
                      [
                        policy.name,
                        deleting ? h.span([h.Role("status")], ["Deleting…"]) : h.empty,
                        editor !== undefined && PolicyEditor.hasUnsavedInput(editor)
                          ? h.span(
                              [
                                h.Class("policy-unsaved-dot"),
                                h.Role("img"),
                                h.AriaLabel("Unsaved changes"),
                                h.Title("Unsaved changes"),
                              ],
                              [],
                            )
                          : h.empty,
                      ],
                    ),
                    h.span(
                      [h.Class("policy-library-summary")],
                      [policy.description || "No description"],
                    ),
                    h.span(
                      [h.Class("policy-library-meta")],
                      [
                        policy.target === "pull_request" ? "Pull requests" : "Issues",
                        PolicyStatus.view(h, status),
                      ],
                    ),
                  ],
                ),
              ],
            )
          }),
        ],
      ),
      policies.length === 0 && view.policies.length > 0
        ? h.p([h.Class("p-3 text-body-sm text-ink-muted")], ["No policies match your search."])
        : h.empty,
    ],
  )
}

const RuleMenu = Menu.create<"Edit">()
const ruleMenuModel = (model: Model, ruleId: string) =>
  model.ruleMenus[ruleId] ?? Menu.init({ id: `rule-menu-${ruleId}`, isModal: false })
const foldRuleMenu = (ruleId: string) =>
  Update.foldChild({
    update: RuleMenu.update,
    read: (model: Model) => Option.some(ruleMenuModel(model, ruleId)),
    write: (model, menu) => evo(model, { ruleMenus: (menus) => ({ ...menus, [ruleId]: menu }) }),
    toParentMessage: (message) => Message.GotRuleMenuMessage({ ruleId, message }),
    toParentOutMessage: () => OutMessage.RequestedRule({ ruleId }),
  })

export const ruleBehavior = (view: ConfigurationView, rule: RuleRecord): string =>
  `${rule.ai ? (rule.ai.prompt.split("\n")[0] ?? "AI classification") : policyName(view.policies, rule.policyId)} · Match: ${describeResultAction(rule.onMatch)} · Non-match: ${describeResultAction(rule.onNoMatch)}`

const ruleType = (view: ConfigurationView, rule: RuleRecord): string =>
  rule.ai ||
  view.policies.find((policy) => policy.policyId === rule.policyId)?.publishedEvaluator ===
    "Classifier"
    ? "AI"
    : "Policy"

/** GitHub label colours are user data, the one value the interface renders
 *  that does not come from the theme. They appear only as a 6px dot. */
export const labelDotStyle = (color: string | null | undefined): Record<string, string> =>
  !color || !/^[0-9a-f]{6}$/i.test(color) ? {} : { backgroundColor: `#${color}` }

export const labelBadge = <M>(
  h: HtmlBuilder<M>,
  name: string,
  color: string | null | undefined,
  className?: string,
): Html =>
  chip(h, {
    ...(className === undefined ? {} : { className }),
    children: [
      ...(Object.keys(labelDotStyle(color)).length === 0
        ? []
        : [
            h.span(
              [
                h.Class("size-1.5 shrink-0 rounded-full"),
                h.Style(labelDotStyle(color)),
                h.AriaHidden(true),
              ],
              [],
            ),
          ]),
      name,
    ],
  })

const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "always" })

/** "3 days ago" for table cells; past a month the date itself reads better. */
export const describeAge = (at: DateTime.Utc, nowMillis: number): string => {
  const seconds = Math.max(0, Math.round((nowMillis - DateTime.toEpochMillis(at)) / 1000))
  const minutes = Math.round(seconds / 60)
  const hours = Math.round(minutes / 60)
  const days = Math.round(hours / 24)
  if (seconds < 45) return "just now"
  if (minutes < 60) return relativeFormat.format(-minutes, "minute")
  if (hours < 24) return relativeFormat.format(-hours, "hour")
  if (days < 31) return relativeFormat.format(-days, "day")
  return DateTime.formatUtc(at, { day: "numeric", month: "short", year: "numeric" })
}

/** `2026-09-05 11:05`, the machine form for inspector rows. */
export const formatTimestamp = (at: DateTime.Utc): string =>
  DateTime.formatIso(at).slice(0, 16).replace("T", " ")

const describeTarget = (target: PolicyRecord["target"]): string =>
  target === "issue" ? "issues" : "pull_requests"

/** A link dressed as a button, for actions that are navigation. */
const linkButton = <M>(
  h: HtmlBuilder<M>,
  config: {
    readonly href: string
    readonly label: ReadonlyArray<Html | string>
    readonly variant?: Button.ButtonVariant
    readonly size?: Button.ButtonSize
    readonly attributes?: ReadonlyArray<Parameters<typeof h.a>[0][number]>
  },
): Html =>
  h.a(
    [
      h.Href(config.href),
      h.Class(
        cn(
          Button.buttonBase,
          "inline-flex items-center justify-center shrink-0 whitespace-nowrap [&_svg]:shrink-0",
          Button.buttonVariants[config.variant ?? "secondary"],
          Button.buttonSizes[config.size ?? "default"],
        ),
      ),
      h.DataAttribute("slot", "button"),
      h.DataAttribute("size", config.size ?? "default"),
      h.DataAttribute("variant", config.variant ?? "secondary"),
      ...(config.attributes ?? []),
    ],
    config.label,
  )

const ruleRow = (
  h: HtmlBuilder<Message>,
  model: Model,
  view: ConfigurationView,
  rule: RuleRecord,
  nowMillis: number,
): Html => {
  const name = labelName(view.labels, rule.labelId)
  const label = view.labels.find((label) => label.labelId === rule.labelId)
  const pending = model.pendingMutations.find(
    (mutation) =>
      mutation.repositoryId === rule.repositoryId &&
      mutation.subjectId === rule.id &&
      (mutation.kind === "RuleToggle" || mutation.kind === "RuleDelete"),
  )
  const isAi = ruleType(view, rule) === "AI"
  const isSelected = model.selectedRuleId === rule.id
  // Clicking the informational cells selects the row; the switch and the
  // action buttons keep their own behaviour, so they carry no handler.
  const select: ReadonlyArray<Parameters<typeof h.td>[0][number]> = [
    h.OnClick(Message.SelectedRule({ ruleId: rule.id })),
  ]
  return Table.row(h, {
    isSelected,
    className: "cursor-pointer",
    attributes: [h.DataAttribute("rule-id", rule.id)],
    children: [
      Table.cell(h, {
        children: [
          SwitchControl.view(h, {
            id: `rule-toggle-${rule.id}`,
            label: `Enable ${name}`,
            isLabelHidden: true,
            isChecked: rule.enabled,
            isDisabled: pending !== undefined,
            isBusy: pending !== undefined,
            onToggle: () => Message.ClickedToggleRule({ ruleId: rule.id }),
          }),
          pending
            ? h.span(
                [h.Class("sr-only"), h.Role("status")],
                [
                  pending.kind === "RuleDelete"
                    ? "Deleting…"
                    : rule.enabled
                      ? "Enabling…"
                      : "Disabling…",
                ],
              )
            : h.empty,
        ],
      }),
      Table.cell(h, {
        attributes: select,
        children: [
          isAi
            ? chip(h, { variant: "agent", children: ["AI"] })
            : chip(h, { children: ["policy"] }),
        ],
      }),
      Table.cell(h, {
        attributes: select,
        children: [
          labelBadge(
            h,
            name,
            label?.color,
            rule.labelStatus === "missing" ? "line-through text-ink-subtle" : undefined,
          ),
        ],
      }),
      // Label and Policy share the leftover width (fixed layout) and truncate.
      Table.cell(h, {
        code: true,
        attributes: select,
        children: [
          h.span(
            [h.Class("block truncate"), h.Title(policyName(view.policies, rule.policyId))],
            [policyName(view.policies, rule.policyId)],
          ),
        ],
      }),
      Table.cell(h, {
        code: true,
        attributes: select,
        children: [h.span([h.Title(rule.group ?? "No exclusive group")], [rule.group ?? "–"])],
      }),
      Table.cell(h, {
        code: true,
        numeric: true,
        attributes: select,
        children: [String(rule.priority)],
      }),
      Table.cell(h, {
        className: "whitespace-nowrap text-ink-muted",
        attributes: [...select, h.Title(formatTimestamp(rule.updatedAt))],
        children: [describeAge(rule.updatedAt, nowMillis)],
      }),
      Table.cell(h, {
        className: "w-20 py-1",
        children: [
          h.div(
            [h.Class("flex items-center justify-end gap-1")],
            [
              linkButton(h, {
                href: Routes.rule({ repositoryId: rule.repositoryId, ruleId: rule.id }),
                variant: "ghost",
                size: "icon-xs",
                label: [Icon.view(h, Pencil, "size-4 text-ink-subtle")],
                attributes: [
                  h.AriaLabel(`Edit ${name}`),
                  h.Title("Edit rule"),
                  h.DataAttribute("action", "edit-rule"),
                ],
              }),
              h.submodel({
                slotId: `rule-menu-${rule.id}`,
                model: ruleMenuModel(model, rule.id),
                view: RuleMenu.view,
                viewInputs: {
                  items: ["Edit"],
                  ariaLabel: `Actions for ${name}`,
                  isButtonDisabled: hasMutation(model, rule.repositoryId, rule.id, [
                    "RuleDelete",
                    "RuleToggle",
                  ]),
                  buttonContent: Icon.view(h, Ellipsis),
                  buttonClassName: cn(
                    Overlay.menuButtonClass,
                    "size-7 border-transparent bg-transparent",
                  ),
                  buttonAttributes: childAttributes([
                    h.AriaLabel(`Actions for ${name}`),
                    h.Title("Rule actions"),
                  ]),
                  itemsClassName: Overlay.menuItemsClass,
                  anchor: { placement: "bottom-end", gap: 4 },
                  itemToConfig: (_item, { isActive }) => ({
                    className: cn(Overlay.menuItemClass, isActive && Overlay.menuItemActiveClass),
                    content: h.span(
                      [h.Class("flex items-center gap-2"), h.DataAttribute("action", "edit-rule")],
                      [Icon.view(h, Pencil), "Edit rule"],
                    ),
                  }),
                },
                toParentMessage: (message) =>
                  Message.GotRuleMenuMessage({ ruleId: rule.id, message }),
              }),
            ],
          ),
        ],
      }),
    ],
  })
}

/** The selected rule as a read-only blueprint: what it watches, what must
 *  hold, what it does. Mirrors the editor's graph without the controls. */
const ruleDetailCard = (
  h: HtmlBuilder<Message>,
  view: ConfigurationView,
  rule: RuleRecord,
): Html => {
  const name = labelName(view.labels, rule.labelId)
  const policy = view.policies.find((policy) => policy.policyId === rule.policyId)
  const ai = rule.ai ?? undefined
  const target = ai?.target ?? policy?.target ?? "issue"
  const gate = ai?.gatePolicyId
    ? view.policies.find((policy) => policy.policyId === ai.gatePolicyId)
    : undefined
  const whenNodes = [
    Blueprint.node(h, { kind: "Event", children: [describeTarget(target)] }),
    ...(gate === undefined
      ? []
      : [Blueprint.node(h, { kind: "Gate policy", children: [gate.name] })]),
  ]
  const conditionNodes = [
    Blueprint.node(h, { kind: "Policy", children: [policyName(view.policies, rule.policyId)] }),
    ...(ai === undefined
      ? []
      : [
          Blueprint.node(h, {
            kind: "Agent",
            isAgent: true,
            isSelected: true,
            children: [
              h.div([], [`confidence ≥ ${ai.minimumConfidence.toFixed(2)}`]),
              h.div(
                [h.Class("mt-1 whitespace-pre-wrap wrap-anywhere text-ink-muted")],
                [ai.prompt],
              ),
            ],
          }),
        ]),
  ]
  const thenNodes = [
    Blueprint.node(h, { kind: "Match", children: [describeResultAction(rule.onMatch)] }),
    Blueprint.node(h, { kind: "No match", children: [describeResultAction(rule.onNoMatch)] }),
  ]
  const nodeCount = whenNodes.length + conditionNodes.length + thenNodes.length
  return panel(h, {
    flush: true,
    attributes: [
      h.DataAttribute("rule-detail", rule.id),
      h.Role("region"),
      h.AriaLabel(`Rule ${name}`),
    ],
    children: [
      panelHeader(h, {
        title: h.span([h.Class("font-mono")], [name]),
        meta: `v${rule.version}`,
        actions: [
          linkButton(h, {
            href: Routes.rule({ repositoryId: rule.repositoryId, ruleId: rule.id }),
            label: [Icon.view(h, Pencil), "Edit"],
            attributes: [h.DataAttribute("action", "edit-rule")],
          }),
        ],
      }),
      // The graph scrolls inside its card; without `contain` its natural width
      // would still widen the page and push the inspector off screen.
      Blueprint.canvas(h, {
        className: "contain-inline-size",
        children: [
          Blueprint.column(h, { label: "When", children: whenNodes }),
          Blueprint.wire(h, { label: ai ? "gate" : "evaluate" }),
          Blueprint.column(h, {
            label: ai ? "If The Janitor classifies it" : "If every condition matches",
            ...(ai ? { className: "w-72" } : {}),
            children: conditionNodes,
          }),
          Blueprint.wire(h, {
            paths: [
              { fromY: 24, toY: 24, label: "match" },
              { fromY: 24, toY: 110, label: "no match" },
            ],
          }),
          Blueprint.column(h, { label: "Then", children: thenNodes }),
        ],
      }),
      Blueprint.footer(h, {
        summary: ai
          ? "Applies to a target, runs the classification, then acts on the label"
          : "Evaluates the policy, then acts on the label",
        counts: `${nodeCount} nodes · 3 wires`,
      }),
    ],
  })
}

const ruleSelectionCard = (
  h: HtmlBuilder<Message>,
  view: ConfigurationView,
  rule: RuleRecord | undefined,
): Html =>
  Page.inspectorCard(h, {
    heading: "Selection",
    children:
      rule === undefined
        ? [h.p([h.Class("text-body-md text-ink-muted")], ["Select a rule to see its details."])]
        : [
            h.div(
              [h.Class("flex flex-wrap items-center gap-2")],
              [
                labelBadge(
                  h,
                  labelName(view.labels, rule.labelId),
                  view.labels.find((label) => label.labelId === rule.labelId)?.color,
                  rule.labelStatus === "missing" ? "line-through text-ink-subtle" : undefined,
                ),
                ruleType(view, rule) === "AI"
                  ? chip(h, { variant: "agent", children: ["AI"] })
                  : h.empty,
              ],
            ),
            h.div(
              [h.Class("mt-3")],
              [
                Page.kvList(h, [
                  Page.kv(h, "Policy", policyName(view.policies, rule.policyId)),
                  Page.kv(h, "Group", rule.group ?? "–"),
                  Page.kv(h, "Priority", String(rule.priority)),
                  ...(rule.ai
                    ? [Page.kv(h, "Confidence", `≥ ${rule.ai.minimumConfidence.toFixed(2)}`)]
                    : []),
                  Page.kv(h, "Version", String(rule.version)),
                  Page.kv(h, "Updated", formatTimestamp(rule.updatedAt)),
                ]),
              ],
            ),
          ],
  })

const rulesSection = (h: HtmlBuilder<Message>, model: Model, view: ConfigurationView): Html => {
  const query = model.ruleSearch.trim().toLowerCase()
  const rules = view.rules.filter((rule) =>
    `${labelName(view.labels, rule.labelId)} ${ruleBehavior(view, rule)} ${rule.group ?? ""} ${view.policies.find((policy) => policy.policyId === rule.policyId)?.description ?? ""} ${ruleType(view, rule)}`
      .toLowerCase()
      .includes(query),
  )
  const selected = view.rules.find((rule) => rule.id === model.selectedRuleId)
  const nowMillis = Date.now()
  const newRule = Button.view(h, {
    onClick: Message.ClickedNewRule(),
    label: h.span([h.Class("contents")], [Icon.view(h, Plus), "New rule"]),
    attributes: [h.DataAttribute("action", "new-rule")],
  })
  return Page.layout(h, {
    attributes: [h.AriaLabel("Labeling rules")],
    main: [
      Page.header(h, {
        title: "Labeling rules",
        lede: "Connect policies to the labels they manage. Rules run top to bottom; the first match in a group wins.",
        actions: [newRule],
      }),
      h.div(
        [h.DataAttribute("slot", "tabs-list"), h.Role("tablist")],
        [
          h.button(
            [
              h.Type("button"),
              h.Role("tab"),
              h.DataAttribute("slot", "tabs-trigger"),
              h.DataAttribute("state", "active"),
              h.AriaSelected(true),
            ],
            ["Rules"],
          ),
        ],
      ),
      view.rules.length === 0
        ? emptyPanel(h, {
            children: [
              h.div(
                [h.Class("flex flex-wrap items-center justify-between gap-3")],
                [
                  h.span(
                    [h.Class("text-foreground")],
                    ["No rules yet. Choose a published policy and the label it manages."],
                  ),
                  Button.view(h, {
                    size: "sm",
                    label: "New rule",
                    onClick: Message.ClickedNewRule(),
                  }),
                ],
              ),
            ],
          })
        : panel(h, {
            flush: true,
            children: [
              panelHeader(h, {
                title: "Rules",
                meta: `${rules.length} of ${view.rules.length}`,
                actions: [
                  inputGroup(h, {
                    className: "w-64",
                    children: [
                      inputGroupAddon(h, { children: [Icon.view(h, Search)] }),
                      inputGroupInput(h, {
                        id: "rule-search",
                        ariaLabel: "Search rules",
                        value: model.ruleSearch,
                        placeholder: "Find a rule",
                        onInput: (value) => Message.UpdatedRuleSearch({ value }),
                      }),
                    ],
                  }),
                ],
              }),
              h.div(
                [h.Class("overflow-x-auto contain-inline-size")],
                [
                  Table.table(h, {
                    className: "min-w-2xl table-fixed",
                    children: [
                      Table.head(h, [
                        Table.row(h, {
                          children: [
                            Table.headCell(h, { className: "w-16", children: ["Enabled"] }),
                            Table.headCell(h, { className: "w-20", children: ["Type"] }),
                            Table.headCell(h, { children: ["Label"] }),
                            Table.headCell(h, { children: ["Policy"] }),
                            Table.headCell(h, { className: "w-24", children: ["Group"] }),
                            Table.headCell(h, {
                              className: "w-20",
                              numeric: true,
                              children: ["Priority"],
                            }),
                            Table.headCell(h, { className: "w-28", children: ["Updated"] }),
                            Table.headCell(h, {
                              className: "w-20",
                              children: [h.span([h.Class("sr-only")], ["Actions"])],
                            }),
                          ],
                        }),
                      ]),
                      Table.body(
                        h,
                        rules.map((rule) => ruleRow(h, model, view, rule, nowMillis)),
                      ),
                    ],
                  }),
                  rules.length === 0
                    ? h.p(
                        [h.Class("px-4 py-3 text-body-sm text-ink-muted")],
                        ["No rules match your search."],
                      )
                    : h.empty,
                ],
              ),
            ],
          }),
      ...(selected === undefined ? [] : [ruleDetailCard(h, view, selected)]),
    ],
    inspector: [ruleSelectionCard(h, view, selected)],
  })
}

/** The AI classification card alone; the shell provides the page around it. */
/** The issue review card: opt-in and dry-run for this repository. */
const reviewSection = (h: HtmlBuilder<Message>, model: Model): Html => {
  const review = Option.getOrUndefined(model.maybeReview)
  const busy =
    review !== undefined && hasMutation(model, review.repositoryId, review.repositoryId, ["Review"])
  return panel(h, {
    flush: true,
    attributes: [
      h.DataAttribute(
        "review",
        review === undefined ? "unknown" : review.enabled ? "enabled" : "disabled",
      ),
      h.AriaLabel("Issue review"),
    ],
    children: [
      panelHeader(h, {
        title: "Issue review",
        ...(review === undefined || review.available ? {} : { meta: "unavailable" }),
        actions:
          review === undefined
            ? []
            : [
                Button.view(h, {
                  variant: review.enabled ? "destructive" : "secondary",
                  size: "sm",
                  onClick: Message.ChangedReview({
                    enabled: !review.enabled,
                    dryRun: review.dryRun,
                  }),
                  isDisabled: busy || (!review.enabled && !review.available),
                  label: busy
                    ? review.enabled
                      ? "Disabling…"
                      : "Enabling…"
                    : review.enabled
                      ? "Disable"
                      : "Enable",
                  attributes: [h.DataAttribute("action", "toggle-review")],
                }),
              ],
      }),
      h.div(
        [h.Class("flex flex-col gap-2 px-4 py-3")],
        [
          Option.isSome(model.reviewError)
            ? h.div(
                [
                  h.Role("alert"),
                  h.Class("flex flex-wrap items-center gap-2 text-body-sm text-destructive"),
                ],
                [
                  model.reviewError.value,
                  Button.view(h, {
                    label: "Retry issue review",
                    variant: "secondary",
                    size: "sm",
                    onClick: Message.ClickedRetryReview(),
                    isDisabled: Option.isSome(model.maybeReviewRequest),
                  }),
                ],
              )
            : h.empty,
          review === undefined
            ? Option.isSome(model.reviewError)
              ? h.empty
              : h.p([h.Class("text-body-md text-ink-muted")], ["Loading"])
            : h.div(
                [h.Class("flex flex-col gap-3")],
                [
                  h.div(
                    [h.Class("flex items-center gap-2")],
                    [
                      chip(h, {
                        variant: review.enabled ? "success" : "neutral",
                        children: [review.enabled ? "Enabled" : "Disabled"],
                      }),
                      ...(review.enabled && review.dryRun
                        ? [chip(h, { children: ["dry-run"] })]
                        : []),
                    ],
                  ),
                  h.p(
                    [h.Class("text-body-md text-ink-muted")],
                    [
                      review.enabled
                        ? "A comment on an open issue containing /janitor, from someone with write or admin permission, starts a review run. One run is active per issue; later invocations wait behind it."
                        : "The /janitor command is ignored on this repository's issues. Enabling admits comments posted from now on; earlier ones never start work.",
                    ],
                  ),
                  SwitchControl.view(h, {
                    id: "review-dry-run",
                    label: "Dry-run: keep findings in Janitor and never write to GitHub",
                    isChecked: review.dryRun,
                    isDisabled: busy,
                    onToggle: (dryRun) =>
                      Message.ChangedReview({ enabled: review.enabled, dryRun }),
                  }),
                  !review.available
                    ? h.p(
                        [h.Class("text-body-md text-ink-muted")],
                        ["Issue review is not available in this deployment yet."],
                      )
                    : h.empty,
                ],
              ),
        ],
      ),
    ],
  })
}

const consentSection = (h: HtmlBuilder<Message>, model: Model): Html => {
  const consent = Option.getOrUndefined(model.maybeConsent)
  const busy =
    consent !== undefined &&
    hasMutation(model, consent.repositoryId, consent.repositoryId, ["Consent"])
  return panel(h, {
    flush: true,
    attributes: [
      h.DataAttribute("consent", consent?.state ?? "unknown"),
      h.AriaLabel("AI classification"),
    ],
    children: [
      panelHeader(h, {
        title: "AI classification",
        ...(consent === undefined || consent.provider === "none"
          ? {}
          : { meta: `${consent.provider} · ${consent.model}` }),
        actions:
          consent === undefined
            ? []
            : [
                Button.view(h, {
                  variant: consent.state === "enabled" ? "destructive" : "secondary",
                  size: "sm",
                  onClick: Message.ClickedToggleConsent(),
                  isDisabled: busy || consent.state === "draining",
                  label: busy
                    ? consent.state === "enabled"
                      ? "Revoking…"
                      : "Enabling…"
                    : consent.state === "enabled"
                      ? "Revoke"
                      : consent.state === "draining"
                        ? "Draining"
                        : "Enable",
                  attributes: [h.DataAttribute("action", "toggle-consent")],
                }),
              ],
      }),
      h.div(
        [h.Class("flex flex-col gap-2 px-4 py-3")],
        [
          Option.isSome(model.consentError)
            ? h.div(
                [
                  h.Role("alert"),
                  h.Class("flex flex-wrap items-center gap-2 text-body-sm text-destructive"),
                ],
                [
                  model.consentError.value,
                  Button.view(h, {
                    label: "Retry AI consent",
                    variant: "secondary",
                    size: "sm",
                    onClick: Message.ClickedRetryConsent(),
                    isDisabled: Option.isSome(model.maybeConsentRequest),
                  }),
                ],
              )
            : h.empty,
          consent === undefined
            ? Option.isSome(model.consentError)
              ? h.empty
              : h.p([h.Class("text-body-md text-ink-muted")], ["Loading"])
            : h.div(
                [h.Class("flex flex-col gap-2")],
                [
                  h.div(
                    [h.Class("flex items-center gap-2")],
                    [
                      chip(h, {
                        variant: consent.state === "enabled" ? "success" : "neutral",
                        children: [
                          consent.state === "enabled"
                            ? "Enabled"
                            : consent.state === "draining"
                              ? "Draining"
                              : "Disabled",
                        ],
                      }),
                    ],
                  ),
                  h.p(
                    [h.Class("text-body-md text-ink-muted")],
                    [
                      consent.state === "enabled"
                        ? `Enabled for ${consent.provider} ${consent.model}. Classifier policies send only the evidence facts they name, with no credentials or repository access, and their answers use each rule's configured match and non-match actions.`
                        : consent.state === "draining"
                          ? `Revoked. ${consent.activeLeases} call${consent.activeLeases === 1 ? "" : "s"} already in flight cannot be recalled; no new ones start, and this becomes disabled when they finish.`
                          : `Disabled. Classifier policies evaluate as unknown, which preserves labels. Enabling sends the evidence facts a classifier names to ${consent.provider === "none" ? "the configured provider" : `${consent.provider} ${consent.model}`}.`,
                    ],
                  ),
                  consent.provider === "none" && consent.state !== "enabled"
                    ? h.p(
                        [h.Class("text-body-md text-ink-muted")],
                        [
                          "No provider key is configured on the server, so enabling has no effect yet.",
                        ],
                      )
                    : h.empty,
                ],
              ),
        ],
      ),
    ],
  })
}

const panelView = (h: HtmlBuilder<Message>, model: Model): Html => {
  switch (model.panel._tag) {
    case "Closed":
      return h.empty
    case "Unavailable":
      return h.p(
        [h.Class("p-4 text-body-sm text-destructive"), h.Role("alert")],
        [model.panel.message],
      )
    case "LoadingPolicy":
      return h.div([h.Class("p-4 text-body-sm text-ink-muted")], ["Loading the policy"])
    case "PolicyEditor": {
      const editor = model.panel.editor
      return h.submodel({
        slotId: "policy-editor",
        model: editor,
        view: PolicyEditor.view,
        viewInputs: {
          isDeleting:
            editor.identity._tag === "Existing" &&
            hasMutation(model, editor.repositoryId, editor.identity.policyId, ["PolicyDelete"]),
        },
        toParentMessage: (message) => Message.GotPolicyEditorMessage({ message }),
      })
    }
    case "RuleEditor":
      return h.submodel({
        slotId: "rule-editor",
        model: model.panel.editor,
        view: RuleEditor.view,
        viewInputs: {
          isDeleting:
            model.panel.editor.identity._tag === "Existing" &&
            hasMutation(
              model,
              model.panel.editor.repositoryId,
              model.panel.editor.identity.ruleId,
              ["RuleDelete"],
            ),
        },
        toParentMessage: (message) => Message.GotRuleEditorMessage({ message }),
      })
  }
}

const describeFreshness = (freshness: ConfigurationView["labelFreshness"]): string => {
  switch (freshness) {
    case "verified":
      return "verified against GitHub"
    case "syncing":
      return "synchronizing now"
    case "stale":
      return "stale, re-sync needed"
    case "blocked":
      return "sync blocked"
    case "projected":
      return "projected, not yet verified"
  }
}

const describeStatus = (
  repository: RepositoryOverview,
  configuration: ConfigurationView | undefined,
): string => {
  if (repository.access !== "accessible") return "Access needs attention"
  if (!repository.enabled) return "Paused"
  const sync =
    configuration === undefined
      ? "loading configuration"
      : configuration.labelFreshness === "verified"
        ? "synchronized"
        : describeFreshness(configuration.labelFreshness)
  return `Automation active · ${sync}`
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`

const statTile = (
  h: HtmlBuilder<Message>,
  config: { readonly label: string; readonly value: string; readonly note: string },
): Html =>
  panel(h, {
    className: "flex flex-col gap-1",
    attributes: [h.DataAttribute("stat", config.label.toLowerCase())],
    children: [
      h.span([h.Class("text-caption font-medium text-ink-subtle")], [config.label]),
      h.span(
        [h.Class("font-mono text-h1 font-semibold tabular-nums text-foreground")],
        [config.value],
      ),
      h.span([h.Class("text-body-sm text-ink-muted")], [config.note]),
    ],
  })

const OVERVIEW_ROWS = 6

const viewAllLink = (h: HtmlBuilder<Message>, href: string, label: string): Html =>
  h.a(
    [h.Href(href), h.Class("text-body-md text-primary hover:underline")],
    ["View all", h.span([h.Class("sr-only")], [` ${label}`])],
  )

const moreRow = (h: HtmlBuilder<Message>, remaining: number, href: string): Html =>
  remaining <= 0
    ? h.empty
    : h.a(
        [
          h.Href(href),
          h.Class("block px-4 py-2 font-mono text-mono-sm text-ink-subtle hover:text-foreground"),
        ],
        [`+${remaining} more`],
      )

const overviewRules = (h: HtmlBuilder<Message>, view: ConfigurationView): Html => {
  const href = Routes.rules({ repositoryId: view.repositoryId })
  const shown = view.rules.slice(0, OVERVIEW_ROWS)
  return panel(h, {
    flush: true,
    attributes: [h.AriaLabel("Rules summary")],
    children: [
      panelHeader(h, {
        title: "Rules",
        meta: String(view.rules.length),
        actions: [viewAllLink(h, href, "rules")],
      }),
      view.rules.length === 0
        ? h.p([h.Class("px-4 py-3 text-body-sm text-ink-muted")], ["No rules yet."])
        : h.ul(
            [h.Class("flex flex-col divide-y divide-border-subtle")],
            shown.map((rule) => {
              const name = labelName(view.labels, rule.labelId)
              const label = view.labels.find((label) => label.labelId === rule.labelId)
              return h.li(
                [h.Class("flex h-10 items-center gap-3 px-4"), h.DataAttribute("rule-id", rule.id)],
                [
                  h.span(
                    [
                      h.Class(
                        cn(
                          "size-2 shrink-0 rounded-full",
                          rule.enabled ? "bg-success" : "bg-ink-faint",
                        ),
                      ),
                      h.Role("img"),
                      h.AriaLabel(rule.enabled ? "Enabled" : "Disabled"),
                    ],
                    [],
                  ),
                  labelBadge(
                    h,
                    name,
                    label?.color,
                    rule.labelStatus === "missing" ? "line-through text-ink-subtle" : undefined,
                  ),
                  ruleType(view, rule) === "AI"
                    ? chip(h, { variant: "agent", children: ["AI"] })
                    : chip(h, { children: ["policy"] }),
                  h.span(
                    [h.Class("min-w-0 truncate font-mono text-mono-sm text-ink-muted")],
                    [policyName(view.policies, rule.policyId)],
                  ),
                  linkButton(h, {
                    href: Routes.rule({ repositoryId: rule.repositoryId, ruleId: rule.id }),
                    variant: "ghost",
                    size: "icon",
                    label: [Icon.view(h, Pencil, "size-4 text-ink-subtle")],
                    attributes: [
                      h.Class("ml-auto"),
                      h.AriaLabel(`Edit ${name}`),
                      h.Title("Edit rule"),
                    ],
                  }),
                ],
              )
            }),
          ),
      moreRow(h, view.rules.length - shown.length, href),
    ],
  })
}

const overviewPolicies = (h: HtmlBuilder<Message>, view: ConfigurationView): Html => {
  const href = Routes.policies({ repositoryId: view.repositoryId })
  const shown = view.policies.slice(0, OVERVIEW_ROWS)
  return panel(h, {
    flush: true,
    attributes: [h.AriaLabel("Policies summary")],
    children: [
      panelHeader(h, {
        title: "Policies",
        meta: String(view.policies.length),
        actions: [viewAllLink(h, href, "policies")],
      }),
      view.policies.length === 0
        ? h.p([h.Class("px-4 py-3 text-body-sm text-ink-muted")], ["No policies yet."])
        : h.ul(
            [h.Class("flex flex-col divide-y divide-border-subtle")],
            shown.map((policy) =>
              h.li(
                [
                  h.Class("flex h-10 items-center gap-3 px-4"),
                  h.DataAttribute("policy-id", policy.policyId),
                ],
                [
                  h.a(
                    [
                      h.Href(
                        Routes.policy({
                          repositoryId: view.repositoryId,
                          policyId: policy.policyId,
                        }),
                      ),
                      h.Class("min-w-0 truncate text-body-md font-medium hover:underline"),
                    ],
                    [policy.name],
                  ),
                  h.span(
                    [h.Class("shrink-0 font-mono text-mono-sm text-ink-muted")],
                    [describeTarget(policy.target)],
                  ),
                  h.span(
                    [h.Class("ml-auto shrink-0")],
                    [
                      PolicyStatus.view(h, {
                        published: policy.publishedRevision !== null,
                        revision: policy.publishedRevision,
                        changes: policy.draftDiffers ?? false,
                      }),
                    ],
                  ),
                ],
              ),
            ),
          ),
      moreRow(h, view.policies.length - shown.length, href),
    ],
  })
}

/** Overview: the repository's status, four counts, and the first rows of
 *  its rules and policies. Needs the repository list and its configuration. */
const overview = (h: HtmlBuilder<Message>, model: Model): Html => {
  const repository = Option.getOrElse(model.repositories, () => []).find((repo) =>
    Option.contains(model.dataRepositoryId, repo.repositoryId),
  )
  if (!repository)
    return h.p(
      [
        h.Class("p-4 text-body-sm text-ink-muted"),
        h.Role(Option.isSome(model.repositoriesError) ? "alert" : "status"),
      ],
      [
        Option.getOrElse(model.repositoriesError, () =>
          Option.isNone(model.dataRepositoryId)
            ? "Select a repository to get started."
            : Option.isNone(model.repositories)
              ? "Loading repository…"
              : "This repository is unavailable or you no longer have access.",
        ),
      ],
    )
  const configuration = Option.getOrUndefined(
    Option.map(model.detail, (detail) => detail.configuration),
  )
  const body: ReadonlyArray<Html> =
    configuration === undefined
      ? [
          h.p(
            [
              h.Class("text-body-md text-ink-muted"),
              h.Role(Option.isSome(model.detailError) ? "alert" : "status"),
            ],
            [
              Option.match(model.detailError, {
                onNone: () => "Loading configuration…",
                onSome: (reason) => `The configuration could not be loaded. ${reason}`,
              }),
            ],
          ),
        ]
      : [
          h.div(
            [h.Class("grid grid-cols-4 gap-4 max-[900px]:grid-cols-2")],
            [
              statTile(h, {
                label: "Rules",
                value: String(configuration.rules.length),
                note: `${configuration.rules.filter((rule) => rule.enabled).length} enabled · ${configuration.rules.filter((rule) => ruleType(configuration, rule) === "AI").length} AI`,
              }),
              statTile(h, {
                label: "Policies",
                value: String(configuration.policies.length),
                note: `${configuration.policies.filter((policy) => policy.publishedRevision !== null).length} published · ${plural(configuration.policies.filter((policy) => policy.publishedRevision === null || policy.draftDiffers === true).length, "draft")}`,
              }),
              statTile(h, {
                label: "Configuration",
                value: `rev ${configuration.configuredRevision}`,
                note:
                  configuration.activeRevision === configuration.configuredRevision
                    ? `active rev ${configuration.activeRevision}`
                    : configuration.activeRevision === null
                      ? "publish pending"
                      : `active rev ${configuration.activeRevision} · publish pending`,
              }),
              statTile(h, {
                label: "Labels",
                value: String(configuration.labels.length),
                note: describeFreshness(configuration.labelFreshness),
              }),
            ],
          ),
          h.div(
            [h.Class("grid grid-cols-2 items-start gap-4 max-[1240px]:grid-cols-1")],
            [overviewRules(h, configuration), overviewPolicies(h, configuration)],
          ),
        ]
  return Page.layout(h, {
    attributes: [h.AriaLabel("Repository overview")],
    main: [
      Page.header(h, {
        title: h.h1([h.Class("font-mono")], [repository.owner + " / " + repository.repo]),
        lede: describeStatus(repository, configuration),
      }),
      ...body,
    ],
  })
}

const detailPanel = (h: HtmlBuilder<Message>, model: Model, section: Section): Html =>
  Option.match(model.detail, {
    onNone: () =>
      h.div(
        [h.Class("p-4 text-body-sm text-ink-muted")],
        [
          Option.getOrElse(model.detailError, () =>
            Option.getOrElse(model.repositoriesError, () =>
              Option.isNone(model.dataRepositoryId)
                ? "Select a repository to get started."
                : "Loading repository…",
            ),
          ),
        ],
      ),
    onSome: (detail) => {
      if (section === "Policies") {
        return h.div(
          [h.Class("policy-workspace")],
          [
            policiesSection(h, model, detail.configuration),
            h.div(
              [h.Class("policy-workspace-main")],
              [
                Option.match(model.detailError, {
                  onNone: () => h.empty,
                  onSome: (reason) =>
                    h.p(
                      [h.Class("p-3 text-body-sm text-destructive"), h.Role("alert")],
                      [`Refresh failed: ${reason}`],
                    ),
                }),
                model.panel._tag === "PolicyEditor" ||
                model.panel._tag === "LoadingPolicy" ||
                model.panel._tag === "Unavailable"
                  ? panelView(h, model)
                  : h.div(
                      [h.Class("policy-empty")],
                      [
                        h.p(
                          [h.Class("text-body-md")],
                          [
                            detail.configuration.policies.length === 0
                              ? "No policies yet. Define when an issue or pull request matches, then test it against your repository."
                              : "Select a policy to edit its conditions and test your changes.",
                          ],
                        ),
                        detail.configuration.policies.length === 0
                          ? Button.view(h, {
                              size: "sm",
                              label: "New policy",
                              onClick: Message.ClickedNewPolicy(),
                            })
                          : h.empty,
                      ],
                    ),
              ],
            ),
          ],
        )
      }
      if (section === "Rules")
        return h.div(
          [h.Class("rules-workspace")],
          [
            model.panel._tag === "RuleEditor" || model.panel._tag === "Unavailable"
              ? panelView(h, model)
              : rulesSection(h, model, detail.configuration),
          ],
        )
      // The shell wraps Settings in its own page layout, so these are the cards alone.
      return section === "Settings"
        ? h.div(
            [h.Class("flex flex-col gap-4")],
            [reviewSection(h, model), consentSection(h, model)],
          )
        : h.empty
    },
  })

export const view = Submodel.defineView<Model, Message, { section: Section }>(
  (model, { section }, h) =>
    h.div(
      [h.Class(`repository-workspace ${section === "Activity" ? "repository-activity" : ""}`)],
      [
        section === "Overview"
          ? overview(h, model)
          : section === "Activity"
            ? h.submodel({
                slotId: "activity",
                model: model.activity,
                view: Activity.view,
                viewInputs: {
                  configuration: Option.getOrUndefined(
                    Option.map(model.detail, (detail) => detail.configuration),
                  ),
                  repository: Option.getOrElse(model.repositories, () => []).find(
                    (repository) => repository.repositoryId === model.activity.repositoryId,
                  ),
                },
                toParentMessage: (message) => Message.GotActivityMessage({ message }),
              })
            : section === "Reviews"
              ? h.submodel({
                  slotId: "reviews",
                  model: model.reviews,
                  view: Reviews.view,
                  viewInputs: {},
                  toParentMessage: (message) => Message.GotReviewsMessage({ message }),
                })
              : detailPanel(h, model, section),
      ],
    ),
)

/** Refresh server data after sync without replacing an open editor or its draft. */
export const refreshAfterSync = (model: Model): UpdateReturn => {
  const list = refreshRepositories(model)
  const detail = refresh(list.model)
  return {
    model: detail.model,
    commands: [...(list.commands ?? []), ...(detail.commands ?? []), FetchCatalog()],
  }
}

/** Apply a confirmed connection result without clearing unrelated repositories. */
export const informConnectionChanged = (
  model: Model,
  repositoryId: string,
  action: string,
): UpdateReturn => {
  const next = evo(model, {
    repositories: Option.map((rows) =>
      action === "disconnect"
        ? rows.filter((row) => row.repositoryId !== repositoryId)
        : rows.map((row) =>
            row.repositoryId === repositoryId
              ? {
                  ...row,
                  enabled: action === "resume" ? true : action === "pause" ? false : row.enabled,
                }
              : row,
          ),
    ),
  })
  return refreshAfterSync(next)
}

/** Materialize a route after navigation, or after its repository finishes loading. */
export const openRoute = (
  model: Model,
  route: Routes.AppRoute,
  changedDocument: boolean,
): UpdateReturn => {
  if (!("repositoryId" in route))
    return {
      model: {
        ...closed(model),
        activity: { ...model.activity, active: false },
        reviews: { ...model.reviews, active: false },
      },
    }
  const selected = update(model, Message.Selected({ repositoryId: route.repositoryId }))
  let next = evo(changedDocument ? closed(selected.model) : selected.model, {
    policySearch: () => ("q" in route ? (route.q ?? "") : ""),
  })
  const activity = update(
    next,
    Message.GotActivityMessage({
      message: Activity.Message.Activated({
        repositoryId: route.repositoryId,
        active: route._tag === "Activity",
      }),
    }),
  )
  const reviews = update(
    activity.model,
    Message.GotReviewsMessage({
      message: Reviews.Message.Activated({
        repositoryId: route.repositoryId,
        active: route._tag === "Reviews",
      }),
    }),
  )
  next = reviews.model
  const routeCommands = [
    ...(selected.commands ?? []),
    ...(activity.commands ?? []),
    ...(reviews.commands ?? []),
  ]
  if (Option.isNone(next.detail)) return { model: next, commands: routeCommands }
  let result: UpdateReturn = { model: next }
  if (next.panel._tag === "Closed") {
    switch (route._tag) {
      case "NewPolicy":
        result = update(next, Message.ClickedNewPolicy())
        break
      case "Policy":
        result = update(next, Message.ClickedEditPolicy({ policyId: route.policyId }))
        break
      case "NewRule":
        result = update(next, Message.ClickedNewRule())
        break
      case "Rule":
        result = Option.exists(next.detail, (detail) =>
          detail.configuration.rules.some((rule) => rule.id === route.ruleId),
        )
          ? update(next, Message.ClickedEditRule({ ruleId: route.ruleId }))
          : {
              model: evo(next, {
                panel: () => ({
                  _tag: "Unavailable" as const,
                  message: "This rule was not found in this repository.",
                }),
              }),
            }
        break
    }
  }
  next = result.model
  if (next.panel._tag === "PolicyEditor") {
    const number =
      "item" in route &&
      route.item !== undefined &&
      /^[1-9]\d*$/.test(route.item) &&
      Number.isSafeInteger(Number(route.item))
        ? Number(route.item)
        : null
    if (next.panel.editor.testNumber !== number) {
      const editor = evo(next.panel.editor, {
        testNumber: () => number,
        maybeTestBench: () => Option.none(),
        testGeneration: (generation) => generation + 1,
      })
      next = evo(next, { panel: () => ({ _tag: "PolicyEditor" as const, editor }) })
    }
  }
  return { model: next, commands: [...routeCommands, ...(result.commands ?? [])] }
}

/** Save-button visibility includes unpublished drafts; navigation warns only about unsaved input. */
export const hasUnsavedChanges = (model: Model): boolean => {
  const panel = model.panel
  if (panel._tag === "PolicyEditor") {
    const editor = panel.editor
    return (
      editor.submission._tag === "Submitting" ||
      editor.name !== editor.savedFields.name ||
      editor.description !== editor.savedFields.description ||
      editor.source.source !== editor.savedFields.sourceText ||
      (editor.metadataEdits.name !== null && editor.metadataEdits.name !== editor.name) ||
      (editor.metadataEdits.description !== null &&
        editor.metadataEdits.description !== editor.description)
    )
  }
  if (panel._tag === "RuleEditor") return RuleEditor.hasUnsavedChanges(panel.editor)
  return false
}

export const isSaving = (model: Model): boolean =>
  (model.panel._tag === "PolicyEditor" || model.panel._tag === "RuleEditor") &&
  model.panel.editor.submission._tag === "Submitting"
