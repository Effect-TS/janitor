import * as Tooltip from "@foldkit/ui/tooltip"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage"
import * as FoldkitCommand from "foldkit/command"
import type { Html } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import * as Submodel from "foldkit/submodel"
import * as Update from "foldkit/update"
import { RefreshCw } from "lucide"
import { buttonSizes, buttonVariants } from "@/components/ui/button"
import * as Icon from "@/lib/icons"
import { cn } from "@/lib/utils"

// CONSTANTS

export const SYNC_ENDPOINT = "/api/v1/sync"

// WIRE SCHEMA
//
// Mirrors the HTTP representation of `SyncSummary` in
// `@janitor/domain/GitHub/Sync`. Keep wire changes in sync with that schema.

export const SyncState = Schema.Literals(["idle", "syncing", "blocked", "failed"])
export type SyncState = typeof SyncState.Type

export const SyncSummary = Schema.Struct({
  state: SyncState,
  lastVerifiedAt: Schema.NullOr(Schema.DateTimeUtc),
  pendingTargets: Schema.Int,
  blockedTargets: Schema.Int,
  failedTargets: Schema.Int,
  queuedTargets: Schema.optional(Schema.Int),
  runningTargets: Schema.optional(Schema.Int),
  retryingTargets: Schema.optional(Schema.Int),
  stalledTargets: Schema.optional(Schema.Int),
  appliedItems: Schema.optional(Schema.Int),
})
export type SyncSummary = typeof SyncSummary.Type

// MODEL

