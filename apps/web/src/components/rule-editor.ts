import { resultAction, describeResultAction } from "@janitor/domain/Labeling/Policy/Plan"
import * as Clock from "effect/Clock"
import { AiInputDetails } from "@/components/labeling-wire"
import { aiInputView, InputInspection } from "@/components/ai-input-view"
import { inspectAiPrompt } from "@janitor/domain/Labeling/Policy/PromptReferences"
import * as Mount from "foldkit/mount"
import * as Stream from "effect/Stream"
import * as Queue from "effect/Queue"
import { AiRuleDefinition, FactDescription } from "@/components/labeling-wire"
import * as Dialog from "@foldkit/ui/dialog"
import * as Disclosure from "@foldkit/ui/disclosure"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage"
import * as FoldkitCommand from "foldkit/command"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import * as Submodel from "foldkit/submodel"
import type * as Update from "foldkit/update"
import { ArrowLeft, ChevronRight, Play, Trash2 } from "lucide"
import * as Button from "@/components/ui/button"
import { input } from "@/components/ui/input"
import * as Blueprint from "@/components/ui/blueprint"
import { chip } from "@/components/ui/chip"
import * as DialogChrome from "@/components/ui/dialog"
import * as Feed from "@/components/ui/feed"
import { panel, panelHeader } from "@/components/ui/panel"
import * as SelectField from "@/components/ui/select"
import * as SwitchControl from "@/components/ui/switch"
import {
  ConfigurationView,
  ResultAction,
  type Outcome,
  PolicyRecord,
  RuleIssue,
  RuleRecord,
  ruleEndpoint,
  rulesEndpoint,
  SynchronizedLabel,
  TestCandidates,
  TestResponse,
  testEndpoint,
  labelName,
  describeOutcome,
} from "@/components/labeling-wire"
import * as Icon from "@/lib/icons"
import { cn } from "@/lib/utils"

/**
 * The rule editor: one label bound to one published policy, plus what a
 * miss means and how the rule competes inside its group.
 */

// MODEL

export const Identity = Schema.Union([
  Schema.TaggedStruct("New", {}),
  Schema.TaggedStruct("Existing", { ruleId: Schema.String, version: Schema.Int }),
])
export type Identity = typeof Identity.Type

