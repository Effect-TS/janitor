import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage"
import * as FoldkitCommand from "foldkit/command"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import * as Submodel from "foldkit/submodel"
import * as Subscription from "foldkit/subscription"
import * as Update from "foldkit/update"
import * as Button from "@/components/ui/button"
import * as Icon from "@/lib/icons"
import { Plus, Search, FileCode2, MousePointer2 } from "lucide"
import { input } from "@/components/ui/input"
import * as PolicyEditor from "@/components/policy-editor"
import * as RuleEditor from "@/components/rule-editor"
import * as TestBench from "@/components/test-bench"
import {
  AiConsent,
  TestCandidates,
  TestEntity,
  testEndpoint,
  aiConsentEndpoint,
  CATALOG_ENDPOINT,
  ConfigurationView,
  configurationEndpoint,
  describePlan,
  describeRevision,
  FactDescription,
  labelName,
  PolicyDetail,
  policyEndpoint,
  policyName,
  ReconciliationRecord,
  reconciliationsEndpoint,
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

// CONSTANTS

/** How often the selected repository is refreshed while the page is open. */
export const POLL_INTERVAL = Duration.seconds(10)

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
  Schema.TaggedStruct("TestBench", { bench: TestBench.Model }),
])
export type Panel = typeof Panel.Type

export const Section = Schema.Literals(["Policies", "Rules", "Activity", "Settings"])
export type Section = typeof Section.Type

const Mutation = Schema.Struct({
  operationId: Schema.Int,
  repositoryId: Schema.String,
  subjectId: Schema.String,
  kind: Schema.Literals(["RuleToggle", "SyncToggle", "PolicyDelete", "RuleDelete", "Consent"]),
  previousEnabled: Schema.Boolean,
  enabled: Schema.Boolean,
})
type Mutation = typeof Mutation.Type
const ResponseContext = { repositoryId: Schema.String, operationId: Schema.Int }

export const Model = Schema.Struct({
  nextOperationId: Schema.Int,
  pendingMutations: Schema.Array(Mutation),
  nextRequestId: Schema.Int,
  maybeDetailRequest: Schema.Option(Schema.Int),
  maybeConsentRequest: Schema.Option(Schema.Int),
  maybeRepositoriesRequest: Schema.Option(Schema.Int),
  consentError: Schema.Option(Schema.String),
  section: Section,
  policySearch: Schema.String,
  repositories: Schema.Option(Schema.Array(RepositoryOverview)),
  repositoriesError: Schema.Option(Schema.String),
  catalog: Schema.Array(FactDescription),
  selected: Schema.Option(Schema.String),
  detail: Schema.Option(RepositoryDetail),
  detailError: Schema.Option(Schema.String),
  maybeConsent: Schema.Option(AiConsent),

  panel: Panel,
  /** A row whose delete button was pressed once; the second press deletes. */
  maybeConfirmingDelete: Schema.Option(
    Schema.Union([
      Schema.TaggedStruct("Policy", { policyId: Schema.String }),
      Schema.TaggedStruct("Rule", { ruleId: Schema.String }),
    ]),
  ),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SelectedSection: { section: Section },
  UpdatedPolicySearch: { value: Schema.String },
  GotRepositories: { repositories: Schema.Array(RepositoryOverview), requestId: Schema.Int },
  FailedRepositories: { reason: Schema.String, requestId: Schema.Int },
  GotCatalog: { catalog: Schema.Array(FactDescription) },
  Selected: { repositoryId: Schema.String },
  Polled: {},
  GotDetail: { repositoryId: Schema.String, detail: RepositoryDetail, requestId: Schema.Int },
  FailedDetail: { repositoryId: Schema.String, reason: Schema.String, requestId: Schema.Int },
  GotConsent: { repositoryId: Schema.String, consent: AiConsent, requestId: Schema.Int },
  FailedConsent: { repositoryId: Schema.String, reason: Schema.String, requestId: Schema.Int },
  ClickedRetryConsent: {},
  ClickedToggleConsent: {},
  ClickedToggleSync: { repositoryId: Schema.String, enabled: Schema.Boolean },
  CompletedToggleSync: ResponseContext,
  FailedToggleSync: { ...ResponseContext, reason: Schema.String },
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
  ClickedTestPolicy: { policyId: Schema.String },
  ClickedTestConfiguration: {},
  ClickedDeletePolicy: { policyId: Schema.String, version: Schema.Int },
  ClickedNewRule: {},
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
  GotTestBenchMessage: { message: TestBench.Message },
})
export type Message = typeof Message.Type