export const Model = Schema.Struct({
  tooltip: Tooltip.Model,
  summary: Schema.Option(SyncSummary),
  /** When the summary was received; relative times in the tooltip count from here. */
  observedAt: Schema.Option(Schema.DateTimeUtc),
  /** Set from the button press until the request answers. */
  isRequesting: Schema.Boolean,
  isPolling: Schema.Boolean,
  needsRefresh: Schema.Boolean,
  lastError: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

/** True while the button must stay disabled and the icon spins. */
export const isSyncing = (model: Model): boolean =>
  model.isRequesting || Option.exists(model.summary, (summary) => summary.state === "syncing")

// MESSAGE

export const Message = defineMessageUnion({
  GotTooltipMessage: { message: Tooltip.Message },
  PressedSync: { repositoryId: Schema.optionalKey(Schema.String) },
  Polled: {},
  GotSummary: { summary: SyncSummary, receivedAt: Schema.DateTimeUtc },
  FailedSummary: { reason: Schema.String },
  GotRequestResult: { summary: SyncSummary, receivedAt: Schema.DateTimeUtc },
  FailedRequest: { reason: Schema.String },
})
export type Message = typeof Message.Type

/** What the parent needs to know to show toasts. */
export const OutMessage = defineMessageUnion({
  SyncStarted: { pendingTargets: Schema.Int },
  SyncFinished: {
    state: Schema.Literals(["idle", "blocked", "failed"]),
    blockedTargets: Schema.Int,
    failedTargets: Schema.Int,
  },
  SyncFailed: { reason: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

// COMMANDS

const decodeSummary = HttpIncomingMessage.schemaBodyJson(SyncSummary)

const describe = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error)

export const FetchSyncSummary = FoldkitCommand.define("FetchSyncSummary", {
  messages: [Message.GotSummary, Message.FailedSummary],
  execute: HttpClient.get(SYNC_ENDPOINT).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(decodeSummary),
    Effect.flatMap((summary) =>
      Effect.map(DateTime.now, (receivedAt) => Message.GotSummary({ summary, receivedAt })),
    ),
    Effect.catch((error) => Effect.succeed(Message.FailedSummary({ reason: describe(error) }))),
  ),
})

export const RequestSync = FoldkitCommand.define("RequestSync", {
  args: { repositoryId: Schema.optionalKey(Schema.String) },
  messages: [Message.GotRequestResult, Message.FailedRequest],
  execute: ({ repositoryId }) =>
    HttpClient.post(
      repositoryId === undefined
        ? SYNC_ENDPOINT
        : `/api/v1/repositories/${encodeURIComponent(repositoryId)}/sync`,
    ).pipe(
      Effect.flatMap((response) =>
        response.status === 409
          ? response.text.pipe(Effect.flatMap((reason) => Effect.fail({ message: reason })))
          : HttpClientResponse.filterStatusOk(response),
      ),
      Effect.flatMap(decodeSummary),
      Effect.flatMap((summary) =>
        Effect.map(DateTime.now, (receivedAt) => Message.GotRequestResult({ summary, receivedAt })),
      ),
      Effect.catch((error) => Effect.succeed(Message.FailedRequest({ reason: describe(error) }))),
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
      tooltip: Tooltip.init({ id: "sync-tooltip" }),
      summary: Option.none(),
      observedAt: Option.none(),
      isRequesting: false,
      isPolling: true,
      needsRefresh: false,
      lastError: Option.none(),
    },
    { disableChecks: true },
  ),
  commands: [FetchSyncSummary()],
})

// UPDATE

/** Shown and Hidden carry nothing this component needs to react to. */
const foldTooltipOutMessage = Match.type<Tooltip.OutMessage>().pipe(
  Match.withReturnType<Update.Step<Model, Message, HttpClient.HttpClient>>(),
  Match.tagsExhaustive({
    Shown: () => (model: Model) => ({ model }),
    Hidden: () => (model: Model) => ({ model }),
  }),
)

const foldTooltip = Update.foldChild({
  update: Tooltip.update,
  read: (model: Model) => Option.some(model.tooltip),
  write: (model, next) => evo(model, { tooltip: () => next }),
  toParentMessage: (message) => Message.GotTooltipMessage({ message }),
  foldOutMessage: foldTooltipOutMessage,
})

const stateOf = (model: Model): SyncState | undefined =>
  Option.getOrUndefined(Option.map(model.summary, (summary) => summary.state))

/** A summary arrived; announce the transition out of syncing if there was one. */
const absorbSummary = (
  model: Model,
  summary: SyncSummary,
  receivedAt: DateTime.Utc,
): UpdateReturn => {
  const wasSyncing = stateOf(model) === "syncing"
  const next: Model = evo(model, {
    summary: () => Option.some(summary),
    observedAt: () => Option.some(receivedAt),
    isPolling: () => false,
    lastError: () => Option.none<string>(),
  })
  if (model.needsRefresh)
    return {
      model: evo(next, { needsRefresh: () => false, isPolling: () => true }),
      commands: [FetchSyncSummary()],
    }
  return wasSyncing && summary.state !== "syncing"
    ? {
        model: next,
        outMessage: OutMessage.SyncFinished({
          state: summary.state,
          blockedTargets: summary.blockedTargets,
          failedTargets: summary.failedTargets,
        }),
      }
    : { model: next }
}

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    GotTooltipMessage: ({ message }) => foldTooltip(model, message),

    PressedSync: ({ repositoryId }) =>
      isSyncing(model) || model.isPolling
        ? { model }
        : {
            model: evo(model, { isRequesting: () => true, lastError: () => Option.none<string>() }),
            commands: [RequestSync(repositoryId === undefined ? {} : { repositoryId })],
          },

    Polled: () =>
      model.isRequesting || model.isPolling
        ? { model }
        : {
            model: evo(model, { isPolling: () => true }),
            commands: [FetchSyncSummary()],
          },

    GotSummary: ({ summary, receivedAt }) => absorbSummary(model, summary, receivedAt),

    FailedSummary: ({ reason }) => ({
      model: evo(model, {
        isPolling: () => model.needsRefresh,
        needsRefresh: () => false,
        lastError: () => Option.some(reason),
      }),
      commands: model.needsRefresh ? [FetchSyncSummary()] : [],
    }),

    GotRequestResult: ({ summary, receivedAt }) => ({
      model: evo(model, {
        summary: () => Option.some(summary),
        observedAt: () => Option.some(receivedAt),
        isRequesting: () => false,
        isPolling: () => model.needsRefresh,
        needsRefresh: () => false,
        lastError: () => Option.none<string>(),
      }),
      commands: model.needsRefresh ? [FetchSyncSummary()] : [],
      outMessage: OutMessage.SyncStarted({ pendingTargets: summary.pendingTargets }),
    }),

    FailedRequest: ({ reason }) => ({
      model: evo(model, {
        isRequesting: () => false,
        isPolling: () => model.needsRefresh,
        needsRefresh: () => false,
        lastError: () => Option.some(reason),
      }),
      commands: model.needsRefresh ? [FetchSyncSummary()] : [],
      outMessage: OutMessage.SyncFailed({ reason }),
    }),
  })

/** A confirmed mutation may have scheduled work while an older summary was in flight. */
export const informWorkChanged = (model: Model): UpdateReturn =>
  model.isPolling || model.isRequesting
    ? { model: evo(model, { needsRefresh: () => true }) }
    : update(model, Message.Polled())

// VIEW

const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" })

