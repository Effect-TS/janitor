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
import { chip, type ChipVariant } from "@/components/ui/chip"
import * as Feed from "@/components/ui/feed"
import { emptyPanel, panel } from "@/components/ui/panel"
import { sign } from "@/components/ui/sign"
import * as Live from "@/components/live"
import { readFailure, reasonOf } from "@/lib/api"
import * as Icon from "@/lib/icons"
import { cn } from "@/lib/utils"
import * as Routes from "@/routes"
import { CircleAlert, Clock, ExternalLink, GitPullRequest, MessageSquare } from "lucide"

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

/** Working is the agent running, so it takes the agent mark; blocked is a
 *  neutral state whose reason sits beside it; failed is genuine failure. */
const EXECUTION_VARIANT: Record<ExecutionState, ChipVariant> = {
  working: "agent",
  idle: "neutral",
  blocked: "neutral",
  failed: "danger",
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

/** A machine value: a timestamp, a count, an identifier. */
const mono = (h: HtmlBuilder<Message>, text: string, className?: string): Html =>
  h.span([h.Class(cn("font-mono text-mono-sm", className))], [text])

const agentDot = (h: HtmlBuilder<Message>): Html =>
  h.span([h.Class("oc-agent-dot"), h.AriaHidden(true)], [])

const badge = (h: HtmlBuilder<Message>, session: SessionSummary): Html =>
  chip(h, {
    variant: EXECUTION_VARIANT[session.execution],
    className: "shrink-0",
    children: [
      ...(session.execution === "working" ? [agentDot(h)] : []),
      EXECUTION_LABEL[session.execution],
    ],
  })

const externalLink = (
  h: HtmlBuilder<Message>,
  url: string,
  label: ReadonlyArray<Html | string>,
): Html =>
  h.a(
    [
      h.Href(url),
      h.Target("_blank"),
      h.Rel("noreferrer"),
      h.Class("inline-flex items-center gap-1 text-primary"),
    ],
    [...label, Icon.view(h, ExternalLink, "size-3 shrink-0")],
  )

const links = (h: HtmlBuilder<Message>, session: SessionSummary): ReadonlyArray<Html> => [
  ...(session.homeThread === null
    ? []
    : [
        h.span(
          [h.Class("inline-flex items-center gap-1")],
          [Icon.view(h, MessageSquare), externalLink(h, session.homeThread.url, ["Home thread"])],
        ),
      ]),
  ...session.pullRequests.map((pr) =>
    h.span(
      [h.Class("inline-flex items-center gap-1")],
      [
        Icon.view(h, GitPullRequest),
        externalLink(h, pr.url, ["PR ", mono(h, `#${pr.number}`, "text-primary")]),
      ],
    ),
  ),
]

/** A warning is neutral text with an icon; there is no warning colour. */
const warning = (h: HtmlBuilder<Message>, text: string): ReadonlyArray<Html | string> => [
  Icon.view(h, CircleAlert),
  text,
]

const row = (h: HtmlBuilder<Message>, session: SessionSummary): Html =>
  h.li(
    [h.Class("flex flex-col gap-1 border-b border-border-subtle px-3 py-2 last:border-b-0")],
    [
      h.div(
        [h.Class("flex flex-wrap items-center gap-2")],
        [
          agentDot(h),
          badge(h, session),
          h.a(
            [
              h.Href(Routes.session({ sessionId: session.sessionId })),
              h.Class("text-body-md font-medium"),
            ],
            [session.title],
          ),
          session.repository === null
            ? h.span([h.Class("text-body-sm text-ink-subtle")], ["No repository yet"])
            : mono(h, `${session.repository.owner}/${session.repository.repo}`, "text-ink-subtle"),
        ],
      ),
      session.reason === null
        ? h.empty
        : h.p([h.Class("text-body-sm text-ink-muted")], [session.reason]),
      h.div(
        [h.Class("flex flex-wrap items-center gap-x-4 gap-y-1 text-body-sm text-ink-subtle")],
        [
          h.span([], ["Activity ", mono(h, formatTime(session.activityAt), "text-mono-xs")]),
          mono(h, describeUsage(session.usage), "text-mono-xs"),
          session.deliveryWarning === null
            ? h.empty
            : h.span(
                [h.Class("inline-flex items-center gap-1 text-ink-muted")],
                warning(h, `Delivery: ${session.deliveryWarning}`),
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
    [h.Role("status"), h.Class("flex flex-wrap items-center gap-2 text-body-sm text-ink-muted")],
    [
      h.span([], [text]),
      Button.view(h, {
        variant: "link",
        size: "sm",
        label: status === "denied" ? "Reconnect" : "Retry",
        onClick: Message.ClickedRetry(),
      }),
    ],
  )
}

const alert = (h: HtmlBuilder<Message>, text: string): Html =>
  panel(h, {
    attributes: [h.Role("alert")],
    className: "border-destructive text-body-sm",
    children: [h.div([h.Class("font-medium text-destructive")], [text])],
  })

const fact = (h: HtmlBuilder<Message>, label: string, value: ReadonlyArray<Html | string>) =>
  h.div(
    [h.Class("flex flex-col gap-0.5")],
    [
      h.dt([h.Class("text-caption font-medium text-ink-subtle")], [label]),
      h.dd([h.Class("text-body-md")], value),
    ],
  )

/**
 * One line per platform, stating what the scan is doing rather than what it
 * found. A caught-up scan with nothing pending says so; a gap is shown next
 * to it because being caught up never means nothing was lost.
 */
const describeRecovery = (
  h: HtmlBuilder<Message>,
  status: RecoveryStatus,
): ReadonlyArray<Html | string> => {
  const parts: Array<ReadonlyArray<Html | string>> = []
  if (status.completedAt === null) parts.push(["not scanned yet"])
  else if (status.overdue)
    parts.push(["scan overdue, last ", mono(h, formatTime(status.completedAt))])
  if (status.incomplete) parts.push(["results still arriving"])
  if (status.hydrating > 0)
    parts.push([
      "fetching comments for ",
      mono(h, formatCount(status.hydrating)),
      ` contribution${status.hydrating === 1 ? "" : "s"}`,
    ])
  const body: ReadonlyArray<Html | string> =
    parts.length === 0
      ? ["caught up, last scan ", mono(h, formatTime(status.completedAt!))]
      : parts.flatMap((part, index) => (index === 0 ? part : ["; ", ...part]))
  return [`${platformName(status.platform)}: `, ...body]
}

const recoveryRow = (h: HtmlBuilder<Message>, status: RecoveryStatus): Html =>
  h.li(
    [
      h.Class(
        "flex items-start gap-2 border-b border-border-subtle px-3 py-2 text-body-md last:border-b-0",
      ),
    ],
    [
      status.overdue
        ? Icon.view(h, Clock, "mt-0.5 size-3.5 shrink-0 text-ink-muted")
        : status.incomplete
          ? Icon.view(h, CircleAlert, "mt-0.5 size-3.5 shrink-0 text-ink-muted")
          : h.empty,
      h.div(
        [h.Class("flex min-w-0 flex-col gap-0.5")],
        [
          h.p([], describeRecovery(h, status)),
          status.warning === null
            ? h.empty
            : h.p([h.Class("text-body-sm text-ink-muted")], [`Retrying past: ${status.warning}`]),
          status.gap === null
            ? h.empty
            : h.p([h.Class("text-body-sm text-ink-subtle")], [status.gap]),
        ],
      ),
    ],
  )

const recoveryView = (h: HtmlBuilder<Message>, recovery: ReadonlyArray<RecoveryStatus>): Html =>
  recovery.length === 0
    ? h.empty
    : h.section(
        [h.Class("flex flex-col gap-3")],
        [
          sign(h, { children: ["Recovery"] }),
          panel(h, {
            flush: true,
            children: [
              h.ul(
                [],
                recovery.map((status) => recoveryRow(h, status)),
              ),
            ],
          }),
        ],
      )

const pendingDeliveryView = (h: HtmlBuilder<Message>, detail: SessionDetail): Html =>
  detail.pendingDelivery.length === 0
    ? h.empty
    : h.section(
        [h.Class("flex flex-col gap-3")],
        [
          sign(h, { children: ["Pending delivery"] }),
          panel(h, {
            flush: true,
            children: [
              h.ul(
                [],
                detail.pendingDelivery.map((item) =>
                  h.li(
                    [
                      h.Class(
                        "flex flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2 text-body-md last:border-b-0",
                      ),
                    ],
                    [
                      `${platformName(item.platform)} reply ${item.state}${item.error === null ? "" : ": "}`,
                      ...(item.error === null ? [] : [mono(h, item.error, "text-destructive")]),
                    ],
                  ),
                ),
              ),
            ],
          }),
        ],
      )

const detailView = (h: HtmlBuilder<Message>, detail: SessionDetail): Html =>
  h.div(
    [h.Class("flex flex-col gap-4")],
    [
      h.a([h.Href(Routes.sessions()), h.Class("self-start text-body-sm")], ["All sessions"]),
      h.div(
        [h.Class("flex flex-wrap items-center gap-2")],
        [h.h1([], [detail.title]), Feed.agentBadge(h), badge(h, detail)],
      ),
      detail.reason === null
        ? h.empty
        : h.p([h.Class("text-body-md text-ink-muted")], [detail.reason]),
      detail.latestError === null ? h.empty : alert(h, `Latest error: ${detail.latestError}`),
      detail.deliveryWarning === null
        ? h.empty
        : h.p(
            [h.Role("alert"), h.Class("flex items-center gap-1 text-body-sm text-ink-muted")],
            warning(h, `Delivery: ${detail.deliveryWarning}`),
          ),
      panel(h, {
        children: [
          h.dl(
            [h.Class("grid gap-4 sm:grid-cols-2")],
            [
              fact(h, "Repository", [
                detail.repository === null
                  ? "Not selected yet"
                  : mono(h, `${detail.repository.owner}/${detail.repository.repo}`),
              ]),
              fact(h, "Links", [
                h.span(
                  [h.Class("flex flex-wrap items-center gap-x-4 gap-y-1")],
                  links(h, detail).length === 0 ? ["None"] : links(h, detail),
                ),
              ]),
              fact(h, "Latest activity", [mono(h, formatTime(detail.activityAt))]),
              fact(h, "Projection", [describeFreshness(detail)]),
              fact(h, "Inputs", [
                mono(h, formatCount(detail.acceptedInputs)),
                " accepted, ",
                mono(h, formatCount(detail.pendingInputs)),
                " awaiting the runner",
                ...(detail.lastInputAt === null
                  ? []
                  : [", last ", mono(h, formatTime(detail.lastInputAt))]),
              ]),
              fact(h, "Recorded usage", [
                mono(h, describeUsage(detail.usage)),
                h.p([h.Class("text-body-sm text-ink-muted")], [USAGE_NOTE]),
              ]),
            ],
          ),
        ],
      }),
      pendingDeliveryView(h, detail),
      recoveryView(h, detail.recovery),
      h.p([h.Class("text-body-sm text-ink-subtle")], [describeFreshness(detail)]),
    ],
  )

const listView = (h: HtmlBuilder<Message>, model: Model): Html =>
  h.div(
    [h.Class("flex flex-col gap-4")],
    [
      h.div(
        [h.Class("flex flex-col gap-1")],
        [
          h.div(
            [h.Class("flex flex-wrap items-center gap-2")],
            [h.h1([], ["Sessions"]), Feed.agentBadge(h)],
          ),
          h.p(
            [h.Class("text-body-sm text-ink-muted")],
            [
              "Every teammate sees the same sessions. Collaborate with an agent in its home thread; usage totals are recorded by OpenCode and are not a bill.",
            ],
          ),
        ],
      ),
      !model.loaded && model.loading
        ? h.p([h.Role("status"), h.Class("text-body-sm text-ink-muted")], ["Loading sessions…"])
        : model.loaded && model.sessions.length === 0
          ? emptyPanel(h, { children: ["No agent sessions yet."] })
          : panel(h, {
              flush: true,
              children: [
                h.ul(
                  [],
                  model.sessions.map((session) => row(h, session)),
                ),
              ],
            }),
      model.cursor === null
        ? h.empty
        : Button.view(h, {
            label: model.loadingMore ? "Loading…" : "Load more",
            onClick: Message.ClickedMore(),
            variant: "secondary",
            size: "sm",
            className: "self-start",
            isDisabled: model.loadingMore,
          }),
    ],
  )

export const view = Submodel.defineView<Model, Message, Record<string, never>>(
  (model, _inputs, h) =>
    h.div(
      [h.Class("flex w-full max-w-3xl flex-col gap-4 p-4 lg:p-5")],
      [
        liveStatus(h, model),
        model.error !== null && !model.stale ? alert(h, model.error) : h.empty,
        model.selected === null
          ? listView(h, model)
          : model.detail === null
            ? model.loading
              ? h.p(
                  [h.Role("status"), h.Class("text-body-sm text-ink-muted")],
                  ["Loading session…"],
                )
              : h.a([h.Href(Routes.sessions()), h.Class("text-body-sm")], ["All sessions"])
            : detailView(h, model.detail),
      ],
    ),
)