/** What the shell needs to know to show toasts. */
export const OutMessage = defineMessageUnion({
  Notified: { title: Schema.String, description: Schema.String },
  Failed: { title: Schema.String, reason: Schema.String },
  SyncWorkChanged: {},
})
export type OutMessage = typeof OutMessage.Type

// COMMANDS

const describe = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error)

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
        reconciliations: getJson(
          reconciliationsEndpoint(repositoryId),
          Schema.Array(ReconciliationRecord),
        ),
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

export const SetRepositorySync = FoldkitCommand.define("SetRepositorySync", {
  args: { ...ResponseContext, enabled: Schema.Boolean },
  messages: [Message.CompletedToggleSync, Message.FailedToggleSync],
  execute: ({ repositoryId, enabled, operationId }) =>
    HttpClientRequest.put(`/api/v1/repositories/${encodeURIComponent(repositoryId)}/sync`).pipe(
      HttpClientRequest.bodyJson({ enabled }),
      Effect.flatMap(HttpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.as(Message.CompletedToggleSync({ repositoryId, operationId })),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedToggleSync({ repositoryId, operationId, reason: describe(error) }),
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

const MessageBody = Schema.Struct({ message: Schema.String })

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
      nextOperationId: 1,
      pendingMutations: [],
      nextRequestId: 1,
      maybeDetailRequest: Option.none(),
      maybeConsentRequest: Option.none(),
      maybeRepositoriesRequest: Option.some(0),
      consentError: Option.none(),
      section: "Policies",
      policySearch: "",
      repositories: Option.none(),
      repositoriesError: Option.none(),
      catalog: [],
      selected: Option.none(),
      detail: Option.none(),
      detailError: Option.none(),
      maybeConsent: Option.none(),
      panel: { _tag: "Closed" },
      maybeConfirmingDelete: Option.none(),
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
    maybeConfirmingDelete: () => Option.none(),
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
  if (Option.isNone(model.selected)) return { model }
  const repositoryId = model.selected.value
  const detail = force || Option.isNone(model.maybeDetailRequest)
  const consent = force || Option.isNone(model.maybeConsentRequest)
  const requestId = model.nextRequestId
  return {
    model: evo(model, {
      nextRequestId: () => requestId + 2,
      maybeDetailRequest: (current) => (detail ? Option.some(requestId) : current),
      maybeConsentRequest: (current) => (consent ? Option.some(requestId + 1) : current),
    }),
    commands: [
      ...(detail ? [FetchDetail({ repositoryId, requestId })] : []),
      ...(consent ? [FetchConsent({ repositoryId, requestId: requestId + 1 })] : []),
    ],
  }
}

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
  if (!Option.contains(model.selected, repositoryId)) return model
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
              editor: RuleEditor.reflectConfiguration(panel.editor, detail.value.configuration),
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
  Option.flatMap(model.selected, (repositoryId) =>
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
            labels: detail.configuration.labels,
            policies: detail.configuration.policies,
            existing: rule,
          }),
        }),
      })
    },
  })

const openTestBench = (
  model: Model,
  subject: TestBench.Model["subject"],
  title: string,
): UpdateReturn =>
  Option.match(loaded(model), {
    onNone: () => ({ model }),
    onSome: ({ repositoryId, detail }) => {
      const bench = TestBench.init({
        repositoryId,
        subject,
        title,
        configuration: detail.configuration,
      })
      return {
        model: evo(model, { panel: () => ({ _tag: "TestBench" as const, bench: bench.model }) }),
        commands: FoldkitCommand.mapMessages(bench.commands, (message) =>
          Message.GotTestBenchMessage({ message }),
        ),
      }
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
      Cancelled: () => undefined,
      RequestedDelete: () => undefined,
      SaveFailed: ({ reason }) => OutMessage.Failed({ title: "The policy was not saved", reason }),
      PersistedDraft: () => undefined,
    }),
  foldOutMessage: (outMessage) => (model) =>
    PolicyEditor.OutMessage.match<Step>(outMessage, {
      Saved: ({ detail }) => refresh(acceptPolicy(model, detail)),
      PersistedDraft: ({ detail }) => refresh(acceptPolicy(model, detail)),
      Cancelled: () => ({ model: closed(model) }),
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
      Saved: () =>
        OutMessage.Notified({
          title: "Rule saved",
          description: "It takes effect once the revision activates.",
        }),
      Cancelled: () => undefined,
      SaveFailed: ({ reason }) => OutMessage.Failed({ title: "The rule was not saved", reason }),
    }),
  foldOutMessage: (outMessage) => (model) =>
    RuleEditor.OutMessage.match<Step>(outMessage, {
      Saved: ({ rule, closeEditor }) =>
        refresh(acceptRule(closeEditor ? closed(model) : model, rule)),
      Cancelled: () => ({ model: closed(model) }),
      SaveFailed: () => ({ model }),
    }),
})

