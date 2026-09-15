import {
  type DeliveryItem,
  ExecutionState,
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
import * as Page from "@/components/ui/page"
import { panel, panelHeader } from "@/components/ui/panel"
import * as Select from "@/components/ui/select"
import * as Table from "@/components/ui/table"
import * as Live from "@/components/live"
import { readFailure, reasonOf } from "@/lib/api"
import * as Icon from "@/lib/icons"
import { cn } from "@/lib/utils"
import * as Routes from "@/routes"
import {
  ExternalLink,
  GitPullRequest,
  MessageSquare,
  RotateCw,
  Sparkles,
  TriangleAlert,
} from "lucide"

/**
 * The Janitor dashboard: every teammate sees the same table of agent
 * sessions; opening one keeps the table on screen and fills the inspector
 * with that session's facts. Data comes from plain HTTP reads; the live
 * channel only says when to read again. A failed refresh keeps the last
 * known data on screen and says so, because a stale read is not a runner
 * failure.
 */

export const Model = Schema.Struct({
  /** True while a sessions route is on screen; the live channel follows it. */
  active: Schema.Boolean,
  selected: Schema.NullOr(Schema.String),
  sessions: Schema.Array(SessionSummary),
  cursor: Schema.NullOr(SessionCursor),
  detail: Schema.NullOr(SessionDetail),
  /** Client-side state filter for the table; null shows every state. */
  filter: Schema.NullOr(ExecutionState),
  loaded: Schema.Boolean,
  /** The list is being read. */
  loading: Schema.Boolean,
  /** The selected session's facts are being read. */
  loadingDetail: Schema.Boolean,
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
  filter: null,
  loaded: false,
  loading: false,
  loadingDetail: false,
  loadingMore: false,
  error: null,
  stale: false,
  invalidated: false,
  generation: 0,
  live: Live.init(),
})

export const Message = defineMessageUnion({
  ClickedRetry: {},
  ClickedRefresh: {},
  ClickedMore: {},
  ChangedFilter: { value: Schema.String },
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

const reading = (model: Model): boolean => model.loading || model.loadingDetail

/**
 * Reads whatever the screen shows again: the table always, plus the selected
 * session's facts. Older replies are fenced by the generation. A list
 * refresh re-reads as many rows as are on screen, so pages loaded with
 * "Load more" survive an invalidation.
 */
const refresh = (model: Model): Step => {
  const generation = model.generation + 1
  const next = evo(model, {
    generation: () => generation,
    loading: () => true,
    loadingDetail: () => model.selected !== null,
    invalidated: () => false,
  })
  return {
    model: next,
    commands: [
      FetchList({
        generation,
        cursor: null,
        limit: Math.min(MAX_REFRESH, Math.max(PAGE_SIZE, model.sessions.length)),
      }),
      ...(model.selected === null ? [] : [FetchDetail({ generation, sessionId: model.selected })]),
    ],
  }
}

/** A read finished: apply an invalidation that arrived meanwhile once every read has landed. */
const settle = (model: Model): Step =>
  model.invalidated && !reading(model) ? refresh(model) : { model }

/** Entering a sessions route: the table, plus one session's facts when one is selected. */
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

const parseFilter = (value: string): ExecutionState | null =>
  Schema.is(ExecutionState)(value) ? value : null

export const update = (model: Model, message: Message): Step =>
  Message.match<Step>(message, {
    ClickedRetry: () =>
      refresh(
        evo(model, {
          live: (live) => ({ ...live, retry: live.retry + 1, status: "connecting" as const }),
        }),
      ),
    ClickedRefresh: () => refresh(model),
    ChangedFilter: ({ value }) => ({ model: evo(model, { filter: () => parseFilter(value) }) }),
    ClickedMore: () =>
      model.cursor === null || model.loadingMore
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
              loadingDetail: () => false,
            }),
          ),
    DetailFailed: ({ generation, reason }) =>
      generation !== model.generation
        ? { model }
        : settle(
            evo(model, {
              loadingDetail: () => false,
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
      return reading(connected)
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

const EXECUTION_STATES: ReadonlyArray<ExecutionState> = ["working", "idle", "blocked", "failed"]

/** Working is the agent running, so it takes the agent mark; idle, blocked
 *  and failed are neutral chips, the latter two with danger ink. */
const EXECUTION_VARIANT: Record<ExecutionState, ChipVariant> = {
  working: "agent",
  idle: "neutral",
  blocked: "neutral",
  failed: "neutral",
}

const EXECUTION_CLASS: Record<ExecutionState, string> = {
  working: "",
  idle: "text-ink-muted",
  blocked: "text-destructive",
  failed: "text-destructive",
}

const EXECUTION_DOT: Record<ExecutionState, string> = {
  working: "bg-agent",
  idle: "bg-ink-faint",
  blocked: "bg-destructive",
  failed: "bg-destructive",
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

const statusPill = (h: HtmlBuilder<Message>, state: ExecutionState): Html =>
  chip(h, {
    variant: EXECUTION_VARIANT[state],
    className: cn("shrink-0 font-normal", EXECUTION_CLASS[state]),
    children: [
      h.span([h.Class(cn("size-1.5 rounded-full", EXECUTION_DOT[state])), h.AriaHidden(true)], []),
      state,
    ],
  })

const externalLink = (h: HtmlBuilder<Message>, url: string, icon: Html, label: string): Html =>
  h.a(
    [
      h.Href(url),
      h.Target("_blank"),
      h.Rel("noreferrer"),
      h.Class("inline-flex items-center gap-1 text-body-md text-primary hover:underline"),
    ],
    [icon, label, Icon.view(h, ExternalLink, "size-3 text-ink-subtle")],
  )

const links = (h: HtmlBuilder<Message>, session: SessionSummary): ReadonlyArray<Html> => [
  ...(session.homeThread === null
    ? []
    : [
        externalLink(
          h,
          session.homeThread.url,
          Icon.view(h, MessageSquare, "size-3.5"),
          "Home thread",
        ),
      ]),
  ...session.pullRequests.map((pr) =>
    externalLink(h, pr.url, Icon.view(h, GitPullRequest, "size-3.5"), `PR #${pr.number}`),
  ),
]

const repositoryName = (session: SessionSummary): string | null =>
  session.repository === null ? null : `${session.repository.owner}/${session.repository.repo}`

const CELL = "py-3"

const sessionRow = (h: HtmlBuilder<Message>, session: SessionSummary, selected: boolean): Html => {
  const repository = repositoryName(session)
  const rowLinks = links(h, session)
  return Table.row(h, {
    isSelected: selected,
    children: [
      Table.cell(h, {
        className: cn(CELL, "whitespace-nowrap"),
        children: [statusPill(h, session.execution)],
      }),
      Table.cell(h, {
        className: CELL,
        children: [
          h.div(
            [h.Class("flex flex-col gap-0.5")],
            [
              h.div(
                [h.Class("flex flex-wrap items-center gap-2")],
                [
                  h.a(
                    [
                      h.Href(Routes.session({ sessionId: session.sessionId })),
                      h.Class(
                        "whitespace-nowrap text-body-md font-medium text-primary hover:underline",
                      ),
                    ],
                    [session.title],
                  ),
                  repository === null
                    ? h.span([h.Class("text-body-sm text-ink-subtle")], ["No repository yet"])
                    : mono(h, repository, "text-ink-subtle"),
                ],
              ),
              session.reason === null
                ? h.empty
                : h.p([h.Class("text-body-md text-ink-muted")], [session.reason]),
              session.deliveryWarning === null
                ? h.empty
                : h.p(
                    [h.Class("flex items-center gap-1.5 text-body-md text-destructive")],
                    [
                      Icon.view(h, TriangleAlert, "size-3.5"),
                      `Delivery: ${session.deliveryWarning}`,
                    ],
                  ),
              rowLinks.length === 0
                ? h.empty
                : h.div([h.Class("mt-1 flex flex-wrap items-center gap-3")], rowLinks),
            ],
          ),
        ],
      }),
      Table.cell(h, {
        className: cn(CELL, "whitespace-nowrap"),
        children: [mono(h, formatTime(session.activityAt), "text-ink-muted tabular-nums")],
      }),
      Table.cell(h, {
        numeric: true,
        className: cn(CELL, "whitespace-nowrap"),
        children: [
          session.usage === null
            ? h.span(
                [h.Class("font-sans text-body-md text-ink-subtle"), h.Title(USAGE_UNAVAILABLE)],
                ["—"],
              )
            : mono(h, describeUsage(session.usage), "text-ink-muted tabular-nums"),
        ],
      }),
    ],
  })
}

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

const healthDot = (h: HtmlBuilder<Message>, healthy: boolean): Html =>
  h.span(
    [
      h.Class(cn("size-2 shrink-0 rounded-full", healthy ? "bg-success" : "bg-destructive")),
      h.AriaHidden(true),
    ],
    [],
  )

const deliveryRow = (
  h: HtmlBuilder<Message>,
  healthy: boolean,
  label: string,
  state: string,
  note: string | null,
): Html =>
  h.div(
    [h.Class("flex flex-col gap-1 py-1.5")],
    [
      h.div(
        [h.Class("flex items-center gap-2 text-body-md")],
        [
          healthDot(h, healthy),
          label,
          mono(h, state, cn("ml-auto", healthy ? "text-ink-subtle" : "text-destructive")),
        ],
      ),
      note === null ? h.empty : h.p([h.Class("text-body-sm text-destructive")], [note]),
    ],
  )

const pendingRow = (h: HtmlBuilder<Message>, item: DeliveryItem): Html =>
  deliveryRow(
    h,
    false,
    `${platformName(item.platform)} reply`,
    item.state,
    item.error === null ? null : item.error,
  )

/** The home thread's health first, then every reply the runner still owes. */
const deliveryCard = (h: HtmlBuilder<Message>, detail: SessionDetail): Html => {
  const homeIssue =
    detail.deliveryWarning ??
    detail.pendingDelivery.find((item) => item.platform === "slack")?.error ??
    null
  return Page.inspectorCard(h, {
    heading: "Delivery",
    children:
      detail.homeThread === null && detail.pendingDelivery.length === 0
        ? [h.p([h.Class("text-body-md text-ink-muted")], ["No home thread yet."])]
        : [
            Page.kvList(h, [
              ...(detail.homeThread === null
                ? []
                : [
                    deliveryRow(
                      h,
                      homeIssue === null,
                      `${platformName(detail.homeThread.platform)} home thread`,
                      homeIssue === null ? "ok" : "warning",
                      homeIssue,
                    ),
                  ]),
              ...detail.pendingDelivery.map((item) => pendingRow(h, item)),
            ]),
          ],
  })
}

const sessionCard = (h: HtmlBuilder<Message>, detail: SessionDetail): Html => {
  const repository = repositoryName(detail)
  return Page.inspectorCard(h, {
    heading: "Session",
    children: [
      h.div(
        [h.Class("mb-3 flex flex-wrap items-center gap-2")],
        [
          statusPill(h, detail.execution),
          h.span([h.Class("text-body-md font-medium")], [detail.title]),
        ],
      ),
      detail.latestError === null
        ? h.empty
        : h.p(
            [h.Role("alert"), h.Class("mb-3 text-body-sm text-destructive")],
            [`Latest error: ${detail.latestError}`],
          ),
      Page.kvList(h, [
        repository === null
          ? Page.kv(h, "Repository", "Not selected yet", { mono: false })
          : Page.kv(h, "Repository", repository),
        Page.kv(h, "Pending inputs", formatCount(detail.pendingInputs)),
        Page.kv(h, "Accepted", formatCount(detail.acceptedInputs)),
        Page.kv(
          h,
          "Last input",
          detail.lastInputAt === null ? "—" : formatTime(detail.lastInputAt),
        ),
        Page.kv(
          h,
          "Runner read",
          detail.freshness.error !== null
            ? `failed: ${detail.freshness.error}`
            : detail.freshness.readAt === null
              ? "not yet"
              : formatTime(detail.freshness.readAt),
        ),
        Page.kv(h, "Usage", describeUsage(detail.usage)),
      ]),
      h.p([h.Class("mt-3 text-body-sm text-ink-subtle")], [USAGE_NOTE]),
    ],
  })
}

const inspector = (h: HtmlBuilder<Message>, model: Model): ReadonlyArray<Html> => {
  if (model.selected === null)
    return [
      Page.inspectorCard(h, {
        heading: "Session",
        children: [
          h.p(
            [h.Class("text-body-md text-ink-muted")],
            ["Select a session to see its inputs and delivery."],
          ),
        ],
      }),
    ]
  if (model.detail === null)
    return [
      Page.inspectorCard(h, {
        heading: "Session",
        children: [
          model.loadingDetail
            ? h.p([h.Role("status"), h.Class("text-body-md text-ink-muted")], ["Loading session…"])
            : h.p(
                [h.Class("text-body-md text-ink-muted")],
                ["The session could not be loaded. Retry to continue."],
              ),
        ],
      }),
    ]
  return [sessionCard(h, model.detail), deliveryCard(h, model.detail)]
}

const filterSelect = (h: HtmlBuilder<Message>, model: Model): Html =>
  Select.view(h, {
    id: "sessions-state-filter",
    label: "State",
    isLabelHidden: true,
    value: model.filter ?? "",
    options: [["", "All states"], ...EXECUTION_STATES.map((state) => [state, state] as const)],
    wrapperClass: "w-40",
    onChange: (value) => Message.ChangedFilter({ value }),
  })

const sessionsTable = (h: HtmlBuilder<Message>, model: Model): Html => {
  const rows = model.sessions.filter(
    (session) => model.filter === null || session.execution === model.filter,
  )
  return rows.length === 0
    ? h.p(
        [h.Class("px-4 py-6 text-body-sm text-ink-muted")],
        [model.filter === null ? "No agent sessions yet." : `No ${model.filter} sessions.`],
      )
    : Table.table(h, {
        children: [
          Table.head(h, [
            h.tr(
              [],
              [
                Table.headCell(h, { children: ["State"] }),
                Table.headCell(h, { className: "w-full", children: ["Session"] }),
                Table.headCell(h, { children: ["Last activity"] }),
                Table.headCell(h, { numeric: true, children: ["Usage"] }),
              ],
            ),
          ]),
          Table.body(
            h,
            rows.map((session) => sessionRow(h, session, session.sessionId === model.selected)),
          ),
        ],
      })
}

const sessionsCard = (h: HtmlBuilder<Message>, model: Model): Html => {
  const working = model.sessions.filter((session) => session.execution === "working").length
  return panel(h, {
    flush: true,
    children: [
      panelHeader(h, {
        title: "Sessions",
        meta: `${formatCount(model.sessions.length)} · ${formatCount(working)} working`,
        actions: [filterSelect(h, model)],
      }),
      !model.loaded && model.loading
        ? h.p(
            [h.Role("status"), h.Class("px-4 py-6 text-body-sm text-ink-muted")],
            ["Loading sessions…"],
          )
        : sessionsTable(h, model),
    ],
  })
}

const header = (h: HtmlBuilder<Message>): Html =>
  Page.header(h, {
    title: h.div(
      [h.Class("flex items-center gap-3")],
      [
        h.h1([], ["Sessions"]),
        chip(h, {
          variant: "agent",
          className: "h-5 px-1.5 text-mono-xs font-normal",
          children: [Icon.view(h, Sparkles, "size-3"), "AI"],
        }),
      ],
    ),
    lede: "Every teammate sees the same sessions. Collaborate with an agent in its home thread; usage totals are recorded by OpenCode and are not a bill.",
    actions: [
      Button.view(h, {
        variant: "secondary",
        label: h.span(
          [h.Class("inline-flex items-center gap-1.5")],
          [Icon.view(h, RotateCw, "size-4"), "Refresh"],
        ),
        onClick: Message.ClickedRefresh(),
      }),
    ],
  })

export const view = Submodel.defineView<Model, Message, Record<string, never>>(
  (model, _inputs, h) =>
    Page.layout(h, {
      main: [
        header(h),
        liveStatus(h, model),
        model.error !== null && !model.stale ? alert(h, model.error) : h.empty,
        sessionsCard(h, model),
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
      inspector: inspector(h, model),
    }),
)
