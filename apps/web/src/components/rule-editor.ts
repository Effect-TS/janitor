import * as Switch from "@foldkit/ui/switch"
import * as Disclosure from "@foldkit/ui/disclosure"
import * as Select from "@foldkit/ui/select"
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
import { ArrowLeft, ChevronRight, FileCode2, Tag, Play, Trash2 } from "lucide"
import * as Button from "@/components/ui/button"
import { input, inputClass } from "@/components/ui/input"
import {
  ConfigurationView,
  OnNoMatch,
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
  Schema.TaggedStruct("Submitting", { operationId: Schema.Int, snapshot: Schema.String }),
  Schema.TaggedStruct("Conflicted", {}),
  Schema.TaggedStruct("Rejected", { issues: Schema.Array(RuleIssue) }),
  Schema.TaggedStruct("SubmitError", { message: Schema.String }),
])
export type Submission = typeof Submission.Type

export const Model = Schema.Struct({
  repositoryId: Schema.String,
  identity: Identity,
  maybeLabelId: Schema.Option(Schema.String),
  maybePolicyId: Schema.Option(Schema.String),
  onNoMatch: OnNoMatch,
  group: Schema.String,
  priority: Schema.String,
  enabled: Schema.Boolean,
  labels: Schema.Array(SynchronizedLabel),
  policies: Schema.Array(PolicyRecord),
  submission: Submission,
  nextOperationId: Schema.Int,
  savedSnapshot: Schema.String,
  testCandidates: TestCandidates,
  selectedNumber: Schema.NullOr(Schema.Int),
  testGeneration: Schema.Int,
  testResult: Schema.Union([
    Schema.TaggedStruct("Idle", {}),
    Schema.TaggedStruct("Running", {}),
    Schema.TaggedStruct("Done", { response: TestResponse }),
    Schema.TaggedStruct("Failed", { reason: Schema.String }),
  ]),
  groupOpen: Schema.Boolean,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SelectedLabel: { labelId: Schema.String },
  UpdatedPolicy: { value: Schema.String },
  UpdatedOnNoMatch: { value: Schema.String },
  UpdatedGroup: { value: Schema.String },
  UpdatedPriority: { value: Schema.String },
  ToggledEnabled: { isChecked: Schema.Boolean },
  ClickedSave: {},
  SucceededSaveRule: { rule: RuleRecord, operationId: Schema.Int },
  ConflictedSaveRule: { rule: RuleRecord, operationId: Schema.Int },
  RejectedSaveRule: { issues: Schema.Array(RuleIssue), operationId: Schema.Int },
  FailedSaveRule: { reason: Schema.String, operationId: Schema.Int },
  ClickedCancel: {},
  ClickedDelete: {},
  ToggledGroup: { isOpen: Schema.Boolean },
  SelectedTestItem: { number: Schema.Int },
  ClickedTest: {},
  CompletedTest: { response: TestResponse, generation: Schema.Int },
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
  ...(Option.isNone(model.maybeLabelId) ? ["Pick a label"] : []),
  ...(!model.policies.some(
    (policy) =>
      Option.contains(model.maybePolicyId, policy.policyId) && policy.publishedVersionId !== null,
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
  (!/^-?\d+$/.test(model.priority.trim()) || !Number.isSafeInteger(Number(model.priority)))
    ? ["Priority must be a whole number"]
    : []),
]

const publishedPolicies = (model: Model) =>
  model.policies.filter((policy) => policy.publishedVersionId !== null)

// COMMAND

const describe = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error)

const IssuesBody = Schema.Struct({ issues: Schema.Array(RuleIssue) })

const Payload = {
  operationId: Schema.Int,
  repositoryId: Schema.String,
  identity: Identity,
  labelId: Schema.String,
  policyId: Schema.String,
  onNoMatch: OnNoMatch,
  group: Schema.NullOr(Schema.String),
  priority: Schema.Int,
  enabled: Schema.Boolean,
}

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
    repositoryId,
    identity,
    labelId,
    policyId,
    onNoMatch,
    group,
    priority,
    enabled,
  }) =>
    Effect.gen(function* () {
      const fields = { labelId, policyId, onNoMatch, group, priority, enabled }
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
    repositoryId: Schema.String,
    policyId: Schema.String,
    number: Schema.Int,
    generation: Schema.Int,
  },
  messages: [Message.CompletedTest, Message.FailedTest],
  execute: ({ repositoryId, policyId, number, generation }) =>
    Effect.gen(function* () {
      const request = yield* HttpClientRequest.bodyJson(
        HttpClientRequest.post(testEndpoint(repositoryId)),
        { subject: { _tag: "Policy", policyId }, numbers: [number] },
      )
      const response = yield* HttpClient.execute(request)
      if (response.status !== 200)
        return Message.FailedTest({ reason: `Server answered ${response.status}`, generation })
      return Message.CompletedTest({
        response: yield* HttpIncomingMessage.schemaBodyJson(TestResponse)(response),
        generation,
      })
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(Message.FailedTest({ reason: describe(error), generation })),
      ),
    ),
})
const selectedPolicy = (model: Model) =>
  model.policies.find((policy) => Option.contains(model.maybePolicyId, policy.policyId))
