// Janitor's declaration of the versioned runner JSON protocol.
// These applications share dependencies but deploy independently. Version and
// compatibility tests guard rolling deployments between these declarations.
import * as Schema from "effect/Schema"

export const RUNNER_PROTOCOL_VERSION = 2
export const RUNNER_PROTOCOL_HEADER = "x-janitor-runner-protocol"
/** The runner state family this Janitor release is tested against (`apps/runner/release-manifest.json`). */
export const RUNNER_STATE_FAMILY = "janitor-runner-1"
/** The durable event contract Janitor's projection consumes (`apps/runner/release-manifest.json`). */
export const RUNNER_EVENT_CONTRACT = 1

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

export const MaintenanceRequest = Schema.Struct({
  hold: Schema.Boolean,
  epoch: Schema.Int,
})
export type MaintenanceRequest = typeof MaintenanceRequest.Type

export const MaintenanceCheck = Schema.Struct({
  name: Schema.Literals(["fence", "state", "checkpoint", "model", "bridge"]),
  ok: Schema.Boolean,
  detail: Schema.String,
})
export type MaintenanceCheck = typeof MaintenanceCheck.Type

export const MaintenanceResult = Schema.Struct({
  held: Schema.Boolean,
  epoch: Schema.NullOr(Schema.Int),
  /** No host-scoped execution can act and every upload has settled. */
  quiescent: Schema.Boolean,
  /** An operation's outcome is unknown; the runner holds recovery for reconciliation. */
  uncertain: Schema.Boolean,
  /** The checks a release ran; a refused release stays held and names the failures. */
  checks: Schema.Array(MaintenanceCheck),
})
export type MaintenanceResult = typeof MaintenanceResult.Type

/** What a runner deployment answers on its health route: identity and pinned manifest. */
export const RunnerHealth = Schema.Struct({
  protocol: Schema.Int,
  release: Schema.String,
  manifest: Schema.Struct({
    family: Schema.String,
    readableFamilies: Schema.Array(Schema.String),
    commandProtocol: Schema.Struct({ version: Schema.Int, accepted: Schema.Array(Schema.Int) }),
    events: Schema.Struct({ contract: Schema.Int }),
    bridge: Schema.Struct({
      protocol: Schema.Int,
      sourceHash: Schema.String,
      imageDigest: Schema.String,
    }),
  }),
  /** Disagreements between the pinned manifest and the compiled bundle. */
  problems: Schema.Array(Schema.String),
})
export type RunnerHealth = typeof RunnerHealth.Type

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
