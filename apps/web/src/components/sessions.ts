import {
  type ExecutionState,
  type RecoveryStatus,
  SessionCursor,
  SessionDetail,
  SessionPage,
  SessionSummary,
  USAGE_NOTE,
  USAGE_UNAVAILABLE,
  type RecordedUsage,
} from "@janitor/domain/Agent/Observation"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage"
import * as Command from "foldkit/command"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import * as Submodel from "foldkit/submodel"
import * as Subscription from "foldkit/subscription"
import * as Update from "foldkit/update"
import * as Button from "@/components/ui/button"
import * as Live from "@/components/live"
import { readFailure, reasonOf } from "@/lib/api"
import * as Icon from "@/lib/icons"
import { cn } from "@/lib/utils"
import * as Routes from "@/routes"
import { Bot, CircleAlert, ExternalLink, GitPullRequest, MessageSquare } from "lucide"

/**
 * The Janitor dashboard: every teammate sees the same compact list of agent
 * sessions and can open a session's facts. Data comes from plain HTTP reads;
 * the live channel only says when to read again. A failed refresh keeps the
 * last known data on screen and says so, because a stale read is not a
 * runner failure.
 */

export const Model = Schema.Struct({
  /** True while a sessions route is on screen; the live channel follows it. */
  active: Schema.Boolean,
  selected: Schema.NullOr(Schema.String),
  sessions: Schema.Array(SessionSummary),
  cursor: Schema.NullOr(SessionCursor),
  detail: Schema.NullOr(SessionDetail),
  loaded: Schema.Boolean,
  loading: Schema.Boolean,
  loadingMore: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  /** The screen shows data an attempted refresh could not replace. */
  stale: Schema.Boolean,
  /** An invalidation arrived during a read; read again once it lands. */
  invalidated: Schema.Boolean,
  generation: Schema.Int,
  live: Live.Model,
})
export type Model = typeof Model.Type

export const init = (): Model => ({
  active: false,
  selected: null,
  sessions: [],
  cursor: null,
  detail: null,
  loaded: false,
  loading: false,
  loadingMore: false,
  error: null,
  stale: false,
  invalidated: false,
  generation: 0,
  live: Live.init(),
})

export const Message = defineMessageUnion({
  ClickedRetry: {},
  ClickedMore: {},
  LoadedList: { generation: Schema.Int, page: SessionPage, append: Schema.Boolean },
  ListFailed: { generation: Schema.Int, reason: Schema.String },
  LoadedDetail: { generation: Schema.Int, detail: SessionDetail },
  DetailFailed: { generation: Schema.Int, reason: Schema.String },
  GotLiveMessage: { message: Live.Message },
})
export type Message = typeof Message.Type

const base = "/api/v1/sessions"
export const PAGE_SIZE = 25
/** The server's cap; a refresh re-reads at most this many already-loaded rows. */
const MAX_REFRESH = 100

export const FetchList = Command.define("FetchSessions", {
  args: { generation: Schema.Int, cursor: Schema.NullOr(SessionCursor), limit: Schema.Int },
  messages: [Message.LoadedList, Message.ListFailed],
  execute: ({ generation, cursor, limit }) =>
    Effect.gen(function* () {
      const params = new URLSearchParams({ limit: String(limit) })
      if (cursor !== null) params.set("cursor", JSON.stringify(cursor))
      const response = yield* HttpClient.get(`${base}?${params}`)
      if (response.status !== 200)
        return yield* readFailure(response, "Sessions could not be loaded. Retry to continue.")
      const page = yield* HttpIncomingMessage.schemaBodyJson(SessionPage)(response)
      return Message.LoadedList({ generation, page, append: cursor !== null })
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(Message.ListFailed({ generation, reason: reasonOf(error) })),
      ),
    ),
})

export const FetchDetail = Command.define("FetchSession", {
  args: { generation: Schema.Int, sessionId: Schema.String },
  messages: [Message.LoadedDetail, Message.DetailFailed],
  execute: ({ generation, sessionId }) =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`${base}/${encodeURIComponent(sessionId)}`)
      if (response.status !== 200)
        return yield* readFailure(response, "The session could not be loaded. Retry to continue.")
      const detail = yield* HttpIncomingMessage.schemaBodyJson(SessionDetail)(response)
      return Message.LoadedDetail({ generation, detail })
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(Message.DetailFailed({ generation, reason: reasonOf(error) })),
      ),
    ),
})

type Step = Update.Return<Model, Message, HttpClient.HttpClient>