const foldTestBench = Update.foldChild({
  update: TestBench.update,
  read: (model: Model) =>
    model.panel._tag === "TestBench" ? Option.some(model.panel.bench) : Option.none(),
  write: (model, nextBench) =>
    evo(model, { panel: () => ({ _tag: "TestBench" as const, bench: nextBench }) }),
  toParentMessage: (message) => Message.GotTestBenchMessage({ message }),
  foldOutMessage: (outMessage) => (model) =>
    TestBench.OutMessage.match<Step>(outMessage, { Closed: () => ({ model: closed(model) }) }),
})

const confirmingPolicy = (model: Model, policyId: string) =>
  Option.exists(
    model.maybeConfirmingDelete,
    (entry) => entry._tag === "Policy" && entry.policyId === policyId,
  )

const confirmingRule = (model: Model, ruleId: string) =>
  Option.exists(
    model.maybeConfirmingDelete,
    (entry) => entry._tag === "Rule" && entry.ruleId === ruleId,
  )

export const isViewingSubject = (
  model: Model,
  repositoryId: string,
  what: "policy" | "rule",
  subjectId: string,
): boolean => {
  if (!Option.contains(model.selected, repositoryId)) return false
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
  if (Option.isNone(model.selected)) return { model }
  const repositoryId = model.selected.value
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
  if (!(what === "policy" ? confirmingPolicy(model, subjectId) : confirmingRule(model, subjectId)))
    return {
      model: evo(model, {
        maybeConfirmingDelete: () =>
          Option.some(
            what === "policy"
              ? { _tag: "Policy" as const, policyId: subjectId }
              : { _tag: "Rule" as const, ruleId: subjectId },
          ),
      }),
    }
  return {
    model: evo(
      startMutation(model, {
        repositoryId,
        subjectId,
        kind: what === "policy" ? "PolicyDelete" : "RuleDelete",
        previousEnabled: false,
        enabled: false,
      }),
      { maybeConfirmingDelete: () => Option.none() },
    ),
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
    SelectedSection: ({ section }) => ({ model: evo(model, { section: () => section }) }),
    UpdatedPolicySearch: ({ value }) => ({ model: evo(model, { policySearch: () => value }) }),
    GotRepositories: ({ repositories, requestId }) => {
      if (!Option.contains(model.maybeRepositoriesRequest, requestId)) return { model }
      const next = evo(model, {
        repositories: () =>
          Option.some(
            repositories.map((row) => {
              const pending = model.pendingMutations.find(
                (mutation) =>
                  mutation.kind === "SyncToggle" && mutation.repositoryId === row.repositoryId,
              )
              const counted =
                Option.contains(model.selected, row.repositoryId) && Option.isSome(model.detail)
                  ? {
                      ...row,
                      policyCount: model.detail.value.configuration.policies.length,
                      ruleCount: model.detail.value.configuration.rules.length,
                    }
                  : row
              return pending ? { ...counted, syncEnabled: pending.enabled } : counted
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
            : panel,
      }),
    }),

    Selected: ({ repositoryId }) =>
      Option.contains(model.selected, repositoryId)
        ? { model }
        : refresh(
            evo(closed(model), {
              selected: () => Option.some(repositoryId),
              policySearch: () => "",
              detail: () => Option.none(),
              detailError: () => Option.none(),
              maybeConsent: () => Option.none(),
              consentError: () => Option.none(),
            }),
          ),
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
      return Option.contains(model.selected, repositoryId) &&
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
                        editor: RuleEditor.reflectConfiguration(panel.editor, detail.configuration),
                      }
                    : panel,
            }),
          }
        : { model }
    },
    FailedDetail: ({ repositoryId, reason, requestId }) =>
      Option.contains(model.selected, repositoryId) &&
      Option.contains(model.maybeDetailRequest, requestId)
        ? {
            model: evo(model, {
              detailError: () => Option.some(reason),
              maybeDetailRequest: () => Option.none(),
            }),
          }
        : { model },
    GotConsent: ({ repositoryId, consent, requestId }) =>
      Option.contains(model.selected, repositoryId) &&
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
      Option.contains(model.selected, repositoryId) &&
      Option.contains(model.maybeConsentRequest, requestId)
        ? {
            model: evo(model, {
              consentError: () => Option.some(reason),
              maybeConsentRequest: () => Option.none(),
            }),
          }
        : { model },
    ClickedRetryConsent: () => refresh(model, false),
    ClickedToggleSync: ({ repositoryId, enabled }) => {
      const row = Option.getOrElse(model.repositories, () => []).find(
        (row) => row.repositoryId === repositoryId,
      )
      if (!row || hasMutation(model, repositoryId, repositoryId, ["SyncToggle"])) return { model }
      return {
        model: evo(
          startMutation(model, {
            repositoryId,
            subjectId: repositoryId,
            kind: "SyncToggle",
            previousEnabled: row.syncEnabled !== false,
            enabled,
          }),
          {
            repositories: Option.map((rows) =>
              rows.map((row) =>
                row.repositoryId === repositoryId ? { ...row, syncEnabled: enabled } : row,
              ),
            ),
          },
        ),
        commands: [
          SetRepositorySync({ repositoryId, enabled, operationId: model.nextOperationId }),
        ],
      }
    },
    CompletedToggleSync: ({ repositoryId, operationId }) => {
      if (
        !model.pendingMutations.some(
          (mutation) =>
            mutation.operationId === operationId &&
            mutation.repositoryId === repositoryId &&
            mutation.kind === "SyncToggle",
        )
      )
        return { model }
      return {
        ...refreshRepositories(finishMutation(model, operationId)),
        outMessage: OutMessage.SyncWorkChanged(),
      }
    },
    FailedToggleSync: ({ repositoryId, operationId, reason }) => {
      const pending = model.pendingMutations.find(
        (mutation) =>
          mutation.operationId === operationId &&
          mutation.repositoryId === repositoryId &&
          mutation.kind === "SyncToggle",
      )
      if (!pending) return { model }
      const restored = evo(finishMutation(model, operationId), {
        repositories: Option.map((rows) =>
          rows.map((row) =>
            row.repositoryId === repositoryId
              ? { ...row, syncEnabled: pending.previousEnabled }
              : row,
          ),
        ),
      })
      return {
        ...refreshRepositories(restored),
        outMessage: OutMessage.Failed({ title: "Sync setting could not be confirmed", reason }),
      }
    },
    ClickedToggleConsent: () => {
      if (Option.isNone(model.selected) || Option.isNone(model.maybeConsent)) return { model }
      const repositoryId = model.selected.value
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
          Option.contains(model.selected, repositoryId) ? Option.some(consent) : current,
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
        : Option.match(model.selected, {
            onNone: () => ({ model }),
            onSome: (repositoryId) => ({
              model: evo(model, { panel: () => ({ _tag: "LoadingPolicy" as const, policyId }) }),
              commands: [FetchPolicyDetail({ repositoryId, policyId })],
            }),
          }),
    GotPolicyDetail: ({ detail }) =>
      model.panel._tag === "LoadingPolicy" &&
      model.panel.policyId === detail.policy.policyId &&
      Option.contains(model.selected, detail.policy.repositoryId)
        ? { model: openPolicyEditor(model, Option.some(detail)) }
        : { model },
    FailedPolicyDetail: ({ reason, repositoryId, policyId }) =>
      model.panel._tag === "LoadingPolicy" &&
      (repositoryId === undefined || Option.contains(model.selected, repositoryId)) &&
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
    ClickedTestPolicy: ({ policyId }) =>
      openTestBench(
        model,
        { _tag: "Policy", policyId },
        Option.match(model.detail, {
          onNone: () => policyId,
          onSome: (detail) => `Policy ${policyName(detail.configuration.policies, policyId)}`,
        }),
      ),
    ClickedTestConfiguration: () =>
      openTestBench(model, { _tag: "Configuration" }, "Every rule of the configured revision"),
    ClickedDeletePolicy: ({ policyId, version }) =>
      deleteSubject(model, "policy", policyId, version),
    ClickedNewRule: () => ({ model: openRuleEditor(model, Option.none()) }),
    ClickedEditRule: ({ ruleId }) =>
      Option.isSome(model.selected) &&
      hasMutation(model, model.selected.value, ruleId, ["RuleToggle", "RuleDelete"])
        ? { model }
        : { model: openRuleEditor(model, Option.some({ _tag: "Existing", ruleId, version: 0 })) },
    ClickedToggleRule: ({ ruleId }) => {
      if (Option.isNone(model.selected) || Option.isNone(model.detail)) return { model }
      const repositoryId = model.selected.value
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

    GotPolicyEditorMessage: ({ message }) =>
      model.panel._tag === "PolicyEditor" &&
      model.panel.editor.identity._tag === "Existing" &&
      hasMutation(model, model.panel.editor.repositoryId, model.panel.editor.identity.policyId, [
        "PolicyDelete",
      ])
        ? { model }
        : foldPolicyEditor(model, message),
    GotRuleEditorMessage: ({ message }) => foldRuleEditor(model, message),
    GotTestBenchMessage: ({ message }) => foldTestBench(model, message),
  })