/** "3 minutes ago" for the tooltip; falls back to the absolute time past a day. */
export const describeLastSync = (lastVerifiedAt: DateTime.Utc, now: DateTime.Utc): string => {
  const seconds = Math.round(
    (DateTime.toEpochMillis(lastVerifiedAt) - DateTime.toEpochMillis(now)) / 1000,
  )
  const minutes = Math.round(seconds / 60)
  const hours = Math.round(minutes / 60)
  if (Math.abs(seconds) < 60) return relativeFormat.format(seconds, "second")
  if (Math.abs(minutes) < 60) return relativeFormat.format(minutes, "minute")
  if (Math.abs(hours) < 24) return relativeFormat.format(hours, "hour")
  return DateTime.formatUtc(lastVerifiedAt)
}

export const tooltipText = (model: Model): string =>
  Option.match(model.summary, {
    onNone: () =>
      Option.match(model.lastError, {
        onNone: () => "Checking sync status",
        onSome: (reason) => `Sync status unavailable: ${reason}`,
      }),
    onSome: (summary) => {
      switch (summary.state) {
        case "syncing":
          return [
            summary.runningTargets === undefined
              ? `Syncing ${summary.pendingTargets} scopes`
              : `${summary.runningTargets} running · ${summary.queuedTargets ?? 0} queued`,
            (summary.appliedItems ?? 0) > 0
              ? `${summary.appliedItems} items processed in active scans`
              : undefined,
            (summary.stalledTargets ?? 0) > 0
              ? `${summary.stalledTargets} stalled; recovery in progress`
              : undefined,
            summary.failedTargets > 0 ? `${summary.failedTargets} failed` : undefined,
            (summary.retryingTargets ?? 0) > 0
              ? `${summary.retryingTargets} scheduled to retry`
              : undefined,
          ]
            .filter(Boolean)
            .join(" · ")
        case "failed":
          return `${summary.failedTargets} scopes failed; ${(summary.retryingTargets ?? 0) > 0 ? "automatic retry scheduled" : "retry available"}`
        case "blocked":
          return `${summary.blockedTargets} scopes blocked`
        case "idle":
          return summary.lastVerifiedAt === null || Option.isNone(model.observedAt)
            ? "Some scopes have never synced"
            : `Oldest verification ${describeLastSync(summary.lastVerifiedAt, model.observedAt.value)}`
      }
    },
  })

export const view = Submodel.defineView<
  Model,
  Message,
  { syncDisabled: boolean; repositoryId?: string }
>((model, { syncDisabled, repositoryId }, h) => {
  const syncing = !syncDisabled && isSyncing(model)
  const disabled = syncDisabled || syncing || model.isPolling
  return h.submodel({
    slotId: "sync-tooltip",
    model: model.tooltip,
    view: Tooltip.view,
    toParentMessage: (message) => Message.GotTooltipMessage({ message }),
    viewInputs: {
      anchor: { placement: "bottom-end", gap: 4, padding: 8 },
      ariaLabel: "Re-sync GitHub",
      toView: (render): Html =>
        h.div(
          [h.Class("relative")],
          [
            h.button(
              [
                ...render.trigger,
                h.Type("button"),
                h.AriaLabel("Re-sync GitHub"),
                h.AriaDisabled(disabled),
                h.DataAttribute("state", syncDisabled ? "disabled" : syncing ? "syncing" : "idle"),
                ...(disabled
                  ? []
                  : [
                      h.OnClick(
                        Message.PressedSync(repositoryId === undefined ? {} : { repositoryId }),
                      ),
                    ]),
                h.Class(
                  cn(
                    "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md outline-none transition-all focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
                    buttonVariants.ghost,
                    buttonSizes["icon-sm"],
                    disabled && "opacity-50 cursor-default",
                    Option.isSome(model.summary) &&
                      model.summary.value.failedTargets > 0 &&
                      "text-amber-500",
                  ),
                ),
              ],
              [Icon.view(h, RefreshCw, cn("size-4 shrink-0", syncing && "animate-spin"))],
            ),
            render.isVisible
              ? h.div(
                  [
                    ...render.panel,
                    h.Class(
                      "z-50 rounded-md bg-card px-3 py-2 text-xs text-foreground shadow-md ring ring-border whitespace-nowrap",
                    ),
                  ],
                  [
                    h.div([h.Class("font-medium")], ["Re-sync GitHub"]),
                    h.div(
                      [h.Class("text-muted-foreground")],
                      [
                        syncDisabled
                          ? "Repository paused. Resume it in repository settings before syncing."
                          : tooltipText(model),
                      ],
                    ),
                  ],
                )
              : h.empty,
          ],
        ),
    },
  })
})