/**
 * Reads whatever the screen shows again; older replies are fenced by the
 * generation. A list refresh re-reads as many rows as are on screen, so
 * pages loaded with "Load more" survive an invalidation.
 */
const refresh = (model: Model): Step => {
  const generation = model.generation + 1
  const next = evo(model, {
    generation: () => generation,
    loading: () => true,
    invalidated: () => false,
  })
  return {
    model: next,
    commands: [
      model.selected === null
        ? FetchList({
            generation,
            cursor: null,
            limit: Math.min(MAX_REFRESH, Math.max(PAGE_SIZE, model.sessions.length)),
          })
        : FetchDetail({ generation, sessionId: model.selected }),
    ],
  }
}

/** A read finished: apply an invalidation that arrived meanwhile. */
const settle = (model: Model): Step => (model.invalidated ? refresh(model) : { model })

/** Entering a sessions route: the list, or one session's facts. */
export const enter = (model: Model, sessionId: string | null): Step =>
  refresh(
    evo(model, {
      active: () => true,
      selected: () => sessionId,
      detail: (detail) => (detail !== null && detail.sessionId === sessionId ? detail : null),
      error: () => null,
      live: (live) => (model.active ? live : { ...live, status: "connecting" as const }),
    }),
  )

/** Leaving the sessions routes closes the live channel; the last data stays for a quick return. */
export const leave = (model: Model): Model =>
  model.active ? evo(model, { active: () => false, invalidated: () => false }) : model

export const update = (model: Model, message: Message): Step =>
  Message.match<Step>(message, {
    ClickedRetry: () =>
      refresh(
        evo(model, {
          live: (live) => ({ ...live, retry: live.retry + 1, status: "connecting" as const }),
        }),
      ),
    ClickedMore: () =>
      model.cursor === null || model.loadingMore || model.selected !== null
        ? { model }
        : {
            model: evo(model, {
              generation: (generation) => generation + 1,
              loadingMore: () => true,
            }),
            commands: [
              FetchList({
                generation: model.generation + 1,
                cursor: model.cursor,
                limit: PAGE_SIZE,
              }),
            ],
          },
    LoadedList: ({ generation, page, append }) => {
      if (generation !== model.generation) return { model }
      const known = new Set(page.sessions.map((session) => session.sessionId))
      return settle(
        evo(model, {
          sessions: (sessions) =>
            append
              ? [...sessions.filter((session) => !known.has(session.sessionId)), ...page.sessions]
              : page.sessions,
          cursor: () => page.cursor,
          loaded: () => true,
          loading: () => false,
          loadingMore: () => false,
          stale: () => false,
          error: () => null,
        }),
      )
    },
    ListFailed: ({ generation, reason }) =>
      generation !== model.generation
        ? { model }
        : settle(
            evo(model, {
              loading: () => false,
              loadingMore: () => false,
              stale: () => model.loaded,
              error: () => reason,
            }),
          ),
    LoadedDetail: ({ generation, detail }) =>
      generation !== model.generation
        ? { model }
        : settle(
            evo(model, {
              detail: () => detail,
              loading: () => false,
              stale: () => false,
              error: () => null,
            }),
          ),
    DetailFailed: ({ generation, reason }) =>
      generation !== model.generation
        ? { model }
        : settle(
            evo(model, {
              loading: () => false,
              stale: () => model.detail !== null,
              error: () => reason,
            }),
          ),
    GotLiveMessage: ({ message }) => {
      switch (message._tag) {
        case "Visibility":
          return {
            model: evo(model, {
              live: (live) => ({ ...live, visible: message.visible, status: "connecting" }),
            }),
          }
        case "Retry":
          return {
            model: evo(model, {
              live: (live) => ({ ...live, retry: live.retry + 1, status: "connecting" }),
            }),
          }
      }
      if (message.channel !== Live.SESSIONS_CHANNEL || !model.active) return { model }
      if (message._tag === "Disconnected")
        return {
          model: evo(model, {
            live: (live) => ({ ...live, status: message.denied ? "denied" : "disconnected" }),
          }),
        }
      const connected = evo(model, {
        live: (live) => ({
          ...live,
          status: message._tag === "Fallback" ? live.status : ("connected" as const),
        }),
      })
      // A fresh connection reads everything again: frames may have been missed
      // while it was down. Otherwise only the sessions topic matters here.
      const relevant =
        message._tag === "Fallback" ||
        message.connected ||
        message.topics.includes(Live.SESSIONS_CHANNEL)
      if (!relevant) return { model: connected }
      return connected.loading
        ? { model: evo(connected, { invalidated: () => true }) }
        : refresh(connected)
    },
  })

