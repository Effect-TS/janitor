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
import { Plus, Search } from "lucide"
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
} from "@/components/labeling-wire"
import { cn } from "@/lib/utils"

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
  Schema.TaggedStruct("PolicyEditor", { editor: PolicyEditor.Model }),
  Schema.TaggedStruct("RuleEditor", { editor: RuleEditor.Model }),
  Schema.TaggedStruct("TestBench", { bench: TestBench.Model }),
])
export type Panel = typeof Panel.Type

export const Section = Schema.Literals(["Policies", "Rules", "Activity", "Settings"])
export type Section = typeof Section.Type

export const Model = Schema.Struct({
  section: Section,
  policySearch: Schema.String,
  repositories: Schema.Option(Schema.Array(RepositoryOverview)),
  repositoriesError: Schema.Option(Schema.String),
  catalog: Schema.Array(FactDescription),
  selected: Schema.Option(Schema.String),
  detail: Schema.Option(RepositoryDetail),
  detailError: Schema.Option(Schema.String),
  maybeConsent: Schema.Option(AiConsent),
  isChangingConsent: Schema.Boolean,
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
  GotRepositories: { repositories: Schema.Array(RepositoryOverview) },
  FailedRepositories: { reason: Schema.String },
  GotCatalog: { catalog: Schema.Array(FactDescription) },
  Selected: { repositoryId: Schema.String },
  Polled: {},
  GotDetail: { repositoryId: Schema.String, detail: RepositoryDetail },
  FailedDetail: { repositoryId: Schema.String, reason: Schema.String },
  GotConsent: { repositoryId: Schema.String, consent: AiConsent },
  ClickedToggleConsent: {},
  ClickedToggleSync: { repositoryId: Schema.String, enabled: Schema.Boolean },
  CompletedToggleSync: {},
  FailedToggleSync: { reason: Schema.String },
  CompletedSetConsent: { repositoryId: Schema.String, consent: AiConsent },
  FailedSetConsent: { reason: Schema.String },
  ClickedNewPolicy: {},
  ClickedEditPolicy: { policyId: Schema.String },
  GotPolicyDetail: { detail: PolicyDetail },
  FailedPolicyDetail: { reason: Schema.String },
  ClickedTestPolicy: { policyId: Schema.String },
  ClickedTestConfiguration: {},
  ClickedDeletePolicy: { policyId: Schema.String, version: Schema.Int },
  ClickedNewRule: {},
  ClickedEditRule: { ruleId: Schema.String },
  ClickedToggleRule: { ruleId: Schema.String },
  ClickedDeleteRule: { ruleId: Schema.String, version: Schema.Int },
  CompletedDelete: { what: Schema.String },
  FailedDelete: { reason: Schema.String },
  CompletedToggleRule: {},
  FailedToggleRule: { reason: Schema.String },
  GotPolicyEditorMessage: { message: PolicyEditor.Message },
  GotRuleEditorMessage: { message: RuleEditor.Message },
  GotTestBenchMessage: { message: TestBench.Message },
})
export type Message = typeof Message.Type

/** What the shell needs to know to show toasts. */
export const OutMessage = defineMessageUnion({
  Notified: { title: Schema.String, description: Schema.String },
  Failed: { title: Schema.String, reason: Schema.String },
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
  messages: [Message.GotRepositories, Message.FailedRepositories],
  execute: getJson(REPOSITORIES_ENDPOINT, Schema.Array(RepositoryOverview)).pipe(
    Effect.map((repositories) => Message.GotRepositories({ repositories })),
    Effect.catch((error) =>
      Effect.succeed(Message.FailedRepositories({ reason: describe(error) })),
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
  args: { repositoryId: Schema.String },
  messages: [Message.GotDetail, Message.FailedDetail],
  execute: ({ repositoryId }) =>
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
      Effect.map((detail) => Message.GotDetail({ repositoryId, detail })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedDetail({ repositoryId, reason: describe(error) })),
      ),
    ),
})

/** Consent is separate from the configuration so a failure here never hides the tables. */
export const FetchConsent = FoldkitCommand.define("FetchConsent", {
  args: { repositoryId: Schema.String },
  messages: [Message.GotConsent],
  execute: ({ repositoryId }) =>
    getJson(aiConsentEndpoint(repositoryId), AiConsent).pipe(
      Effect.map((consent) => Message.GotConsent({ repositoryId, consent })),
      Effect.catch(() => Effect.never),
    ),
})

