// The versioned JSON boundary between the Janitor API Worker and the session
// runner. Both applications share the root Effect graph; fibers and service
// instances are process-local. Protocol versions guard rolling deployments.
import { Schema } from "effect"

export const PROTOCOL_VERSION = 4
export const PROTOCOL_HEADER = "x-janitor-runner-protocol"

/** Stable identity of one Janitor agent session; also the Durable Object name. */
export const SessionId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,120}$/))
export type SessionId = typeof SessionId.Type

/** A repository connection generation. Stale generations are fenced out. */
export const Generation = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export type Generation = typeof Generation.Type

/** Janitor's stable runner message identity; OpenCode requires the `msg_` prefix. */
export const InputId = Schema.String.check(Schema.isPattern(/^msg_[A-Za-z0-9_-]{1,120}$/))
export type InputId = typeof InputId.Type

export const CreateSession = Schema.Struct({
  generation: Generation,
  title: Schema.String,
  repositoryId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9]+$/))),
  /** Omitted selects the deployment default for a new session; existing sessions keep their record. */
  modelConfigurationId: Schema.optionalKey(Schema.String),
})
export type CreateSession = typeof CreateSession.Type

export const CreateSessionResult = Schema.Struct({
  sessionId: SessionId,
  generation: Generation,
  nativeSessionId: Schema.String,
  modelConfigurationId: Schema.String,
  /** False when an earlier creation already established the session. */
  created: Schema.Boolean,
})
export type CreateSessionResult = typeof CreateSessionResult.Type

export const InputAttribution = Schema.Struct({
  source: Schema.Literals(["slack", "github", "driver"]),
  teammateId: Schema.optionalKey(Schema.String),
  displayName: Schema.optionalKey(Schema.String),
  contributionKey: Schema.optionalKey(Schema.String),
})
export type InputAttribution = typeof InputAttribution.Type

export const AdmitInput = Schema.Struct({
  generation: Generation,
  inputId: InputId,
  text: Schema.String,
  attribution: InputAttribution,
})
export type AdmitInput = typeof AdmitInput.Type

/**
 * A durable admission receipt. `duplicate` reports that the same input identity
 * was already accepted; the retained payload hash identifies which payload the
 * session holds when a retry disagrees.
 */
export const AdmitResult = Schema.Struct({
  inputId: InputId,
  nativeSessionId: Schema.String,
  status: Schema.Literal("admitted"),
  admittedAt: Schema.Number,
  payloadHash: Schema.String,
  duplicate: Schema.Boolean,
  payloadMatches: Schema.Boolean,
})
export type AdmitResult = typeof AdmitResult.Type

export const ExecutionState = Schema.Literals(["working", "idle", "blocked", "failed"])
export type ExecutionState = typeof ExecutionState.Type

export const UsageTotals = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  reasoning: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  /** Durable event watermark at the time the totals were read; replay-safe replacement key. */
  seq: Schema.Number,
})
export type UsageTotals = typeof UsageTotals.Type

/** Why a session waits for a teammate's Retry or Skip. */
export const AwaitingKind = Schema.Literals(["interrupted", "save_failed"])
export type AwaitingKind = typeof AwaitingKind.Type

export const Awaiting = Schema.Struct({
  inputId: InputId,
  attempt: Schema.Int,
  kind: AwaitingKind,
  reason: Schema.String,
  since: Schema.Number,
})
export type Awaiting = typeof Awaiting.Type

export const TurnStage = Schema.Literals(["preparing", "working", "saving"])
export type TurnStage = typeof TurnStage.Type

export const Inspection = Schema.Struct({
  sessionId: SessionId,
  generation: Generation,
  nativeSessionId: Schema.NullOr(Schema.String),
  modelConfigurationId: Schema.NullOr(Schema.String),
  execution: ExecutionState,
  reason: Schema.NullOr(Schema.String),
  /** Accepted inputs not yet completed or skipped, including the active one. */
  pendingInputs: Schema.Int,
  admittedInputs: Schema.Int,
  awaiting: Schema.NullOr(Awaiting),
  usage: Schema.NullOr(UsageTotals),
  release: Schema.String,
})
export type Inspection = typeof Inspection.Type

