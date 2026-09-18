import { SavedPublication } from "@janitor/domain/Review/Publication"
import { ReviewHistory, ReviewRun, ReviewRunStatus } from "@janitor/domain/Review/Run"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage"
import * as Command from "foldkit/command"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as Submodel from "foldkit/submodel"
import type * as Update from "foldkit/update"
import { RotateCw, X } from "lucide"
import * as Sheet from "./ui/sheet"
import * as Button from "./ui/button"
import { chip, type ChipVariant } from "./ui/chip"
import * as Page from "./ui/page"
import { emptyPanel, panel } from "./ui/panel"
import * as Table from "./ui/table"
import * as Icon from "@/lib/icons"
import { reasonOf, request } from "@/lib/api"
import { cn } from "@/lib/utils"

/**
 * The issue review history of one repository: every run an authorized
 * mention created, newest first, with its place in its issue's queue and,
 * once it stopped, why. A concluded run shows its classification, the
 * commit its evidence was read from, the agent's findings and uncertainty,
 * and the evidence it cited; a run that stopped short shows what stopped it.
 * Cancel run asks the server, which checks the teammate's current GitHub
 * permission before stopping the run.
 */

const DetailTab = Schema.Literals(["Overview", "Execution", "Evidence", "Patch"])
const RunFilter = Schema.Literals(["All runs", "Active", "Failed"])