export const SetRepositorySync = FoldkitCommand.define("SetRepositorySync", {
  args: { repositoryId: Schema.String, enabled: Schema.Boolean },
  messages: [Message.CompletedToggleSync, Message.FailedToggleSync],
  execute: ({ repositoryId, enabled }) =>
    HttpClientRequest.put(`/api/v1/repositories/${encodeURIComponent(repositoryId)}/sync`).pipe(
      HttpClientRequest.bodyJson({ enabled }),
      Effect.flatMap(HttpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.as(Message.CompletedToggleSync()),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedToggleSync({ reason: describe(error) })),
      ),
    ),
})

export const SetConsent = FoldkitCommand.define("SetConsent", {
  args: { repositoryId: Schema.String, enabled: Schema.Boolean },
  messages: [Message.CompletedSetConsent, Message.FailedSetConsent],
  execute: ({ repositoryId, enabled }) =>
    HttpClientRequest.put(aiConsentEndpoint(repositoryId)).pipe(
      HttpClientRequest.bodyJson({ enabled }),
      Effect.flatMap(HttpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpIncomingMessage.schemaBodyJson(AiConsent)),
      Effect.map((consent) => Message.CompletedSetConsent({ repositoryId, consent })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedSetConsent({ reason: describe(error) })),
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
        Effect.succeed(Message.FailedPolicyDetail({ reason: describe(error) })),
      ),
    ),
})

const MessageBody = Schema.Struct({ message: Schema.String })

export const DeleteSubject = FoldkitCommand.define("DeleteSubject", {
  args: { url: Schema.String, version: Schema.Int, what: Schema.String },
  messages: [Message.CompletedDelete, Message.FailedDelete],
  execute: ({ url, version, what }) =>
    Effect.gen(function* () {
      const response = yield* HttpClient.execute(
        HttpClientRequest.make("DELETE")(`${url}?version=${version}`),
      )
      switch (response.status) {
        case 204:
          return Message.CompletedDelete({ what })
        case 409: {
          const { message } = yield* HttpIncomingMessage.schemaBodyJson(MessageBody)(response)
          return Message.FailedDelete({ reason: message })
        }
        default:
          return Message.FailedDelete({ reason: `Server answered ${response.status}` })
      }
    }).pipe(
      Effect.catch((error) => Effect.succeed(Message.FailedDelete({ reason: describe(error) }))),
    ),
})

export const ToggleRule = FoldkitCommand.define("ToggleRule", {
  args: {
    repositoryId: Schema.String,
    ruleId: Schema.String,
    version: Schema.Int,
    enabled: Schema.Boolean,
  },
  messages: [Message.CompletedToggleRule, Message.FailedToggleRule],
  execute: ({ repositoryId, ruleId, version, enabled }) =>
    HttpClientRequest.patch(ruleEndpoint(repositoryId, ruleId)).pipe(
      HttpClientRequest.bodyJson({ version, enabled }),
      Effect.flatMap(HttpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.map(() => Message.CompletedToggleRule()),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedToggleRule({ reason: describe(error) })),
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
      section: "Policies",
      policySearch: "",
      repositories: Option.none(),
      repositoriesError: Option.none(),
      catalog: [],
      selected: Option.none(),
      detail: Option.none(),
      detailError: Option.none(),
      maybeConsent: Option.none(),
      isChangingConsent: false,
      panel: { _tag: "Closed" },
      maybeConfirmingDelete: Option.none(),
    },
    { disableChecks: true },
  ),
  commands: [FetchRepositories(), FetchCatalog()],
})

// UPDATE

type Step = Update.Return<Model, Message, HttpClient.HttpClient>

const closed = (model: Model): Model =>
  evo(model, {
    panel: () => ({ _tag: "Closed" as const }),
    maybeConfirmingDelete: () => Option.none(),
  })