export const Submission = Schema.Union([
  Schema.TaggedStruct("NotSubmitted", {}),
  Schema.TaggedStruct("Submitting", {
    operationId: Schema.Int,
    snapshot: Schema.String,
    submittedPriority: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("Conflicted", {}),
  Schema.TaggedStruct("Rejected", { issues: Schema.Array(RuleIssue) }),
  Schema.TaggedStruct("SubmitError", { message: Schema.String }),
])
export type Submission = typeof Submission.Type

export const Model = Schema.Struct({
  deleteDialog: Dialog.Model,
  repositoryId: Schema.String,
  ai: Schema.NullOr(AiRuleDefinition),
  creationKey: Schema.NullOr(Schema.String),
  catalog: Schema.Array(FactDescription),
  identity: Identity,
  maybeLabelId: Schema.Option(Schema.String),
  maybePolicyId: Schema.Option(Schema.String),
  onMatch: ResultAction,
  onNoMatch: ResultAction,
  group: Schema.String,
  priority: Schema.String,
  enabled: Schema.Boolean,
  labels: Schema.Array(SynchronizedLabel),
  policies: Schema.Array(PolicyRecord),
  rules: Schema.Array(RuleRecord),
  submission: Submission,
  nextOperationId: Schema.Int,
  savedSnapshot: Schema.String,
  testCandidates: TestCandidates,
  selectedNumber: Schema.NullOr(Schema.Int),
  testGeneration: Schema.Int,
  liveJob: Schema.NullOr(
    Schema.Struct({
      testId: Schema.String,
      generation: Schema.Int,
      polls: Schema.Int,
      startedAt: Schema.Number,
      status: Schema.Literals(["queued", "running"]),
    }),
  ),
  jobLoading: Schema.Boolean,
  jobRefresh: Schema.Boolean,
  testResult: Schema.Union([
    Schema.TaggedStruct("Idle", {}),
    Schema.TaggedStruct("Running", {
      status: Schema.Literals(["submitting", "queued", "running"]),
      elapsedSeconds: Schema.Int,
      pollError: Schema.optionalKey(Schema.String),
      progress: Schema.optionalKey(Schema.String),
    }),
    Schema.TaggedStruct("Done", {
      response: TestResponse,
      testId: Schema.optionalKey(Schema.String),
    }),
    Schema.TaggedStruct("Failed", { reason: Schema.String }),
  ]),
  inputInspection: InputInspection,
  groupOpen: Schema.Boolean,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ClickedInspectInput: {},
  LoadedInput: { generation: Schema.Int, details: AiInputDetails },
  FailedInput: { generation: Schema.Int, reason: Schema.String },
  PreparedCreation: { key: Schema.String },
  SelectedType: { value: Schema.String },
  EditedPrompt: { value: Schema.String },
  SelectedTarget: { value: Schema.String },
  SelectedGate: { value: Schema.String },
  ChangedConfidence: { value: Schema.String },
  FailedPromptEditor: { reason: Schema.String },
  SelectedLabel: { labelId: Schema.String },
  UpdatedPolicy: { value: Schema.String },
  UpdatedOnMatch: { value: Schema.String },
  UpdatedOnNoMatch: { value: Schema.String },
  UpdatedGroup: { value: Schema.String },
  UpdatedPriority: { value: Schema.String },
  ToggledEnabled: { isChecked: Schema.Boolean },
  MovedGroupRule: { ruleId: Schema.String, direction: Schema.Literals(["up", "down"]) },
  SucceededReorderGroup: { rules: Schema.Array(RuleRecord), operationId: Schema.Int },
  ClickedSave: {},
  SucceededSaveRule: { rule: RuleRecord, operationId: Schema.Int },
  ConflictedSaveRule: { rule: RuleRecord, operationId: Schema.Int },
  RejectedSaveRule: { issues: Schema.Array(RuleIssue), operationId: Schema.Int },
  FailedSaveRule: { reason: Schema.String, operationId: Schema.Int },
  ClickedCancel: {},
  ClickedDelete: {},
  ConfirmedDelete: {},
  CancelledDelete: {},
  GotDeleteDialogMessage: { message: Dialog.Message },
  ToggledGroup: { isOpen: Schema.Boolean },
  SelectedTestItem: { number: Schema.Int },
  ClickedTest: {},
  RefreshTest: {},
  QueuedTest: {
    testId: Schema.String,
    generation: Schema.Int,
    status: Schema.Literals(["queued", "running"]),
    startedAt: Schema.Number,
    elapsedSeconds: Schema.Int,
    pollError: Schema.optionalKey(Schema.String),
    progress: Schema.optionalKey(Schema.String),
    polls: Schema.Int,
  },
  CompletedTest: {
    response: TestResponse,
    generation: Schema.Int,
    testId: Schema.optionalKey(Schema.String),
  },
  FailedTest: { reason: Schema.String, generation: Schema.Int },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  Saved: { rule: RuleRecord, closeEditor: Schema.Boolean },
  Cancelled: {},
  RequestedDelete: { ruleId: Schema.String, version: Schema.Int },
  SaveFailed: { reason: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

// DOMAIN

export const draftIssues = (model: Model): ReadonlyArray<string> => [
  ...groupDraftIssues(model),
  ...(model.ai?.gatePolicyId &&
  !model.policies.some(
    (p) =>
      p.policyId === model.ai!.gatePolicyId &&
      p.publishedVersionId !== null &&
      p.target === model.ai!.target &&
      p.publishedEvaluator === "Conditions",
  )
    ? ["Choose a published gate policy for this target"]
    : []),
  ...(Option.isNone(model.maybeLabelId) ? ["Pick a label"] : []),
  ...(model.ai
    ? inspectAiPrompt(model.ai.prompt, model.ai.target, model.catalog).diagnostics.map(
        (d) => d.message,
      )
    : !model.policies.some(
          (policy) =>
            Option.contains(model.maybePolicyId, policy.policyId) &&
            policy.publishedVersionId !== null,
        )
      ? ["Pick a published policy"]
      : []),
  ...(Option.exists(
    model.maybeLabelId,
    (id) =>
      !model.labels.some((label) => label.labelId === id && label.availability !== "unavailable"),
  )
    ? ["Choose an available label"]
    : []),
  ...(model.priority.trim() !== "" &&
  (!/^-?\d+$/.test(model.priority.trim()) ||
    !Number.isSafeInteger(Number(model.priority)) ||
    Number(model.priority) < -2147483648 ||
    Number(model.priority) > 2147483647)
    ? ["Priority must be a whole number"]
    : []),
]

const groupMembers = (model: Model) =>
  model.rules
    .filter((rule) => rule.group !== null && rule.group === model.group.trim())
    .sort((a, b) => b.priority - a.priority)

const groupDraftIssues = (model: Model): ReadonlyArray<string> => {
  const identity = model.identity
  const others = groupMembers(model).filter(
    (rule) => identity._tag === "New" || rule.id !== identity.ruleId,
  )
  const issues: Array<string> = []
  if (others.some((rule) => rule.priority === Number(model.priority)))
    issues.push(
      "Priority " +
        Number(model.priority) +
        " is reserved by another group member, including disabled rules. Use reordering to swap priorities.",
    )
  const publishedTarget = (policyId: string | null) => {
    const policy = model.policies.find((policy) => policy.policyId === policyId)
    // A draft target may differ from the published target. The API validates that case.
    return policy?.draftDiffers ? undefined : policy?.target
  }
  const target = model.ai?.target ?? publishedTarget(Option.getOrNull(model.maybePolicyId))
  const otherTarget = others
    .map((rule) => rule.ai?.target ?? publishedTarget(rule.policyId))
    .find((other) => other !== undefined && other !== target)
  if (target && otherTarget)
    issues.push(
      "This labeling group targets " + otherTarget + ". Choose another group for this target.",
    )
  return issues
}

const publishedPolicies = (model: Model) =>
  model.policies.filter((policy) => policy.publishedVersionId !== null)

// COMMAND

const describe = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error)

const IssuesBody = Schema.Struct({ issues: Schema.Array(RuleIssue) })

const Payload = {
  requestId: Schema.optionalKey(Schema.String),
  ai: Schema.optionalKey(AiRuleDefinition),
  operationId: Schema.Int,
  repositoryId: Schema.String,
  identity: Identity,
  labelId: Schema.String,
  policyId: Schema.String,
  onMatch: ResultAction,
  onNoMatch: ResultAction,
  group: Schema.NullOr(Schema.String),
  priority: Schema.Int,
  enabled: Schema.Boolean,
}

export const ReorderGroup = FoldkitCommand.define("ReorderGroup", {
  args: {
    repositoryId: Schema.String,
    group: Schema.String,
    operationId: Schema.Int,
    rules: Schema.Array(
      Schema.Struct({ id: Schema.String, version: Schema.Int, priority: Schema.Int }),
    ),
  },
  messages: [Message.SucceededReorderGroup, Message.FailedSaveRule],
  execute: ({ repositoryId, group, rules, operationId }) =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(rulesEndpoint(repositoryId) + "/reorder").pipe(
        HttpClientRequest.bodyJson({ group, rules }),
        Effect.flatMap(HttpClient.execute),
      )
      if (response.status === 200)
        return Message.SucceededReorderGroup({
          operationId,
          rules: yield* HttpIncomingMessage.schemaBodyJson(Schema.Array(RuleRecord))(response),
        })
      return Message.FailedSaveRule({
        operationId,
        reason:
          response.status === 409
            ? "This labeling group changed. Reload the page before reordering."
            : "Could not reorder the labeling group. Reload its members and try again.",
      })
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(Message.FailedSaveRule({ operationId, reason: describe(error) })),
      ),
    ),
})

export const SaveRule = FoldkitCommand.define("SaveRule", {
  args: Payload,
  messages: [
    Message.SucceededSaveRule,
    Message.ConflictedSaveRule,
    Message.RejectedSaveRule,
    Message.FailedSaveRule,
  ],
  execute: ({
    operationId,
    requestId,
    ai,
    repositoryId,
    identity,
    labelId,
    policyId,
    onMatch,
    onNoMatch,
    group,
    priority,
    enabled,
  }) =>
    Effect.gen(function* () {
      const fields = {
        requestId,
        labelId,
        ...(ai ? { ai } : { policyId }),
        onMatch,
        onNoMatch,
        group,
        priority,
        enabled,
      }
      const request =
        identity._tag === "New"
          ? HttpClientRequest.post(rulesEndpoint(repositoryId)).pipe(
              HttpClientRequest.bodyJson(fields),
            )
          : HttpClientRequest.patch(ruleEndpoint(repositoryId, identity.ruleId)).pipe(
              HttpClientRequest.bodyJson({ ...fields, version: identity.version }),
            )
      const response = yield* Effect.flatMap(request, HttpClient.execute)
      switch (response.status) {
        case 200:
        case 201:
          return Message.SucceededSaveRule({
            operationId,
            rule: yield* HttpIncomingMessage.schemaBodyJson(RuleRecord)(response),
          })
        case 409:
          return Message.ConflictedSaveRule({
            operationId,
            rule: yield* HttpIncomingMessage.schemaBodyJson(RuleRecord)(response),
          })
        case 422:
          return Message.RejectedSaveRule({
            ...(yield* HttpIncomingMessage.schemaBodyJson(IssuesBody)(response)),
            operationId,
          })
        default:
          return Message.FailedSaveRule({
            reason: `Server answered ${response.status}`,
            operationId,
          })
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(Message.FailedSaveRule({ reason: describe(error), operationId })),
      ),
    ),
})

export const TestRule = FoldkitCommand.define("TestRule", {
  args: {
    ai: Schema.optionalKey(AiRuleDefinition),
    evidence: Schema.optionalKey(Schema.Array(Schema.String)),
    repositoryId: Schema.String,
    policyId: Schema.String,
    number: Schema.Int,
    generation: Schema.Int,
  },
  messages: [Message.QueuedTest, Message.CompletedTest, Message.FailedTest],
  execute: ({ repositoryId, policyId, number, generation, ai, evidence }) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      const request = yield* HttpClientRequest.bodyJson(
        HttpClientRequest.post(testEndpoint(repositoryId).replace(/\/test$/, "/rule-tests")),
        {
          subject: ai
            ? {
                _tag: "Draft",
                source: {
                  target: ai.target,
                  ...(ai.gatePolicyId ? { appliesWhen: { policy: ai.gatePolicyId } } : {}),
                  classify: {
                    prompt: ai.prompt,
                    minimumConfidence: ai.minimumConfidence,
                    evidence,
                  },
                },
              }
            : { _tag: "Policy", policyId },
          numbers: [number],
        },
      )
      const response = yield* HttpClient.execute(request)
      if (response.status !== 202)
        return Message.FailedTest({ reason: `Server answered ${response.status}`, generation })
      const job = yield* HttpIncomingMessage.schemaBodyJson(RuleTestJob)(response)
      return testJobMessage(job, generation, startedAt, 0, yield* Clock.currentTimeMillis)
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedTest({ reason: describe(error), generation })),
      ),
    ),
})
const selectedPolicy = (model: Model) =>
  model.policies.find((policy) => Option.contains(model.maybePolicyId, policy.policyId))
export const testItems = (model: Model) =>
  model.testCandidates._tag === "Ready"
    ? model.testCandidates.items.filter(
        (item) => item.kind === (model.ai?.target ?? selectedPolicy(model)?.target),
      )
    : []
const selectedTestItem = (model: Model) =>
  testItems(model).find((item) => item.number === model.selectedNumber) ?? testItems(model)[0]

// INIT

export type UpdateReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  HttpClient.HttpClient
>

