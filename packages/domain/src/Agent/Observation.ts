import * as Schema from "effect/Schema"

/**
 * The Janitor dashboard's view of agent sessions (spec: "Observation and
 * lifecycle"). Compact facts only: no conversation history, execution logs,
 * commands, pricing or team totals.
 */

export const ExecutionState = Schema.Literals(["working", "idle", "blocked", "failed"])
export type ExecutionState = typeof ExecutionState.Type

/** The five normalized OpenCode buckets, retained so a later breakdown needs no reprojection. */
export const UsageBuckets = Schema.Struct({
  input: Schema.Int,
  output: Schema.Int,
  reasoning: Schema.Int,
  cacheRead: Schema.Int,
  cacheWrite: Schema.Int,
})
export type UsageBuckets = typeof UsageBuckets.Type

/**
 * Session-lifetime totals as displayed: input folds in cache traffic, output
 * folds in reasoning. The projection keeps the buckets; the wire carries the
 * two totals the dashboard shows.
 */
export const RecordedUsage = Schema.Struct({
  input: Schema.Int,
  output: Schema.Int,
})
export type RecordedUsage = typeof RecordedUsage.Type

export const displayedUsage = (buckets: UsageBuckets): RecordedUsage => ({
  input: buckets.input + buckets.cacheRead + buckets.cacheWrite,
  output: buckets.output + buckets.reasoning,
})

/** Standing explanation shown next to every total; normalized zeros cannot prove completeness. */
export const USAGE_NOTE =
  "Recorded by OpenCode, not a bill. Input includes cached reads and writes; output includes reasoning. Interrupted or unreported model usage is not counted, and a recorded zero cannot confirm the provider reported nothing."

export const USAGE_UNAVAILABLE = "No usage recorded yet"

export const SessionRepository = Schema.Struct({
  repositoryId: Schema.String,
  owner: Schema.String,
  repo: Schema.String,
})
export type SessionRepository = typeof SessionRepository.Type

export const HomeThread = Schema.Struct({
  platform: Schema.Literal("slack"),
  url: Schema.String,
})
export type HomeThread = typeof HomeThread.Type

export const PullRequestLink = Schema.Struct({
  number: Schema.Int,
  url: Schema.String,
})
export type PullRequestLink = typeof PullRequestLink.Type

/** When the projection was last confirmed against the runner, independent of activity. */
export const Freshness = Schema.Struct({
  /** Last successful runner read; null before the first. */
  readAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  /** Last read failure retained by the catch-up obligation, if the latest read failed. */
  error: Schema.NullOr(Schema.String),
})
export type Freshness = typeof Freshness.Type

export const SessionSummary = Schema.Struct({
  sessionId: Schema.String,
  title: Schema.String,
  repository: Schema.NullOr(SessionRepository),
  homeThread: Schema.NullOr(HomeThread),
  pullRequests: Schema.Array(PullRequestLink),
  execution: ExecutionState,
  reason: Schema.NullOr(Schema.String),
  /** Latest meaningful activity: accepted input or agent work, never heartbeats. */
  activityAt: Schema.DateTimeUtcFromString,
  /** Null until the first usable cumulative snapshot. */
  usage: Schema.NullOr(RecordedUsage),
  deliveryWarning: Schema.NullOr(Schema.String),
  freshness: Freshness,
})
export type SessionSummary = typeof SessionSummary.Type

/**
 * Keyset position: working first, then activity descending, then session ID.
 * `activityAt` is the database's own text form of the activity time, kept
 * opaque so the comparison keeps its full precision.
 */
export const SessionCursor = Schema.Struct({
  working: Schema.Boolean,
  activityAt: Schema.String,
  sessionId: Schema.String,
})
export type SessionCursor = typeof SessionCursor.Type

export const SessionPage = Schema.Struct({
  sessions: Schema.Array(SessionSummary),
  cursor: Schema.NullOr(SessionCursor),
})
export type SessionPage = typeof SessionPage.Type

export const DeliveryItem = Schema.Struct({
  platform: Schema.Literals(["slack", "github"]),
  state: Schema.String,
  error: Schema.NullOr(Schema.String),
})
export type DeliveryItem = typeof DeliveryItem.Type

export const SessionDetail = Schema.Struct({
  ...SessionSummary.fields,
  /** Accepted inputs the runner has not yet confirmed. */
  pendingInputs: Schema.Int,
  acceptedInputs: Schema.Int,
  lastInputAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  /** The latest actionable error: execution, admission or runner refusal. */
  latestError: Schema.NullOr(Schema.String),
  /** Outputs not yet confirmed on their platform. */
  pendingDelivery: Schema.Array(DeliveryItem),
})
export type SessionDetail = typeof SessionDetail.Type
