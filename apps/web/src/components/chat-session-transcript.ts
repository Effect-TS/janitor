import {
  type GateOutcome,
  SessionTranscript,
  type SessionTranscriptTurn,
  type TranscriptMessage,
} from "@janitor/domain/Chat/Session"
import * as Dialog from "@foldkit/ui/dialog"
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
import { RotateCw, Trash2 } from "lucide"
import { channelLabel, platformLabel, statusChip, threadLink, tokens } from "./chat-sessions"
import { describeDuration, timestamp } from "./pull-request-reviews"
import { downloadLink, messageView, prose, type RoleLabels, status } from "./transcript"
import * as Button from "./ui/button"
import { chip } from "./ui/chip"
import * as DialogChrome from "./ui/dialog"
import * as Page from "./ui/page"
import { ApiClient } from "@/lib/api-client"
import * as Icon from "@/lib/icons"
import * as Routes from "@/routes"

/**
 * One chat session's transcript (EFF-3021): the thread's messages with their
 * gate outcomes, and each turn with its steps, tokens and model, in thread
 * order. Everything in it comes from the thread or the model, so all of it
 * is shown as plain text; nothing is rendered as HTML or Markdown. A running
 * turn shows the steps committed so far and is read again every few
 * seconds. Deleting the session is the page's one action.
 */

export const Model = Schema.Struct({
  sessionId: Schema.String,
  active: Schema.Boolean,
  transcript: Schema.NullOr(SessionTranscript),
  /** The session expired or was deleted. */
  expired: Schema.Boolean,
  loading: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  deleteDialog: Dialog.Model,
  deleting: Schema.Boolean,
  /** Fences responses from an earlier session or activation. */
  generation: Schema.Int,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  Activated: { sessionId: Schema.String, active: Schema.Boolean },
  Polled: {},
  ClickedRefresh: {},
  Loaded: { generation: Schema.Int, transcript: SessionTranscript },
  Expired: { generation: Schema.Int },
  Failed: { generation: Schema.Int, reason: Schema.String },
  ClickedDelete: {},
  CancelledDelete: {},
  ConfirmedDelete: {},
  GotDeleteDialogMessage: { message: Dialog.Message },
  Deleted: { generation: Schema.Int },
  FailedDelete: { generation: Schema.Int, reason: Schema.String },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  /** The session is gone; the page leaves for the sessions list. */
  DeletedSession: {},
})
export type OutMessage = typeof OutMessage.Type

export const init = (): Model => ({
  sessionId: "",
  active: false,
  transcript: null,
  expired: false,
  loading: false,
  error: null,
  deleteDialog: Dialog.init({
    id: "delete-chat-session",
    focusSelector: "#cancel-delete-chat-session",
  }),
  deleting: false,
  generation: 0,
})

/** The "Download JSON" link: an `href`, so the path is built by hand. */
const transcriptPath = (sessionId: string) =>
  `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/transcript`

const OFF =
  "The chat bot is off in this deployment, so its sessions can't be read or deleted until it's back on."

/** How often a running turn's transcript is read again. */
const POLL = "5 seconds"

export const FetchTranscript = Command.define("FetchChatSessionTranscript", {
  args: { sessionId: Schema.String, generation: Schema.Int },
  messages: [Message.Loaded, Message.Expired, Message.Failed],
  execute: ({ sessionId, generation }) =>
    ApiClient.use((api) => api.chat.getTranscript({ params: { sessionId } })).pipe(
      Effect.timeout("15 seconds"),
      Effect.map((transcript) => Message.Loaded({ generation, transcript })),
      Effect.catchTags({
        TranscriptGone: () => Effect.succeed(Message.Expired({ generation })),
        ChatUnavailable: () => Effect.succeed(Message.Failed({ generation, reason: OFF })),
      }),
      Effect.orElseSucceed(() =>
        Message.Failed({
          generation,
          reason: "The transcript could not be loaded. Check your connection and try again.",
        }),
      ),
    ),
})

export const DeleteSession = Command.define("DeleteChatSession", {
  args: { sessionId: Schema.String, generation: Schema.Int },
  messages: [Message.Deleted, Message.FailedDelete],
  execute: ({ sessionId, generation }) =>
    ApiClient.use((api) => api.chat.deleteSession({ params: { sessionId } })).pipe(
      Effect.timeout("30 seconds"),
      Effect.as(Message.Deleted({ generation })),
      Effect.catchTag("ChatUnavailable", () =>
        Effect.succeed(Message.FailedDelete({ generation, reason: OFF })),
      ),
      Effect.orElseSucceed(() =>
        Message.FailedDelete({
          generation,
          reason: "The session could not be deleted. Please retry.",
        }),
      ),
    ),
})

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, ApiClient>