/**
 * Janitor's durable turn events. `type` is one of:
 * - `turn.accepted` `{inputId}`: durably accepted and queued.
 * - `turn.started` `{inputId, attempt}`: an attempt began.
 * - `turn.stage` `{inputId, attempt, stage}`: preparing, working or saving.
 * - `turn.message` `{inputId, attempt, ordinal, text}`: an assistant text block landed while the model works; the last block repeats as `turn.completed`'s text.
 * - `turn.published` `{inputId, attempt, publication}`: a PR was pushed or updated.
 * - `turn.completed` `{inputId, attempt, text}`: the recovery point is committed; `text` is the reply.
 * - `turn.interrupted` `{inputId, attempt, reason}`: waits for Retry or Skip.
 * - `turn.save_failed` `{inputId, attempt, reason}`: model work finished but could not be saved.
 * - `turn.retried` `{inputId, attempt, actor}`: a teammate retried; `attempt` is the new attempt.
 * - `turn.skipped` `{inputId, attempt, actor}`: a teammate skipped the input.
 */
export const RunnerEvent = Schema.Struct({
  seq: Schema.Int,
  type: Schema.String,
  created: Schema.Number,
  data: Schema.Unknown,
})
export type RunnerEvent = typeof RunnerEvent.Type

export const EventsRead = Schema.Struct({
  sessionId: SessionId,
  /** Exclusive cursor the caller supplied. */
  after: Schema.Int,
  events: Schema.Array(RunnerEvent),
  /** The next exclusive cursor: the last returned seq, or `after` when empty. */
  next: Schema.Int,
  /** Committed watermark; equals `next` once the reader has caught up. Null before any event. */
  synced: Schema.NullOr(Schema.Int),
  usage: Schema.NullOr(UsageTotals),
  /** Current runner-side state, so blocks reach consumers through reads. */
  execution: ExecutionState,
  reason: Schema.NullOr(Schema.String),
})
export type EventsRead = typeof EventsRead.Type

export const Actor = Schema.Struct({
  source: Schema.Literals(["slack", "github", "driver"]),
  teammateId: Schema.optionalKey(Schema.String),
  displayName: Schema.optionalKey(Schema.String),
})
export type Actor = typeof Actor.Type

export const TurnActionKind = Schema.Literals(["retry", "skip"])
export type TurnActionKind = typeof TurnActionKind.Type

/** A teammate's Retry or Skip of one specific interrupted attempt. */
export const TurnAction = Schema.Struct({
  generation: Generation,
  inputId: InputId,
  attempt: Schema.Int,
  action: TurnActionKind,
  /** Deduplication identity of the click or request. */
  actionId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9:._-]{1,200}$/)),
  actor: Actor,
})
export type TurnAction = typeof TurnAction.Type

export const TurnActionOutcome = Schema.Literals(["applied", "duplicate", "stale", "not_awaiting"])
export type TurnActionOutcome = typeof TurnActionOutcome.Type

export const TurnActionResult = Schema.Struct({
  outcome: TurnActionOutcome,
  message: Schema.String,
  awaiting: Schema.NullOr(Awaiting),
})
export type TurnActionResult = typeof TurnActionResult.Type

export const Cleanup = Schema.Struct({ generation: Generation })
export type Cleanup = typeof Cleanup.Type

export const CleanupResult = Schema.Struct({ sessionId: SessionId, cleaned: Schema.Boolean })
export type CleanupResult = typeof CleanupResult.Type

export const ErrorCode = Schema.Literals([
  "unauthorized",
  "incompatible_protocol",
  "invalid_request",
  "stale_generation",
  "missing_session",
  "blocked",
  "transport",
])
export type ErrorCode = typeof ErrorCode.Type

export const ErrorBody = Schema.Struct({
  code: ErrorCode,
  message: Schema.String,
  /** Concrete blocker for `blocked`. */
  reason: Schema.optionalKey(Schema.String),
})
export type ErrorBody = typeof ErrorBody.Type

export const errorStatus = (code: ErrorCode): number => {
  switch (code) {
    case "unauthorized":
      return 401
    case "incompatible_protocol":
      return 426
    case "invalid_request":
      return 400
    case "stale_generation":
      return 409
    case "missing_session":
      return 404
    case "blocked":
      return 423
    case "transport":
      return 503
  }
}

export class ProtocolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly reason?: string,
  ) {
    super(message)
  }
  get body(): ErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.reason === undefined ? {} : { reason: this.reason }),
    }
  }
  get status() {
    return errorStatus(this.code)
  }
}
