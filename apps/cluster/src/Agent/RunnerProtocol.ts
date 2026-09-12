// Janitor's declaration of the versioned runner command boundary.
//
// The runner (`runner/src/Protocol.ts`) is built from a separate dependency
// graph, so the shapes are declared twice and exchanged as plain JSON. Both
// declarations carry the protocol version; the runner rejects mismatches.
import * as Schema from "effect/Schema"

export const RUNNER_PROTOCOL_VERSION = 2
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

export const Inspection = Schema.Struct({
  sessionId: AgentSessionId,
  generation: Schema.Int,
  nativeSessionId: Schema.NullOr(Schema.String),
  modelConfigurationId: Schema.NullOr(Schema.String),
  execution: ExecutionState,
  reason: Schema.NullOr(Schema.String),
  wakeObligation: Schema.Boolean,
  supervisionRevision: Schema.Int,
  alarmAt: Schema.NullOr(Schema.Finite),
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
  created: Schema.Finite,
  data: Schema.Unknown,
})
export type RunnerEvent = typeof RunnerEvent.Type

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

export const MaintenanceResult = Schema.Struct({
  held: Schema.Boolean,
  epoch: Schema.NullOr(Schema.Int),
  quiescent: Schema.Boolean,
})
export type MaintenanceResult = typeof MaintenanceResult.Type

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