export const testItems = (model: Model) =>
  model.testCandidates._tag === "Ready"
    ? model.testCandidates.items.filter((item) => item.kind === selectedPolicy(model)?.target)
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
  readonly labels: ReadonlyArray<SynchronizedLabel>
  readonly policies: ReadonlyArray<PolicyRecord>
  readonly testCandidates?: TestCandidates | undefined
  readonly existing: Option.Option<RuleRecord>
}): Model =>
  Model.make(
    {
      repositoryId: input.repositoryId,
      identity: Option.match(input.existing, {
        onNone: () => ({ _tag: "New" as const }),
        onSome: (rule) => ({ _tag: "Existing" as const, ruleId: rule.id, version: rule.version }),
      }),
      maybeLabelId: Option.map(input.existing, (rule) => rule.labelId),
      maybePolicyId: Option.map(input.existing, (rule) => rule.policyId),
      onNoMatch: Option.map(input.existing, (rule) => rule.onNoMatch).pipe(
        Option.getOrElse((): OnNoMatch => "ensure-absent"),
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
      submission: { _tag: "NotSubmitted" },
      nextOperationId: 1,
      savedSnapshot: "",
      testCandidates: input.testCandidates ?? { _tag: "Ready", items: [] },
      selectedNumber: null,
      testGeneration: 0,
      testResult: { _tag: "Idle" },
      groupOpen: Option.exists(input.existing, (rule) => rule.group !== null),
    },
    { disableChecks: true },
  )

// UPDATE

const snapshot = (model: Model): string =>
  JSON.stringify([
    Option.getOrNull(model.maybeLabelId),
    Option.getOrNull(model.maybePolicyId),
    model.onNoMatch,
    model.group,
    model.priority,
    model.enabled,
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
    testGeneration: (id) => id + 1,
    submission: (current) =>
      current._tag === "Submitting" ? current : { _tag: "NotSubmitted" as const },
  })

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
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
    UpdatedOnNoMatch: ({ value }) => ({
      model: edited(
        evo(model, { onNoMatch: () => (value === "preserve" ? "preserve" : "ensure-absent") }),
      ),
    }),
    UpdatedGroup: ({ value }) => ({ model: edited(evo(model, { group: () => value })) }),
    UpdatedPriority: ({ value }) => ({ model: edited(evo(model, { priority: () => value })) }),
    ToggledEnabled: ({ isChecked }) => ({
      model: edited(evo(model, { enabled: () => isChecked })),
    }),

    ClickedSave: () => {
      if (model.submission._tag === "Submitting" || draftIssues(model).length > 0) return { model }
      if (Option.isNone(model.maybeLabelId) || Option.isNone(model.maybePolicyId)) return { model }
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
            repositoryId: model.repositoryId,
            identity: model.identity,
            labelId: model.maybeLabelId.value,
            policyId: model.maybePolicyId.value,
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
        Option.isNone(model.maybePolicyId) ||
        draftIssues(model).length ||
        model.testResult._tag === "Running"
      )
        return { model }
      const generation = model.testGeneration + 1
      return {
        model: evo(model, {
          testGeneration: () => generation,
          testResult: () => ({ _tag: "Running" as const }),
        }),
        commands: [
          TestRule({
            repositoryId: model.repositoryId,
            policyId: model.maybePolicyId.value,
            number: item.number,
            generation,
          }),
        ],
      }
    },
    CompletedTest: ({ response, generation }) =>
      generation !== model.testGeneration
        ? { model }
        : { model: evo(model, { testResult: () => ({ _tag: "Done" as const, response }) }) },
    FailedTest: ({ reason, generation }) =>
      generation !== model.testGeneration
        ? { model }
        : { model: evo(model, { testResult: () => ({ _tag: "Failed" as const, reason }) }) },
    ClickedDelete: () =>
      model.identity._tag === "Existing" && model.submission._tag !== "Submitting"
        ? {
            model,
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

const labelClass = "text-muted-foreground text-xs font-medium"
const selectClass = cn(inputClass, "h-8 appearance-none pr-6 text-sm")

const selectField = (
  h: HtmlBuilder<Message>,
  config: {
    readonly id: string
    readonly label: string
    readonly value: string
    readonly options: ReadonlyArray<readonly [string, string]>
    readonly onChange: (value: string) => Message
  },
): Html =>
  Select.view(
    {
      id: config.id,
      value: config.value,
      onChange: config.onChange,
      toView: (attributes) =>
        h.div(
          [h.Class("flex flex-col gap-1")],
          [
            h.label([...attributes.label, h.Class(labelClass)], [config.label]),
            h.select(
              [...attributes.select, h.Class(selectClass)],
              config.options.map(([value, text]) =>
                h.option([h.Value(value), h.Selected(value === config.value)], [text]),
              ),
            ),
          ],
        ),
    },
    h,
  )

const submissionView = (h: HtmlBuilder<Message>, submission: Submission): Html => {
  switch (submission._tag) {
    case "NotSubmitted":
    case "Submitting":
      return h.empty
    case "Conflicted":
      return h.div(
        [h.Class("text-xs text-amber-600 dark:text-amber-400"), h.Role("alert")],
        ["Someone changed this rule meanwhile. Saving again writes over their change."],
      )
    case "Rejected":
      return h.ul(
        [h.Class("text-destructive flex flex-col gap-0.5 text-xs"), h.Role("alert")],
        submission.issues.map((issue) => h.li([], [issue.message])),
      )
    case "SubmitError":
      return h.div([h.Class("text-destructive text-xs"), h.Role("alert")], [submission.message])
  }
}

const step = (
  h: HtmlBuilder<Message>,
  number: string,
  title: string,
  children: ReadonlyArray<Html>,
): Html =>
  h.section(
    [h.Class("rule-flow-step")],
    [
      h.span([h.Class("rule-step-number"), h.AriaHidden(true)], [number]),
      h.div(
        [h.Class("rule-flow-card")],
        [h.h2([h.Class("rule-step-title")], [title]), ...children],
      ),
    ],
  )

/** A single-rule preview uses a real published policy evaluation, never changes labels. */
export const previewAction = (
  model: Model,
  outcome: string,
  labels: ReadonlyArray<string>,
): string => {
  if (!model.enabled) return "Rule is disabled; labels stay unchanged."
  if (outcome === "not-applicable")
    return "Policy does not apply to this item; labels stay unchanged."
  if (outcome === "unknown") return "Could not determine a match; labels stay unchanged."
  const present = Option.exists(model.maybeLabelId, (id) => labels.includes(id))
  const name = labelName(
    model.labels,
    Option.getOrElse(model.maybeLabelId, () => ""),
  )
  if (outcome === "match") return present ? `${name} is already applied.` : `Add ${name}`
  return model.onNoMatch === "preserve"
    ? "Leave labels unchanged"
    : present
      ? `Remove ${name}`
      : `${name} is already absent.`
}

const testResultView = (h: HtmlBuilder<Message>, model: Model): Html => {
  const result = model.testResult
  if (result._tag === "Idle") return h.empty
  if (result._tag === "Running")
    return h.p([h.Role("status"), h.Class("text-xs text-muted-foreground")], ["Testing…"])
  if (result._tag === "Failed")
    return h.p([h.Role("alert"), h.Class("text-xs text-destructive")], [result.reason])
  if (result.response._tag === "Rejected")
    return h.p([h.Role("alert"), h.Class("text-xs text-destructive")], [result.response.message])
  const entity = result.response.entities[0]
  if (!entity)
    return h.p(
      [h.Class("text-xs text-muted-foreground")],
      ["This item is no longer available. Choose another item."],
    )
  const outcome = entity.evaluation?.outcome ?? "unknown"
  return h.div(
    [h.Class("policy-test-result"), h.DataAttribute("outcome", outcome)],
    [
      h.div(
        [h.Class("flex items-center justify-between gap-3")],
        [
          h.strong(
            [
              h.Class(
                cn(
                  "text-xs",
                  outcome === "match"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground",
                ),
              ),
            ],
            [describeOutcome(outcome)],
          ),
          h.span([h.Class("text-xs text-muted-foreground")], [`#${entity.number}`]),
        ],
      ),
      h.ul(
        [h.Class("policy-test-trace")],
        (entity.evaluation?.trace ?? []).map((node) =>
          h.li(
            [],
            [
              h.span([], [node.reason]),
              h.span(
                [h.AriaLabel(describeOutcome(node.outcome))],
                [node.outcome === "match" ? "✓" : node.outcome === "no-match" ? "−" : "?"],
              ),
            ],
          ),
        ),
      ),
      h.p(
        [h.Class("rounded-md border p-2 text-xs")],
        [previewAction(model, outcome, entity.labels)],
      ),
      model.group.trim()
        ? h.p(
            [h.Class("text-xs text-muted-foreground")],
            [
              "Single-rule preview. Other rules in this exclusive group may change the final result.",
            ],
          )
        : h.empty,
    ],
  )
}

export type ViewInputs = { readonly isDeleting?: boolean; readonly confirmingDelete?: boolean }
export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, { isDeleting = false, confirmingDelete = false }, h): Html => {
    const issues = draftIssues(model)
    const busy = model.submission._tag === "Submitting" || isDeleting
    const dirty = model.identity._tag === "New" || hasUnsavedChanges(model)
    const policy = selectedPolicy(model)
    const label = model.labels.find((label) => Option.contains(model.maybeLabelId, label.labelId))
    return h.div(
      [h.Class("rule-document"), h.DataAttribute("editor", "rule")],
      [
        h.header(
          [h.Class("rule-navigation")],
          [
            Button.view(h, {
              variant: "outline",
              size: "sm",
              onClick: Message.ClickedCancel(),
              isDisabled: busy,
              label: h.span(
                [h.Class("flex items-center gap-2")],
                [Icon.view(h, ArrowLeft, "size-3.5"), "Back to rules"],
              ),
            }),
            Switch.view(
              {
                id: "rule-enabled",
                isChecked: model.enabled,
                isDisabled: busy,
                onToggle: (isChecked) => Message.ToggledEnabled({ isChecked }),
                toView: (attributes) =>
                  h.div(
                    [h.Class("ml-auto flex items-center gap-3")],
                    [
                      h.label(
                        [...attributes.label, h.Class("cursor-pointer text-xs font-medium")],
                        ["Enable"],
                      ),
                      h.button(
                        [...attributes.button, h.Class("rule-enable-switch")],
                        [h.span([h.AriaHidden(true)], [])],
                      ),
                    ],
                  ),
              },
              h,
            ),
          ],
        ),
        h.div(
          [h.Class("rule-editor-workspace")],
          [
            h.article(
              [h.Class("rule-editor-main")],
              [
                h.header(
                  [h.Class("rule-document-heading")],
                  [
                    h.h1(
                      [h.Class("flex items-center gap-2 text-2xl font-semibold tracking-tight")],
                      [
                        Icon.view(h, Tag, "size-5 text-muted-foreground"),
                        label?.name ?? "New rule",
                      ],
                    ),
                    h.p(
                      [h.Class("mt-2 text-xs leading-relaxed text-muted-foreground")],
                      [
                        policy && label
                          ? `Apply ${label.name} to ${policy.target === "issue" ? "issues" : "pull requests"} that match ${policy.name}.`
                          : "Choose a published policy and the label it manages.",
                      ],
                    ),
                  ],
                ),
                h.div(
                  [h.Class("rule-flow")],
                  [
                    step(h, "1", "When", [
                      selectField(h, {
                        id: "rule-policy",
                        label: "When policy matches",
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
                        ? h.div(
                            [h.Class("mt-3 flex items-center gap-2 text-xs text-muted-foreground")],
                            [
                              Icon.view(h, FileCode2, "size-3"),
                              `${policy.target === "issue" ? "Issues" : "Pull requests"} · Published v${policy.publishedRevision}`,
                            ],
                          )
                        : h.empty,
                      policy?.description
                        ? h.p(
                            [h.Class("mt-3 text-xs leading-relaxed text-muted-foreground")],
                            [policy.description],
                          )
                        : h.empty,
                    ]),
                    step(h, "2", "Then", [
                      selectField(h, {
                        id: "rule-label",
                        label: "Add a GitHub label",
                        value: Option.getOrElse(model.maybeLabelId, () => ""),
                        options: [
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
                        ],
                        onChange: (labelId) => Message.SelectedLabel({ labelId }),
                      }),
                      h.p(
                        [h.Class("mt-3 text-xs text-muted-foreground")],
                        [
                          model.labels.length
                            ? "Already present? Leave it in place."
                            : "No labels synchronized yet.",
                        ],
                      ),
                    ]),
                    step(h, "3", "Otherwise", [
                      selectField(h, {
                        id: "rule-on-no-match",
                        label: "When it does not match",
                        value: model.onNoMatch,
                        options: [
                          ["ensure-absent", "Remove the label"],
                          ["preserve", "Leave unchanged"],
                        ],
                        onChange: (value) => Message.UpdatedOnNoMatch({ value }),
                      }),
                      h.p(
                        [h.Class("mt-3 text-xs text-muted-foreground")],
                        [
                          model.onNoMatch === "preserve"
                            ? "Keep the current label state if the policy does not match."
                            : "Remove this label if the policy stops matching.",
                        ],
                      ),
                    ]),
                    Disclosure.view(
                      {
                        id: "rule-grouping",
                        isOpen: model.groupOpen,
                        onToggle: (isOpen) => Message.ToggledGroup({ isOpen }),
                        toView: ({ button, panel }) =>
                          h.section(
                            [h.Class("rule-grouping")],
                            [
                              h.button(
                                [...button, h.Class("flex w-full items-center gap-2 py-2 text-xs")],
                                [
                                  Icon.view(
                                    h,
                                    ChevronRight,
                                    cn("size-3", model.groupOpen && "rotate-90"),
                                  ),
                                  "Exclusive group",
                                  h.span(
                                    [h.Class("ml-auto text-muted-foreground")],
                                    [model.group.trim() || "None"],
                                  ),
                                ],
                              ),
                              model.groupOpen
                                ? h.div(
                                    [...panel, h.Class("mt-3 flex flex-col gap-3")],
                                    [
                                      input(h, {
                                        id: "rule-group",
                                        label: "Group",
                                        value: model.group,
                                        placeholder: "optional",
                                        onInput: (value) => Message.UpdatedGroup({ value }),
                                        labelClass,
                                      }),
                                      input(h, {
                                        id: "rule-priority",
                                        label: "Priority",
                                        value: model.priority,
                                        type: "number",
                                        onInput: (value) => Message.UpdatedPriority({ value }),
                                        labelClass,
                                      }),
                                      h.p(
                                        [h.Class("text-xs text-muted-foreground")],
                                        [
                                          "The matching rule with the lowest priority wins. Other labels in the group are removed.",
                                        ],
                                      ),
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
                          [h.Class("text-xs text-destructive"), h.Role("status")],
                          [issues.join(". ")],
                        )
                      : h.empty,
                  ],
                ),
              ],
            ),
            h.aside(
              [h.Class("rule-inspector"), h.AriaLabel("Rule controls and testing")],
              [
                dirty
                  ? h.div(
                      [h.Class("rule-save-actions")],
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
                          variant: "outline",
                          onClick: Message.ClickedCancel(),
                          isDisabled: busy,
                          label: "Cancel",
                        }),
                      ],
                    )
                  : h.empty,
                h.section(
                  [h.Class("rule-test-card")],
                  [
                    h.h2([h.Class("rule-test-heading")], ["Test bench"]),
                    h.div(
                      [h.Class("flex flex-col gap-3 p-4")],
                      [
                        model.testCandidates._tag === "Failed"
                          ? h.p(
                              [h.Class("text-xs text-destructive")],
                              ["Could not load test items. Retrying on the next refresh."],
                            )
                          : testItems(model).length === 0
                            ? h.p(
                                [h.Class("text-xs text-muted-foreground")],
                                [
                                  policy
                                    ? "No open items are available for this policy."
                                    : "Select a policy to choose a test item.",
                                ],
                              )
                            : selectField(h, {
                                id: "rule-test-item",
                                label: policy?.target === "issue" ? "Issues" : "Pull Requests",
                                value: String(selectedTestItem(model)?.number ?? ""),
                                options: testItems(model).map((item) => [
                                  String(item.number),
                                  `#${item.number} · ${item.title}`,
                                ]),
                                onChange: (value) =>
                                  Message.SelectedTestItem({ number: Number(value) }),
                              }),
                        Button.view(h, {
                          variant: "outline",
                          size: "sm",
                          onClick: Message.ClickedTest(),
                          isDisabled:
                            issues.length > 0 ||
                            !selectedTestItem(model) ||
                            model.testResult._tag === "Running",
                          label: h.span(
                            [h.Class("flex items-center gap-2")],
                            [Icon.view(h, Play, "size-3"), "Test rule"],
                          ),
                        }),
                        testResultView(h, model),
                      ],
                    ),
                  ],
                ),
                model.identity._tag === "Existing"
                  ? h.div(
                      [h.Class("rule-delete-actions")],
                      [
                        Button.view(h, {
                          variant: "destructive",
                          size: "lg",
                          className: "w-full h-10",
                          onClick: Message.ClickedDelete(),
                          isDisabled: busy,
                          label: h.span(
                            [h.Class("flex items-center gap-1.5")],
                            [
                              Icon.view(h, Trash2, "size-4"),
                              isDeleting
                                ? "Deleting rule…"
                                : confirmingDelete
                                  ? "Confirm delete"
                                  : "Delete rule",
                            ],
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
    testCandidates: () => testCandidates ?? model.testCandidates,
  })
  const changed =
    selectedPolicy(model)?.publishedVersionId !== selectedPolicy(next)?.publishedVersionId ||
    selectedTestItem(model)?.number !== selectedTestItem(next)?.number
  return changed
    ? evo(next, { testResult: () => ({ _tag: "Idle" as const }), testGeneration: (id) => id + 1 })
    : next
}