const fetch = (model: Model): Return =>
  !model.active || model.loading
    ? { model }
    : {
        model: { ...model, loading: true, error: null },
        commands: [FetchTranscript({ sessionId: model.sessionId, generation: model.generation })],
      }

const withDialog = (model: Model, result: ReturnType<typeof Dialog.open>): Return => ({
  model: { ...model, deleteDialog: result.model },
  commands: Command.mapMessages(result.commands, (message) =>
    Message.GotDeleteDialogMessage({ message }),
  ),
})

/** Only a session with a running turn still changes on its own. */
const running = (model: Model) =>
  model.transcript?.turns.some((turn) => turn.status === "running") ?? false

export const update = (model: Model, message: Message): Return =>
  Message.match(message, {
    Activated: ({ sessionId, active }) => {
      if (model.sessionId === sessionId && model.active === active) return { model }
      const next =
        model.sessionId === sessionId
          ? { ...model, active }
          : { ...init(), generation: model.generation, sessionId, active }
      // Fence responses when leaving and refresh on return.
      const fenced = { ...next, loading: false, deleting: false, generation: next.generation + 1 }
      return active ? fetch(fenced) : { model: fenced }
    },
    Polled: () => (running(model) ? fetch(model) : { model }),
    ClickedRefresh: () => fetch(model),
    Loaded: ({ generation, transcript }) =>
      generation !== model.generation || !model.active
        ? { model }
        : { model: { ...model, transcript, expired: false, loading: false, error: null } },
    Expired: ({ generation }) =>
      generation !== model.generation
        ? { model }
        : { model: { ...model, transcript: null, expired: true, loading: false, error: null } },
    Failed: ({ generation, reason }) =>
      generation !== model.generation
        ? { model }
        : { model: { ...model, loading: false, error: reason } },
    GotDeleteDialogMessage: ({ message }) =>
      withDialog(model, Dialog.update(model.deleteDialog, message)),
    ClickedDelete: () =>
      model.transcript === null || model.deleting
        ? { model }
        : withDialog(model, Dialog.open(model.deleteDialog)),
    CancelledDelete: () => withDialog(model, Dialog.close(model.deleteDialog)),
    ConfirmedDelete: () => {
      if (!model.deleteDialog.isOpen || model.deleting) return { model }
      const closed = withDialog(
        { ...model, deleting: true, error: null },
        Dialog.close(model.deleteDialog),
      )
      return {
        ...closed,
        commands: [
          ...(closed.commands ?? []),
          DeleteSession({ sessionId: model.sessionId, generation: model.generation }),
        ],
      }
    },
    Deleted: ({ generation }) =>
      generation !== model.generation
        ? { model }
        : {
            model: { ...model, transcript: null, expired: true, deleting: false },
            outMessage: OutMessage.DeletedSession(),
          },
    FailedDelete: ({ generation, reason }) =>
      generation !== model.generation
        ? { model }
        : { model: { ...model, deleting: false, error: reason } },
  })

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  chatTranscriptPoll: entry(
    { polling: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ polling: model.active && running(model) }),
      dependenciesToStream: ({ polling }) =>
        polling
          ? Stream.tick(POLL).pipe(
              Stream.drop(1),
              Stream.map(() => Message.Polled()),
            )
          : Stream.empty,
    },
  ),
}))

// VIEW

/** In a turn's agent history, user messages are the thread and janitor's steering. */
const roleLabel: RoleLabels = {
  system: "System",
  user: "Thread",
  assistant: "Agent",
  tool: "Tool",
}

const gateLabel = (gate: GateOutcome): string => {
  switch (gate._tag) {
    case "Mention":
      return "Mention"
    case "Stop":
      return "Stop"
    case "Passed":
      return `Gate passed · ${gate.probability.toFixed(2)}`
    case "Rejected":
      return `Gate rejected · ${gate.probability.toFixed(2)}`
    case "Failed":
      return "Gate failed"
    case "Context":
      return "Context only"
    case "SwitchedOff":
      return "Bot switched off"
  }
}