// SUBSCRIPTIONS

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  repositoryPoll: entry(
    { hasSelection: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ hasSelection: Option.isSome(model.selected) }),
      dependenciesToStream: ({ hasSelection }) =>
        hasSelection
          ? Stream.map(Stream.tick(POLL_INTERVAL), () => Message.Polled())
          : Stream.empty,
    },
  ),
}))

// VIEW

const badgeClass = "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium"
const cellClass = "py-1.5 pr-3 align-top"
const headClass = "py-1 pr-3 text-left text-xs font-medium"
const emptyClass = "text-muted-foreground rounded-md border border-dashed p-4 text-sm"

const sectionTitle = <M>(h: HtmlBuilder<M>, text: string): Html =>
  h.h2([h.Class("text-sm font-semibold tracking-tight")], [text])

const rowButton = (
  h: HtmlBuilder<Message>,
  label: string,
  onClick: Message,
  options: {
    readonly isDestructive?: boolean
    readonly action?: string
    readonly isDisabled?: boolean
  } = {},
): Html =>
  Button.view(h, {
    isDisabled: options.isDisabled ?? false,
    variant: options.isDestructive ? "destructive" : "ghost",
    size: "xs",
    onClick,
    label,
    attributes: options.action === undefined ? [] : [h.DataAttribute("action", options.action)],
  })