const lifted = (stream: Stream.Stream<Live.Message, never, HttpClient.HttpClient>) =>
  Stream.map(stream, (message) => Message.GotLiveMessage({ message }))

/** The same socket and fallback as a repository page, on the team-wide channel while a sessions route is open. */
export const subscriptions = Subscription.make<Model, Message, HttpClient.HttpClient>()(
  (entry) => ({
    sessionsSocket: entry(
      {
        channel: Schema.String,
        endpoint: Schema.String,
        visible: Schema.Boolean,
        retry: Schema.Int,
      },
      {
        modelToDependencies: (model) => ({
          channel: model.active ? Live.SESSIONS_CHANNEL : "",
          endpoint: Live.sessionsEndpoint,
          visible: model.live.visible,
          retry: model.live.retry,
        }),
        dependenciesToStream: (dependencies) =>
          lifted(Live.subscriptions.liveSocket.dependenciesToStream(dependencies)),
      },
    ),
    sessionsFallback: entry(
      { channel: Schema.String, visible: Schema.Boolean, status: Live.Model.fields.status },
      {
        modelToDependencies: (model) => ({
          channel: model.active ? Live.SESSIONS_CHANNEL : "",
          visible: model.live.visible,
          status: model.live.status,
        }),
        dependenciesToStream: (dependencies) =>
          lifted(Live.subscriptions.liveFallback.dependenciesToStream(dependencies)),
      },
    ),
    sessionsVisibility: entry(
      { active: Schema.Boolean },
      {
        modelToDependencies: (model) => ({ active: model.active }),
        dependenciesToStream: ({ active }) =>
          active
            ? lifted(Live.subscriptions.liveVisibility.dependenciesToStream({}))
            : Stream.empty,
      },
    ),
  }),
)

// VIEW

const EXECUTION_LABEL: Record<ExecutionState, string> = {
  working: "Working",
  idle: "Idle",
  blocked: "Blocked",
  failed: "Failed",
}

const EXECUTION_CLASS: Record<ExecutionState, string> = {
  working: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  idle: "bg-muted text-muted-foreground",
  blocked: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  failed: "bg-destructive/10 text-destructive",
}

export const formatTime = (time: DateTime.Utc): string =>
  `${DateTime.formatIso(time).slice(0, 16).replace("T", " ")} UTC`

const formatCount = (value: number): string => value.toLocaleString("en-US")

const platformName = (platform: "slack" | "github"): string =>
  platform === "slack" ? "Slack" : "GitHub"

export const describeUsage = (usage: RecordedUsage | null): string =>
  usage === null
    ? USAGE_UNAVAILABLE
    : `${formatCount(usage.input)} in · ${formatCount(usage.output)} out`

export const describeFreshness = (session: SessionSummary): string =>
  session.freshness.error !== null
    ? `Last runner read failed: ${session.freshness.error}`
    : session.freshness.readAt === null
      ? "Not yet read from the runner"
      : `Confirmed ${formatTime(session.freshness.readAt)}`

const badge = (h: HtmlBuilder<Message>, session: SessionSummary): Html =>
  h.span(
    [
      h.Class(
        cn(
          "inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-xs font-medium",
          EXECUTION_CLASS[session.execution],
        ),
      ),
    ],
    [EXECUTION_LABEL[session.execution]],
  )

const externalLink = (h: HtmlBuilder<Message>, url: string, label: string): Html =>
  h.a(
    [
      h.Href(url),
      h.Target("_blank"),
      h.Rel("noreferrer"),
      h.Class("inline-flex items-center gap-1 text-sm underline"),
    ],
    [label, Icon.view(h, ExternalLink, "size-3")],
  )

const links = (h: HtmlBuilder<Message>, session: SessionSummary): ReadonlyArray<Html> => [
  ...(session.homeThread === null
    ? []
    : [
        h.span(
          [h.Class("inline-flex items-center gap-1")],
          [
            Icon.view(h, MessageSquare, "size-3"),
            externalLink(h, session.homeThread.url, "Home thread"),
          ],
        ),
      ]),
  ...session.pullRequests.map((pr) =>
    h.span(
      [h.Class("inline-flex items-center gap-1")],
      [Icon.view(h, GitPullRequest, "size-3"), externalLink(h, pr.url, `PR #${pr.number}`)],
    ),
  ),
]

