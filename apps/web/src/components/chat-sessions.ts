import {
  type ChatThread,
  KillSwitchState,
  SessionList,
  SessionSummary,
  type TurnStatus,
  type TurnUsage,
} from "@janitor/domain/Chat/Session"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Command from "foldkit/command"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as Submodel from "foldkit/submodel"
import * as Subscription from "foldkit/subscription"
import type * as Update from "foldkit/update"
import { RotateCw } from "lucide"
import { timestamp } from "./pull-request-reviews"
import * as Button from "./ui/button"
import { chip, type ChipVariant } from "./ui/chip"
import * as Page from "./ui/page"
import * as Switch from "./ui/switch"
import * as Table from "./ui/table"
import { ApiClient } from "@/lib/api-client"
import * as Icon from "@/lib/icons"
import * as Routes from "@/routes"

/**
 * The chat sessions page (EFF-3021): every chat session still kept, latest
 * activity first, each linking to its transcript, and the chat bot's kill
 * switch. Deployment-wide, like Account. Anyone signed in may use the kill
 * switch.
 */

export const KillSwitchKey = Schema.Literals(["global", "slack", "discord"])
export type KillSwitchKey = typeof KillSwitchKey.Type

export const Model = Schema.Struct({
  active: Schema.Boolean,
  sessions: Schema.Array(SessionSummary),
  loading: Schema.Boolean,
  initialized: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  killSwitch: Schema.NullOr(KillSwitchState),
  /** The switch being saved; the others wait for it. */
  saving: Schema.NullOr(KillSwitchKey),
  killSwitchError: Schema.NullOr(Schema.String),
  /** Fences responses from an earlier activation. */
  generation: Schema.Int,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  Activated: { active: Schema.Boolean },
  Polled: {},
  ClickedRefresh: {},
  Loaded: { generation: Schema.Int, list: SessionList },
  Failed: { generation: Schema.Int, reason: Schema.String },
  LoadedKillSwitch: { state: KillSwitchState },
  FailedKillSwitch: { reason: Schema.String },
  /** `on` engages the kill switch: the bot stops there. */
  ToggledKillSwitch: { key: KillSwitchKey, on: Schema.Boolean },
})
export type Message = typeof Message.Type

export const init = (): Model => ({
  active: false,
  sessions: [],
  loading: false,
  initialized: false,
  error: null,
  killSwitch: null,
  saving: null,
  killSwitchError: null,
  generation: 0,
})

/** How often the open page reads the sessions again: chat has no live updates. */
const POLL = "15 seconds"

export const FetchSessions = Command.define("FetchChatSessions", {
  args: { generation: Schema.Int },
  messages: [Message.Loaded, Message.Failed],
  execute: ({ generation }) =>
    ApiClient.use((api) => api.chat.listSessions()).pipe(
      Effect.timeout("15 seconds"),
      Effect.map((list) => Message.Loaded({ generation, list })),
      Effect.orElseSucceed(() =>
        Message.Failed({
          generation,
          reason: "Chat sessions could not be loaded. Check your connection and try again.",
        }),
      ),
    ),
})

export const FetchKillSwitch = Command.define("FetchChatKillSwitch", {
  args: {},
  messages: [Message.LoadedKillSwitch, Message.FailedKillSwitch],
  execute: () =>
    ApiClient.use((api) => api.chat.getKillSwitch()).pipe(
      Effect.timeout("15 seconds"),
      Effect.map((state) => Message.LoadedKillSwitch({ state })),
      Effect.orElseSucceed(() =>
        Message.FailedKillSwitch({ reason: "The kill switch could not be loaded." }),
      ),
    ),
})

export const SetKillSwitch = Command.define("SetChatKillSwitch", {
  args: { state: KillSwitchState },
  messages: [Message.LoadedKillSwitch, Message.FailedKillSwitch],
  execute: ({ state }) =>
    ApiClient.use((api) => api.chat.setKillSwitch({ payload: state })).pipe(
      Effect.timeout("15 seconds"),
      Effect.map((state) => Message.LoadedKillSwitch({ state })),
      Effect.orElseSucceed(() =>
        Message.FailedKillSwitch({ reason: "The kill switch didn't change. Please retry." }),
      ),
    ),
})

type Return = Update.Return<Model, Message, ApiClient>

const fetch = (model: Model): Return =>
  !model.active || model.loading
    ? { model }
    : {
        model: { ...model, loading: true, error: null },
        commands: [FetchSessions({ generation: model.generation })],
      }