const initialize = (input: {
  readonly repositoryId: string
  readonly catalog?: ReadonlyArray<FactDescription>
  readonly labels: ReadonlyArray<SynchronizedLabel>
  readonly rules?: ReadonlyArray<RuleRecord>
  readonly policies: ReadonlyArray<PolicyRecord>
  readonly testCandidates?: TestCandidates | undefined
  readonly existing: Option.Option<RuleRecord>
}): Model =>
  Model.make(
    {
      repositoryId: input.repositoryId,
      creationKey: null,
      deleteDialog: Dialog.init({ id: "delete-rule", focusSelector: "#cancel-delete-rule" }),
      ai: Option.map(input.existing, (rule) => rule.ai ?? null).pipe(Option.getOrNull),
      catalog: input.catalog ?? [],
      identity: Option.match(input.existing, {
        onNone: () => ({ _tag: "New" as const }),
        onSome: (rule) => ({ _tag: "Existing" as const, ruleId: rule.id, version: rule.version }),
      }),
      maybeLabelId: Option.map(input.existing, (rule) => rule.labelId),
      maybePolicyId: Option.map(input.existing, (rule) => rule.policyId),
      onMatch: Option.map(input.existing, (rule) => rule.onMatch).pipe(
        Option.getOrElse((): ResultAction => "ensure-present"),
      ),
      onNoMatch: Option.map(input.existing, (rule) => rule.onNoMatch).pipe(
        Option.getOrElse((): ResultAction => "ensure-absent"),
      ),
      group: Option.flatMap(input.existing, (rule) => Option.fromNullishOr(rule.group)).pipe(
        Option.getOrElse(() => ""),
      ),
      priority: Option.map(input.existing, (rule) => String(rule.priority)).pipe(
        Option.getOrElse(() => "0"),
      ),
      enabled: Option.map(input.existing, (rule) => rule.enabled).pipe(
        Option.getOrElse(() => true),
      ),
      labels: input.labels,
      policies: input.policies,
      rules: input.rules ?? Option.toArray(input.existing),
      submission: { _tag: "NotSubmitted" },
      nextOperationId: 1,
      savedSnapshot: "",
      testCandidates: input.testCandidates ?? { _tag: "Ready", items: [] },
      selectedNumber: null,
      testGeneration: 0,
      liveJob: null,
      jobLoading: false,
      jobRefresh: false,
      testResult: { _tag: "Idle" },
      inputInspection: { _tag: "Idle" },
      groupOpen: Option.exists(input.existing, (rule) => rule.group !== null),
    },
    { disableChecks: true },
  )

// UPDATE

const snapshot = (model: Model): string =>
  JSON.stringify([
    Option.getOrNull(model.maybeLabelId),
    Option.getOrNull(model.maybePolicyId),
    model.onMatch,
    model.onNoMatch,
    model.group,
    model.priority,
    model.enabled,
    model.ai,
  ])

export const init = (input: Parameters<typeof initialize>[0]): Model => {
  const model = initialize(input)
  return evo(model, { savedSnapshot: () => snapshot(model) })
}

export const hasUnsavedChanges = (model: Model): boolean =>
  model.submission._tag === "Submitting" || snapshot(model) !== model.savedSnapshot

const edited = (model: Model): Model =>
  evo(model, {
    testResult: () => ({ _tag: "Idle" as const }),
    inputInspection: () => ({ _tag: "Idle" as const }),
    testGeneration: (id) => id + 1,
    submission: (current) =>
      current._tag === "Submitting" ? current : { _tag: "NotSubmitted" as const },
  })

