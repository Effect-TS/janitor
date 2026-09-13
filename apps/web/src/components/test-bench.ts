import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage"
import * as FoldkitCommand from "foldkit/command"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import * as Submodel from "foldkit/submodel"
import type * as Update from "foldkit/update"
import * as Button from "@/components/ui/button"
import { chip, type ChipVariant } from "@/components/ui/chip"
import * as Feed from "@/components/ui/feed"
import { panel, panelHeader } from "@/components/ui/panel"
import * as Select from "@/components/ui/select"
import * as Icon from "@/lib/icons"
import { Check, CircleAlert, CircleHelp, Play, X } from "lucide"
import {
  ConfigurationView,
  describeLocation,
  describeOutcome,
  describePlan,
  labelName,
  type Outcome,
  TestEntity,
  testEndpoint,
  TestResponse,
  TestSubject,
} from "@/components/labeling-wire"

/**
 * The test bench (plan: "User interface"). Runs a subject against the most
 * recently updated open entities and shows, per entity, the outcome with
 * its trace, or the plan when the whole configuration is under test.
 */

// MODEL

export const Model = Schema.Struct({
  repositoryId: Schema.String,
  subject: TestSubject,
  title: Schema.String,
  configuration: ConfigurationView,
  run: Schema.Union([
    Schema.TaggedStruct("Running", {}),
    Schema.TaggedStruct("Evaluated", { entities: Schema.Array(TestEntity) }),
    Schema.TaggedStruct("Rejected", { message: Schema.String }),
    Schema.TaggedStruct("Failed", { reason: Schema.String }),
  ]),
  /** Entity numbers whose trace is expanded. */
  expanded: Schema.Array(Schema.Int),
  selectedNumber: Schema.NullOr(Schema.Int),
  numbers: Schema.Array(Schema.Int),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SelectedEntity: { number: Schema.Int },
  ClickedRun: {},
  CompletedRunTest: { response: TestResponse },
  FailedRunTest: { reason: Schema.String },
  ToggledTrace: { number: Schema.Int },
  ClickedClose: {},
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ Closed: {} })
export type OutMessage = typeof OutMessage.Type

// COMMAND

const describe = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error)

export const RunTest = FoldkitCommand.define("RunTest", {
  args: {
    repositoryId: Schema.String,
    subject: TestSubject,
    numbers: Schema.optionalKey(Schema.Array(Schema.Int)),
  },
  messages: [Message.CompletedRunTest, Message.FailedRunTest],
  execute: ({ repositoryId, subject, numbers }) =>
    HttpClientRequest.post(testEndpoint(repositoryId)).pipe(
      HttpClientRequest.bodyJson({ subject, numbers: numbers ?? [] }),
      Effect.flatMap(HttpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpIncomingMessage.schemaBodyJson(TestResponse)),
      Effect.map((response) => Message.CompletedRunTest({ response })),
      Effect.catch((error) => Effect.succeed(Message.FailedRunTest({ reason: describe(error) }))),
    ),
})

// INIT

export type UpdateReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  HttpClient.HttpClient
>

export const init = (input: {
  readonly repositoryId: string
  readonly subject: TestSubject
  readonly title: string
  readonly configuration: ConfigurationView
  readonly numbers?: ReadonlyArray<number>
}): UpdateReturn => {
  const model = Model.make(
    {
      repositoryId: input.repositoryId,
      subject: input.subject,
      title: input.title,
      configuration: input.configuration,
      run: { _tag: "Running" },
      expanded: [],
      selectedNumber: null,
      numbers: input.numbers ?? [],
    },
    { disableChecks: true },
  )
  return {
    model,
    commands: [
      RunTest({
        repositoryId: model.repositoryId,
        subject: model.subject,
        ...(input.numbers === undefined ? {} : { numbers: input.numbers }),
      }),
    ],
  }
}