const table = (
  h: HtmlBuilder<Message>,
  heads: ReadonlyArray<string>,
  rows: ReadonlyArray<Html>,
): Html =>
  h.table(
    [h.Class("w-full text-sm")],
    [
      h.thead(
        [h.Class("text-muted-foreground")],
        [
          h.tr(
            [],
            heads.map((head) => h.th([h.Class(headClass)], [head])),
          ),
        ],
      ),
      h.tbody([], rows),
    ],
  )

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
                [h.Class("text-xs font-semibold")],
                [
                  "All policies",
                  h.span(
                    [h.Class("ml-2 font-normal text-muted-foreground")],
                    [String(view.policies.length + (creating ? 1 : 0))],
                  ),
                ],
              ),
              Button.view(h, {
                variant: "ghost",
                size: "icon-sm",
                label: Icon.view(h, Plus, "size-4"),
                onClick: Message.ClickedNewPolicy(),
                attributes: [
                  h.AriaLabel("New policy"),
                  h.Title("New policy"),
                  h.DataAttribute("action", "new-policy"),
                ],
              }),
            ],
          ),
          h.div(
            [h.Class("policy-search-field")],
            [
              Icon.view(h, Search, "size-3.5"),
              input(h, {
                id: "policy-search",
                label: "Search policies",
                labelClass: "sr-only",
                placeholder: "Find a policy…",
                value: model.policySearch,
                onInput: (value) => Message.UpdatedPolicySearch({ value }),
              }),
            ],
          ),
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
        ? h.p([h.Class("p-4 text-xs text-muted-foreground")], ["No policies match your search."])
        : h.empty,
    ],
  )
}

