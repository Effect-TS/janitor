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
import { RotateCw } from "lucide"
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
 * once it stopped, why. Cancel run asks the server, which checks the
 * teammate's current GitHub permission before stopping the run.
 */

export const Model = Schema.Struct({
  repositoryId: Schema.String,
  active: Schema.Boolean,
  runs: Schema.Array(ReviewRun),
  loading: Schema.Boolean,
  initialized: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  generation: Schema.Int,
  /** The run whose cancellation is in flight. */
  cancelling: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type

export const init = (): Model => ({
  repositoryId: "",
  active: false,
  runs: [],
  loading: false,
  initialized: false,
  error: null,
  generation: 0,
  cancelling: null,
})

export const Message = defineMessageUnion({
  Activated: { repositoryId: Schema.String, active: Schema.Boolean },
  Polled: {},
  ClickedRefresh: {},
  Loaded: { generation: Schema.Int, runs: ReviewHistory.fields.runs },
  Failed: { generation: Schema.Int, reason: Schema.String },
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

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    Activated: ({ repositoryId, active }) => {
      if (model.repositoryId === repositoryId && model.active === active) return { model }
      const next: Model =
        repositoryId === model.repositoryId
          ? { ...model, active, loading: false, generation: model.generation + 1 }
          : { ...init(), repositoryId, active, generation: model.generation + 1 }
      return active ? fetchHistory(next) : { model: next }
    },
    Polled: () => (model.error ? { model } : fetchHistory(model)),
    ClickedRefresh: () => fetchHistory({ ...model, error: null }),
    Loaded: ({ generation, runs }) =>
      generation !== model.generation || !model.active
        ? { model }
        : { model: { ...model, runs, loading: false, initialized: true, error: null } },
    Failed: ({ generation, reason }) =>
      generation !== model.generation
        ? { model }
        : { model: { ...model, loading: false, error: reason } },
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

const head = (h: HtmlBuilder<Message>, text: string, className?: string) =>
  Table.headCell(h, { className: cn("h-8", className), children: [text] })
const cell = (
  h: HtmlBuilder<Message>,
  children: ReadonlyArray<Html | string>,
  className?: string,
) => Table.cell(h, { className: cn("py-2 align-top", className), children })

const runRow = (h: HtmlBuilder<Message>, model: Model, run: ReviewRun): Html => {
  const live = run.queuePosition !== null
  const busy = model.cancelling === run.runId
  return Table.row(h, {
    className: "border-b border-border-subtle last:border-b-0",
    attributes: [h.DataAttribute("run", run.runId), h.DataAttribute("status", run.status)],
    children: [
      cell(
        h,
        [
          h.span([h.Class("font-mono text-mono-sm")], [`#${run.issueNumber}`]),
          ...(run.issueTitle === null
            ? []
            : [h.span([h.Class("ml-2 text-body-md")], [run.issueTitle])]),
        ],
        "min-w-40 whitespace-nowrap",
      ),
      cell(h, [h.span([h.Class("font-mono text-mono-sm")], [run.invokerLogin])], "min-w-28"),
      cell(
        h,
        [
          chip(h, { variant: statusVariant[run.status], children: [statusLabel(run)] }),
          ...(run.dryRun ? [chip(h, { className: "ml-1", children: ["dry-run"] })] : []),
        ],
        "min-w-36 whitespace-nowrap",
      ),
      cell(
        h,
        [
          h.p([h.Class("line-clamp-2 text-body-md")], [run.instructions]),
          ...(run.cancelReason === null
            ? []
            : [
                h.p(
                  [h.Class("mt-1 text-body-sm text-ink-muted")],
                  [
                    run.cancelledBy === null
                      ? run.cancelReason
                      : `${run.cancelReason} (${run.cancelledBy})`,
                  ],
                ),
              ]),
        ],
        "w-full max-w-0",
      ),
      cell(h, [stamp(run.acceptedAt)], "min-w-36 whitespace-nowrap text-ink-muted"),
      cell(
        h,
        live
          ? [
              Button.view(h, {
                variant: "secondary",
                size: "sm",
                label: busy ? "Cancelling…" : "Cancel run",
                onClick: Message.ClickedCancel({ runId: run.runId }),
                isDisabled: model.cancelling !== null,
                attributes: [h.DataAttribute("action", "cancel-run")],
              }),
            ]
          : [],
        "text-right",
      ),
    ],
  })
}

export const view = Submodel.defineView<Model, Message, Record<string, never>>((model, _, h) =>
  Page.layout(h, {
    attributes: [h.AriaLabel("Issue reviews")],
    main: [
      Page.header(h, {
        title: "Reviews",
        lede: "Every review run an authorized @janitor mention started in this repository, newest first. One run is active per issue; later invocations wait behind it.",
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
      model.runs.length === 0
        ? emptyPanel(h, {
            children: [
              model.initialized
                ? "No review runs yet. Mention @janitor in a comment on an open issue to start one."
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
                        head(h, "Invoked by"),
                        head(h, "Status"),
                        head(h, "Instructions"),
                        head(h, "Accepted"),
                        head(h, "", "w-32"),
                      ],
                    ),
                  ]),
                  Table.body(
                    h,
                    model.runs.map((run) => runRow(h, model, run)),
                  ),
                ],
              }),
            ],
          }),
    ],
  }),
)