const refresh = (model: Model) =>
  Option.match(model.selected, {
    onNone: () => [],
    onSome: (repositoryId) => [FetchDetail({ repositoryId }), FetchConsent({ repositoryId })],
  })

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
            policyNames: detail.configuration.policies
              .filter((policy) => policy.publishedVersionId !== null)
              .map((policy) => policy.name),
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
            ? "Rules bound to it re-evaluate once synchronization verifies the tracks it needs."
            : "Publish it to make it available to rules.",
        }),
      Cancelled: () => undefined,
      RequestedDelete: () => undefined,
      SaveFailed: ({ reason }) => OutMessage.Failed({ title: "The policy was not saved", reason }),
    }),
  foldOutMessage: (outMessage) => (model) =>
    PolicyEditor.OutMessage.match<Step>(outMessage, {
      Saved: () => ({ model, commands: refresh(model) }),
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
      Saved: () => ({ model: closed(model), commands: refresh(model) }),
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

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SelectedSection: ({ section }) => ({ model: evo(model, { section: () => section }) }),
    UpdatedPolicySearch: ({ value }) => ({ model: evo(model, { policySearch: () => value }) }),
    GotRepositories: ({ repositories }) => {
      const next = evo(model, {
        repositories: () => Option.some(repositories),
        repositoriesError: () => Option.none<string>(),
      })
      // Open the first repository so the page is never empty.
      const first = repositories[0]
      return Option.isNone(model.selected) && first !== undefined
        ? {
            model: evo(next, { selected: () => Option.some(first.repositoryId) }),
            commands: [
              FetchDetail({ repositoryId: first.repositoryId }),
              FetchConsent({ repositoryId: first.repositoryId }),
            ],
          }
        : { model: next }
    },
    FailedRepositories: ({ reason }) => ({
      model: evo(model, { repositoriesError: () => Option.some(reason) }),
    }),
    GotCatalog: ({ catalog }) => ({ model: evo(model, { catalog: () => catalog }) }),

    Selected: ({ repositoryId }) =>
      Option.contains(model.selected, repositoryId)
        ? { model }
        : {
            model: evo(closed(model), {
              selected: () => Option.some(repositoryId),
              policySearch: () => "",
              detail: () => Option.none<RepositoryDetail>(),
              detailError: () => Option.none<string>(),
              maybeConsent: () => Option.none<AiConsent>(),
            }),
            commands: [FetchDetail({ repositoryId }), FetchConsent({ repositoryId })],
          },
    Polled: () => ({ model, commands: refresh(model) }),
    // A late answer for a repository that is no longer selected is dropped.
    GotDetail: ({ repositoryId, detail }) =>
      Option.contains(model.selected, repositoryId)
        ? {
            model: evo(model, {
              detail: () => Option.some(detail),
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
                      editor: evo(
                        PolicyEditor.withTestCandidates(
                          panel.editor,
                          detail.testCandidates ?? panel.editor.testCandidates,
                        ),
                        {
                          configuration: () => detail.configuration,
                        },
                      ),
                    }
                  : panel,
            }),
          }
        : { model },
    FailedDetail: ({ repositoryId, reason }) =>
      Option.contains(model.selected, repositoryId)
        ? { model: evo(model, { detailError: () => Option.some(reason) }) }
        : { model },
    GotConsent: ({ repositoryId, consent }) =>
      Option.contains(model.selected, repositoryId)
        ? { model: evo(model, { maybeConsent: () => Option.some(consent) }) }
        : { model },
    ClickedToggleSync: ({ repositoryId, enabled }) => ({
      model,
      commands: [SetRepositorySync({ repositoryId, enabled })],
    }),
    CompletedToggleSync: () => ({ model, commands: [FetchRepositories()] }),
    FailedToggleSync: ({ reason }) => ({
      model,
      outMessage: OutMessage.Failed({ title: "Sync setting was not saved", reason }),
    }),
    ClickedToggleConsent: () =>
      Option.match(model.selected, {
        onNone: () => ({ model }),
        onSome: (repositoryId) =>
          model.isChangingConsent
            ? { model }
            : {
                model: evo(model, { isChangingConsent: () => true }),
                commands: [
                  SetConsent({
                    repositoryId,
                    enabled: !Option.exists(
                      model.maybeConsent,
                      (consent) => consent.state === "enabled",
                    ),
                  }),
                ],
              },
      }),
    CompletedSetConsent: ({ repositoryId, consent }) => ({
      model: evo(model, {
        isChangingConsent: () => false,
        maybeConsent: (current) =>
          Option.contains(model.selected, repositoryId) ? Option.some(consent) : current,
      }),
      outMessage: OutMessage.Notified({
        title:
          consent.state === "enabled"
            ? "AI classification enabled"
            : consent.state === "draining"
              ? "AI classification draining"
              : "AI classification disabled",
        description:
          consent.state === "enabled"
            ? `Classifier policies may send the evidence they name to ${consent.provider} ${consent.model}.`
            : consent.state === "draining"
              ? `${consent.activeLeases} call${consent.activeLeases === 1 ? "" : "s"} still in flight; no new ones start.`
              : "Classifier policies evaluate as unknown and never remove labels.",
      }),
    }),
    FailedSetConsent: ({ reason }) => ({
      model: evo(model, { isChangingConsent: () => false }),
      outMessage: OutMessage.Failed({ title: "AI consent was not changed", reason }),
    }),

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
      model.panel._tag === "LoadingPolicy" && model.panel.policyId === detail.policy.policyId
        ? { model: openPolicyEditor(model, Option.some(detail)) }
        : { model },
    FailedPolicyDetail: ({ reason }) => ({
      model: closed(model),
      outMessage: OutMessage.Failed({ title: "Could not open the policy", reason }),
    }),
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
      confirmingPolicy(model, policyId)
        ? Option.match(model.selected, {
            onNone: () => ({ model }),
            onSome: (repositoryId) => ({
              model: evo(model, { maybeConfirmingDelete: () => Option.none() }),
              commands: [
                DeleteSubject({
                  url: policyEndpoint(repositoryId, policyId),
                  version,
                  what: "policy",
                }),
              ],
            }),
          })
        : {
            model: evo(model, {
              maybeConfirmingDelete: () => Option.some({ _tag: "Policy" as const, policyId }),
            }),
          },

    ClickedNewRule: () => ({ model: openRuleEditor(model, Option.none()) }),
    ClickedEditRule: ({ ruleId }) => ({
      model: openRuleEditor(model, Option.some({ _tag: "Existing", ruleId, version: 0 })),
    }),
    ClickedToggleRule: ({ ruleId }) =>
      Option.match(loaded(model), {
        onNone: () => ({ model }),
        onSome: ({ repositoryId, detail }) => {
          const rule = detail.configuration.rules.find((candidate) => candidate.id === ruleId)
          return rule === undefined
            ? { model }
            : {
                model,
                commands: [
                  ToggleRule({
                    repositoryId,
                    ruleId,
                    version: rule.version,
                    enabled: !rule.enabled,
                  }),
                ],
              }
        },
      }),
    ClickedDeleteRule: ({ ruleId, version }) =>
      confirmingRule(model, ruleId)
        ? Option.match(model.selected, {
            onNone: () => ({ model }),
            onSome: (repositoryId) => ({
              model: evo(model, { maybeConfirmingDelete: () => Option.none() }),
              commands: [
                DeleteSubject({ url: ruleEndpoint(repositoryId, ruleId), version, what: "rule" }),
              ],
            }),
          })
        : {
            model: evo(model, {
              maybeConfirmingDelete: () => Option.some({ _tag: "Rule" as const, ruleId }),
            }),
          },
    CompletedDelete: ({ what }) => ({
      model: what === "policy" ? closed(model) : model,
      commands: refresh(model),
      outMessage: OutMessage.Notified({
        title: `Deleted the ${what}`,
        description: "The configuration revision advanced.",
      }),
    }),
    FailedDelete: ({ reason }) => ({
      model,
      outMessage: OutMessage.Failed({ title: "Nothing was deleted", reason }),
    }),
    CompletedToggleRule: () => ({ model, commands: refresh(model) }),
    FailedToggleRule: ({ reason }) => ({
      model,
      outMessage: OutMessage.Failed({ title: "The rule was not changed", reason }),
    }),

    GotPolicyEditorMessage: ({ message }) => foldPolicyEditor(model, message),
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
  options: { readonly isDestructive?: boolean; readonly action?: string } = {},
): Html =>
  Button.view(h, {
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
                    [String(view.policies.length)],
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
        policies.map((policy) =>
          h.li(
            [h.DataAttribute("policy-id", policy.policyId)],
            [
              h.button(
                [
                  h.Type("button"),
                  h.Class(
                    cn("policy-library-item", selectedId === policy.policyId && "is-selected"),
                  ),
                  h.AriaPressed(selectedId === policy.policyId ? "true" : "false"),
                  h.OnClick(Message.ClickedEditPolicy({ policyId: policy.policyId })),
                  h.DataAttribute("action", "edit-policy"),
                ],
                [
                  h.span([h.Class("policy-library-name")], [policy.name]),
                  h.span(
                    [h.Class("policy-library-summary")],
                    [policy.description || "No description"],
                  ),
                  h.span(
                    [h.Class("policy-library-meta")],
                    [
                      policy.target === "pull_request" ? "Pull requests" : "Issues",
                      h.span(
                        [],
                        [
                          policy.publishedRevision === null
                            ? "Draft"
                            : `Published · v${policy.publishedRevision}`,
                        ],
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
      policies.length === 0
        ? h.p(
            [h.Class("p-4 text-xs text-muted-foreground")],
            [
              view.policies.length === 0
                ? "Create your first policy to get started."
                : "No policies match your search.",
            ],
          )
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
              h.OnClick(Message.ClickedToggleRule({ ruleId: rule.id })),
              h.Class(
                cn(
                  "cursor-pointer text-xs",
                  rule.enabled ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
                ),
              ),
            ],
            [rule.enabled ? "enabled" : "disabled"],
          ),
        ],
      ),
      h.td(
        [h.Class(cn(cellClass, "text-right whitespace-nowrap"))],
        [
          rowButton(h, "Edit", Message.ClickedEditRule({ ruleId: rule.id }), {
            action: "edit-rule",
          }),
          rowButton(
            h,
            confirming ? "Confirm delete" : "Delete",
            Message.ClickedDeleteRule({ ruleId: rule.id, version: rule.version }),
            { isDestructive: confirming, action: "delete-rule" },
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
              h.OnClick(
                Message.ClickedToggleSync({
                  repositoryId: row.repositoryId,
                  enabled: row.syncEnabled === false,
                }),
              ),
              h.Class("w-fit rounded-md border px-3 py-2 text-sm hover:bg-accent"),
            ],
            [row.syncEnabled === false ? "Sync off" : "Sync on"],
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
                isDisabled: model.isChangingConsent || consent.state === "draining",
                label:
                  consent.state === "enabled"
                    ? "Revoke"
                    : consent.state === "draining"
                      ? "Draining"
                      : "Enable",
                attributes: [h.DataAttribute("action", "toggle-consent")],
              }),
          }),
        ],
      ),
      Option.match(model.maybeConsent, {
        onNone: () => h.div([h.Class("text-muted-foreground text-xs")], ["Loading"]),
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
    case "LoadingPolicy":
      return h.div([h.Class("text-muted-foreground text-sm")], ["Loading the policy"])
    case "PolicyEditor": {
      const editor = model.panel.editor
      return h.submodel({
        slotId: "policy-editor",
        model: editor,
        view: PolicyEditor.view,
        viewInputs: {
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
                model.panel._tag === "PolicyEditor" || model.panel._tag === "LoadingPolicy"
                  ? panelView(h, model)
                  : h.div(
                      [h.Class("policy-empty")],
                      [
                        h.h2([h.Class("text-lg font-semibold")], ["Your policy workspace"]),
                        h.p(
                          [h.Class("max-w-sm text-sm text-muted-foreground")],
                          ["Select a policy to edit and test it, or create a new one."],
                        ),
                        Button.view(h, {
                          variant: "outline",
                          size: "sm",
                          label: "Create policy",
                          onClick: Message.ClickedNewPolicy(),
                        }),
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
                  model.panel._tag === "RuleEditor" || model.panel._tag === "TestBench"
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
export const refreshAfterSync = (model: Model): UpdateReturn => ({
  model,
  commands: [
    FetchRepositories(),
    FetchCatalog(),
    ...Option.match(model.selected, {
      onNone: () => [],
      onSome: (repositoryId) => [FetchDetail({ repositoryId }), FetchConsent({ repositoryId })],
    }),
  ],
})
