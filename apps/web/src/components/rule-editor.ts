import * as Checkbox from "@foldkit/ui/checkbox"
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
import { Check } from "lucide"
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
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  Saved: { rule: RuleRecord, closeEditor: Schema.Boolean },
  Cancelled: {},
  SaveFailed: { reason: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

// DOMAIN

export const draftIssues = (model: Model): ReadonlyArray<string> => [
  ...(Option.isNone(model.maybeLabelId) ? ["Pick a label"] : []),
  ...(Option.isNone(model.maybePolicyId) ? ["Pick a published policy"] : []),
  ...(model.priority.trim() !== "" && !/^-?\d+$/.test(model.priority.trim())
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
    submission: (current) =>
      current._tag === "Submitting" ? current : { _tag: "NotSubmitted" as const },
  })

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SelectedLabel: ({ labelId }) => ({
      model: edited(evo(model, { maybeLabelId: () => Option.some(labelId) })),
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
    ClickedCancel: () =>
      model.submission._tag === "Submitting"
        ? { model }
        : { model, outMessage: OutMessage.Cancelled() },
  })

// VIEW

const labelClass = "text-muted-foreground text-xs font-medium"
const chipClass = "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium"
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

const labelPicker = (h: HtmlBuilder<Message>, model: Model): Html =>
  h.div(
    [h.Class("flex flex-col gap-1")],
    [
      h.span([h.Class(labelClass)], ["Label"]),
      model.labels.length === 0
        ? h.span([h.Class("text-muted-foreground text-xs")], ["No labels synchronized yet"])
        : h.div(
            [h.Class("flex flex-wrap gap-1")],
            model.labels.map((label) => {
              const isSelected = Option.contains(model.maybeLabelId, label.labelId)
              const isGone = label.availability === "unavailable"
              return h.button(
                [
                  h.Type("button"),
                  h.Disabled(isGone && !isSelected),
                  h.AriaPressed(String(isSelected)),
                  h.DataAttribute("label-id", label.labelId),
                  h.OnClick(Message.SelectedLabel({ labelId: label.labelId })),
                  h.Class(
                    cn(
                      chipClass,
                      "cursor-pointer transition-colors",
                      isSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "hover:bg-accent",
                      isGone && "line-through opacity-60",
                    ),
                  ),
                ],
                [label.name],
              )
            }),
          ),
    ],
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

export const view = Submodel.defineView<Model, Message>((model, h): Html => {
  const issues = draftIssues(model)
  const busy = model.submission._tag === "Submitting"
  return h.div(
    [h.Class("flex flex-col gap-4"), h.DataAttribute("editor", "rule")],
    [
      h.div(
        [h.Class("flex items-center justify-between gap-3")],
        [
          h.h2(
            [h.Class("text-sm font-semibold tracking-tight")],
            [model.identity._tag === "New" ? "New rule" : "Edit rule"],
          ),
          h.div(
            [h.Class("flex items-center gap-2")],
            [
              Button.view(h, {
                variant: "outline",
                size: "sm",
                onClick: Message.ClickedCancel(),
                isDisabled: busy,
                label: "Cancel",
              }),
              Button.view(h, {
                size: "sm",
                onClick: Message.ClickedSave(),
                isDisabled: issues.length > 0 || busy,
                label: busy ? "Saving" : "Save rule",
                attributes: [h.DataAttribute("action", "save")],
              }),
            ],
          ),
        ],
      ),
      labelPicker(h, model),
      h.div(
        [h.Class("grid gap-3 sm:grid-cols-2 lg:grid-cols-4")],
        [
          selectField(h, {
            id: "rule-policy",
            label: "When policy matches",
            value: Option.getOrElse(model.maybePolicyId, () => ""),
            options: [
              ["", "Choose a policy"] as const,
              ...publishedPolicies(model).map((policy) => [policy.policyId, policy.name] as const),
            ],
            onChange: (value) => Message.UpdatedPolicy({ value }),
          }),
          selectField(h, {
            id: "rule-on-no-match",
            label: "When it does not match",
            value: model.onNoMatch,
            options: [
              ["ensure-absent", "Remove the label"],
              ["preserve", "Leave the label alone"],
            ],
            onChange: (value) => Message.UpdatedOnNoMatch({ value }),
          }),
          input(h, {
            id: "rule-group",
            label: "Exclusive group",
            value: model.group,
            placeholder: "optional",
            onInput: (value) => Message.UpdatedGroup({ value }),
            labelClass,
            wrapperClass: "gap-1",
          }),
          input(h, {
            id: "rule-priority",
            label: "Priority in group",
            value: model.priority,
            type: "number",
            onInput: (value) => Message.UpdatedPriority({ value }),
            labelClass,
            wrapperClass: "gap-1",
          }),
        ],
      ),
      Checkbox.view(
        {
          id: "rule-enabled",
          isChecked: model.enabled,
          onToggle: (isChecked) => Message.ToggledEnabled({ isChecked }),
          toView: (attributes) =>
            h.div(
              [h.Class("flex items-center gap-2")],
              [
                h.button(
                  [
                    ...attributes.checkbox,
                    h.Class(
                      "border-input data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground flex size-4 items-center justify-center rounded-[4px] border",
                    ),
                    h.DataAttribute("state", model.enabled ? "checked" : "unchecked"),
                  ],
                  model.enabled ? [Icon.view(h, Check, "size-3")] : [],
                ),
                h.label(
                  [...attributes.label, h.Class("cursor-pointer text-sm select-none")],
                  ["Enabled"],
                ),
              ],
            ),
        },
        h,
      ),
      h.div(
        [h.Class("text-muted-foreground text-xs")],
        [
          "In a group, the matching rule with the lowest priority wins and the others' labels come off.",
        ],
      ),
      issues.length === 0
        ? h.empty
        : h.ul(
            [h.Class("text-destructive flex flex-col gap-0.5 text-xs")],
            issues.map((issue) => h.li([], [issue])),
          ),
      submissionView(h, model.submission),
    ],
  )
})

export const reflectConfiguration = (model: Model, configuration: ConfigurationView): Model =>
  evo(model, {
    labels: () => configuration.labels,
    policies: () => configuration.policies,
  })
