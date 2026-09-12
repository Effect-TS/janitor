// The versioned command boundary between Janitor and the runner.
//
// Janitor and the runner are built from different dependency graphs, so they
// exchange plain JSON: no Effect services, fibers or implementation error
// objects cross this boundary. Janitor re-declares these shapes in its own
// graph; the protocol version guards drift between the two declarations.
import { Schema } from "effect"

export const PROTOCOL_VERSION = 1
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
  /** Omitted selects the deployment default for a new session; existing sessions keep their record. */
  modelConfigurationId: Schema.optionalKey(Schema.String),
})
export type CreateSession = typeof CreateSession.Type

export const CreateSessionResult = Schema.Struct({
  sessionId: SessionId,
  generation: Generation,
  nativeSessionId: Schema.String,
  modelConfigurationId: Schema.String,
  /** False when an earlier creation already established the native conversation. */
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
 * was already admitted; the retained payload hash identifies which payload the
 * conversation holds when a retry disagrees.
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

export const Inspection = Schema.Struct({
  sessionId: SessionId,
  generation: Generation,
  nativeSessionId: Schema.NullOr(Schema.String),
  modelConfigurationId: Schema.NullOr(Schema.String),
  execution: ExecutionState,
  reason: Schema.NullOr(Schema.String),
  wakeObligation: Schema.Boolean,
  supervisionRevision: Schema.Int,
  alarmAt: Schema.NullOr(Schema.Number),
  pendingInputs: Schema.Int,
  admittedInputs: Schema.Int,
  claimHeld: Schema.Boolean,
  lastOutcome: Schema.NullOr(Schema.String),
  maintenanceEpoch: Schema.NullOr(Schema.Int),
  usage: Schema.NullOr(UsageTotals),
  release: Schema.String,
})
export type Inspection = typeof Inspection.Type

export const RunnerEvent = Schema.Struct({
  seq: Schema.Int,
  id: Schema.String,
  type: Schema.String,
  version: Schema.Int,
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
  /** Committed watermark; equals `next` once the reader has caught up. Null before any durable event. */
  synced: Schema.NullOr(Schema.Int),
  usage: Schema.NullOr(UsageTotals),
  /** Current runner-side state, so maintenance and compatibility holds reach consumers through reads. */
  execution: ExecutionState,
  reason: Schema.NullOr(Schema.String),
})
export type EventsRead = typeof EventsRead.Type

export const Maintenance = Schema.Struct({
  hold: Schema.Boolean,
  epoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type Maintenance = typeof Maintenance.Type

export const MaintenanceResult = Schema.Struct({
  held: Schema.Boolean,
  epoch: Schema.NullOr(Schema.Int),
  /** True once no host-scoped execution owned by this object can act. */
  quiescent: Schema.Boolean,
})
export type MaintenanceResult = typeof MaintenanceResult.Type

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
  /** Concrete blocker for `blocked`; the maintenance or compatibility reason. */
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