export const Model = Schema.Struct({
  selectedRunId: Schema.NullOr(Schema.String),
  detailTab: DetailTab,
  filter: RunFilter,
  drawer: Sheet.Model,
  repositoryId: Schema.String,
  active: Schema.Boolean,
  runs: Schema.Array(ReviewRun),
  loading: Schema.Boolean,
  initialized: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  generation: Schema.Int,
  /** The run whose cancellation is in flight. */
  cancelling: Schema.NullOr(Schema.String),
  publishing: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type

export const init = (): Model => ({
  selectedRunId: null,
  detailTab: "Overview",
  filter: "All runs",
  drawer: Sheet.init({ id: "review-details", focusSelector: "#close-review-details" }),
  repositoryId: "",
  active: false,
  runs: [],
  loading: false,
  initialized: false,
  error: null,
  generation: 0,
  cancelling: null,
  publishing: null,
})

export const Message = defineMessageUnion({
  Activated: { repositoryId: Schema.String, active: Schema.Boolean },
  ClickedRun: { runId: Schema.String },
  ClickedDetailTab: { tab: DetailTab },
  ClickedFilter: { filter: RunFilter },
  GotDrawerMessage: { message: Sheet.Message },
  Polled: {},
  ClickedRefresh: {},
  Loaded: { generation: Schema.Int, runs: ReviewHistory.fields.runs },
  Failed: { generation: Schema.Int, reason: Schema.String },
  ClickedPublish: { runId: Schema.String },
  Published: { runId: Schema.String, generation: Schema.Int, publication: SavedPublication },
  PublishFailed: { runId: Schema.String, generation: Schema.Int, reason: Schema.String },
  ClickedCancel: { runId: Schema.String },
  Cancelled: { runId: Schema.String, status: ReviewRunStatus },
  CancelFailed: { runId: Schema.String, reason: Schema.String },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  Notified: { title: Schema.String, description: Schema.String },
  Failed: { title: Schema.String, reason: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

export const historyEndpoint = (repositoryId: string) =>
  `/api/v1/repositories/${encodeURIComponent(repositoryId)}/reviews`

export const FetchHistory = Command.define("FetchReviewHistory", {
  args: { repositoryId: Schema.String, generation: Schema.Int },
  messages: [Message.Loaded, Message.Failed],
  execute: ({ repositoryId, generation }) =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(historyEndpoint(repositoryId))
      if (response.status !== 200)
        return Message.Failed({
          generation,
          reason:
            response.status === 404
              ? "This repository is unavailable."
              : "Review history could not be loaded. Try again.",
        })
      const history = yield* HttpIncomingMessage.schemaBodyJson(ReviewHistory)(response)
      return Message.Loaded({ generation, runs: history.runs })
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.catch(() =>
        Effect.succeed(
          Message.Failed({
            generation,
            reason: "Review history could not be loaded. Check your connection and try again.",
          }),
        ),
      ),
    ),
})

export const CancelRun = Command.define("CancelReviewRun", {
  args: { repositoryId: Schema.String, runId: Schema.String },
  messages: [Message.Cancelled, Message.CancelFailed],
  execute: ({ repositoryId, runId }) =>
    request(
      "POST",
      `${historyEndpoint(repositoryId)}/${encodeURIComponent(runId)}/cancel`,
      {},
    ).pipe(
      Effect.flatMap(
        HttpIncomingMessage.schemaBodyJson(Schema.Struct({ status: ReviewRunStatus })),
      ),
      Effect.map(({ status }) => Message.Cancelled({ runId, status })),
      Effect.catch((error) =>
        Effect.succeed(Message.CancelFailed({ runId, reason: reasonOf(error) })),
      ),
    ),
})

export const PublishRun = Command.define("PublishReviewResults", {
  args: { repositoryId: Schema.String, runId: Schema.String, generation: Schema.Int },
  messages: [Message.Published, Message.PublishFailed],
  execute: ({ repositoryId, runId, generation }) =>
    request(
      "POST",
      `${historyEndpoint(repositoryId)}/${encodeURIComponent(runId)}/publish`,
      {},
    ).pipe(
      Effect.flatMap(HttpIncomingMessage.schemaBodyJson(SavedPublication)),
      Effect.timeout("15 seconds"),
      Effect.map((publication) => Message.Published({ runId, generation, publication })),
      Effect.catch((error) =>
        Effect.succeed(Message.PublishFailed({ runId, generation, reason: reasonOf(error) })),
      ),
    ),
})

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, HttpClient.HttpClient>

const fetchHistory = (model: Model): Return =>
  !model.active || model.loading
    ? { model }
    : {
        model: { ...model, loading: true, error: null },
        commands: [
          FetchHistory({ repositoryId: model.repositoryId, generation: model.generation }),
        ],
      }

const mapDrawer = (model: Model, result: ReturnType<typeof Sheet.open>): Return => ({
  model: { ...model, drawer: result.model },
  commands: Command.mapMessages(result.commands, (message) =>
    Message.GotDrawerMessage({ message }),
  ),
})

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ClickedRun: ({ runId }) =>
      model.runs.some((run) => run.runId === runId)
        ? mapDrawer(
            { ...model, selectedRunId: runId, detailTab: "Overview" },
            Sheet.open(model.drawer),
          )
        : { model },
    ClickedDetailTab: ({ tab }) => ({ model: { ...model, detailTab: tab } }),
    ClickedFilter: ({ filter }) => ({ model: { ...model, filter } }),
    GotDrawerMessage: ({ message }) => mapDrawer(model, Sheet.update(model.drawer, message)),
    Activated: ({ repositoryId, active }) => {
      if (model.repositoryId === repositoryId && model.active === active) return { model }
      const next: Model =
        repositoryId === model.repositoryId
          ? { ...model, active, loading: false, publishing: null, generation: model.generation + 1 }
          : { ...init(), repositoryId, active, generation: model.generation + 1 }
      const closed = mapDrawer({ ...next, selectedRunId: null }, Sheet.close(model.drawer))
      const refreshed = active ? fetchHistory(closed.model) : { model: closed.model }
      return { ...refreshed, commands: [...(closed.commands ?? []), ...(refreshed.commands ?? [])] }
    },
    Polled: () => fetchHistory(model),
    ClickedRefresh: () => fetchHistory({ ...model, error: null }),
    Loaded: ({ generation, runs }) =>
      generation !== model.generation || !model.active
        ? { model }
        : { model: { ...model, runs, loading: false, initialized: true, error: null } },
    Failed: ({ generation, reason }) =>
      generation !== model.generation
        ? { model }
        : { model: { ...model, loading: false, error: reason } },
    ClickedPublish: ({ runId }) =>
      model.publishing !== null || !model.runs.some((run) => run.runId === runId && run.canPublish)
        ? { model }
        : {
            model: { ...model, publishing: runId },
            commands: [
              PublishRun({ repositoryId: model.repositoryId, runId, generation: model.generation }),
            ],
          },
    Published: ({ runId, generation, publication }) =>
      generation !== model.generation || model.publishing !== runId
        ? { model }
        : {
            model: {
              ...model,
              publishing: null,
              runs: model.runs.map((run) =>
                run.runId === runId
                  ? { ...run, savedPublication: publication, canPublish: false }
                  : run,
              ),
            },
          },
    PublishFailed: ({ runId, generation, reason }) =>
      generation !== model.generation || model.publishing !== runId
        ? { model }
        : {
            ...fetchHistory({ ...model, publishing: null }),
            outMessage: OutMessage.Failed({
              title: "Publication could not be confirmed. Refresh to check its status.",
              reason,
            }),
          },
    ClickedCancel: ({ runId }) =>
      model.cancelling !== null ||
      !model.runs.some((run) => run.runId === runId && run.queuePosition !== null)
        ? { model }
        : {
            model: { ...model, cancelling: runId },
            commands: [CancelRun({ repositoryId: model.repositoryId, runId })],
          },
    Cancelled: ({ runId, status }) => {
      if (model.cancelling !== runId) return { model }
      const refreshed = fetchHistory({ ...model, cancelling: null })
      return {
        ...refreshed,
        outMessage: OutMessage.Notified({
          title: status === "cancelled" ? "Review run cancelled" : "Review run already finished",
          description:
            status === "cancelled"
              ? "Later runs on the same issue stay queued; completed publications are untouched."
              : "Nothing was changed.",
        }),
      }
    },
    CancelFailed: ({ runId, reason }) =>
      model.cancelling !== runId
        ? { model }
        : {
            model: { ...model, cancelling: null },
            outMessage: OutMessage.Failed({ title: "The run was not cancelled", reason }),
          },
  })

// VIEW

const statusVariant: Record<ReviewRun["status"], ChipVariant> = {
  queued: "neutral",
  running: "agent",
  completed: "success",
  cancelled: "neutral",
  interrupted: "danger",
  failed: "danger",
}

export const statusLabel = (run: ReviewRun): string =>
  run.status === "queued" && run.queuePosition !== null
    ? `queued #${run.queuePosition}`
    : run.status

const stamp = (at: DateTime.Utc) =>
  DateTime.formatUtc(at, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }) + " UTC"

const duration = (run: ReviewRun): string => {
  if (run.startedAt === null) return run.status === "queued" ? "Not started" : "Unavailable"
  if (run.finishedAt === null) return "In progress"
  const seconds = Math.max(
    0,
    Math.floor(
      (DateTime.toEpochMillis(run.finishedAt) - DateTime.toEpochMillis(run.startedAt)) / 1000,
    ),
  )
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const head = (h: HtmlBuilder<Message>, text: string, className?: string) =>
  Table.headCell(h, { className: cn("h-8", className), children: [text] })
const cell = (
  h: HtmlBuilder<Message>,
  children: ReadonlyArray<Html | string>,
  className?: string,
) => Table.cell(h, { className: cn("py-2 align-top", className), children })

const classificationVariant: Record<NonNullable<ReviewRun["classification"]>, ChipVariant> = {
  bug: "danger",
  enhancement: "agent",
  question: "neutral",
  unclear: "neutral",
}

const paragraphs = (h: HtmlBuilder<Message>, text: string, className: string) =>
  text
    .split(/\n{2,}/)
    .filter((part) => part.trim() !== "")
    .map((part) => h.p([h.Class(cn("whitespace-pre-wrap", className))], [part.trim()]))

const evidenceItem = (h: HtmlBuilder<Message>, item: ReviewRun["evidence"][number]): Html => {
  const label =
    item.kind === "file"
      ? item.reference
      : `${item.kind === "issue" ? "issue" : "PR"} #${item.reference}`
  return h.li(
    [h.Class("text-body-sm")],
    [
      item.url === null
        ? h.span([h.Class("font-mono text-mono-sm")], [label])
        : h.a(
            [
              h.Href(item.url),
              h.Target("_blank"),
              h.Rel("noreferrer"),
              h.Class("font-mono text-mono-sm text-primary hover:underline"),
            ],
            [label],
          ),
      ...(item.verified
        ? []
        : [chip(h, { className: "ml-1", children: ["not observed in this run"] })]),
      ...(item.note.trim() === "" ? [] : [h.span([h.Class("ml-2 text-ink-muted")], [item.note])]),
    ],
  )
}

const sectionTitle = (h: HtmlBuilder<Message>, text: string) =>
  h.h3([h.Class("text-body-sm font-semibold")], [text])

const overview = (h: HtmlBuilder<Message>, run: ReviewRun): ReadonlyArray<Html> => [
  ...(run.classification === null
    ? []
    : [
        chip(h, {
          variant: classificationVariant[run.classification],
          children: [run.classification],
        }),
      ]),
  ...(run.limitation === null
    ? []
    : [
        h.div(
          [
            h.Class("border-l-2 border-destructive bg-surface-muted p-3 text-body-sm"),
            h.DataAttribute("slot", "limitation"),
          ],
          [run.limitation],
        ),
      ]),
  ...(run.cancelReason === null
    ? []
    : [
        h.p(
          [h.Class("text-body-sm text-ink-muted")],
          [
            run.cancelledBy === null
              ? run.cancelReason
              : `${run.cancelReason} (${run.cancelledBy})`,
          ],
        ),
      ]),
  ...(run.findings === null
    ? [
        h.p(
          [h.Class("text-body-sm text-ink-muted")],
          [
            run.status === "queued"
              ? "Waiting for earlier runs on this issue."
              : run.status === "running"
                ? "Investigation in progress. Execution and evidence update as the run proceeds."
                : "No findings were saved for this run.",
          ],
        ),
      ]
    : paragraphs(h, run.findings, "text-body-md")),
  ...reproductionDetails(h, run, "Overview"),
  ...(run.uncertainty === null || run.uncertainty.trim() === ""
    ? []
    : [
        sectionTitle(h, "Uncertainty"),
        ...paragraphs(h, run.uncertainty, "text-body-sm text-ink-muted"),
      ]),
  sectionTitle(h, "Execution summary"),
  h.ol(
    [h.Class("ml-1 space-y-4 border-l border-border pl-5 text-body-sm")],
    [
      h.li([], ["Invocation accepted", h.p([h.Class("text-ink-muted")], [stamp(run.acceptedAt)])]),
      ...(run.commitSha === null
        ? []
        : [
            h.li(
              [],
              [
                "Repository inspected",
                h.p([h.Class("text-ink-muted")], [`${run.evidence.length} saved evidence items`]),
              ],
            ),
          ]),
      ...run.reproduction.attempts
        .slice(-1)
        .map((attempt) =>
          h.li(
            [],
            [
              attempt.exitCode === null
                ? "Latest command has no saved exit result"
                : `Latest ${attempt.kind} command exited with code ${attempt.exitCode}`,
              h.p(
                [h.Class("font-mono text-mono-sm text-ink-muted line-clamp-2")],
                [attempt.command],
              ),
            ],
          ),
        ),
      ...(run.finishedAt === null
        ? []
        : [
            h.li(
              [],
              [`Review ${run.status}`, h.p([h.Class("text-ink-muted")], [stamp(run.finishedAt)])],
            ),
          ]),
    ],
  ),
  Button.view(h, {
    variant: "secondary",
    size: "sm",
    label: "Inspect commands & output",
    onClick: Message.ClickedDetailTab({ tab: "Execution" }),
  }),
  sectionTitle(h, "Invocation"),
  h.p(
    [h.Class("border-l-2 border-border pl-3 whitespace-pre-wrap text-body-sm text-ink-muted")],
    [run.instructions],
  ),
  sectionTitle(h, "Publication"),
  ...(run.savedPublication == null
    ? []
    : [
        h.p(
          [h.Class("text-body-sm text-ink-muted"), h.DataAttribute("slot", "saved-publication")],
          [
            `Publication: ${run.savedPublication.status}. Authorized by ${run.savedPublication.githubLogin}.`,
          ],
        ),
      ]),
  h.p(
    [h.Class("text-body-sm text-ink-muted"), h.DataAttribute("slot", "publication")],
    [
      run.publication.status === "none"
        ? "No summary has been published."
        : run.dryRun && run.savedPublication == null && run.publication.status === "pending"
          ? "Validated summary saved."
          : `Summary publication: ${run.publication.status}.`,
      ...(run.publication.reason === null ? [] : [` ${run.publication.reason}`]),
      ...(run.publication.url === null
        ? []
        : [
            " ",
            h.a(
              [h.Href(run.publication.url), h.Class("text-primary hover:underline")],
              ["View summary"],
            ),
          ]),
    ],
  ),
]

const reproductionDetails = (
  h: HtmlBuilder<Message>,
  run: ReviewRun,
  tab: typeof DetailTab.Type,
): ReadonlyArray<Html> => {
  const { patch, attempts, assessment } = run.reproduction
  const draft = run.draftPublication
  return [
    ...(draft === null || tab !== "Patch"
      ? []
      : [
          h.div(
            [h.DataAttribute("slot", "draft-publication"), h.Class("space-y-2 text-body-sm")],
            [
              h.p(
                [],
                [
                  `Reproduction PR: ${draft.status}.`,
                  ...(draft.reason === null ? [] : [` ${draft.reason}`]),
                ],
              ),
              ...(draft.url === null
                ? []
                : [
                    h.a(
                      [
                        h.Href(draft.url),
                        h.Target("_blank"),
                        h.Rel("noreferrer"),
                        h.Class("underline"),
                      ],
                      [`View PR #${draft.prNumber}`],
                    ),
                  ]),
              ...(draft.reuse === undefined || draft.status === "published"
                ? []
                : [h.p([], ["Findings and the proposed test patch are retained below."])]),
              h.details(
                [],
                [
                  h.summary([h.Class("cursor-pointer")], ["Proposed PR text"]),
                  h.p([], [draft.text.title]),
                  h.pre([h.Class("max-h-80 overflow-auto whitespace-pre-wrap")], [draft.text.body]),
                ],
              ),
            ],
          ),
        ]),
    ...(assessment === null || tab !== "Overview"
      ? []
      : [
          h.p([h.Class("text-body-sm font-medium")], [assessment.outcome.replaceAll("_", " ")]),
          ...paragraphs(h, assessment.rationale, "text-body-sm"),
          ...paragraphs(h, assessment.unverified, "text-body-sm text-ink-muted"),
          ...(assessment.duplicate === null
            ? []
            : [
                h.p(
                  [h.Class("text-body-sm")],
                  [
                    "No new reproduction proposed. ",
                    h.a(
                      [
                        h.Href(assessment.duplicate.url),
                        h.Target("_blank"),
                        h.Rel("noreferrer"),
                        h.Class("text-primary hover:underline"),
                      ],
                      [`Existing issue #${assessment.duplicate.issueNumber}`],
                    ),
                  ],
                ),
                ...paragraphs(h, assessment.duplicate.rationale, "text-body-sm text-ink-muted"),
              ]),
        ]),
    ...(tab === "Execution" ? attempts : []).map((attempt) =>
      h.details(
        [h.Class("rounded-md border border-border p-3 text-body-sm")],
        [
          h.summary(
            [h.Class("cursor-pointer")],
            [
              `${attempt.kind} ${attempt.id}: ${attempt.exitCode === null ? "incomplete" : `exit ${attempt.exitCode}`} at ${attempt.commitSha.slice(0, 12)}`,
            ],
          ),
          h.pre([h.Class("overflow-x-auto whitespace-pre-wrap text-mono-sm")], [attempt.command]),
          ...(attempt.limitation === null
            ? []
            : [h.p([h.Class("text-destructive")], [attempt.limitation])]),
          h.pre(
            [h.Class("max-h-80 overflow-auto whitespace-pre-wrap text-mono-sm")],
            [attempt.output],
          ),
          ...(attempt.truncated
            ? [h.p([h.Class("text-ink-muted")], ["Earlier output was truncated."])]
            : []),
        ],
      ),
    ),
    ...(patch === null || tab !== "Patch"
      ? []
      : [
          h.details(
            [h.Class("text-body-sm")],
            [
              h.summary(
                [h.Class("cursor-pointer")],
                [`Validated test patch at ${patch.baseCommit.slice(0, 12)}`],
              ),
              ...patch.files.map((file) => h.p([], [`${file.path}: ${file.rationale}`])),
              h.pre([h.Class("max-h-96 overflow-auto whitespace-pre text-mono-sm")], [patch.diff]),
            ],
          ),
        ]),
  ]
}

const runActions = (h: HtmlBuilder<Message>, model: Model, run: ReviewRun): ReadonlyArray<Html> =>
  run.queuePosition !== null
    ? [
        Button.view(h, {
          variant: "secondary",
          size: "sm",
          label: model.cancelling === run.runId ? "Cancelling…" : "Cancel run",
          onClick: Message.ClickedCancel({ runId: run.runId }),
          isDisabled: model.cancelling !== null,
          attributes: [h.DataAttribute("action", "cancel-run")],
        }),
      ]
    : run.canPublish && run.savedPublication == null
      ? [
          Button.view(h, {
            variant: "secondary",
            size: "sm",
            label: model.publishing === run.runId ? "Publishing…" : "Publish results",
            onClick: Message.ClickedPublish({ runId: run.runId }),
            isDisabled: model.publishing !== null,
            attributes: [h.DataAttribute("action", "publish-results")],
          }),
        ]
      : []

const runRow = (h: HtmlBuilder<Message>, model: Model, run: ReviewRun): Html =>
  Table.row(h, {
    className: cn(
      "cursor-pointer border-b border-border-subtle last:border-b-0 hover:bg-surface-muted",
      model.drawer.isOpen && model.selectedRunId === run.runId && "bg-accent",
    ),
    attributes: [
      h.DataAttribute("run", run.runId),
      h.DataAttribute("status", run.status),
      h.OnClick(Message.ClickedRun({ runId: run.runId })),
    ],
    children: [
      cell(
        h,
        [
          Button.view(h, {
            variant: "ghost",
            className: "h-auto min-h-10 w-full justify-start whitespace-normal text-left",
            label: `#${run.issueNumber} ${run.issueTitle ?? "Issue review"}`,
            onClick: Message.ClickedRun({ runId: run.runId }),
            attributes: [
              h.AriaLabel(`View run ${run.runId} for issue #${run.issueNumber}`),
              h.Attribute("aria-haspopup", "dialog"),
            ],
          }),
        ],
        "w-full min-w-40",
      ),
      cell(
        h,
        [
          chip(h, { variant: statusVariant[run.status], children: [statusLabel(run)] }),
          ...(run.dryRun ? [chip(h, { className: "ml-1", children: ["dry-run"] })] : []),
        ],
        "min-w-28",
      ),
      cell(h, [run.invokerLogin], "hidden font-mono text-mono-sm md:table-cell"),
      cell(h, [stamp(run.acceptedAt)], "hidden whitespace-nowrap text-ink-muted sm:table-cell"),
    ],
  })

const drawer = (h: HtmlBuilder<Message>, model: Model): Html => {
  const run = model.runs.find((candidate) => candidate.runId === model.selectedRunId)
  return h.submodel({
    slotId: "review-details",
    model: model.drawer,
    view: Sheet.view,
    toParentMessage: (message) => Message.GotDrawerMessage({ message }),
    viewInputs: Sheet.styledViewInputs(h, {
      side: "right",
      panelClass:
        "data-[side=right]:w-full data-[side=right]:sm:max-w-[620px] data-[side=right]:rounded-none overflow-y-auto overscroll-contain",
      content: (h, render) => [
        h.div(
          [h.Class("relative min-w-0 space-y-5 p-5 sm:p-7 [overflow-wrap:anywhere]")],
          [
            h.button(
              [
                ...render.closeButton,
                h.Id("close-review-details"),
                h.AriaLabel("Close run details"),
                h.Class(
                  "absolute right-4 top-4 flex size-10 items-center justify-center rounded-md hover:bg-surface-muted",
                ),
              ],
              [Icon.view(h, X, "size-4")],
            ),
            h.h2(
              [...render.title, h.Class("pr-10 text-h2 font-semibold")],
              [
                run === undefined
                  ? "Run details"
                  : `#${run.issueNumber} ${run.issueTitle ?? "Issue review"}`,
              ],
            ),
            h.p(
              [...render.description, h.Class("text-body-sm text-ink-muted")],
              [
                run === undefined
                  ? "This run is no longer in the recent history."
                  : `Invoked by ${run.invokerLogin} · ${stamp(run.acceptedAt)}`,
              ],
            ),
            ...(run === undefined
              ? []
              : [
                  h.div(
                    [h.Class("flex flex-wrap gap-2")],
                    [
                      chip(h, { variant: statusVariant[run.status], children: [statusLabel(run)] }),
                      ...(run.dryRun ? [chip(h, { children: ["dry-run"] })] : []),
                    ],
                  ),
                  h.p([h.Class("text-body-sm text-ink-muted")], [`Duration: ${duration(run)}`]),
                  ...(run.commitSha === null
                    ? []
                    : [
                        h.p(
                          [h.Class("border-y border-border py-3 text-body-sm text-ink-muted")],
                          [
                            `Evidence read at ${run.defaultBranch ?? "the default branch"} `,
                            h.span(
                              [h.Class("font-mono text-mono-sm")],
                              [run.commitSha.slice(0, 12)],
                            ),
                          ],
                        ),
                      ]),
                  h.nav(
                    [
                      h.AriaLabel("Run detail sections"),
                      h.Class("flex gap-1 border-b border-border"),
                    ],
                    DetailTab.literals.map((tab) =>
                      Button.view(h, {
                        variant: "ghost",
                        size: "sm",
                        label: tab === "Evidence" ? `Evidence ${run.evidence.length}` : tab,
                        onClick: Message.ClickedDetailTab({ tab }),
                        attributes: [h.Attribute("aria-pressed", String(model.detailTab === tab))],
                        className: cn(
                          "rounded-none border-0 border-b-2 border-transparent pb-3 pt-2 h-auto",
                          model.detailTab === tab && "border-primary text-primary",
                        ),
                      }),
                    ),
                  ),
                  h.div(
                    [h.Class("space-y-4"), h.DataAttribute("slot", "run-detail-content")],
                    model.detailTab === "Overview"
                      ? overview(h, run)
                      : model.detailTab === "Evidence"
                        ? [
                            run.evidence.length === 0
                              ? h.p(
                                  [h.Class("text-body-sm text-ink-muted")],
                                  ["No evidence has been saved yet."],
                                )
                              : h.ul(
                                  [h.Class("space-y-4")],
                                  run.evidence.map((item) => evidenceItem(h, item)),
                                ),
                          ]
                        : model.detailTab === "Execution" && run.reproduction.attempts.length === 0
                          ? [
                              h.p(
                                [h.Class("text-body-sm text-ink-muted")],
                                ["No setup or test commands have been saved yet."],
                              ),
                            ]
                          : model.detailTab === "Patch" &&
                              run.reproduction.patch === null &&
                              run.draftPublication === null
                            ? [
                                h.p(
                                  [h.Class("text-body-sm text-ink-muted")],
                                  ["No test patch has been proposed."],
                                ),
                              ]
                            : reproductionDetails(h, run, model.detailTab),
                  ),
                  h.div(
                    [h.Class("flex flex-wrap gap-2 border-t border-border pt-4")],
                    runActions(h, model, run),
                  ),
                ]),
          ],
        ),
      ],
    }),
  })
}

const filteredRuns = (model: Model) =>
  model.runs.filter(
    (run) =>
      model.filter === "All runs" ||
      (model.filter === "Active"
        ? run.queuePosition !== null
        : run.status === "failed" || run.status === "interrupted"),
  )

export const view = Submodel.defineView<Model, Message, Record<string, never>>((model, _, h) =>
  Page.layout(h, {
    attributes: [h.AriaLabel("Issue reviews")],
    main: [
      Page.header(h, {
        title: "Reviews",
        lede: "Review runs from the last 14 days, newest first. Older details expire. One run is active per issue; later invocations wait behind it.",
        actions: [
          Button.view(h, {
            variant: "secondary",
            label: h.span([h.Class("contents")], [Icon.view(h, RotateCw, "size-4"), "Refresh"]),
            onClick: Message.ClickedRefresh(),
            isDisabled: model.loading,
          }),
        ],
      }),
      model.error
        ? h.div(
            [h.Role("alert"), h.Class("flex items-center justify-between gap-3 text-body-sm")],
            [
              h.span([h.Class("text-destructive")], [model.error]),
              Button.view(h, {
                label: "Retry",
                variant: "secondary",
                size: "sm",
                onClick: Message.ClickedRefresh(),
                isDisabled: model.loading,
              }),
            ],
          )
        : h.empty,
      h.nav(
        [h.AriaLabel("Filter review runs"), h.Class("flex gap-2")],
        RunFilter.literals.map((filter) =>
          Button.view(h, {
            variant: model.filter === filter ? "secondary" : "ghost",
            size: "sm",
            label: `${filter} ${filteredRuns({ ...model, filter }).length}`,
            onClick: Message.ClickedFilter({ filter }),
            attributes: [h.Attribute("aria-pressed", String(model.filter === filter))],
          }),
        ),
      ),
      model.runs.length > 0 && filteredRuns(model).length === 0
        ? emptyPanel(h, { children: ["No runs match this filter."] })
        : model.runs.length === 0
          ? emptyPanel(h, {
              children: [
                model.initialized
                  ? "No review runs in the last 14 days. Older details have expired. Post /janitor in a new comment on an open issue to start one."
                  : "Loading review history…",
              ],
            })
          : panel(h, {
              flush: true,
              children: [
                Table.table(h, {
                  children: [
                    Table.head(h, [
                      h.tr(
                        [],
                        [
                          head(h, "Issue"),
                          head(h, "Status"),
                          head(h, "Invoked by", "hidden md:table-cell"),
                          head(h, "Accepted", "hidden sm:table-cell"),
                        ],
                      ),
                    ]),
                    Table.body(
                      h,
                      filteredRuns(model).map((run) => runRow(h, model, run)),
                    ),
                  ],
                }),
              ],
            }),
      drawer(h, model),
    ],
  }),
)