const mapDeleteDialog = (model: Model, result: ReturnType<typeof Dialog.open>): UpdateReturn => ({
  model: evo(model, { deleteDialog: () => result.model }),
  commands: FoldkitCommand.mapMessages(result.commands, (message) =>
    Message.GotDeleteDialogMessage({ message }),
  ),
})

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    PreparedCreation: ({ key }) => ({
      model: evo(model, { creationKey: (current) => current ?? key }),
    }),
    SelectedType: ({ value }) =>
      model.identity._tag !== "New"
        ? { model }
        : {
            model: edited(
              evo(model, {
                ai: () =>
                  value === "ai"
                    ? {
                        target: "pull_request" as const,
                        prompt:
                          "Does this describe a bug?\n\nTitle: {{fact:title}}\nDescription: {{fact:body}}",
                        minimumConfidence: 0.8,
                      }
                    : null,
              }),
            ),
          },
    EditedPrompt: ({ value }) => ({
      model: model.ai ? edited(evo(model, { ai: () => ({ ...model.ai!, prompt: value }) })) : model,
    }),
    SelectedGate: ({ value }) => ({
      model: model.ai
        ? edited(evo(model, { ai: () => ({ ...model.ai!, gatePolicyId: value || null }) }))
        : model,
    }),
    SelectedTarget: ({ value }) => ({
      model: model.ai
        ? edited(
            evo(model, {
              ai: () => ({
                ...model.ai!,
                target: value === "issue" ? ("issue" as const) : ("pull_request" as const),
              }),
            }),
          )
        : model,
    }),
    ChangedConfidence: ({ value }) => ({
      model: model.ai
        ? edited(
            evo(model, {
              ai: () => ({
                ...model.ai!,
                minimumConfidence: Math.max(0, Math.min(1, Number(value) / 100)),
              }),
            }),
          )
        : model,
    }),
    FailedPromptEditor: ({ reason }) => ({
      model: evo(model, { submission: () => ({ _tag: "SubmitError" as const, message: reason }) }),
    }),
    SelectedLabel: ({ labelId }) => ({
      model: edited(
        evo(model, { maybeLabelId: () => (labelId === "" ? Option.none() : Option.some(labelId)) }),
      ),
    }),
    UpdatedPolicy: ({ value }) => ({
      model: edited(
        evo(model, { maybePolicyId: () => (value === "" ? Option.none() : Option.some(value)) }),
      ),
    }),
    UpdatedOnMatch: ({ value }) => ({
      model: Schema.is(ResultAction)(value) ? edited(evo(model, { onMatch: () => value })) : model,
    }),
    UpdatedOnNoMatch: ({ value }) => ({
      model: Schema.is(ResultAction)(value)
        ? edited(evo(model, { onNoMatch: () => value }))
        : model,
    }),
    UpdatedGroup: ({ value }) => ({ model: edited(evo(model, { group: () => value })) }),
    UpdatedPriority: ({ value }) => ({ model: edited(evo(model, { priority: () => value })) }),
    ToggledEnabled: ({ isChecked }) => ({
      model: edited(evo(model, { enabled: () => isChecked })),
    }),

    MovedGroupRule: ({ ruleId, direction }) => {
      if (
        model.submission._tag === "Submitting" ||
        hasUnsavedChanges(model) ||
        model.identity._tag !== "Existing"
      )
        return { model }
      const members = groupMembers(model)
      const index = members.findIndex((rule) => rule.id === ruleId)
      const neighbor = members[index + (direction === "up" ? -1 : 1)]
      const moving = members[index]
      if (!moving || !neighbor) return { model }
      const operationId = model.nextOperationId
      return {
        model: evo(model, {
          nextOperationId: (id) => id + 1,
          submission: () => ({
            _tag: "Submitting" as const,
            operationId,
            snapshot: snapshot(model),
            submittedPriority: model.priority,
          }),
        }),
        commands: [
          ReorderGroup({
            repositoryId: model.repositoryId,
            group: model.group.trim(),
            operationId,
            rules: members.map((rule) => ({
              id: rule.id,
              version: rule.version,
              priority:
                rule.id === moving.id
                  ? neighbor.priority
                  : rule.id === neighbor.id
                    ? moving.priority
                    : rule.priority,
            })),
          }),
        ],
      }
    },
    SucceededReorderGroup: ({ rules, operationId }) => {
      if (
        model.submission._tag !== "Submitting" ||
        model.submission.operationId !== operationId ||
        model.identity._tag !== "Existing"
      )
        return { model }
      const identity = model.identity
      const current = rules.find((rule) => rule.id === identity.ruleId)
      if (!current) return { model }
      const clean = snapshot(model) === model.submission.snapshot
      const next = evo(model, {
        rules: (existing) =>
          existing.map((rule) => rules.find((updated) => updated.id === rule.id) ?? rule),
        identity: () => ({ ...identity, version: current.version }),
        priority: () =>
          model.submission._tag === "Submitting" &&
          model.priority === model.submission.submittedPriority
            ? String(current.priority)
            : model.priority,
        submission: () => ({ _tag: "NotSubmitted" as const }),
      })
      const saved = clean
        ? snapshot(next)
        : snapshot(
            initialize({
              repositoryId: model.repositoryId,
              labels: model.labels,
              policies: model.policies,
              existing: Option.some(current),
            }),
          )
      return {
        model: evo(next, { savedSnapshot: () => saved }),
        outMessage: OutMessage.Saved({ rule: current, closeEditor: false }),
      }
    },
    ClickedSave: () => {
      if (model.submission._tag === "Submitting" || draftIssues(model).length > 0) return { model }
      if (Option.isNone(model.maybeLabelId) || (!model.ai && Option.isNone(model.maybePolicyId)))
        return { model }
      return {
        model: evo(model, {
          submission: () => ({
            _tag: "Submitting" as const,
            operationId: model.nextOperationId,
            snapshot: snapshot(model),
          }),
          nextOperationId: (id) => id + 1,
        }),
        commands: [
          SaveRule({
            operationId: model.nextOperationId,
            ...(model.creationKey ? { requestId: model.creationKey } : {}),
            repositoryId: model.repositoryId,
            identity: model.identity,
            labelId: model.maybeLabelId.value,
            policyId: Option.getOrElse(model.maybePolicyId, () => ""),
            ...(model.ai
              ? {
                  ai: model.ai,
                  evidence: inspectAiPrompt(model.ai.prompt, model.ai.target, model.catalog)
                    .references,
                }
              : {}),
            onMatch: model.onMatch,
            onNoMatch: model.onNoMatch,
            group: model.group.trim() === "" ? null : model.group.trim(),
            priority: Number(model.priority.trim() === "" ? "0" : model.priority.trim()),
            enabled: model.enabled,
          }),
        ],
      }
    },
    SucceededSaveRule: ({ rule, operationId }) => {
      if (model.submission._tag !== "Submitting" || model.submission.operationId !== operationId)
        return { model }
      const submitted = model.submission.snapshot
      return {
        model: evo(model, {
          identity: () => ({ _tag: "Existing" as const, ruleId: rule.id, version: rule.version }),
          savedSnapshot: () => submitted,
          submission: () => ({ _tag: "NotSubmitted" as const }),
        }),
        outMessage: OutMessage.Saved({ rule, closeEditor: snapshot(model) === submitted }),
      }
    },
    ConflictedSaveRule: ({ rule, operationId }) =>
      model.submission._tag !== "Submitting" || model.submission.operationId !== operationId
        ? { model }
        : {
            model: evo(model, {
              identity: () => ({
                _tag: "Existing" as const,
                ruleId: rule.id,
                version: rule.version,
              }),
              submission: () => ({ _tag: "Conflicted" as const }),
            }),
          },
    RejectedSaveRule: ({ issues, operationId }) =>
      model.submission._tag !== "Submitting" || model.submission.operationId !== operationId
        ? { model }
        : {
            model: evo(model, { submission: () => ({ _tag: "Rejected" as const, issues }) }),
          },
    FailedSaveRule: ({ reason, operationId }) =>
      model.submission._tag !== "Submitting" || model.submission.operationId !== operationId
        ? { model }
        : {
            model: evo(model, {
              submission: () => ({ _tag: "SubmitError" as const, message: reason }),
            }),
            outMessage: OutMessage.SaveFailed({ reason }),
          },
    ToggledGroup: ({ isOpen }) => ({ model: evo(model, { groupOpen: () => isOpen }) }),
    SelectedTestItem: ({ number }) => ({
      model: edited(evo(model, { selectedNumber: () => number })),
    }),
    ClickedTest: () => {
      const item = selectedTestItem(model)
      if (
        !item ||
        (!model.ai && Option.isNone(model.maybePolicyId)) ||
        draftIssues(model).length ||
        model.testResult._tag === "Running"
      )
        return { model }
      const generation = model.testGeneration + 1
      return {
        model: evo(model, {
          testGeneration: () => generation,
          testResult: () => ({
            _tag: "Running" as const,
            status: "submitting" as const,
            elapsedSeconds: 0,
          }),
          inputInspection: () => ({ _tag: "Idle" as const }),
        }),
        commands: [
          TestRule({
            repositoryId: model.repositoryId,
            policyId: Option.getOrElse(model.maybePolicyId, () => ""),
            ...(model.ai
              ? {
                  ai: model.ai,
                  evidence: inspectAiPrompt(model.ai.prompt, model.ai.target, model.catalog)
                    .references,
                }
              : {}),
            number: item.number,
            generation,
          }),
        ],
      }
    },
    RefreshTest: () =>
      model.testResult._tag !== "Running" || !model.liveJob
        ? { model }
        : model.jobLoading
          ? { model: { ...model, jobRefresh: true } }
          : {
              model: { ...model, jobLoading: true },
              commands: [
                PollRuleTest({ repositoryId: model.repositoryId, ...model.liveJob, delayMs: 0 }),
              ],
            },
    QueuedTest: ({
      testId,
      generation,
      polls,
      status,
      startedAt,
      elapsedSeconds,
      pollError,
      progress,
    }) => {
      if (generation !== model.testGeneration || model.testResult._tag !== "Running")
        return { model }
      const phase = model.testResult.status === "running" ? ("running" as const) : status
      const fetchAgain = model.liveJob?.generation !== generation || model.jobRefresh || !!pollError
      return {
        model: evo(model, {
          liveJob: () => ({ testId, generation, polls, startedAt, status: phase }),
          jobLoading: () => fetchAgain,
          jobRefresh: () => false,
          testResult: () => ({
            _tag: "Running" as const,
            status: phase,
            elapsedSeconds,
            ...(pollError ? { pollError } : {}),
            ...(progress ? { progress } : {}),
          }),
        }),
        commands: fetchAgain
          ? [
              PollRuleTest({
                repositoryId: model.repositoryId,
                testId,
                generation,
                polls,
                startedAt,
                status: phase,
                delayMs: pollError ? 10000 : 0,
              }),
            ]
          : [],
      }
    },
    CompletedTest: ({ response, generation, testId }) =>
      generation !== model.testGeneration || model.testResult._tag !== "Running"
        ? { model }
        : {
            model: evo(model, {
              testResult: () => ({
                _tag: "Done" as const,
                response,
                ...(testId ? { testId } : {}),
              }),
            }),
          },
    ClickedInspectInput: () =>
      model.testResult._tag !== "Done" ||
      !model.testResult.testId ||
      model.inputInspection._tag === "Loading" ||
      model.inputInspection._tag === "Ready"
        ? { model }
        : {
            model: evo(model, { inputInspection: () => ({ _tag: "Loading" as const }) }),
            commands: [
              LoadInput({
                repositoryId: model.repositoryId,
                testId: model.testResult.testId,
                generation: model.testGeneration,
              }),
            ],
          },
    LoadedInput: ({ generation, details }) =>
      generation !== model.testGeneration
        ? { model }
        : { model: evo(model, { inputInspection: () => ({ _tag: "Ready" as const, details }) }) },
    FailedInput: ({ generation, reason }) =>
      generation !== model.testGeneration
        ? { model }
        : { model: evo(model, { inputInspection: () => ({ _tag: "Failed" as const, reason }) }) },
    FailedTest: ({ reason, generation }) =>
      generation !== model.testGeneration || model.testResult._tag !== "Running"
        ? { model }
        : { model: evo(model, { testResult: () => ({ _tag: "Failed" as const, reason }) }) },
    GotDeleteDialogMessage: ({ message }) =>
      mapDeleteDialog(model, Dialog.update(model.deleteDialog, message)),
    CancelledDelete: () => mapDeleteDialog(model, Dialog.close(model.deleteDialog)),
    ClickedDelete: () =>
      model.identity._tag === "Existing" && model.submission._tag !== "Submitting"
        ? mapDeleteDialog(model, Dialog.open(model.deleteDialog))
        : { model },
    ConfirmedDelete: () =>
      model.deleteDialog.isOpen &&
      model.identity._tag === "Existing" &&
      model.submission._tag !== "Submitting"
        ? {
            ...mapDeleteDialog(model, Dialog.close(model.deleteDialog)),
            outMessage: OutMessage.RequestedDelete({
              ruleId: model.identity.ruleId,
              version: model.identity.version,
            }),
          }
        : { model },
    ClickedCancel: () =>
      model.submission._tag === "Submitting"
        ? { model }
        : { model, outMessage: OutMessage.Cancelled() },
  })

