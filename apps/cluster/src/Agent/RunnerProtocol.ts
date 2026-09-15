// Janitor's declaration of the versioned runner JSON protocol.
// These applications share dependencies but deploy independently. Version and
// compatibility tests guard rolling deployments between these declarations.
import * as Schema from "effect/Schema"

export const RUNNER_PROTOCOL_VERSION = 4
export const RUNNER_PROTOCOL_HEADER = "x-janitor-runner-protocol"

export const AgentSessionId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,120}$/))
export type AgentSessionId = typeof AgentSessionId.Type

export const RunnerMessageId = Schema.String.check(Schema.isPattern(/^msg_[A-Za-z0-9_-]{1,120}$/))
export type RunnerMessageId = typeof RunnerMessageId.Type

export const InputSource = Schema.Literals(["slack", "github", "driver"])
export type InputSource = typeof InputSource.Type

export const InputAttribution = Schema.Struct({
  source: InputSource,
  teammateId: Schema.optionalKey(Schema.String),
  displayName: Schema.optionalKey(Schema.String),
  contributionKey: Schema.optionalKey(Schema.String),
})
export type InputAttribution = typeof InputAttribution.Type

export const CreateSessionRequest = Schema.Struct({
  generation: Schema.Int,
  title: Schema.String,
  repositoryId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9]+$/))),
  modelConfigurationId: Schema.optionalKey(Schema.String),
})
export type CreateSessionRequest = typeof CreateSessionRequest.Type

export const CreateSessionResult = Schema.Struct({
  sessionId: AgentSessionId,
  generation: Schema.Int,
  nativeSessionId: Schema.String,
  modelConfigurationId: Schema.String,
  created: Schema.Boolean,
})
export type CreateSessionResult = typeof CreateSessionResult.Type

export const AdmitInputRequest = Schema.Struct({
  generation: Schema.Int,
  inputId: RunnerMessageId,
  text: Schema.String,
  attribution: InputAttribution,
})
export type AdmitInputRequest = typeof AdmitInputRequest.Type

export const AdmitResult = Schema.Struct({
  inputId: RunnerMessageId,
  nativeSessionId: Schema.String,
  status: Schema.Literal("admitted"),
  admittedAt: Schema.Finite,
  payloadHash: Schema.String,
  duplicate: Schema.Boolean,
  payloadMatches: Schema.Boolean,
})
export type AdmitResult = typeof AdmitResult.Type

export const ExecutionState = Schema.Literals(["working", "idle", "blocked", "failed"])
export type ExecutionState = typeof ExecutionState.Type

export const UsageTotals = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  seq: Schema.Finite,
})
export type UsageTotals = typeof UsageTotals.Type

export const AwaitingKind = Schema.Literals(["interrupted", "save_failed"])
export type AwaitingKind = typeof AwaitingKind.Type

/** The interrupted attempt a session waits on until a teammate retries or skips it. */
export const Awaiting = Schema.Struct({
  inputId: RunnerMessageId,
  attempt: Schema.Int,
  kind: AwaitingKind,
  reason: Schema.String,
  since: Schema.Finite,
})
export type Awaiting = typeof Awaiting.Type

export const Inspection = Schema.Struct({
  sessionId: AgentSessionId,
  generation: Schema.Int,
  nativeSessionId: Schema.NullOr(Schema.String),
  modelConfigurationId: Schema.NullOr(Schema.String),
  execution: ExecutionState,
  reason: Schema.NullOr(Schema.String),
  pendingInputs: Schema.Int,
  admittedInputs: Schema.Int,
  awaiting: Schema.NullOr(Awaiting),
  usage: Schema.NullOr(UsageTotals),
  release: Schema.String,
})
export type Inspection = typeof Inspection.Type

/** One durable turn event; the runner documents the `type` vocabulary in its protocol. */
export const RunnerEvent = Schema.Struct({
  seq: Schema.Int,
  type: Schema.String,
  created: Schema.Finite,
  data: Schema.Unknown,
})
export type RunnerEvent = typeof RunnerEvent.Type

export const TurnStage = Schema.Literals(["preparing", "working", "saving"])
export type TurnStage = typeof TurnStage.Type

/** The fields turn events carry; consumers decode what they use. */
export const TurnEventData = Schema.Struct({
  inputId: Schema.optionalKey(Schema.String),
  attempt: Schema.optionalKey(Schema.Int),
  stage: Schema.optionalKey(TurnStage),
  /** Position of a `turn.message` text block within its attempt. */
  ordinal: Schema.optionalKey(Schema.Int),
  text: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  publication: Schema.optionalKey(
    Schema.Struct({
      operationId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      repositoryId: Schema.String,
      number: Schema.Int.check(Schema.isGreaterThan(0)),
      url: Schema.String.check(
        Schema.isPattern(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+$/),
      ),
      title: Schema.String,
      body: Schema.String,
    }),
  ),
})
export type TurnEventData = typeof TurnEventData.Type

export const EventsRead = Schema.Struct({
  sessionId: AgentSessionId,
  after: Schema.Int,
  events: Schema.Array(RunnerEvent),
  next: Schema.Int,
  synced: Schema.NullOr(Schema.Int),
  usage: Schema.NullOr(UsageTotals),
  execution: ExecutionState,
  reason: Schema.NullOr(Schema.String),
})
export type EventsRead = typeof EventsRead.Type

export const Actor = Schema.Struct({
  source: InputSource,
  teammateId: Schema.optionalKey(Schema.String),
  displayName: Schema.optionalKey(Schema.String),
})
export type Actor = typeof Actor.Type

export const TurnActionKind = Schema.Literals(["retry", "skip"])
export type TurnActionKind = typeof TurnActionKind.Type

export const TurnActionRequest = Schema.Struct({
  generation: Schema.Int,
  inputId: RunnerMessageId,
  attempt: Schema.Int,
  action: TurnActionKind,
  actionId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9:._-]{1,200}$/)),
  actor: Actor,
})
export type TurnActionRequest = typeof TurnActionRequest.Type

export const TurnActionOutcome = Schema.Literals(["applied", "duplicate", "stale", "not_awaiting"])
export type TurnActionOutcome = typeof TurnActionOutcome.Type

export const TurnActionResult = Schema.Struct({
  outcome: TurnActionOutcome,
  message: Schema.String,
  awaiting: Schema.NullOr(Awaiting),
})
export type TurnActionResult = typeof TurnActionResult.Type

export const CleanupResult = Schema.Struct({ sessionId: AgentSessionId, cleaned: Schema.Boolean })
export type CleanupResult = typeof CleanupResult.Type

export const RunnerErrorCode = Schema.Literals([
  "unauthorized",
  "incompatible_protocol",
  "invalid_request",
  "stale_generation",
  "missing_session",
  "blocked",
  "transport",
])
export type RunnerErrorCode = typeof RunnerErrorCode.Type

export const RunnerErrorBody = Schema.Struct({
  code: RunnerErrorCode,
  message: Schema.String,
  reason: Schema.optionalKey(Schema.String),
})
export type RunnerErrorBody = typeof RunnerErrorBody.Type