// UPDATE

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SelectedEntity: ({ number }) => ({ model: evo(model, { selectedNumber: () => number }) }),
    ClickedRun: () => ({
      model: evo(model, { run: () => ({ _tag: "Running" as const }) }),
      commands: [
        RunTest({
          repositoryId: model.repositoryId,
          subject: model.subject,
          ...(model.numbers.length === 0 ? {} : { numbers: model.numbers }),
        }),
      ],
    }),
    CompletedRunTest: ({ response }) => ({
      model: evo(model, {
        run: () =>
          response._tag === "Evaluated"
            ? ({ _tag: "Evaluated", entities: response.entities } as const)
            : ({ _tag: "Rejected", message: response.message } as const),
      }),
    }),
    FailedRunTest: ({ reason }) => ({
      model: evo(model, { run: () => ({ _tag: "Failed" as const, reason }) }),
    }),
    ToggledTrace: ({ number }) => ({
      model: evo(model, {
        expanded: (expanded) =>
          expanded.includes(number)
            ? expanded.filter((entry) => entry !== number)
            : [...expanded, number],
      }),
    }),
    ClickedClose: () => ({ model, outMessage: OutMessage.Closed() }),
  })

// VIEW

/** Outcome as a chip: match neutral with a check, no-match neutral, unknown
 *  neutral with a question mark, failed danger. No warning colour exists. */
const outcomeChip = (h: HtmlBuilder<Message>, outcome: Outcome, text?: string): Html => {
  const variant: ChipVariant = outcome === "failed" ? "danger" : "neutral"
  const icon =
    outcome === "match"
      ? Check
      : outcome === "unknown"
        ? CircleHelp
        : outcome === "failed"
          ? CircleAlert
          : null
  return chip(h, {
    variant,
    className: "shrink-0",
    children: [
      ...(icon === null ? [] : [Icon.view(h, icon, "size-3 shrink-0")]),
      text ?? describeOutcome(outcome),
    ],
  })
}

const labelChip = (h: HtmlBuilder<Message>, name: string): Html => chip(h, { children: [name] })

const entityRow = (h: HtmlBuilder<Message>, model: Model, entity: TestEntity): Html => {
  const isExpanded = model.expanded.includes(entity.number)
  const meta = [
    entity.kind === "pull_request" ? "pull request" : "issue",
    `by ${entity.authorLogin}`,
    entity.baseRef === null ? "" : `into ${entity.baseRef}`,
    entity.draft === true ? "draft" : "",
  ].filter((part) => part.length > 0)
  return h.li(
    [
      h.Class("flex flex-col gap-1.5 border-t border-border-subtle px-3 py-2 first:border-t-0"),
      h.DataAttribute("number", String(entity.number)),
    ],
    [
      h.div(
        [h.Class("flex items-start justify-between gap-3")],
        [
          h.div(
            [h.Class("flex min-w-0 flex-col gap-0.5")],
            [
              h.span(
                [h.Class("truncate text-body-md font-medium")],
                [h.span([h.Class("font-mono")], [`#${entity.number}`]), ` ${entity.title}`],
              ),
              h.span([h.Class("text-body-sm text-ink-muted")], [meta.join(" · ")]),
              entity.labels.length === 0
                ? h.empty
                : h.div(
                    [h.Class("mt-0.5 flex flex-wrap gap-1")],
                    entity.labels.map((labelId) =>
                      labelChip(h, labelName(model.configuration.labels, labelId)),
                    ),
                  ),
            ],
          ),
          entity.evaluation === null
            ? h.empty
            : h.button(
                [
                  h.Type("button"),
                  h.OnClick(Message.ToggledTrace({ number: entity.number })),
                  h.AriaExpanded(isExpanded),
                  h.Class("shrink-0 cursor-pointer rounded-xs"),
                  h.DataAttribute("outcome", entity.evaluation.outcome),
                ],
                [outcomeChip(h, entity.evaluation.outcome)],
              ),
        ],
      ),
      entity.evaluation === null
        ? h.empty
        : h.div([h.Class("text-body-sm text-ink-muted")], [entity.evaluation.reason]),
      entity.evaluation !== null && isExpanded
        ? h.ul(
            [h.Class("mt-1 flex flex-col gap-0.5 font-mono text-mono-sm text-ink-muted")],
            entity.evaluation.trace.map((node) =>
              h.li(
                [],
                [
                  `${describeOutcome(node.outcome)} · ${describeLocation(node.location)}: ${node.reason}`,
                ],
              ),
            ),
          )
        : h.empty,
      entity.plan === null
        ? h.empty
        : entity.plan.actions.length === 0
          ? h.div([h.Class("text-body-sm text-ink-muted")], ["no changes"])
          : h.ul(
              [h.Class("flex flex-col gap-0.5 font-mono text-mono-sm")],
              describePlan(entity.plan, model.configuration).map((line, index) =>
                h.li(
                  [h.DataAttribute("action", entity.plan?.actions[index]?.action ?? "")],
                  [line],
                ),
              ),
            ),
    ],
  )
}