// VIEW

const groupOrderView = (h: HtmlBuilder<Message>, model: Model): Html => {
  const members = groupMembers(model)
  if (members.length < 2) return h.empty
  const busy =
    model.submission._tag === "Submitting" ||
    hasUnsavedChanges(model) ||
    model.identity._tag !== "Existing"
  return h.div(
    [h.Class("flex flex-col gap-2")],
    [
      h.p(
        [h.Class("text-body-sm text-ink-muted")],
        ["Reorder the saved group. Save any edits first."],
      ),
      ...members.map((rule, index) =>
        h.div(
          [h.Class("flex items-center gap-2 text-body-sm")],
          [
            h.span(
              [h.Class("font-mono text-mono-sm")],
              [
                labelName(model.labels, rule.labelId) +
                  " · " +
                  rule.priority +
                  (rule.enabled ? "" : " · Disabled"),
              ],
            ),
            h.button(
              [
                h.Type("button"),
                h.Disabled(busy || index === 0),
                h.AriaLabel("Move " + labelName(model.labels, rule.labelId) + " up"),
                h.OnClick(Message.MovedGroupRule({ ruleId: rule.id, direction: "up" })),
              ],
              ["Move up"],
            ),
            h.button(
              [
                h.Type("button"),
                h.Disabled(busy || index === members.length - 1),
                h.AriaLabel("Move " + labelName(model.labels, rule.labelId) + " down"),
                h.OnClick(Message.MovedGroupRule({ ruleId: rule.id, direction: "down" })),
              ],
              ["Move down"],
            ),
          ],
        ),
      ),
    ],
  )
}

const selectField = (
  h: HtmlBuilder<Message>,
  config: {
    readonly id: string
    readonly label: string
    readonly value: string
    readonly options: ReadonlyArray<readonly [string, string]>
    readonly onChange: (value: string) => Message
    readonly isLabelHidden?: boolean
  },
): Html =>
  SelectField.view(h, {
    id: config.id,
    label: config.label,
    value: config.value,
    options: config.options,
    onChange: config.onChange,
    ...(config.isLabelHidden === undefined ? {} : { isLabelHidden: config.isLabelHidden }),
  })

const submissionView = (h: HtmlBuilder<Message>, submission: Submission): Html => {
  switch (submission._tag) {
    case "NotSubmitted":
    case "Submitting":
      return h.empty
    case "Conflicted":
      return h.div(
        [h.Class("text-body-sm text-ink-muted"), h.Role("alert")],
        ["Someone changed this rule meanwhile. Saving again writes over their change."],
      )
    case "Rejected":
      return h.ul(
        [h.Class("flex flex-col gap-0.5 text-body-sm text-destructive"), h.Role("alert")],
        submission.issues.map((issue) => h.li([], [issue.message])),
      )
    case "SubmitError":
      return h.div(
        [h.Class("text-body-sm text-destructive"), h.Role("alert")],
        [submission.message],
      )
  }
}

/** A single-rule preview uses a real published policy evaluation, never changes labels. */
export const previewAction = (
  model: Model,
  outcome: Outcome,
  labels: ReadonlyArray<string>,
): string => {
  if (!model.enabled) return "Rule is disabled; labels stay unchanged."
  if (outcome === "not-applicable")
    return "Policy does not apply to this item; labels stay unchanged."
  if (outcome === "unknown") return "Could not determine a match; labels stay unchanged."
  if (outcome === "failed") return "Evaluation failed; labels stay unchanged."
  const present = Option.exists(model.maybeLabelId, (id) => labels.includes(id))
  const name = labelName(
    model.labels,
    Option.getOrElse(model.maybeLabelId, () => ""),
  )
  const action = resultAction(model, outcome)
  if (action === "no-action") return describeResultAction(action)
  const change =
    action === "ensure-present"
      ? present
        ? "Already present"
        : "Add label"
      : present
        ? "Remove label"
        : "Already absent"
  return `${describeResultAction(action)}: ${name} · ${change}`
}

const outcomeHeadline = (
  outcome: Outcome,
  reason: string | undefined,
  reasonCode: string | undefined,
): string =>
  reason?.startsWith("Skipped by gate:")
    ? "Skipped by gate"
    : reason?.startsWith("Gate unresolved:")
      ? "Gate unresolved · AI skipped"
      : outcome === "unknown" && reasonCode
        ? ["insufficient-evidence", "low-confidence"].includes(reasonCode)
          ? "Insufficient evidence"
          : "Could not evaluate"
        : describeOutcome(outcome)

/** The Janitor evaluated the rule against one item: everything here is its output. */
const testResultView = (h: HtmlBuilder<Message>, model: Model): Html => {
  const result = model.testResult
  if (result._tag === "Idle") return h.empty
  if (result._tag === "Running")
    return h.p(
      [h.Role("status"), h.Class("flex flex-col gap-0.5 text-body-sm text-ink-muted")],
      [
        h.span(
          [h.Class("font-medium text-foreground")],
          [
            "Testing… ",
            { submitting: "Submitting", queued: "Queued", running: "Evaluating" }[result.status] +
              (result.elapsedSeconds >= 5 ? ` · ${result.elapsedSeconds}s` : ""),
          ],
        ),
        result.progress ? h.span([], [result.progress]) : h.empty,
        result.pollError
          ? h.span([], ["Unable to check progress. Retrying the same test…"])
          : result.status === "queued" && result.elapsedSeconds >= 5
            ? h.span([], ["Waiting for an evaluation slot."])
            : h.empty,
      ],
    )
  if (result._tag === "Failed")
    return h.p([h.Role("alert"), h.Class("text-body-sm text-destructive")], [result.reason])
  if (result.response._tag === "Rejected")
    return h.p(
      [h.Role("alert"), h.Class("text-body-sm text-destructive")],
      [result.response.message],
    )
  const entity = result.response.entities[0]
  if (!entity)
    return h.p(
      [h.Class("text-body-sm text-ink-muted")],
      ["This item is no longer available. Choose another item."],
    )
  const outcome = entity.evaluation?.outcome ?? "unknown"
  return h.div(
    [
      h.Class(
        "oc-agent-edge flex flex-col gap-2 border border-border bg-card py-2 pr-3 pl-2.5 text-body-sm",
      ),
      h.DataAttribute("outcome", outcome),
    ],
    [
      h.div(
        [h.Class("flex items-center justify-between gap-3")],
        [
          h.div(
            [h.Class("flex items-center gap-2")],
            [
              Feed.agentBadge(h),
              chip(h, {
                variant:
                  outcome === "match" ? "success" : outcome === "failed" ? "danger" : "neutral",
                children: [
                  outcomeHeadline(
                    outcome,
                    entity.evaluation?.reason,
                    entity.evaluation?.reasonCode,
                  ),
                ],
              }),
            ],
          ),
          h.span([h.Class("font-mono text-mono-xs text-ink-subtle")], [`#${entity.number}`]),
        ],
      ),
      entity.evaluation?.cached && !entity.evaluation.inputReport
        ? h.p([h.Class("text-ink-muted")], ["Input details unavailable for this earlier result."])
        : aiInputView(
            h,
            entity.evaluation?.inputReport,
            model.inputInspection,
            Message.ClickedInspectInput(),
            !!result.testId,
          ),
      entity.evaluation?.reason
        ? h.p([h.Class("text-ink-muted")], [entity.evaluation.reason])
        : h.empty,
      entity.evaluation?.confidence !== undefined
        ? h.p(
            [h.Class("font-mono text-mono-sm text-ink-muted")],
            [
              `confidence ${Math.round(entity.evaluation.confidence * 100)}%${entity.evaluation.cached ? " · cached" : ""}`,
            ],
          )
        : h.empty,
      (entity.evaluation?.trace ?? []).length === 0
        ? h.empty
        : h.ul(
            [h.Class("flex flex-col gap-0.5 font-mono text-mono-sm text-ink-muted")],
            (entity.evaluation?.trace ?? []).map((node) =>
              h.li(
                [h.Class("flex justify-between gap-3")],
                [
                  h.span([h.Class("min-w-0 truncate")], [node.reason]),
                  h.span(
                    [h.AriaLabel(describeOutcome(node.outcome)), h.Class("shrink-0")],
                    [node.outcome === "match" ? "✓" : node.outcome === "no-match" ? "−" : "?"],
                  ),
                ],
              ),
            ),
          ),
      h.p(
        [h.Class("border-t border-border-subtle pt-2 text-foreground")],
        [previewAction(model, outcome, entity.labels)],
      ),
      model.group.trim()
        ? h.p(
            [h.Class("text-ink-muted")],
            [
              "Single-rule preview. Other rules in this exclusive group may change the final result.",
            ],
          )
        : h.empty,
    ],
  )
}

