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
import * as Icon from "@/lib/icons"
import { Play, X } from "lucide"
import {
  ConfigurationView,
  describeLocation,
  describeOutcome,
  describePlan,
  labelName,
  TestEntity,
  testEndpoint,
  TestResponse,
  TestSubject,
} from "@/components/labeling-wire"
import { cn } from "@/lib/utils"

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

const chipClass = "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium"

const outcomeClass = (outcome: string) =>
  outcome === "match"
    ? "text-emerald-600 dark:text-emerald-400"
    : outcome === "failed"
      ? "text-destructive"
      : outcome === "no-match"
        ? "text-amber-600 dark:text-amber-400"
        : "text-muted-foreground"

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
      h.Class("flex flex-col gap-1 border-t py-2"),
      h.DataAttribute("number", String(entity.number)),
    ],
    [
      h.div(
        [h.Class("flex items-start justify-between gap-3")],
        [
          h.div(
            [h.Class("flex min-w-0 flex-col")],
            [
              h.span(
                [h.Class("truncate text-sm font-medium")],
                [`#${entity.number} ${entity.title}`],
              ),
              h.span([h.Class("text-muted-foreground text-xs")], [meta.join(" · ")]),
              entity.labels.length === 0
                ? h.empty
                : h.div(
                    [h.Class("mt-1 flex flex-wrap gap-1")],
                    entity.labels.map((labelId) =>
                      h.span(
                        [h.Class(chipClass)],
                        [labelName(model.configuration.labels, labelId)],
                      ),
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
                  h.Class(
                    cn(
                      "shrink-0 cursor-pointer text-sm font-medium",
                      outcomeClass(entity.evaluation.outcome),
                    ),
                  ),
                  h.DataAttribute("outcome", entity.evaluation.outcome),
                ],
                [describeOutcome(entity.evaluation.outcome)],
              ),
        ],
      ),
      entity.evaluation === null
        ? h.empty
        : h.div([h.Class("text-muted-foreground text-xs")], [entity.evaluation.reason]),
      entity.evaluation !== null && isExpanded
        ? h.ul(
            [h.Class("text-muted-foreground mt-1 flex flex-col gap-0.5 font-mono text-xs")],
            entity.evaluation.trace.map((node) =>
              h.li(
                [],
                [
                  h.span([h.Class(outcomeClass(node.outcome))], [describeOutcome(node.outcome)]),
                  ` ${describeLocation(node.location)}: ${node.reason}`,
                ],
              ),
            ),
          )
        : h.empty,
      entity.plan === null
        ? h.empty
        : entity.plan.actions.length === 0
          ? h.div([h.Class("text-muted-foreground text-xs")], ["no changes"])
          : h.ul(
              [h.Class("flex flex-col gap-0.5 text-sm")],
              describePlan(entity.plan, model.configuration).map((line, index) =>
                h.li(
                  [
                    h.DataAttribute("action", entity.plan?.actions[index]?.action ?? ""),
                    h.Class(
                      outcomeClass(
                        entity.plan?.actions[index]?.action === "add" ? "match" : "no-match",
                      ),
                    ),
                  ],
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
    [h.Class("policy-draft-bench"), h.DataAttribute("bench", model.run._tag)],
    [
      h.div(
        [h.Class("flex items-center justify-between")],
        [
          h.h2(
            [h.Class("text-sm font-semibold")],
            [model.numbers.length > 0 ? "Result" : "Test bench"],
          ),
          Button.view(h, {
            variant: "ghost",
            size: "icon-xs",
            label: Icon.view(h, X, "size-3"),
            onClick: Message.ClickedClose(),
            attributes: [h.AriaLabel("Close"), h.Title("Clear test results")],
          }),
        ],
      ),
      model.numbers.length > 0
        ? h.empty
        : h.p(
            [h.Class("text-xs text-muted-foreground")],
            ["Preview this draft against recent open items."],
          ),
      entities.length > 0 && model.numbers.length === 0
        ? h.div(
            [h.Class("flex flex-col gap-1.5")],
            [
              h.label(
                [h.For("policy-test-item"), h.Class("text-xs text-muted-foreground")],
                ["Issue or pull request"],
              ),
              h.select(
                [
                  h.Id("policy-test-item"),
                  h.Class("policy-test-select"),
                  h.Value(String(entity?.number ?? "")),
                  h.OnChange((value) => Message.SelectedEntity({ number: Number(value) })),
                ],
                entities.map((entry) =>
                  h.option([h.Value(String(entry.number))], [`#${entry.number} · ${entry.title}`]),
                ),
              ),
            ],
          )
        : h.empty,
      Button.view(h, {
        variant: "outline",
        size: "sm",
        onClick: Message.ClickedRun(),
        isDisabled: running,
        label: h.span(
          [h.Class("flex items-center gap-1.5")],
          [Icon.view(h, Play, "size-3"), running ? "Running" : "Test draft"],
        ),
      }),
      model.run._tag === "Failed" || model.run._tag === "Rejected"
        ? h.p(
            [h.Role("alert"), h.Class("text-xs text-destructive")],
            [model.run._tag === "Failed" ? model.run.reason : model.run.message],
          )
        : running
          ? h.p(
              [h.Role("status"), h.Class("text-xs text-muted-foreground")],
              ["Evaluating the most recently updated open items"],
            )
          : entity === undefined
            ? h.p(
                [h.Class("text-xs text-muted-foreground")],
                ["No open issues or pull requests to test against yet."],
              )
            : h.div(
                [h.Class("policy-test-result"), h.DataAttribute("number", String(entity.number))],
                [
                  h.div(
                    [h.Class("flex items-center justify-between gap-2")],
                    [
                      h.span(
                        [
                          h.Class(
                            cn(
                              "policy-result-tag",
                              outcomeClass(entity.evaluation?.outcome ?? "unknown"),
                            ),
                          ),
                          h.DataAttribute("outcome", entity.evaluation?.outcome ?? "unknown"),
                        ],
                        [describeOutcome(entity.evaluation?.outcome ?? "unknown")],
                      ),
                      h.span([h.Class("text-xs text-muted-foreground")], [`#${entity.number}`]),
                    ],
                  ),
                  h.p(
                    [h.Class("text-xs leading-relaxed text-muted-foreground")],
                    [
                      entity.evaluation?.outcome === "match"
                        ? `This ${entity.kind === "pull_request" ? "pull request" : "issue"} matches the draft.`
                        : entity.evaluation?.outcome === "no-match"
                          ? "This item does not meet the draft's conditions."
                          : (entity.evaluation?.reason ??
                            "No evaluation is available for this item."),
                    ],
                  ),
                  h.ul(
                    [h.Class("policy-test-trace")],
                    (entity.evaluation?.trace ?? []).map((node) =>
                      h.li(
                        [h.Title(describeLocation(node.location))],
                        [
                          h.span([], [node.reason]),
                          h.span(
                            [
                              h.Class(outcomeClass(node.outcome)),
                              h.AriaLabel(describeOutcome(node.outcome)),
                            ],
                            [
                              node.outcome === "match"
                                ? "✓"
                                : node.outcome === "no-match"
                                  ? "−"
                                  : "?",
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                  model.subject._tag === "Draft" && model.subject.policyId !== undefined
                    ? h.div(
                        [h.Class("policy-test-bindings")],
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
                                h.span([h.Class("text-muted-foreground")], ["Used by rule"]),
                                h.span(
                                  [h.Class(chipClass)],
                                  [labelName(model.configuration.labels, rule.labelId)],
                                ),
                              ],
                            ),
                          ),
                      )
                    : h.empty,
                ],
              ),
      h.p([h.Class("text-xs text-muted-foreground")], ["Tests do not change labels."]),
    ],
  )
}

export const view = Submodel.defineView<Model, Message>((model, h): Html => {
  if (model.subject._tag === "Draft") return draftView(h, model)
  const running = model.run._tag === "Running"
  return h.section(
    [h.Class("flex flex-col gap-2"), h.DataAttribute("bench", model.run._tag)],
    [
      h.div(
        [h.Class("flex flex-wrap items-center justify-between gap-3")],
        [
          h.div(
            [h.Class("flex flex-col")],
            [
              h.h2([h.Class("text-sm font-semibold tracking-tight")], ["Test bench"]),
              h.span([h.Class("text-muted-foreground text-xs")], [model.title]),
            ],
          ),
          h.div(
            [h.Class("flex items-center gap-2")],
            [
              Button.view(h, {
                variant: "outline",
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
            return h.div(
              [h.Class("text-muted-foreground text-sm")],
              ["Evaluating the most recently updated open items"],
            )
          case "Rejected":
            return h.div(
              [h.Class("text-destructive text-sm"), h.Role("alert")],
              [model.run.message],
            )
          case "Failed":
            return h.div(
              [h.Class("text-destructive text-sm"), h.Role("alert")],
              [`Test failed: ${model.run.reason}`],
            )
          case "Evaluated": {
            const list = model.run.entities
            return list.length === 0
              ? h.div(
                  [h.Class("text-muted-foreground text-sm")],
                  ["No open issues or pull requests to test against yet."],
                )
              : h.ul(
                  [h.Class("flex flex-col")],
                  list.map((entity) => entityRow(h, model, entity)),
                )
          }
        }
      })(),
    ],
  )
})