const millisBetween = (from: DateTime.Utc, to: DateTime.Utc) =>
  DateTime.toEpochMillis(to) - DateTime.toEpochMillis(from)

const caption = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html | string>) =>
  h.div([h.Class("flex flex-wrap items-center gap-2 text-caption text-ink-subtle")], children)

const threadMessageView = <M>(h: HtmlBuilder<M>, message: TranscriptMessage) =>
  h.li(
    [
      h.Class("flex flex-col gap-2 rounded-md border border-border bg-card p-3"),
      h.DataAttribute("gate", message.gate._tag),
    ],
    [
      caption(h, [
        h.span([h.Class("font-medium text-foreground")], [message.author.name]),
        message.author.class === "admitted"
          ? h.empty
          : chip(h, { children: [message.author.class] }),
        h.span(
          [h.Class("font-mono tabular-nums"), h.Title(DateTime.formatIso(message.sentAt))],
          [timestamp(message.sentAt)],
        ),
        chip(h, { children: [gateLabel(message.gate)] }),
      ]),
      prose(h, message.text),
      ...message.attachments.map((attachment) =>
        h.p(
          [h.Class("text-body-sm text-ink-muted")],
          [`File · ${attachment.name} · ${attachment.mediaType}`],
        ),
      ),
    ],
  )

/** What the turn went through, beyond its status. */
const markers = (turn: SessionTranscriptTurn): ReadonlyArray<string> => [
  ...(turn.startedAt === null
    ? turn.status === "running"
      ? ["Waiting for a sandbox"]
      : []
    : [`Queued ${describeDuration(millisBetween(turn.queuedAt, turn.startedAt))}`]),
  ...(turn.resumes === 0 ? [] : [`Resumed ${turn.resumes}×`]),
  ...(turn.wrappedUp ? ["Told to wrap up"] : []),
  ...(turn.status === "deadline" ? ["Stopped at the deadline"] : []),
  ...(turn.status === "stopped" ? ['Stopped by "stop", the kill switch or a delete'] : []),
  ...(turn.errorCategory === null ? [] : [`Error · ${turn.errorCategory.replaceAll("_", " ")}`]),
]

const turnView = <M>(h: HtmlBuilder<M>, turn: SessionTranscriptTurn, index: number) =>
  h.li(
    [
      h.Class("flex flex-col gap-3 rounded-md border border-agent-line bg-card p-3"),
      h.DataAttribute("turn", turn.turnId),
    ],
    [
      caption(h, [
        h.span([h.Class("font-medium text-foreground")], [`Turn ${index + 1}`]),
        statusChip(h, turn.status),
        h.span([h.Class("font-mono")], [turn.model ?? "—"]),
        h.span([h.Class("font-mono tabular-nums")], [`${tokens(turn.usage)} tokens`]),
        h.span(
          [h.Class("font-mono tabular-nums")],
          [`${turn.actions} ${turn.actions === 1 ? "action" : "actions"}`],
        ),
        ...(turn.finishedAt === null || turn.startedAt === null
          ? []
          : [
              h.span(
                [h.Class("font-mono tabular-nums")],
                [describeDuration(millisBetween(turn.startedAt, turn.finishedAt))],
              ),
            ]),
      ]),
      ...markers(turn).map((marker) =>
        h.p([h.Class("text-body-sm text-ink-muted"), h.DataAttribute("marker", "")], [marker]),
      ),
      turn.messages.length === 0
        ? h.p(
            [h.Class("text-body-sm text-ink-muted")],
            [
              turn.status === "running"
                ? "Nothing committed yet. The agent's first step is still running."
                : "Nothing was committed.",
            ],
          )
        : h.ol(
            [h.Class("flex flex-col gap-2"), h.AriaLabel(`Turn ${index + 1} steps`)],
            turn.messages.map((message, step) => messageView(h, message, step, roleLabel)),
          ),
    ],
  )

/** Messages and turns in thread order: a turn follows the messages sent before it queued. */
const entries = <M>(h: HtmlBuilder<M>, transcript: SessionTranscript): ReadonlyArray<Html> => {
  const out: Array<Html> = []
  let next = 0
  const flushTurns = (until: DateTime.Utc | null) => {
    while (
      next < transcript.turns.length &&
      (until === null || DateTime.isLessThan(transcript.turns[next]!.queuedAt, until))
    ) {
      out.push(turnView(h, transcript.turns[next]!, next))
      next += 1
    }
  }
  for (const message of transcript.messages) {
    flushTurns(message.sentAt)
    out.push(threadMessageView(h, message))
  }
  flushTurns(null)
  return out
}