const row = (h: HtmlBuilder<Message>, session: SessionSummary): Html =>
  h.li(
    [h.Class("flex flex-col gap-1 py-3")],
    [
      h.div(
        [h.Class("flex flex-wrap items-center gap-2")],
        [
          badge(h, session),
          h.a(
            [
              h.Href(Routes.session({ sessionId: session.sessionId })),
              h.Class("text-sm font-medium underline-offset-4 hover:underline"),
            ],
            [session.title],
          ),
          session.repository === null
            ? h.span([h.Class("text-xs text-muted-foreground")], ["No repository yet"])
            : h.span(
                [h.Class("text-xs text-muted-foreground")],
                [`${session.repository.owner}/${session.repository.repo}`],
              ),
        ],
      ),
      session.reason === null
        ? h.empty
        : h.p([h.Class("text-xs text-muted-foreground")], [session.reason]),
      h.div(
        [h.Class("flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground")],
        [
          h.span([], [`Activity ${formatTime(session.activityAt)}`]),
          h.span([h.Title(USAGE_NOTE)], [describeUsage(session.usage)]),
          session.deliveryWarning === null
            ? h.empty
            : h.span(
                [h.Class("inline-flex items-center gap-1 text-amber-700 dark:text-amber-300")],
                [Icon.view(h, CircleAlert, "size-3"), `Delivery: ${session.deliveryWarning}`],
              ),
          ...links(h, session),
        ],
      ),
    ],
  )

const liveStatus = (h: HtmlBuilder<Message>, model: Model): Html => {
  const status = model.live.status
  if (status === "connected" && !model.stale) return h.empty
  const text =
    status === "denied"
      ? "Live updates unavailable. Your membership may have changed; reload to continue."
      : model.stale
        ? "Showing last known data; the latest refresh failed."
        : "Reconnecting to live updates…"
  return h.p(
    [h.Role("status"), h.Class("flex flex-wrap gap-2 text-xs text-muted-foreground")],
    [
      h.span([], [text]),
      h.button(
        [h.Class("underline"), h.OnClick(Message.ClickedRetry())],
        [status === "denied" ? "Reconnect" : "Retry"],
      ),
    ],
  )
}

const fact = (h: HtmlBuilder<Message>, label: string, value: ReadonlyArray<Html | string>) =>
  h.div(
    [h.Class("flex flex-col gap-0.5")],
    [h.dt([h.Class("text-xs text-muted-foreground")], [label]), h.dd([h.Class("text-sm")], value)],
  )

/**
 * One line per platform, stating what the scan is doing rather than what it
 * found. A caught-up scan with nothing pending says so; a gap is shown next
 * to it because being caught up never means nothing was lost.
 */
const describeRecovery = (status: RecoveryStatus): string => {
  const parts: Array<string> = []
  if (status.completedAt === null) parts.push("not scanned yet")
  else if (status.overdue) parts.push(`scan overdue, last ${formatTime(status.completedAt)}`)
  if (status.incomplete) parts.push("results still arriving")
  if (status.hydrating > 0)
    parts.push(
      `fetching comments for ${formatCount(status.hydrating)} contribution${status.hydrating === 1 ? "" : "s"}`,
    )
  if (status.warning !== null) parts.push(`retrying past: ${status.warning}`)
  return `${platformName(status.platform)}: ${parts.length === 0 ? `caught up, last scan ${formatTime(status.completedAt!)}` : parts.join("; ")}`
}

const recoveryView = (h: HtmlBuilder<Message>, recovery: ReadonlyArray<RecoveryStatus>): Html =>
  recovery.length === 0
    ? h.empty
    : h.section(
        [h.Class("rounded-lg border p-5 space-y-2")],
        [
          h.h2([h.Class("text-base font-semibold")], ["Recovery"]),
          h.ul(
            [h.Class("text-sm space-y-2")],
            recovery.map((status) =>
              h.li(
                [h.Class("space-y-0.5")],
                [
                  h.p(
                    status.overdue || status.incomplete || status.warning !== null
                      ? [h.Class("text-amber-700 dark:text-amber-300")]
                      : [],
                    [describeRecovery(status)],
                  ),
                  status.gap === null
                    ? h.empty
                    : h.p([h.Class("text-xs text-muted-foreground")], [status.gap]),
                ],
              ),
            ),
          ),
        ],
      )