const ruleRow = (
  h: HtmlBuilder<Message>,
  model: Model,
  view: ConfigurationView,
  rule: ConfigurationView["rules"][number],
): Html => {
  const pending = model.pendingMutations.find(
    (mutation) =>
      mutation.repositoryId === rule.repositoryId &&
      mutation.subjectId === rule.id &&
      (mutation.kind === "RuleToggle" || mutation.kind === "RuleDelete"),
  )
  const confirming = confirmingRule(model, rule.id)
  return h.tr(
    [h.Class(cn("border-t", !rule.enabled && "opacity-60")), h.DataAttribute("rule-id", rule.id)],
    [
      h.td(
        [h.Class(cellClass)],
        [
          h.span(
            [h.Class(cn(badgeClass, rule.labelStatus === "missing" && "line-through"))],
            [labelName(view.labels, rule.labelId)],
          ),
        ],
      ),
      h.td([h.Class(cellClass)], [policyName(view.policies, rule.policyId)]),
      h.td(
        [h.Class(cn(cellClass, "text-muted-foreground"))],
        [rule.onNoMatch === "ensure-absent" ? "remove label" : "leave alone"],
      ),
      h.td(
        [h.Class(cn(cellClass, "text-muted-foreground"))],
        [rule.group === null ? "" : `${rule.group} · ${rule.priority}`],
      ),
      h.td(
        [h.Class(cellClass)],
        [
          h.button(
            [
              h.Type("button"),
              h.Role("switch"),
              h.AriaChecked(rule.enabled),
              h.Disabled(pending !== undefined),
              h.AriaBusy(pending !== undefined),
              h.OnClick(Message.ClickedToggleRule({ ruleId: rule.id })),
              h.Class(
                cn(
                  "cursor-pointer text-xs",
                  rule.enabled ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
                ),
              ),
            ],
            [
              pending?.kind === "RuleToggle"
                ? rule.enabled
                  ? "Enabling…"
                  : "Disabling…"
                : rule.enabled
                  ? "enabled"
                  : "disabled",
            ],
          ),
        ],
      ),
      h.td(
        [h.Class(cn(cellClass, "text-right whitespace-nowrap"))],
        [
          rowButton(h, "Edit", Message.ClickedEditRule({ ruleId: rule.id }), {
            action: "edit-rule",
            isDisabled: pending !== undefined,
          }),
          rowButton(
            h,
            pending?.kind === "RuleDelete" ? "Deleting…" : confirming ? "Confirm delete" : "Delete",
            Message.ClickedDeleteRule({ ruleId: rule.id, version: rule.version }),
            { isDestructive: confirming, action: "delete-rule", isDisabled: pending !== undefined },
          ),
        ],
      ),
    ],
  )
}

const rulesSection = (h: HtmlBuilder<Message>, model: Model, view: ConfigurationView): Html =>
  h.section(
    [h.Class("flex flex-col gap-2")],
    [
      h.div(
        [h.Class("flex items-center justify-between gap-2")],
        [
          sectionTitle(h, "Rules"),
          Button.view(h, {
            variant: "outline",
            size: "xs",
            onClick: Message.ClickedNewRule(),
            isDisabled: !view.policies.some((policy) => policy.publishedRevision !== null),
            label: "New rule",
            attributes: [h.DataAttribute("action", "new-rule")],
          }),
        ],
      ),
      view.rules.length === 0
        ? h.div(
            [h.Class(emptyClass)],
            ["No rules yet. A rule adds a label when a published policy matches."],
          )
        : table(
            h,
            ["Label", "Policy", "On no match", "Group", "", ""],
            view.rules.map((rule) => ruleRow(h, model, view, rule)),
          ),
    ],
  )

const reconciliationsSection = (
  h: HtmlBuilder<Message>,
  reconciliations: ReadonlyArray<ReconciliationRecord>,
  view: ConfigurationView,
): Html =>
  h.section(
    [h.Class("flex flex-col gap-2")],
    [
      sectionTitle(h, "Reconciliations"),
      reconciliations.length === 0
        ? h.div(
            [h.Class("text-muted-foreground text-sm")],
            [
              "No qualified snapshots yet. Activate a revision and change an issue or pull request.",
            ],
          )
        : table(
            h,
            ["#", "Snapshot", "Revision", "Outcome", "Plan", "When"],
            reconciliations.map((row) =>
              h.tr(
                [h.Class("border-t"), h.DataAttribute("outcome", row.outcome ?? "pending")],
                [
                  h.td([h.Class(cellClass)], [String(row.number)]),
                  h.td([h.Class(cellClass)], [row.snapshotGeneration]),
                  h.td([h.Class(cellClass)], [String(row.rulesRevision)]),
                  h.td(
                    [h.Class(cellClass)],
                    [
                      h.div([], [row.outcome ?? "pending"]),
                      h.div([h.Class("text-muted-foreground text-xs")], [row.detail ?? ""]),
                    ],
                  ),
                  h.td(
                    [h.Class(cellClass)],
                    [
                      row.plan === null
                        ? h.empty
                        : row.plan.actions.length === 0
                          ? h.span([h.Class("text-muted-foreground")], ["no changes"])
                          : h.ul(
                              [h.Class("flex flex-col gap-0.5")],
                              describePlan(row.plan, view, row.actions).map((line, index) =>
                                h.li(
                                  [
                                    h.DataAttribute(
                                      "action",
                                      row.plan?.actions[index]?.action ?? "",
                                    ),
                                  ],
                                  [line],
                                ),
                              ),
                            ),
                    ],
                  ),
                  h.td(
                    [h.Class(cn(cellClass, "text-muted-foreground whitespace-nowrap"))],
                    [DateTime.formatUtc(row.completedAt ?? row.createdAt)],
                  ),
                ],
              ),
            ),
          ),
    ],
  )