const actionOptions = ResultAction.literals.map(
  (action) => [action, describeResultAction(action)] as const,
)

/** The rule as a blueprint: what the agent watches, what must hold, what it
 *  does. Nodes carry the form controls; the layout is a fixed three-column
 *  chain, which is the only graph shape a rule can take today. */
const ruleGraph = (h: HtmlBuilder<Message>, model: Model): Html => {
  const policy = selectedPolicy(model)
  const ai = model.ai
  const labelOptions: ReadonlyArray<readonly [string, string]> = [
    ["", "Choose a label…"],
    ...model.labels
      .filter(
        (label) =>
          label.availability !== "unavailable" ||
          Option.contains(model.maybeLabelId, label.labelId),
      )
      .map(
        (label) =>
          [
            label.labelId,
            `${label.name}${label.availability === "unavailable" ? " (unavailable)" : ""}`,
          ] as const,
      ),
  ]
  const whenNodes = ai
    ? [
        Blueprint.node(h, {
          kind: "Applies to",
          children: [
            selectField(h, {
              id: "ai-target",
              label: "Applies to",
              isLabelHidden: true,
              value: ai.target,
              options: [
                ["pull_request", "Pull requests"],
                ["issue", "Issues"],
              ],
              onChange: (value) => Message.SelectedTarget({ value }),
            }),
          ],
        }),
        Blueprint.node(h, {
          kind: "Gate policy",
          children: [
            selectField(h, {
              id: "ai-gate",
              label: "Gate policy",
              isLabelHidden: true,
              value: ai.gatePolicyId ?? "",
              options: [
                ["", "No gate · always evaluate"],
                ...model.policies
                  .filter(
                    (p) =>
                      p.publishedVersionId !== null &&
                      p.target === ai.target &&
                      p.publishedEvaluator === "Conditions",
                  )
                  .map((p) => [p.policyId, p.name] as const),
              ],
              onChange: (value) => Message.SelectedGate({ value }),
            }),
            h.p(
              [h.Class("font-sans text-body-sm text-ink-muted")],
              ["AI runs only when this policy matches. Otherwise, labels stay unchanged."],
            ),
          ],
        }),
      ]
    : [
        Blueprint.node(h, {
          kind: "Policy matches",
          children: [
            selectField(h, {
              id: "rule-policy",
              label: "When policy matches",
              isLabelHidden: true,
              value: Option.getOrElse(model.maybePolicyId, () => ""),
              options: [
                ["", "Choose a published policy…"],
                ...publishedPolicies(model).map(
                  (policy) => [policy.policyId, policy.name] as const,
                ),
              ],
              onChange: (value) => Message.UpdatedPolicy({ value }),
            }),
            policy
              ? h.p(
                  [h.Class("text-ink-muted")],
                  [
                    `${policy.target === "issue" ? "issues" : "pull_requests"} · published v${policy.publishedRevision}`,
                  ],
                )
              : h.empty,
            policy?.description
              ? h.p([h.Class("font-sans text-body-sm text-ink-muted")], [policy.description])
              : h.empty,
          ],
        }),
      ]
  const conditionNodes = ai
    ? [
        Blueprint.node(h, {
          kind: "Classification",
          isAgent: true,
          className: "w-80",
          children: [
            h.div(
              [h.Class("flex justify-between font-sans text-caption text-ink-subtle")],
              [
                h.label([h.For("ai-prompt")], ["Instructions"]),
                h.span([h.Class("font-mono text-mono-xs")], [`${ai.prompt.length} / 4,000`]),
              ],
            ),
            h.div(
              [
                h.Id("ai-prompt"),
                h.DataAttribute("target", ai.target),
                h.DataAttribute("catalog", JSON.stringify(model.catalog)),
                h.Class(
                  "overflow-hidden rounded-xs border border-border transition-colors duration-120 ease-ui focus-within:border-primary focus-within:outline-2 focus-within:outline-ring focus-within:outline-offset-1",
                ),
                h.OnMount(MountAiPrompt({ source: ai.prompt, catalog: model.catalog })),
              ],
              [],
            ),
            h.p(
              [h.Class("font-sans text-body-sm text-ink-muted")],
              ["Type {{ to reference a fact. Only referenced facts are used as evidence."],
            ),
            h.div(
              [
                h.Class(
                  "flex items-center justify-between gap-3 border-t border-border-subtle pt-2 font-sans",
                ),
              ],
              [
                h.label(
                  [h.For("ai-confidence"), h.Class("text-label font-medium")],
                  ["Minimum confidence"],
                ),
                h.span(
                  [h.Class("font-mono text-numeral font-medium tabular-nums")],
                  [`${Math.round(ai.minimumConfidence * 100)}%`],
                ),
              ],
            ),
            h.input([
              h.Id("ai-confidence"),
              h.Type("range"),
              h.Min("0"),
              h.Max("100"),
              h.Step("5"),
              h.Value(String(ai.minimumConfidence * 100)),
              h.Class("ai-confidence w-full"),
              h.OnInput((value) => Message.ChangedConfidence({ value })),
            ]),
            h.div(
              [h.Class("flex items-center justify-between gap-2 font-sans")],
              [
                h.span(
                  [h.Class("text-body-sm text-ink-muted")],
                  ["Below this score, use the non-match action."],
                ),
                h.div(
                  [h.Class("flex gap-1")],
                  [70, 80, 95].map((value) =>
                    Button.view(h, {
                      variant: "secondary",
                      size: "xs",
                      className:
                        ai.minimumConfidence * 100 === value ? "bg-primary-wash" : undefined,
                      label: `${value}%`,
                      onClick: Message.ChangedConfidence({ value: String(value) }),
                      attributes: [
                        h.Attribute("aria-pressed", String(ai.minimumConfidence * 100 === value)),
                      ],
                    }),
                  ),
                ),
              ],
            ),
          ],
        }),
      ]
    : [
        Blueprint.node(h, {
          kind: "GitHub label",
          children: [
            selectField(h, {
              id: "rule-label",
              label: "GitHub label",
              isLabelHidden: true,
              value: Option.getOrElse(model.maybeLabelId, () => ""),
              options: labelOptions,
              onChange: (labelId) => Message.SelectedLabel({ labelId }),
            }),
            model.labels.length === 0
              ? h.p(
                  [h.Class("font-sans text-body-sm text-ink-muted")],
                  ["No labels synchronized yet."],
                )
              : h.empty,
          ],
        }),
      ]
  const thenNodes = [
    ...(ai
      ? [
          Blueprint.node(h, {
            kind: "GitHub label",
            children: [
              selectField(h, {
                id: "ai-label",
                label: "GitHub label",
                isLabelHidden: true,
                value: Option.getOrElse(model.maybeLabelId, () => ""),
                options: labelOptions,
                onChange: (labelId) => Message.SelectedLabel({ labelId }),
              }),
            ],
          }),
        ]
      : []),
    Blueprint.node(h, {
      kind: "On match",
      children: [
        selectField(h, {
          id: "rule-on-match",
          label: "When it matches",
          isLabelHidden: true,
          value: model.onMatch,
          options: actionOptions,
          onChange: (value) => Message.UpdatedOnMatch({ value }),
        }),
      ],
    }),
    Blueprint.node(h, {
      kind: "On no match",
      children: [
        selectField(h, {
          id: "rule-on-no-match",
          label: "When it does not match",
          isLabelHidden: true,
          value: model.onNoMatch,
          options: actionOptions,
          onChange: (value) => Message.UpdatedOnNoMatch({ value }),
        }),
      ],
    }),
  ]
  const nodeCount = whenNodes.length + conditionNodes.length + thenNodes.length
  return panel(h, {
    flush: true,
    children: [
      panelHeader(h, {
        title: "Rule graph",
        meta: ai ? "ai rule" : "policy rule",
      }),
      Blueprint.canvas(h, {
        children: [
          Blueprint.column(h, { label: "When", children: whenNodes }),
          Blueprint.wire(h, { label: ai ? "gate" : "evaluate" }),
          Blueprint.column(h, {
            label: ai ? "If The Janitor classifies it" : "If every condition matches",
            ...(ai ? { className: "w-80" } : {}),
            children: conditionNodes,
          }),
          Blueprint.wire(h, {
            paths: [
              { fromY: 24, toY: ai ? 24 : 24, label: "match" },
              { fromY: 24, toY: ai ? 138 : 82, label: "no match" },
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

export type ViewInputs = { readonly isDeleting?: boolean }
export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, { isDeleting = false }, h): Html => {
    const issues = draftIssues(model)
    const busy = model.submission._tag === "Submitting" || isDeleting
    const dirty = model.identity._tag === "New" || hasUnsavedChanges(model)
    const policy = selectedPolicy(model)
    const label = model.labels.find((label) => Option.contains(model.maybeLabelId, label.labelId))
    return h.div(
      [
        h.Class("flex min-w-0 flex-1 flex-col"),
        h.DataAttribute("editor", "rule"),
        ...(model.identity._tag === "New" ? [h.OnMount(PrepareCreation({}))] : []),
      ],
      [
        h.header(
          [h.Class("flex h-9 items-center gap-3 border-b border-border bg-card px-4")],
          [
            Button.view(h, {
              variant: "ghost",
              size: "sm",
              onClick: Message.ClickedCancel(),
              isDisabled: busy,
              label: h.span([h.Class("contents")], [Icon.view(h, ArrowLeft), "Back to rules"]),
            }),
            h.div(
              [h.Class("ml-auto")],
              [
                SwitchControl.view(h, {
                  id: "rule-enabled",
                  label: "Enable",
                  isChecked: model.enabled,
                  isDisabled: busy,
                  onToggle: (isChecked) => Message.ToggledEnabled({ isChecked }),
                }),
              ],
            ),
          ],
        ),
        h.div(
          [h.Class("rule-editor-workspace")],
          [
            h.article(
              [h.Class("flex min-w-0 flex-col gap-4 p-4 lg:p-5")],
              [
                h.header(
                  [h.Class("flex flex-col gap-1")],
                  [
                    h.h1([h.Class("font-mono")], [label?.name ?? "New rule"]),
                    h.p(
                      [h.Class("text-body-sm text-ink-muted")],
                      [
                        model.ai
                          ? "The Janitor uses the referenced facts to decide whether this label applies."
                          : policy && label
                            ? `Manage ${label.name} on ${policy.target === "issue" ? "issues" : "pull requests"} using ${policy.name}.`
                            : "Choose a published policy and the label it manages.",
                      ],
                    ),
                  ],
                ),
                model.identity._tag === "New"
                  ? h.div(
                      [h.Class("max-w-xs")],
                      [
                        selectField(h, {
                          id: "rule-type",
                          label: "Rule type",
                          value: model.ai ? "ai" : "policy",
                          options: [
                            ["policy", "Policy"],
                            ["ai", "AI"],
                          ],
                          onChange: (value) => Message.SelectedType({ value }),
                        }),
                      ],
                    )
                  : h.empty,
                ruleGraph(h, model),
                h.p(
                  [h.Class("text-body-sm text-ink-muted")],
                  [
                    "Ensure present restores manually removed labels. Ensure absent removes manually added labels. Take no action makes no label request.",
                  ],
                ),
                Disclosure.view(
                  {
                    id: "rule-grouping",
                    isOpen: model.groupOpen,
                    onToggle: (isOpen) => Message.ToggledGroup({ isOpen }),
                    toView: ({ button, panel: panelAttributes }) =>
                      h.section(
                        [
                          h.Class("rounded-md border border-border bg-card"),
                          h.DataAttribute("slot", "card"),
                        ],
                        [
                          h.button(
                            [
                              ...button,
                              h.Class(
                                "flex w-full items-center gap-2 px-3 py-2 text-left text-body-md hover:bg-surface-muted",
                              ),
                            ],
                            [
                              Icon.view(
                                h,
                                ChevronRight,
                                cn("size-3.5 text-ink-subtle", model.groupOpen && "rotate-90"),
                              ),
                              h.span([h.Class("font-medium")], ["Exclusive group"]),
                              h.span(
                                [h.Class("ml-auto font-mono text-mono-sm text-ink-subtle")],
                                [model.group.trim() || "none"],
                              ),
                            ],
                          ),
                          model.groupOpen
                            ? h.div(
                                [
                                  ...panelAttributes,
                                  h.Class(
                                    "flex max-w-md flex-col gap-3 border-t border-border-subtle px-3 py-3",
                                  ),
                                ],
                                [
                                  input(h, {
                                    id: "rule-group",
                                    label: "Group",
                                    value: model.group,
                                    placeholder: "optional",
                                    className: "font-mono",
                                    onInput: (value) => Message.UpdatedGroup({ value }),
                                  }),
                                  groupOrderView(h, model),
                                  input(h, {
                                    id: "rule-priority",
                                    label: "Priority",
                                    value: model.priority,
                                    type: "number",
                                    className: "font-mono",
                                    onInput: (value) => Message.UpdatedPriority({ value }),
                                    description:
                                      "Larger priorities take precedence. The group keeps only the highest-priority label requesting presence and removes all other group labels, including disabled rules.",
                                  }),
                                ],
                              )
                            : h.empty,
                        ],
                      ),
                  },
                  h,
                ),
                submissionView(h, model.submission),
                issues.length
                  ? h.p(
                      [h.Class("text-body-sm text-destructive"), h.Role("status")],
                      [issues.join(". ")],
                    )
                  : h.empty,
              ],
            ),
            h.aside(
              [
                h.Class("flex min-w-0 flex-col border-border bg-card"),
                h.DataAttribute("slot", "inspector"),
                h.AriaLabel("Rule controls and testing"),
              ],
              [
                dirty
                  ? h.section(
                      [h.DataAttribute("slot", "inspector-section")],
                      [
                        h.h3([h.DataAttribute("slot", "inspector-heading")], ["Changes"]),
                        h.div(
                          [h.Class("flex gap-2")],
                          [
                            Button.view(h, {
                              size: "sm",
                              className: "flex-1",
                              onClick: Message.ClickedSave(),
                              isDisabled: issues.length > 0 || busy,
                              label: busy
                                ? "Saving…"
                                : model.identity._tag === "New"
                                  ? "Create rule"
                                  : "Save changes",
                              attributes: [h.DataAttribute("action", "save")],
                            }),
                            Button.view(h, {
                              size: "sm",
                              variant: "secondary",
                              onClick: Message.ClickedCancel(),
                              isDisabled: busy,
                              label: "Cancel",
                            }),
                          ],
                        ),
                      ],
                    )
                  : h.empty,
                h.section(
                  [h.DataAttribute("slot", "inspector-section")],
                  [
                    h.h3([h.DataAttribute("slot", "inspector-heading")], ["Test bench"]),
                    h.div(
                      [h.Class("flex flex-col gap-3")],
                      [
                        model.testCandidates._tag === "Failed"
                          ? h.p(
                              [h.Class("text-body-sm text-destructive")],
                              ["Could not load test items. Retrying on the next refresh."],
                            )
                          : testItems(model).length === 0
                            ? h.p(
                                [h.Class("text-body-sm text-ink-muted")],
                                [
                                  policy || model.ai
                                    ? "No open items are available for this policy."
                                    : "Select a policy to choose a test item.",
                                ],
                              )
                            : selectField(h, {
                                id: "rule-test-item",
                                label:
                                  (model.ai?.target ?? policy?.target) === "issue"
                                    ? "Issue"
                                    : "Pull request",
                                value: String(selectedTestItem(model)?.number ?? ""),
                                options: testItems(model).map((item) => [
                                  String(item.number),
                                  `#${item.number} · ${item.title}`,
                                ]),
                                onChange: (value) =>
                                  Message.SelectedTestItem({ number: Number(value) }),
                              }),
                        Button.view(h, {
                          variant: "secondary",
                          size: "sm",
                          className: "self-start",
                          onClick: Message.ClickedTest(),
                          isDisabled:
                            issues.length > 0 ||
                            !selectedTestItem(model) ||
                            model.testResult._tag === "Running",
                          label: h.span(
                            [h.Class("contents")],
                            [Icon.view(h, Play), "Run as a test"],
                          ),
                        }),
                        testResultView(h, model),
                      ],
                    ),
                  ],
                ),
                model.identity._tag === "Existing"
                  ? h.section(
                      [h.DataAttribute("slot", "inspector-section")],
                      [
                        h.h3([h.DataAttribute("slot", "inspector-heading")], ["Delete"]),
                        Button.view(h, {
                          variant: "destructive",
                          size: "sm",
                          onClick: Message.ClickedDelete(),
                          isDisabled: busy,
                          label: h.span(
                            [h.Class("contents")],
                            [Icon.view(h, Trash2), isDeleting ? "Deleting rule…" : "Delete rule"],
                          ),
                          attributes: [h.DataAttribute("action", "delete-rule")],
                        }),
                      ],
                    )
                  : h.empty,
              ],
            ),
          ],
        ),
        h.submodel({
          slotId: "delete-rule-dialog",
          model: model.deleteDialog,
          view: Dialog.view,
          toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
          viewInputs: {
            toView: (render) =>
              DialogChrome.view(h, {
                dialog: render.dialog,
                backdrop: render.backdrop,
                panel: render.panel,
                title: render.title,
                description: render.description,
                isVisible: render.isVisible,
                titleText: "Delete rule?",
                descriptionText:
                  'Delete "' + (label?.name ?? "this rule") + '"? This cannot be undone.',
                actions: [
                  Button.view(h, {
                    label: "Cancel",
                    variant: "secondary",
                    attributes: [h.Id("cancel-delete-rule")],
                    onClick: Message.CancelledDelete(),
                  }),
                  Button.view(h, {
                    label: "Delete rule",
                    variant: "destructive",
                    isDisabled: busy,
                    onClick: Message.ConfirmedDelete(),
                  }),
                ],
              }),
          },
        }),
      ],
    )
  },
)

export const reflectConfiguration = (
  model: Model,
  configuration: ConfigurationView,
  testCandidates?: TestCandidates,
): Model => {
  const next = evo(model, {
    labels: () => configuration.labels,
    policies: () => configuration.policies,
    rules: () => configuration.rules,
    testCandidates: () => testCandidates ?? model.testCandidates,
  })
  const changed =
    selectedPolicy(model)?.publishedVersionId !== selectedPolicy(next)?.publishedVersionId ||
    selectedTestItem(model)?.number !== selectedTestItem(next)?.number
  return changed
    ? evo(next, { testResult: () => ({ _tag: "Idle" as const }), testGeneration: (id) => id + 1 })
    : next
}

const MountAiPrompt = Mount.defineStream("MountAiPrompt", {
  args: { source: Schema.String, catalog: Schema.Array(FactDescription) },
  messages: [Message.EditedPrompt, Message.FailedPromptEditor],
  execute: ({ element, source, catalog }) =>
    Stream.callback((queue) =>
      Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            if (!(element instanceof HTMLElement)) throw new Error("AI editor host unavailable")
            const { createAiPromptEditor } = await import("./policy-source/ai-editor")
            return createAiPromptEditor(element, source, catalog, (value) =>
              Queue.offerUnsafe(queue, Message.EditedPrompt({ value })),
            )
          },
          catch: (error) => String(error),
        }),
        (editor) => Effect.sync(() => editor.destroy()),
      ).pipe(
        Effect.flatMap(() => Effect.never),
        Effect.catch((reason) =>
          Effect.sync(() => {
            Queue.offerUnsafe(queue, Message.FailedPromptEditor({ reason }))
          }),
        ),
      ),
    ),
})
const RuleTestJob = Schema.Struct({
  testId: Schema.String,
  status: Schema.Literals(["queued", "running", "done", "failed"]),
  response: Schema.NullOr(TestResponse),
  message: Schema.NullOr(Schema.String),
})
const testJobMessage = (
  job: typeof RuleTestJob.Type,
  generation: number,
  startedAt: number,
  polls: number,
  now: number,
) => {
  if (job.status === "done" && job.response)
    return Message.CompletedTest({ generation, response: job.response, testId: job.testId })
  if (job.status === "failed")
    return Message.FailedTest({ generation, reason: job.message ?? "Test failed" })
  if (job.status === "done")
    return Message.FailedTest({
      generation,
      reason: "The completed test has no result. Run it again.",
    })
  return Message.QueuedTest({
    testId: job.testId,
    generation,
    status: job.status,
    startedAt,
    polls,
    elapsedSeconds: Math.floor((now - startedAt) / 1000),
    ...(job.message ? { progress: job.message } : {}),
  })
}
export const PollRuleTest = FoldkitCommand.define("PollRuleTest", {
  args: {
    delayMs: Schema.Number,
    repositoryId: Schema.String,
    testId: Schema.String,
    generation: Schema.Int,
    polls: Schema.Int,
    startedAt: Schema.Number,
    status: Schema.Literals(["queued", "running"]),
  },
  messages: [Message.QueuedTest, Message.CompletedTest, Message.FailedTest],
  execute: ({ repositoryId, testId, generation, polls, startedAt, status, delayMs }) =>
    Effect.gen(function* () {
      if (delayMs > 0) yield* Effect.sleep(delayMs)
      if ((yield* Clock.currentTimeMillis) - startedAt >= 240_000)
        return Message.FailedTest({ generation, reason: "The test timed out. Run it again." })

      const response = yield* HttpClient.get(
        testEndpoint(repositoryId).replace(/\/test$/, "/rule-tests/") + encodeURIComponent(testId),
      ).pipe(Effect.timeout("10 seconds"))
      if (response.status >= 500 || response.status === 429)
        return Message.QueuedTest({
          testId,
          generation,
          status,
          startedAt,
          polls: polls + 1,
          elapsedSeconds: Math.floor(((yield* Clock.currentTimeMillis) - startedAt) / 1000),
          pollError: "temporarily unavailable",
        })
      if (response.status !== 200)
        return Message.FailedTest({
          generation,
          reason:
            response.status === 404
              ? "The test expired or is unavailable. Run it again."
              : "Unable to read this test. Check repository access.",
        })
      const job = yield* HttpIncomingMessage.schemaBodyJson(RuleTestJob)(response)
      return testJobMessage(job, generation, startedAt, polls + 1, yield* Clock.currentTimeMillis)
    }).pipe(
      Effect.timeout("20 seconds"),
      Effect.catch(() =>
        Effect.map(Clock.currentTimeMillis, (now) =>
          Message.QueuedTest({
            testId,
            generation,
            status,
            startedAt,
            polls: polls + 1,
            elapsedSeconds: Math.floor((now - startedAt) / 1000),
            pollError: "connection interrupted",
          }),
        ),
      ),
    ),
})
export const LoadInput = FoldkitCommand.define("LoadRuleTestInput", {
  args: { repositoryId: Schema.String, testId: Schema.String, generation: Schema.Int },
  messages: [Message.LoadedInput, Message.FailedInput],
  execute: ({ repositoryId, testId, generation }) =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(
        testEndpoint(repositoryId).replace(/\/test$/, "/rule-tests/") +
          encodeURIComponent(testId) +
          "/input",
      )
      if (response.status !== 200)
        return Message.FailedInput({
          generation,
          reason:
            response.status === 404
              ? "Input details expired or are unavailable. Run the test again to inspect a new snapshot."
              : "Unable to load input details. Try again.",
        })
      const details = yield* HttpIncomingMessage.schemaBodyJson(AiInputDetails)(response)
      return Message.LoadedInput({ generation, details })
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.catch(() =>
        Effect.succeed(
          Message.FailedInput({ generation, reason: "Unable to load input details. Try again." }),
        ),
      ),
    ),
})

const PrepareCreation = Mount.defineStream("PrepareRuleCreation", {
  args: {},
  messages: [Message.PreparedCreation],
  execute: () =>
    Stream.fromEffect(Effect.sync(() => Message.PreparedCreation({ key: crypto.randomUUID() }))),
})