const sessionSummary = <M>(h: HtmlBuilder<M>, transcript: SessionTranscript) => {
  const { session } = transcript
  return Page.kvList(h, [
    Page.kv(h, "Platform", platformLabel(session.thread), { mono: false }),
    Page.kv(h, "Channel", channelLabel(session.thread)),
    Page.kv(h, "Thread", [threadLink(h, session.thread)], { mono: false }),
    Page.kv(h, "Started by", session.startedBy.name, { mono: false }),
    Page.kv(h, "Status", [statusChip(h, session.status)], { mono: false }),
    Page.kv(h, "Turns", String(session.turns)),
    Page.kv(h, "Tokens", tokens(session.usage)),
    Page.kv(h, "Last activity", `${timestamp(session.lastActivityAt)} UTC`),
  ])
}

const deleteWarning =
  "Deleting cancels a running turn, releases the session's sandbox and deletes its history and transcript. This can't be undone. A later message in the thread starts a new session, which reads the thread's last 100 messages again, so delete a pasted secret in Slack or Discord too."

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const { transcript } = model
  const actions = [
    downloadLink(
      h,
      transcriptPath(model.sessionId),
      `chat-session-${model.sessionId.replaceAll("/", "-")}.json`,
    ),
    Button.view(h, {
      variant: "secondary",
      label: h.span([h.Class("contents")], [Icon.view(h, RotateCw, "size-4"), "Refresh"]),
      onClick: Message.ClickedRefresh(),
      isDisabled: model.loading,
    }),
    Button.view(h, {
      variant: "secondary",
      label: h.span([h.Class("contents")], [Icon.view(h, Trash2, "size-4"), "Delete session"]),
      onClick: Message.ClickedDelete(),
      isDisabled: model.deleting,
    }),
  ]
  const body =
    transcript !== null
      ? h.ol([h.Class("flex flex-col gap-3"), h.AriaLabel("Transcript")], entries(h, transcript))
      : model.expired
        ? h.div(
            [h.Class("flex flex-col items-start gap-2")],
            [
              status(
                h,
                "This transcript is gone. A chat session is dropped once the retention period after its last message has passed, or when someone deletes it.",
              ),
              h.a(
                [
                  h.Href(Routes.chatSessions()),
                  h.Class("text-body-sm text-primary hover:underline"),
                ],
                ["Back to chat sessions"],
              ),
            ],
          )
        : model.error === null
          ? status(h, "Loading the transcript…")
          : h.empty
  return Page.layout(h, {
    attributes: [h.AriaLabel("Chat session transcript")],
    main: [
      Page.header(h, {
        title: "Chat session transcript",
        lede:
          transcript === null
            ? "One chat session's thread and turns, as they were committed."
            : "The thread's messages and the bot's turns, as they were committed. Tool calls and their results are collapsed.",
        actions: transcript === null ? [] : actions,
      }),
      Page.errorStrip(h, {
        error: model.error,
        onRetry: Message.ClickedRefresh(),
        isLoading: model.loading,
      }),
      body,
      h.submodel({
        slotId: "delete-chat-session-dialog",
        model: model.deleteDialog,
        view: Dialog.view,
        toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
        viewInputs: {
          hasDescription: true,
          toView: (render) =>
            DialogChrome.view(h, {
              dialog: render.dialog,
              backdrop: render.backdrop,
              panel: render.panel,
              title: render.title,
              description: render.description,
              isVisible: render.isVisible,
              titleText: "Delete chat session?",
              descriptionText: deleteWarning,
              actions: [
                Button.view(h, {
                  label: "Cancel",
                  variant: "secondary",
                  attributes: [h.Id("cancel-delete-chat-session")],
                  onClick: Message.CancelledDelete(),
                }),
                Button.view(h, {
                  label: "Delete session",
                  variant: "destructive",
                  isDisabled: model.deleting,
                  onClick: Message.ConfirmedDelete(),
                }),
              ],
            }),
        },
      }),
    ],
    ...(transcript === null
      ? {}
      : {
          inspector: [
            Page.inspectorCard(h, {
              heading: "Session",
              children: [sessionSummary(h, transcript)],
            }),
          ],
        }),
  })
})