const syncSection = (h: HtmlBuilder<Message>, model: Model): Html => {
  const repository = Option.flatMap(model.repositories, (repositories) =>
    Option.fromNullishOr(
      repositories.find((row) => Option.contains(model.selected, row.repositoryId)),
    ),
  )
  return Option.match(repository, {
    onNone: () => h.empty,
    onSome: (row) =>
      h.section(
        [h.Class("flex flex-col gap-3")],
        [
          sectionTitle(h, "GitHub sync"),
          h.p(
            [h.Class("text-sm text-muted-foreground")],
            [
              "Keep local data up to date with GitHub. Turning sync off retains cached data and leaves auto-labeling settings unchanged.",
            ],
          ),
          h.button(
            [
              h.Type("button"),
              h.Role("switch"),
              h.AriaChecked(row.syncEnabled !== false),
              h.AriaLabel("GitHub sync"),
              h.Disabled(hasMutation(model, row.repositoryId, row.repositoryId, ["SyncToggle"])),
              h.AriaBusy(hasMutation(model, row.repositoryId, row.repositoryId, ["SyncToggle"])),
              h.OnClick(
                Message.ClickedToggleSync({
                  repositoryId: row.repositoryId,
                  enabled: row.syncEnabled === false,
                }),
              ),
              h.Class("w-fit rounded-md border px-3 py-2 text-sm hover:bg-accent"),
            ],
            [
              hasMutation(model, row.repositoryId, row.repositoryId, ["SyncToggle"])
                ? row.syncEnabled === false
                  ? "Turning sync off…"
                  : "Turning sync on…"
                : row.syncEnabled === false
                  ? "Sync off"
                  : "Sync on",
            ],
          ),
        ],
      ),
  })
}

const consentSection = (h: HtmlBuilder<Message>, model: Model): Html =>
  h.section(
    [
      h.Class("flex flex-col gap-2"),
      h.DataAttribute(
        "consent",
        Option.map(model.maybeConsent, (consent) => consent.state).pipe(
          Option.getOrElse(() => "unknown"),
        ),
      ),
    ],
    [
      h.div(
        [h.Class("flex items-center justify-between gap-2")],
        [
          sectionTitle(h, "AI classification"),
          Option.match(model.maybeConsent, {
            onNone: () => h.empty,
            onSome: (consent) =>
              Button.view(h, {
                variant: consent.state === "enabled" ? "destructive" : "outline",
                size: "xs",
                onClick: Message.ClickedToggleConsent(),
                isDisabled:
                  hasMutation(model, consent.repositoryId, consent.repositoryId, ["Consent"]) ||
                  consent.state === "draining",
                label: hasMutation(model, consent.repositoryId, consent.repositoryId, ["Consent"])
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
          }),
        ],
      ),
      Option.isSome(model.consentError)
        ? h.div(
            [h.Role("alert"), h.Class("text-sm text-destructive")],
            [
              model.consentError.value,
              Button.view(h, {
                label: "Retry AI consent",
                variant: "outline",
                size: "xs",
                onClick: Message.ClickedRetryConsent(),
                isDisabled: Option.isSome(model.maybeConsentRequest),
              }),
            ],
          )
        : h.empty,
      Option.match(model.maybeConsent, {
        onNone: () =>
          Option.isSome(model.consentError)
            ? h.empty
            : h.div([h.Class("text-muted-foreground text-xs")], ["Loading"]),
        onSome: (consent) =>
          h.div(
            [h.Class("text-muted-foreground flex flex-col gap-1 text-xs")],
            [
              h.span(
                [],
                [
                  consent.state === "enabled"
                    ? `Enabled for ${consent.provider} ${consent.model}. Classifier policies send only the evidence facts they name, with no credentials or repository access, and their answers can only add labels.`
                    : consent.state === "draining"
                      ? `Revoked. ${consent.activeLeases} call${consent.activeLeases === 1 ? "" : "s"} already in flight cannot be recalled; no new ones start, and this becomes disabled when they finish.`
                      : `Disabled. Classifier policies evaluate as unknown, which preserves labels. Enabling sends the evidence facts a classifier names to ${consent.provider === "none" ? "the configured provider" : `${consent.provider} ${consent.model}`}.`,
                ],
              ),
              consent.provider === "none" && consent.state !== "enabled"
                ? h.span(
                    [],
                    ["No provider key is configured on the server, so enabling has no effect yet."],
                  )
                : h.empty,
            ],
          ),
      }),
    ],
  )

const panelView = (h: HtmlBuilder<Message>, model: Model): Html => {
  switch (model.panel._tag) {
    case "Closed":
      return h.empty
    case "Unavailable":
      return h.p([h.Class("p-6 text-sm text-destructive"), h.Role("alert")], [model.panel.message])
    case "LoadingPolicy":
      return h.div([h.Class("text-muted-foreground text-sm")], ["Loading the policy"])
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
          confirmingDelete:
            editor.identity._tag === "Existing" &&
            confirmingPolicy(model, editor.identity.policyId),
        },
        toParentMessage: (message) => Message.GotPolicyEditorMessage({ message }),
      })
    }
    case "RuleEditor":
      return h.submodel({
        slotId: "rule-editor",
        model: model.panel.editor,
        view: RuleEditor.view,
        toParentMessage: (message) => Message.GotRuleEditorMessage({ message }),
      })
    case "TestBench":
      return h.submodel({
        slotId: "test-bench",
        model: model.panel.bench,
        view: TestBench.view,
        toParentMessage: (message) => Message.GotTestBenchMessage({ message }),
      })
  }
}