const detailView = (h: HtmlBuilder<Message>, detail: SessionDetail): Html =>
  h.div(
    [h.Class("space-y-5")],
    [
      h.a([h.Href(Routes.sessions()), h.Class("text-sm underline")], ["All sessions"]),
      h.div(
        [h.Class("flex flex-wrap items-center gap-2")],
        [badge(h, detail), h.h1([h.Class("text-lg font-semibold")], [detail.title])],
      ),
      detail.reason === null ? h.empty : h.p([h.Class("text-sm")], [detail.reason]),
      detail.latestError === null
        ? h.empty
        : h.p(
            [h.Role("alert"), h.Class("text-sm text-destructive")],
            [`Latest error: ${detail.latestError}`],
          ),
      detail.deliveryWarning === null
        ? h.empty
        : h.p(
            [h.Role("alert"), h.Class("text-sm text-amber-700 dark:text-amber-300")],
            [`Delivery: ${detail.deliveryWarning}`],
          ),
      h.dl(
        [h.Class("grid gap-4 rounded-lg border p-5 sm:grid-cols-2")],
        [
          fact(h, "Repository", [
            detail.repository === null
              ? "Not selected yet"
              : `${detail.repository.owner}/${detail.repository.repo}`,
          ]),
          fact(h, "Links", links(h, detail).length === 0 ? ["None"] : links(h, detail)),
          fact(h, "Latest activity", [formatTime(detail.activityAt)]),
          fact(h, "Projection", [describeFreshness(detail)]),
          fact(h, "Inputs", [
            `${formatCount(detail.acceptedInputs)} accepted, ${formatCount(detail.pendingInputs)} awaiting the runner${detail.lastInputAt === null ? "" : `, last ${formatTime(detail.lastInputAt)}`}`,
          ]),
          fact(h, "Recorded usage", [
            h.span([], [describeUsage(detail.usage)]),
            h.p([h.Class("text-xs text-muted-foreground")], [USAGE_NOTE]),
          ]),
        ],
      ),
      detail.pendingDelivery.length === 0
        ? h.empty
        : h.section(
            [h.Class("rounded-lg border p-5 space-y-2")],
            [
              h.h2([h.Class("text-base font-semibold")], ["Pending delivery"]),
              h.ul(
                [h.Class("text-sm space-y-1")],
                detail.pendingDelivery.map((item) =>
                  h.li(
                    [],
                    [
                      `${platformName(item.platform)} reply ${item.state}${item.error === null ? "" : `: ${item.error}`}`,
                    ],
                  ),
                ),
              ),
            ],
          ),
      recoveryView(h, detail.recovery),
      h.p([h.Class("text-xs text-muted-foreground")], [describeFreshness(detail)]),
    ],
  )

const listView = (h: HtmlBuilder<Message>, model: Model): Html =>
  h.div(
    [h.Class("space-y-4")],
    [
      h.div(
        [h.Class("flex items-center gap-3")],
        [
          Icon.view(h, Bot, "size-6 text-muted-foreground"),
          h.h1([h.Class("text-lg font-semibold")], ["Sessions"]),
        ],
      ),
      h.p(
        [h.Class("text-sm text-muted-foreground")],
        [
          "Every teammate sees the same sessions. Collaborate with an agent in its home thread; usage totals are recorded by OpenCode and are not a bill.",
        ],
      ),
      !model.loaded && model.loading
        ? h.p([h.Role("status")], ["Loading sessions…"])
        : model.loaded && model.sessions.length === 0
          ? h.p([h.Class("text-sm text-muted-foreground")], ["No agent sessions yet."])
          : h.ul(
              [h.Class("divide-y")],
              model.sessions.map((session) => row(h, session)),
            ),
      model.cursor === null
        ? h.empty
        : Button.view(h, {
            label: model.loadingMore ? "Loading…" : "Load more",
            onClick: Message.ClickedMore(),
            variant: "outline",
            size: "sm",
            isDisabled: model.loadingMore,
          }),
    ],
  )

export const view = Submodel.defineView<Model, Message, Record<string, never>>(
  (model, _inputs, h) =>
    h.div(
      [h.Class("mx-auto w-full max-w-3xl p-6 space-y-4")],
      [
        liveStatus(h, model),
        model.error !== null && !model.stale
          ? h.p([h.Role("alert"), h.Class("text-sm text-destructive")], [model.error])
          : h.empty,
        model.selected === null
          ? listView(h, model)
          : model.detail === null
            ? model.loading
              ? h.p([h.Role("status")], ["Loading session…"])
              : h.a([h.Href(Routes.sessions()), h.Class("text-sm underline")], ["All sessions"])
            : detailView(h, model.detail),
      ],
    ),
)
