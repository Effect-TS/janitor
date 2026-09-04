import {
  SyncGeneration,
  SyncGenerationFromStringOrNumber,
  SyncScope,
  type SyncTargetRecord,
  syncScopeKey,
} from "@janitor/domain/GitHub/Sync"
import {
  GitHubWebhookJournalSequence,
  GitHubWebhookJournalSequenceFromStringOrNumber,
} from "@janitor/domain/GitHub/WebhookJournal"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlError from "effect/unstable/sql/SqlError"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describeError } from "./SqlErrors.ts"
import { syncRequest } from "./SyncRequests.ts"
import { WorkflowOutbox } from "./WorkflowOutbox.ts"

export class SyncTargetError extends Schema.TaggedError<SyncTargetError>()(
  "@janitor/cluster/SyncTargets/SyncTargetError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

/** How long a burst of invalidations waits before its first sync starts. */
export const SYNC_DEBOUNCE = Duration.seconds(5)

export interface InvalidateRequest {
  readonly scope: SyncScope
  /** Highest journal sequence that motivated this invalidation, if any. */
  readonly sequence: Option.Option<GitHubWebhookJournalSequence>
  /** Ask the next run to ignore its watermark and scan from scratch. */
  readonly full?: boolean | undefined
  readonly immediate?: boolean | undefined
}

export interface InvalidateResult {
  readonly generation: SyncGeneration
  /** True when this call created the outbox request; false when a run already covers it. */
  readonly dispatched: boolean
}

export type BeginResult =
  | {
      readonly _tag: "Run"
      /** The generation captured once for this execution, including begin replays. */
      readonly generation: SyncGeneration
      readonly sequence: Option.Option<GitHubWebhookJournalSequence>
      /** Cutoff committed by the last complete incremental scan, if any. */
      readonly watermark: Option.Option<DateTime.Utc>
      /** True when a full repair was requested; the run must not rely on the watermark. */
      readonly full: boolean
    }
  | { readonly _tag: "Superseded" }

export type SyncOutcome =
  | { readonly _tag: "Verified"; readonly watermark: Option.Option<DateTime.Utc> }
  | { readonly _tag: "Blocked"; readonly reason: string }
  | { readonly _tag: "Failed"; readonly error: string }

export interface CompleteRequest {
  readonly scope: SyncScope
  readonly generation: SyncGeneration
  readonly outcome: SyncOutcome
}

const TargetRow = Schema.Struct({
  scope_key: Schema.String,
  scope: SyncScope,
  requested_generation: SyncGenerationFromStringOrNumber,
  dispatched_generation: SyncGenerationFromStringOrNumber,
  completed_generation: SyncGenerationFromStringOrNumber,
  verified_generation: SyncGenerationFromStringOrNumber,
  requested_sequence: Schema.NullOr(GitHubWebhookJournalSequenceFromStringOrNumber),
  verified_sequence: Schema.NullOr(GitHubWebhookJournalSequenceFromStringOrNumber),
  verified_at: Schema.NullOr(Schema.DateTimeUtcFromDate),
  health: Schema.Literals(["ok", "blocked"]),
  blocked_reason: Schema.NullOr(Schema.String),
  last_error: Schema.NullOr(Schema.String),
  scan_watermark: Schema.NullOr(Schema.DateTimeUtcFromDate),
  full_requested: Schema.Boolean,
  updated_at: Schema.DateTimeUtcFromDate,
  execution_generation: Schema.NullOr(SyncGenerationFromStringOrNumber),
  active_generation: Schema.NullOr(SyncGenerationFromStringOrNumber),
  active_sequence: Schema.NullOr(GitHubWebhookJournalSequenceFromStringOrNumber),
  active_full: Schema.Boolean,
})

const toRecord = (row: typeof TargetRow.Type): SyncTargetRecord => ({
  scopeKey: row.scope_key,
  scope: row.scope,
  requestedGeneration: row.requested_generation,
  dispatchedGeneration: row.dispatched_generation,
  completedGeneration: row.completed_generation,
  verifiedGeneration: row.verified_generation,
  requestedSequence: row.requested_sequence,
  verifiedSequence: row.verified_sequence,
  verifiedAt: row.verified_at,
  health: row.health,
  blockedReason: row.blocked_reason,
  lastError: row.last_error,
})

const gt = (a: SyncGeneration, b: SyncGeneration) => BigInt(a) > BigInt(b)

/**
 * SQL-owned coalescing. Invalidations bump one counter per scope and create
 * at most one pending run; work that arrives during a run yields exactly one
 * follow-up at completion via compare-and-set.
 */
export class SyncTargets extends Context.Service<
  SyncTargets,
  {
    /** Atomic on its own; composes with an ambient transaction. */
    readonly invalidate: (
      request: InvalidateRequest,
    ) => Effect.Effect<InvalidateResult, SyncTargetError>
    readonly begin: (
      scope: SyncScope,
      generation: SyncGeneration,
    ) => Effect.Effect<BeginResult, SyncTargetError>
    /** Joins the caller's transaction. Returns true only when the completing generation still owned the target. */
    readonly complete: (request: CompleteRequest) => Effect.Effect<boolean, SyncTargetError>
    /** Runs writes only while this generation owns the target, in the same transaction. */
    readonly withRun: <A, E, R>(
      scope: SyncScope,
      generation: SyncGeneration,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E | SyncTargetError, R>
    readonly retryDue: Effect.Effect<number, SyncTargetError>
    /** Replace a terminal engine execution only if it still owns the target. */
    readonly recoverTerminal: (
      scope: SyncScope,
      executionGeneration: SyncGeneration,
    ) => Effect.Effect<void, SyncTargetError>
    readonly get: (
      scope: SyncScope,
    ) => Effect.Effect<Option.Option<SyncTargetRecord>, SyncTargetError>
  }
>()("@janitor/cluster/SyncTargets/SyncTargets", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const outbox = yield* WorkflowOutbox
    const decodeRows = Schema.decodeUnknownEffect(Schema.Array(TargetRow))
    const encodeScope = Schema.encodeEffect(Schema.fromJsonString(SyncScope))

    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new SyncTargetError({ operation, message: describeError(error) }),
        )

    const enqueueRun = (scope: SyncScope, generation: SyncGeneration, immediate = false) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        yield* outbox.enqueue({
          ...syncRequest(scope, generation),
          dueAt: DateTime.toDateUtc(immediate ? now : DateTime.addDuration(now, SYNC_DEBOUNCE)),
        })
        yield* sql`
          UPDATE sync_target SET dispatched_generation = ${generation}, execution_generation = ${generation},
            retry_at = NULL, updated_at = CLOCK_TIMESTAMP()
          WHERE scope_key = ${syncScopeKey(scope)}
        `
      })

    const invalidate = Effect.fn("SyncTargets.invalidate")(function* (request: InvalidateRequest) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const scopeKey = syncScopeKey(request.scope)
            const scopeJson = yield* encodeScope(request.scope)
            const rows = yield* sql`
          INSERT INTO sync_target (scope_key, scope, requested_generation, requested_sequence, full_requested)
          VALUES (${scopeKey}, ${scopeJson}::jsonb, 1, ${Option.getOrNull(request.sequence)}, ${request.full === true})
          ON CONFLICT (scope_key) DO UPDATE SET
            requested_generation = sync_target.requested_generation + 1,
            requested_sequence = GREATEST(sync_target.requested_sequence, EXCLUDED.requested_sequence),
            full_requested = sync_target.full_requested OR EXCLUDED.full_requested
          RETURNING *
        `.pipe(Effect.flatMap(decodeRows))
            const row = rows[0]!
            if (gt(row.dispatched_generation, row.completed_generation)) {
              // A manual request may accelerate an unsubmitted debounced run.
              if (request.immediate) {
                yield* outbox.enqueue({
                  ...syncRequest(request.scope, row.execution_generation!),
                  dueAt: DateTime.toDateUtc(yield* DateTime.now),
                })
              }
              return { generation: row.requested_generation, dispatched: false }
            }
            yield* enqueueRun(request.scope, row.requested_generation, request.immediate)
            return { generation: row.requested_generation, dispatched: true }
          }),
        )
        .pipe(wrap("invalidate"))
    })

    const begin = Effect.fn("SyncTargets.begin")(function* (
      scope: SyncScope,
      generation: SyncGeneration,
    ) {
      const rows = yield* sql`
        UPDATE sync_target SET
          active_generation = COALESCE(active_generation, requested_generation),
          active_sequence = CASE WHEN active_generation IS NULL THEN
            GREATEST(requested_sequence, (SELECT MAX(sequence) FROM github_webhook_delivery)) ELSE active_sequence END,
          active_full = CASE WHEN active_generation IS NULL THEN full_requested OR (scope->>'_tag' = 'RepositoryTrack' AND scan_watermark IS NULL) ELSE active_full END,
          full_requested = CASE WHEN active_generation IS NULL THEN FALSE ELSE full_requested END,
          dispatched_generation = COALESCE(active_generation, requested_generation),
          updated_at = CLOCK_TIMESTAMP()
        WHERE scope_key = ${syncScopeKey(scope)} AND execution_generation = ${generation}
          AND completed_generation < dispatched_generation
        RETURNING *
      `.pipe(Effect.flatMap(decodeRows), wrap("begin"))
      const row = rows[0]
      return row === undefined
        ? ({ _tag: "Superseded" } as const)
        : {
            _tag: "Run" as const,
            generation: row.active_generation!,
            sequence: Option.fromNullishOr(row.active_sequence),
            watermark: Option.fromNullishOr(row.scan_watermark),
            full: row.active_full,
          }
    })

    const complete = Effect.fn("SyncTargets.complete")(function* (request: CompleteRequest) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const { outcome } = request
            const verified = outcome._tag === "Verified"
            const watermark = verified
              ? Option.getOrNull(Option.map(outcome.watermark, DateTime.toDateUtc))
              : null
            const rows = yield* sql`
          UPDATE sync_target SET
            completed_generation = ${request.generation},
            scan_watermark = CASE WHEN ${verified} THEN COALESCE(${watermark}, scan_watermark) ELSE scan_watermark END,
            last_full_at = CASE WHEN ${verified} AND active_full THEN CLOCK_TIMESTAMP() ELSE last_full_at END,
            full_requested = full_requested OR (active_full AND NOT ${verified}),
            verified_generation = CASE WHEN ${verified} THEN ${request.generation} ELSE verified_generation END,
            verified_sequence = CASE WHEN ${verified} THEN active_sequence ELSE verified_sequence END,
            verified_at = CASE WHEN ${verified} THEN CLOCK_TIMESTAMP() ELSE verified_at END,
            health = ${outcome._tag === "Blocked" ? "blocked" : "ok"},
            blocked_reason = ${outcome._tag === "Blocked" ? outcome.reason : null},
            last_error = ${outcome._tag === "Failed" ? outcome.error : null},
            retry_at = CASE WHEN ${!verified} THEN CLOCK_TIMESTAMP() + INTERVAL '5 minutes' ELSE NULL END,
            active_generation = NULL, active_sequence = NULL, active_full = FALSE,
            updated_at = CLOCK_TIMESTAMP()
          WHERE scope_key = ${syncScopeKey(request.scope)} AND active_generation = ${request.generation}
          RETURNING *
        `.pipe(Effect.flatMap(decodeRows))
            const row = rows[0]
            if (row === undefined) return false
            if (gt(row.requested_generation, request.generation)) {
              yield* enqueueRun(request.scope, row.requested_generation)
            }
            return true
          }),
        )
        .pipe(wrap("complete"))
    })

    const withRun = <A, E, R>(
      scope: SyncScope,
      generation: SyncGeneration,
      effect: Effect.Effect<A, E, R>,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql`
          SELECT scope_key FROM sync_target WHERE scope_key = ${syncScopeKey(scope)}
            AND active_generation = ${generation} FOR UPDATE
        `.pipe(wrap("withRun"))
            return rows.length === 0 ? Option.none<A>() : Option.some(yield* effect)
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            SqlError.isSqlError(error)
              ? new SyncTargetError({ operation: "withRun", message: error.message })
              : error,
          ),
        )

    const retryDue = sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql`
        SELECT * FROM sync_target WHERE retry_at <= CLOCK_TIMESTAMP()
          AND requested_generation = completed_generation FOR UPDATE SKIP LOCKED
      `.pipe(Effect.flatMap(decodeRows))
          for (const row of rows)
            yield* invalidate({ scope: row.scope, sequence: Option.none(), immediate: true })
          return rows.length
        }),
      )
      .pipe(wrap("retryDue"))

    const recoverTerminal = (scope: SyncScope, executionGeneration: SyncGeneration) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql`
          UPDATE sync_target SET completed_generation = dispatched_generation,
            active_generation = NULL, active_sequence = NULL,
            full_requested = full_requested OR active_full, active_full = FALSE,
            last_error = 'Workflow terminated before completing its target',
            retry_at = CLOCK_TIMESTAMP() + INTERVAL '5 minutes'
          WHERE scope_key = ${syncScopeKey(scope)} AND execution_generation = ${executionGeneration}
            AND dispatched_generation > completed_generation RETURNING *
        `.pipe(Effect.flatMap(decodeRows))
            const row = rows[0]
            if (row !== undefined && gt(row.requested_generation, row.completed_generation)) {
              yield* enqueueRun(scope, row.requested_generation)
            }
          }),
        )
        .pipe(wrap("recoverTerminal"))

    const get = Effect.fn("SyncTargets.get")(function* (scope: SyncScope) {
      const rows = yield* sql`
        SELECT * FROM sync_target WHERE scope_key = ${syncScopeKey(scope)}
      `.pipe(Effect.flatMap(decodeRows), wrap("get"))
      return Option.map(Option.fromNullishOr(rows[0]), toRecord)
    })

    return { invalidate, begin, complete, get, withRun, retryDue, recoverTerminal }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