const detailPanel = (h: HtmlBuilder<Message>, model: Model): Html =>
  Option.match(model.detail, {
    onNone: () =>
      h.div(
        [h.Class("p-6 text-sm text-muted-foreground")],
        [
          Option.getOrElse(model.detailError, () =>
            Option.getOrElse(model.repositoriesError, () =>
              Option.isNone(model.selected)
                ? "Select a repository to get started."
                : "Loading repository…",
            ),
          ),
        ],
      ),
    onSome: (detail) => {
      if (model.section === "Policies") {
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
                      [h.Class("p-3 text-xs text-destructive"), h.Role("alert")],
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
                        h.div(
                          [h.Class("policy-empty-icon")],
                          [
                            Icon.view(
                              h,
                              detail.configuration.policies.length === 0
                                ? FileCode2
                                : MousePointer2,
                              "size-6",
                            ),
                          ],
                        ),
                        h.h2(
                          [h.Class("text-lg font-semibold")],
                          [
                            detail.configuration.policies.length === 0
                              ? "Create your first policy"
                              : "Select a policy",
                          ],
                        ),
                        h.p(
                          [h.Class("max-w-sm text-sm text-muted-foreground")],
                          [
                            detail.configuration.policies.length === 0
                              ? "Define when an issue or pull request matches, then test it against your repository."
                              : "Choose a policy from the list to edit its conditions and test your changes.",
                          ],
                        ),
                        detail.configuration.policies.length === 0
                          ? Button.view(h, {
                              size: "sm",
                              label: "Create policy",
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
      return h.div(
        [h.Class("flex min-w-0 flex-col gap-6 overflow-auto p-6")],
        [
          model.section === "Rules"
            ? h.div(
                [h.Class("flex flex-col gap-5")],
                [
                  h.p(
                    [h.Class("text-xs text-muted-foreground")],
                    [describeRevision(detail.configuration)],
                  ),
                  Button.view(h, {
                    variant: "outline",
                    size: "sm",
                    label: "Test configuration",
                    onClick: Message.ClickedTestConfiguration(),
                  }),
                  model.panel._tag === "RuleEditor" ||
                  model.panel._tag === "TestBench" ||
                  model.panel._tag === "Unavailable"
                    ? h.div([h.Class("rounded-lg border p-4")], [panelView(h, model)])
                    : h.empty,
                  rulesSection(h, model, detail.configuration),
                ],
              )
            : h.empty,
          model.section === "Activity"
            ? reconciliationsSection(h, detail.reconciliations, detail.configuration)
            : h.empty,
          model.section === "Settings"
            ? h.div(
                [h.Class("flex flex-col gap-8")],
                [syncSection(h, model), consentSection(h, model)],
              )
            : h.empty,
        ],
      )
    },
  })

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.div([h.Class("repository-workspace")], [detailPanel(h, model)]),
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
  if (!("repositoryId" in route)) return { model: closed(model) }
  const selected = update(model, Message.Selected({ repositoryId: route.repositoryId }))
  let next = evo(changedDocument ? closed(selected.model) : selected.model, {
    section: () => Routes.section(route),
    policySearch: () => ("q" in route ? (route.q ?? "") : ""),
  })
  if (Option.isNone(next.detail)) return { model: next, commands: selected.commands ?? [] }
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
      case "TestRules":
        result = update(next, Message.ClickedTestConfiguration())
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
  return { model: next, commands: [...(selected.commands ?? []), ...(result.commands ?? [])] }
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