const draftView = (h: HtmlBuilder<Message>, model: Model): Html => {
  const entities = model.run._tag === "Evaluated" ? model.run.entities : []
  const entity = entities.find((entry) => entry.number === model.selectedNumber) ?? entities[0]
  const running = model.run._tag === "Running"
  return h.section(
    [h.Class("flex flex-col gap-3"), h.DataAttribute("bench", model.run._tag)],
    [
      h.div(
        [h.Class("flex items-center justify-between gap-2")],
        [
          h.h2(
            [h.Class("text-h3 font-semibold")],
            [model.numbers.length > 0 ? "Result" : "Test bench"],
          ),
          Button.view(h, {
            variant: "ghost",
            size: "icon-xs",
            label: Icon.view(h, X),
            onClick: Message.ClickedClose(),
            attributes: [h.AriaLabel("Close"), h.Title("Clear test results")],
          }),
        ],
      ),
      model.numbers.length > 0
        ? h.empty
        : h.p(
            [h.Class("text-body-sm text-ink-muted")],
            ["Preview this draft against recent open items."],
          ),
      entities.length > 0 && model.numbers.length === 0
        ? Select.view(h, {
            id: "policy-test-item",
            label: "Issue or pull request",
            value: String(entity?.number ?? ""),
            options: entities.map((entry) => [
              String(entry.number),
              `#${entry.number} · ${entry.title}`,
            ]),
            onChange: (value) => Message.SelectedEntity({ number: Number(value) }),
          })
        : h.empty,
      Button.view(h, {
        variant: "secondary",
        size: "sm",
        onClick: Message.ClickedRun(),
        isDisabled: running,
        label: h.span(
          [h.Class("flex items-center gap-1.5")],
          [Icon.view(h, Play), running ? "Running" : "Test draft"],
        ),
      }),
      model.run._tag === "Failed" || model.run._tag === "Rejected"
        ? h.p(
            [h.Role("alert"), h.Class("text-body-sm text-destructive")],
            [model.run._tag === "Failed" ? model.run.reason : model.run.message],
          )
        : running
          ? h.p(
              [h.Role("status"), h.Class("text-body-sm text-ink-muted")],
              ["Evaluating the most recently updated open items…"],
            )
          : entity === undefined
            ? h.p(
                [h.Class("text-body-sm text-ink-muted")],
                ["No open issues or pull requests to test against yet."],
              )
            : panel(h, {
                className: "oc-agent-edge flex flex-col gap-3 p-3",
                attributes: [h.DataAttribute("number", String(entity.number))],
                children: [
                  h.div(
                    [h.Class("flex flex-wrap items-center gap-2")],
                    [
                      Feed.agentBadge(h),
                      h.span(
                        [h.Class("font-mono text-mono-sm text-ink-subtle")],
                        [`#${entity.number}`],
                      ),
                      h.span(
                        [
                          h.Class("ml-auto"),
                          h.DataAttribute("outcome", entity.evaluation?.outcome ?? "unknown"),
                        ],
                        [outcomeChip(h, entity.evaluation?.outcome ?? "unknown")],
                      ),
                    ],
                  ),
                  h.p(
                    [h.Class("text-body-sm text-ink-muted")],
                    [
                      entity.evaluation?.outcome === "match"
                        ? `This ${entity.kind === "pull_request" ? "pull request" : "issue"} matches the draft.`
                        : entity.evaluation?.outcome === "no-match"
                          ? "This item does not meet the draft's conditions."
                          : (entity.evaluation?.reason ??
                            "No evaluation is available for this item."),
                    ],
                  ),
                  (entity.evaluation?.trace ?? []).length === 0
                    ? h.empty
                    : h.ul(
                        [h.Class("flex flex-col gap-1.5")],
                        (entity.evaluation?.trace ?? []).map((node) =>
                          h.li(
                            [
                              h.Class("flex items-start justify-between gap-3 text-body-sm"),
                              h.Title(describeLocation(node.location)),
                            ],
                            [
                              h.span([h.Class("min-w-0 text-ink-muted")], [node.reason]),
                              h.span(
                                [
                                  h.Class("inline-flex shrink-0 items-center text-ink-muted"),
                                  h.AriaLabel(describeOutcome(node.outcome)),
                                ],
                                [
                                  Icon.view(
                                    h,
                                    node.outcome === "match"
                                      ? Check
                                      : node.outcome === "no-match"
                                        ? X
                                        : CircleHelp,
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ),
                  model.subject._tag === "Draft" && model.subject.policyId !== undefined
                    ? h.div(
                        [
                          h.Class(
                            "flex flex-col gap-1.5 border-t border-border-subtle pt-2.5 text-body-sm empty:hidden",
                          ),
                        ],
                        model.configuration.rules
                          .filter(
                            (rule) =>
                              model.subject._tag === "Draft" &&
                              rule.policyId === model.subject.policyId,
                          )
                          .map((rule) =>
                            h.div(
                              [h.Class("flex items-center justify-between gap-2")],
                              [
                                h.span([h.Class("text-ink-muted")], ["Used by rule"]),
                                labelChip(h, labelName(model.configuration.labels, rule.labelId)),
                              ],
                            ),
                          ),
                      )
                    : h.empty,
                ],
              }),
      h.p([h.Class("text-body-sm text-ink-muted")], ["Tests do not change labels."]),
    ],
  )
}

export const view = Submodel.defineView<Model, Message>((model, h): Html => {
  if (model.subject._tag === "Draft") return draftView(h, model)
  const running = model.run._tag === "Running"
  return h.section(
    [h.Class("flex flex-col gap-3"), h.DataAttribute("bench", model.run._tag)],
    [
      h.div(
        [h.Class("flex flex-wrap items-center justify-between gap-3")],
        [
          h.div(
            [h.Class("flex min-w-0 flex-col")],
            [
              h.h2([h.Class("text-h3 font-semibold")], ["Test bench"]),
              h.span([h.Class("truncate text-body-sm text-ink-muted")], [model.title]),
            ],
          ),
          h.div(
            [h.Class("flex items-center gap-1.5")],
            [
              Button.view(h, {
                variant: "secondary",
                size: "sm",
                onClick: Message.ClickedRun(),
                isDisabled: running,
                label: running ? "Running" : "Run again",
              }),
              Button.view(h, {
                variant: "ghost",
                size: "sm",
                onClick: Message.ClickedClose(),
                label: "Close",
              }),
            ],
          ),
        ],
      ),
      (() => {
        switch (model.run._tag) {
          case "Running":
            return h.p(
              [h.Role("status"), h.Class("text-body-sm text-ink-muted")],
              ["Evaluating the most recently updated open items…"],
            )
          case "Rejected":
            return h.p(
              [h.Class("text-body-sm text-destructive"), h.Role("alert")],
              [model.run.message],
            )
          case "Failed":
            return h.p(
              [h.Class("text-body-sm text-destructive"), h.Role("alert")],
              [`Test failed: ${model.run.reason}`],
            )
          case "Evaluated": {
            const list = model.run.entities
            return list.length === 0
              ? h.p(
                  [h.Class("text-body-sm text-ink-muted")],
                  ["No open issues or pull requests to test against yet."],
                )
              : panel(h, {
                  flush: true,
                  className: "oc-agent-edge",
                  children: [
                    panelHeader(h, {
                      title: "Results",
                      meta: `${list.length} ${list.length === 1 ? "item" : "items"}`,
                      actions: [Feed.agentBadge(h)],
                    }),
                    h.ul(
                      [h.Class("flex flex-col")],
                      list.map((entity) => entityRow(h, model, entity)),
                    ),
                  ],
                })
          }
        }
      })(),
      h.p([h.Class("text-body-sm text-ink-muted")], ["Tests do not change labels."]),
    ],
  )
})