export const update = (model: Model, message: Message): Return =>
  Message.match(message, {
    Activated: ({ active }) => {
      if (model.active === active) return { model }
      // Fence responses when leaving and refresh on return.
      const fenced = { ...model, active, loading: false, generation: model.generation + 1 }
      if (!active) return { model: fenced }
      const step = fetch(fenced)
      return { ...step, commands: [...(step.commands ?? []), FetchKillSwitch({})] }
    },
    Polled: () => fetch(model),
    ClickedRefresh: () => {
      const step = fetch(model)
      return { ...step, commands: [...(step.commands ?? []), FetchKillSwitch({})] }
    },
    Loaded: ({ generation, list }) =>
      generation !== model.generation || !model.active
        ? { model }
        : {
            model: {
              ...model,
              sessions: list.sessions,
              loading: false,
              initialized: true,
              error: null,
            },
          },
    Failed: ({ generation, reason }) =>
      generation !== model.generation
        ? { model }
        : { model: { ...model, loading: false, error: reason } },
    LoadedKillSwitch: ({ state }) => ({
      model: { ...model, killSwitch: state, saving: null, killSwitchError: null },
    }),
    FailedKillSwitch: ({ reason }) => ({
      model: { ...model, saving: null, killSwitchError: reason },
    }),
    ToggledKillSwitch: ({ key, on }) =>
      model.killSwitch === null || model.saving !== null
        ? { model }
        : {
            model: { ...model, saving: key, killSwitchError: null },
            commands: [SetKillSwitch({ state: { ...model.killSwitch, [key]: on } })],
          },
  })

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  chatSessionsPoll: entry(
    { active: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ active: model.active }),
      dependenciesToStream: ({ active }) =>
        active
          ? Stream.tick(POLL).pipe(
              Stream.drop(1),
              Stream.map(() => Message.Polled()),
            )
          : Stream.empty,
    },
  ),
}))

// VIEW

export const platformLabel = (thread: ChatThread) => thread._tag

/** The Slack channel id or the Discord server id. */
export const channelLabel = (thread: ChatThread) =>
  thread._tag === "Slack" ? thread.channel : thread.guild

/** The thread on its platform, for a teammate signed in there. */
export const threadUrl = (thread: ChatThread) =>
  thread._tag === "Slack"
    ? `https://app.slack.com/client/${encodeURIComponent(thread.team)}/${encodeURIComponent(thread.channel)}/thread/${encodeURIComponent(`${thread.channel}-${thread.threadTs}`)}`
    : `https://discord.com/channels/${encodeURIComponent(thread.guild)}/${encodeURIComponent(thread.threadId)}`

export const threadLink = <M>(h: HtmlBuilder<M>, thread: ChatThread) =>
  h.a(
    [
      h.Href(threadUrl(thread)),
      h.Target("_blank"),
      h.Rel("noopener noreferrer"),
      h.Class("text-primary hover:underline"),
    ],
    [`Open in ${platformLabel(thread)}`],
  )

export const statusChip = <M>(h: HtmlBuilder<M>, status: TurnStatus | null) => {
  const { label, variant }: { label: string; variant: ChipVariant } =
    status === null
      ? { label: "No turn yet", variant: "neutral" }
      : {
          running: { label: "Running", variant: "agent" as const },
          replied: { label: "Replied", variant: "success" as const },
          stopped: { label: "Stopped", variant: "neutral" as const },
          deadline: { label: "Deadline", variant: "neutral" as const },
          failed: { label: "Failed", variant: "danger" as const },
        }[status]
  return chip(h, { variant, children: [label] })
}

/** Input and output tokens, as `12,345`; a dash before the model reports any. */
export const tokens = (usage: TurnUsage | null) =>
  usage === null ? "—" : (usage.inputTokens + usage.outputTokens).toLocaleString("en-US")

const sessionRow = (h: HtmlBuilder<Message>, session: SessionSummary) =>
  Table.row(h, {
    attributes: [h.DataAttribute("session", session.sessionId)],
    children: [
      Table.cell(h, { className: "py-2", children: [platformLabel(session.thread)] }),
      Table.cell(h, { code: true, className: "py-2", children: [channelLabel(session.thread)] }),
      Table.cell(h, {
        className: "py-2 whitespace-nowrap",
        children: [threadLink(h, session.thread)],
      }),
      Table.cell(h, { className: "max-w-48 truncate py-2", children: [session.startedBy.name] }),
      Table.cell(h, { numeric: true, className: "py-2", children: [String(session.turns)] }),
      Table.cell(h, { className: "py-2", children: [statusChip(h, session.status)] }),
      Table.cell(h, {
        code: true,
        className: "py-2 whitespace-nowrap",
        children: [
          h.span(
            [h.Title(DateTime.formatIso(session.lastActivityAt))],
            [timestamp(session.lastActivityAt)],
          ),
        ],
      }),
      Table.cell(h, { numeric: true, className: "py-2", children: [tokens(session.usage)] }),
      Table.cell(h, {
        className: "py-2",
        children: [
          h.a(
            [
              h.Href(Routes.chatSessionTranscript({ sessionId: session.sessionId })),
              h.Class("text-primary hover:underline"),
            ],
            ["Transcript"],
          ),
        ],
      }),
    ],
  })

