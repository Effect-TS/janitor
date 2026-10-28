import * as Prompt from "effect/ai/Prompt"
import * as Schema from "effect/Schema"

/**
 * A chat session as the cluster and the web app share it (EFF-3018,
 * EFF-3021): its thread and messages, its turns, the sessions list and the
 * kill switch.
 */

/** One Slack thread or one Discord thread: what a chat session is for. */
export const ChatThread = Schema.TaggedUnion({
  Slack: { team: Schema.String, channel: Schema.String, threadTs: Schema.String },
  Discord: { guild: Schema.String, threadId: Schema.String },
})
export type ChatThread = typeof ChatThread.Type

/**
 * Who wrote a message, as ingress classified it: an admitted user, an
 * outsider (no role, a guest, a Slack Connect user) or any bot account,
 * janitor's included. Only admitted messages start or steer a turn.
 */
export const AuthorClass = Schema.Literals(["admitted", "outsider", "bot"])
export type AuthorClass = typeof AuthorClass.Type

/** A file attached to a thread message. */
export const ChatAttachment = Schema.Struct({
  /** The platform's file id: the Slack file id or the Discord attachment id. */
  id: Schema.String,
  name: Schema.String,
  mediaType: Schema.String,
  /** In bytes, as the platform reports it. */
  size: Schema.Int,
})
export type ChatAttachment = typeof ChatAttachment.Type

/** A thread message, as ingress hands it to the session. */
export const ChatMessage = Schema.Struct({
  /** The platform's message id: the Slack `ts` or the Discord snowflake. Sessions dedupe on it. */
  id: Schema.String,
  author: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    class: AuthorClass,
  }),
  /** The message text, with mentions of the bot removed. */
  text: Schema.String,
  mentionsBot: Schema.Boolean,
  sentAt: Schema.DateTimeUtc,
  attachments: Schema.Array(ChatAttachment),
})
export type ChatMessage = typeof ChatMessage.Type

/** What the reply gate made of a message, for the transcript. */
export const GateOutcome = Schema.TaggedUnion({
  /** It mentions the bot, so it skipped the gate. */
  Mention: {},
  /** Only "stop": it cancelled the running turn before any model saw it. */
  Stop: {},
  Passed: { probability: Schema.Finite },
  Rejected: { probability: Schema.Finite },
  /** The gate call failed, so it started nothing. */
  Failed: {},
  /** From an outsider or a bot, or backfilled: never gated, context only. */
  Context: {},
  /** Arrived while the kill switch was on: kept as context. */
  SwitchedOff: {},
})
export type GateOutcome = typeof GateOutcome.Type

/** A turn's final cumulative clanka `Usage`, sub-agents included. */
export const TurnUsage = Schema.Struct({
  inputTokens: Schema.Int,
  outputTokens: Schema.Int,
  cacheRead: Schema.Int,
  cacheWrite: Schema.Int,
})
export type TurnUsage = typeof TurnUsage.Type

export const TurnStatus = Schema.Literals([
  "running",
  /** Ended with a final reply. */
  "replied",
  /** "stop", the kill switch or a delete. */
  "stopped",
  "deadline",
  "failed",
])
export type TurnStatus = typeof TurnStatus.Type

export const TranscriptTurn = Schema.Struct({
  turnId: Schema.String,
  status: TurnStatus,
  /** Why a failed turn failed: a provider error's category, `resume_limit`, `busy` and the like. */
  errorCategory: Schema.NullOr(Schema.String),
  resumes: Schema.Int,
  wrappedUp: Schema.Boolean,
  model: Schema.NullOr(Schema.String),
  /** How many scripts the turn started, across its resumes. */
  actions: Schema.Int,
  /** Null until the model reports any. */
  usage: Schema.NullOr(TurnUsage),
})
export type TranscriptTurn = typeof TranscriptTurn.Type

/**
 * The chat bot's kill switch (EFF-3012): on for every thread, or for one
 * platform's.
 */
export const KillSwitchState = Schema.Struct({
  global: Schema.Boolean,
  slack: Schema.Boolean,
  discord: Schema.Boolean,
}).annotate({ identifier: "ChatKillSwitchState" })
export type KillSwitchState = typeof KillSwitchState.Type

/** A row of the chat sessions page. */
export const SessionSummary = Schema.Struct({
  /** The session key, as in the status message's transcript link. */
  sessionId: Schema.String,
  thread: ChatThread,
  /** Who mentioned the bot to start the session. */
  startedBy: Schema.Struct({ id: Schema.String, name: Schema.String }),
  turns: Schema.Int,
  /** The latest turn's status; null before the first turn. */
  status: Schema.NullOr(TurnStatus),
  lastActivityAt: Schema.DateTimeUtc,
  /** Summed over the session's turns; null until the model reports any. */
  usage: Schema.NullOr(TurnUsage),
}).annotate({ identifier: "ChatSessionSummary" })
export type SessionSummary = typeof SessionSummary.Type

/** Every chat session still kept, latest activity first. */
export const SessionList = Schema.Struct({
  sessions: Schema.Array(SessionSummary),
}).annotate({ identifier: "ChatSessionList" })
export type SessionList = typeof SessionList.Type

/** A thread message with what the reply gate made of it. */
export const TranscriptMessage = Schema.Struct({ ...ChatMessage.fields, gate: GateOutcome })
export type TranscriptMessage = typeof TranscriptMessage.Type

/** A turn with when it queued, started and ended, and the agent history it added. */
export const SessionTranscriptTurn = Schema.Struct({
  ...TranscriptTurn.fields,
  queuedAt: Schema.DateTimeUtc,
  /** When it first got a sandbox: queue time ends here. */
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  finishedAt: Schema.NullOr(Schema.DateTimeUtc),
  /** The agent history the turn added, without the system message. */
  messages: Schema.Array(Prompt.Message),
})
export type SessionTranscriptTurn = typeof SessionTranscriptTurn.Type

/**
 * A session's transcript, as far as it has been committed: the transcript
 * page shows it and "Download JSON" saves it.
 */
export const SessionTranscript = Schema.Struct({
  session: SessionSummary,
  /** The thread's messages in thread order. */
  messages: Schema.Array(TranscriptMessage),
  turns: Schema.Array(SessionTranscriptTurn),
}).annotate({ identifier: "ChatSessionTranscript" })
export type SessionTranscript = typeof SessionTranscript.Type

/** The session expired or was deleted, or never existed: its transcript is gone. */
export class TranscriptGone extends Schema.TaggedError<TranscriptGone>()(
  "TranscriptGone",
  { sessionId: Schema.String },
  { httpApiStatus: 410 },
) {}