const table = (h: HtmlBuilder<Message>, sessions: ReadonlyArray<SessionSummary>) =>
  h.div(
    [h.Class("overflow-x-auto")],
    [
      Table.table(h, {
        attributes: [h.AriaLabel("Chat sessions")],
        children: [
          Table.head(h, [
            Table.row(h, {
              children: [
                Table.headCell(h, { children: ["Platform"] }),
                Table.headCell(h, { children: ["Channel"] }),
                Table.headCell(h, { children: ["Thread"] }),
                Table.headCell(h, { children: ["Started by"] }),
                Table.headCell(h, { numeric: true, children: ["Turns"] }),
                Table.headCell(h, { children: ["Status"] }),
                Table.headCell(h, { children: ["Last activity (UTC)"] }),
                Table.headCell(h, { numeric: true, children: ["Tokens"] }),
                Table.headCell(h, { children: ["Links"] }),
              ],
            }),
          ]),
          Table.body(
            h,
            sessions.map((session) => sessionRow(h, session)),
          ),
        ],
      }),
    ],
  )

const switchLabels: Record<KillSwitchKey, string> = {
  global: "Every thread",
  slack: "Slack",
  discord: "Discord",
}

const killSwitch = (h: HtmlBuilder<Message>, model: Model): ReadonlyArray<Html> => {
  const state = model.killSwitch
  const error =
    model.killSwitchError === null
      ? h.empty
      : h.p([h.Role("alert"), h.Class("text-body-sm text-destructive")], [model.killSwitchError])
  if (state === null)
    return [
      model.killSwitchError === null
        ? h.p([h.Class("text-body-md text-ink-muted")], ["Loading"])
        : error,
    ]
  return [
    h.p(
      [h.Class("text-body-sm text-ink-muted")],
      [
        "Turning the bot off stops its running turns within seconds and starts no new ones. Each thread is told once that the bot is off, and its messages are kept as context for when it's back on. Off for every thread wins over the platform switches.",
      ],
    ),
    h.div(
      [h.Class("mt-2 flex flex-col gap-2")],
      KillSwitchKey.literals.map((key) =>
        Switch.view(h, {
          id: `chat-kill-switch-${key}`,
          label: switchLabels[key],
          // On while the bot runs there: the kill switch is the switch turned off.
          isChecked: !state[key],
          isBusy: model.saving === key,
          isDisabled: model.saving !== null,
          className: "justify-between",
          onToggle: (running) => Message.ToggledKillSwitch({ key, on: !running }),
        }),
      ),
    ),
    error,
  ]
}

export const view = Submodel.defineView<Model, Message>((model, h) =>
  Page.layout(h, {
    attributes: [h.AriaLabel("Chat sessions")],
    main: [
      Page.header(h, {
        title: "Chat sessions",
        lede: "Every chat session the bot keeps, latest activity first. A session is kept until the retention period after its last message has passed.",
        actions: [
          Button.view(h, {
            variant: "secondary",
            label: h.span([h.Class("contents")], [Icon.view(h, RotateCw, "size-4"), "Refresh"]),
            onClick: Message.ClickedRefresh(),
            isDisabled: model.loading,
          }),
        ],
      }),
      model.error === null
        ? h.empty
        : h.div(
            [
              h.Role("alert"),
              h.Class("flex shrink-0 items-center justify-between gap-3 text-body-sm"),
            ],
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
          ),
      h.section(
        [
          h.Class("flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card"),
          h.DataAttribute("slot", "card"),
        ],
        [
          model.sessions.length === 0
            ? h.p(
                [h.Role("status"), h.Class("px-4 py-3 text-body-sm text-ink-muted")],
                [
                  model.initialized
                    ? "No chat sessions. A session starts when someone mentions the bot in a thread."
                    : "Loading chat sessions…",
                ],
              )
            : table(h, model.sessions),
          Page.footerStrip(
            h,
            [
              h.span(
                [h.Role("status")],
                model.loading && model.initialized
                  ? ["Updating…"]
                  : [
                      `${model.sessions.length} ${model.sessions.length === 1 ? "session" : "sessions"}`,
                    ],
              ),
            ],
            [],
          ),
        ],
      ),
    ],
    inspector: [Page.inspectorCard(h, { heading: "Kill switch", children: killSwitch(h, model) })],
  }),
)
