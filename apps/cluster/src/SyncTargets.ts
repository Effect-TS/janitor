import { withRepositoryActivity } from "./RepositoryActivity.ts"
import type { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
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
  /** Present only for the item concerned by a new webhook event. */
  readonly webhookReceivedAt?: Date | undefined
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
      progress?: { readonly page: number; readonly items: number },
    ) => Effect.Effect<Option.Option<A>, E | SyncTargetError, R>
    readonly retryDue: Effect.Effect<number, SyncTargetError>
    readonly retryFailedEntities: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<number, SyncTargetError>
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
        const encoded = yield* encodeScope(scope)
        const [policy] = yield* sql<{
          enabled: boolean
        }>`SELECT sync_scope_enabled(${encoded}::jsonb) AS enabled`
        if (!policy?.enabled) return false
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
        return true
      })

    const invalidate = Effect.fn("SyncTargets.invalidate")(function* (request: InvalidateRequest) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            if (request.scope._tag === "RepositoryTrack" || request.scope._tag === "Entity")
              yield* sql`SELECT repository_id FROM github_repository WHERE repository_id = ${request.scope.repositoryId} FOR NO KEY UPDATE`
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
            if (request.scope._tag === "Entity") {
              yield* sql`UPDATE sync_target SET automation_event_at = CASE
                WHEN repository_automation_ready(${request.scope.repositoryId})
                  AND ${request.webhookReceivedAt ?? null}::timestamptz >
                    (SELECT automation_ready_at FROM github_repository WHERE repository_id = ${request.scope.repositoryId})
                THEN ${request.webhookReceivedAt ?? null}::timestamptz ELSE NULL END
                WHERE scope_key = ${scopeKey}`
            }
            if (gt(row.dispatched_generation, row.completed_generation)) {
              // A manual request may accelerate an unsubmitted debounced run.
              if (request.immediate) {
                const [policy] = yield* sql<{
                  enabled: boolean
                }>`SELECT sync_scope_enabled(${scopeJson}::jsonb) AS enabled`
                if (!policy?.enabled)
                  return { generation: row.requested_generation, dispatched: false }
                yield* outbox.enqueue({
                  ...syncRequest(request.scope, row.execution_generation!),
                  dueAt: DateTime.toDateUtc(yield* DateTime.now),
                })
              }
              return { generation: row.requested_generation, dispatched: false }
            }
            const dispatched = yield* enqueueRun(
              request.scope,
              row.requested_generation,
              request.immediate,
            )
            return { generation: row.requested_generation, dispatched }
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
          progressed_at = CASE WHEN active_generation IS NULL THEN CLOCK_TIMESTAMP() ELSE progressed_at END,
          progress_page = CASE WHEN active_generation IS NULL THEN -1 ELSE progress_page END,
          progress_items = CASE WHEN active_generation IS NULL THEN 0 ELSE progress_items END,
          no_result_since = CASE WHEN active_generation IS NULL THEN NULL ELSE no_result_since END,
          updated_at = CLOCK_TIMESTAMP()
        WHERE scope_key = ${syncScopeKey(scope)} AND execution_generation = ${generation}
          AND completed_generation < dispatched_generation AND sync_scope_enabled(scope)
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

    // Called under the repository lock, after recording the target outcome.
    const updateReadiness = (repositoryId: string, verified: boolean) =>
      verified
        ? sql`UPDATE github_repository r SET automation_ready_at = CLOCK_TIMESTAMP()
            WHERE repository_id = ${repositoryId} AND automation_ready_at IS NULL
              AND connected AND enabled AND access = 'accessible'
              AND NOT EXISTS (SELECT 1 FROM sync_target t WHERE t.scope->>'repositoryId' = r.repository_id
                AND (t.last_error IS NOT NULL OR t.health = 'blocked'
                  OR t.requested_generation > t.completed_generation))
              AND (SELECT count(DISTINCT t.scope->>'track') FROM sync_target t
                WHERE t.scope->>'repositoryId' = r.repository_id AND t.scope->>'_tag' = 'RepositoryTrack'
                  AND t.scope->>'track' IN ('labels','entities','pull_requests')
                  AND t.verified_at > r.synchronization_required_after) = 3`
        : sql`UPDATE github_repository SET automation_ready_at = NULL WHERE repository_id = ${repositoryId}`

    const complete = Effect.fn("SyncTargets.complete")(function* (request: CompleteRequest) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const { outcome } = request
            const repositoryId =
              request.scope._tag === "RepositoryTrack" || request.scope._tag === "Entity"
                ? request.scope.repositoryId
                : null
            if (repositoryId !== null)
              yield* sql`SELECT repository_id FROM github_repository WHERE repository_id = ${repositoryId} FOR NO KEY UPDATE`
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
            if (repositoryId !== null) yield* updateReadiness(repositoryId, verified)
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
      progress?: { readonly page: number; readonly items: number },
    ) => {
      const run = sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql`
          SELECT scope_key FROM sync_target WHERE scope_key = ${syncScopeKey(scope)}
            AND active_generation = ${generation} AND sync_scope_enabled(scope) FOR UPDATE
        `.pipe(wrap("withRun"))
            if (rows.length === 0) return Option.none<A>()
            const result = yield* effect
            yield* sql`UPDATE sync_target SET progressed_at = CLOCK_TIMESTAMP(),
              progress_items = progress_items + CASE WHEN progress_page < ${progress?.page ?? -1}
                THEN ${progress?.items ?? 0} ELSE 0 END,
              progress_page = GREATEST(progress_page, ${progress?.page ?? -1})
              WHERE scope_key = ${syncScopeKey(scope)}`
            return Option.some(result)
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            SqlError.isSqlError(error)
              ? new SyncTargetError({ operation: "withRun", message: error.message })
              : error,
          ),
        )
      return scope._tag === "RepositoryTrack" || scope._tag === "Entity"
        ? withRepositoryActivity(sql, scope.repositoryId, run).pipe(
            Effect.map(Option.flatten),
            Effect.mapError((error) =>
              SqlError.isSqlError(error)
                ? new SyncTargetError({ operation: "withRun", message: error.message })
                : error,
            ),
          )
        : run
    }

    const retryDue = Effect.gen(function* () {
      // Discover candidates without retaining target locks across repositories.
      const candidates = yield* sql`
        SELECT * FROM sync_target WHERE retry_at <= CLOCK_TIMESTAMP() AND sync_scope_enabled(scope)
          AND requested_generation = completed_generation
      `.pipe(Effect.flatMap(decodeRows))
      let requested = 0
      for (const candidate of candidates) {
        const dispatched = yield* sql.withTransaction(
          Effect.gen(function* () {
            if (candidate.scope._tag === "RepositoryTrack" || candidate.scope._tag === "Entity")
              yield* sql`SELECT repository_id FROM github_repository WHERE repository_id = ${candidate.scope.repositoryId} FOR NO KEY UPDATE`
            const rows = yield* sql`SELECT scope_key FROM sync_target
            WHERE scope_key = ${syncScopeKey(candidate.scope)} AND retry_at <= CLOCK_TIMESTAMP()
              AND requested_generation = completed_generation AND sync_scope_enabled(scope)
            FOR UPDATE SKIP LOCKED`
            if (rows.length === 0) return false
            return (yield* invalidate({
              scope: candidate.scope,
              sequence: Option.none(),
              immediate: true,
            })).dispatched
          }),
        )
        if (dispatched) requested++
      }
      return requested
    }).pipe(wrap("retryDue"))

    const recoverTerminal = (scope: SyncScope, executionGeneration: SyncGeneration) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const repositoryId =
              scope._tag === "RepositoryTrack" || scope._tag === "Entity"
                ? scope.repositoryId
                : null
            if (repositoryId !== null)
              yield* sql`SELECT repository_id FROM github_repository WHERE repository_id = ${repositoryId} FOR NO KEY UPDATE`
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
            if (row !== undefined && repositoryId !== null)
              yield* updateReadiness(repositoryId, false)
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

    const retryFailedEntities = (repositoryId: GitHubRepositoryDatabaseId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT repository_id FROM github_repository WHERE repository_id = ${repositoryId} FOR NO KEY UPDATE`
            const failed = yield* sql<{
              number: number
            }>`SELECT (scope->>'number')::int AS number FROM sync_target
        WHERE scope->>'repositoryId' = ${repositoryId} AND scope->>'_tag' = 'Entity'
          AND (last_error IS NOT NULL OR health = 'blocked')`
            for (const { number } of failed)
              yield* invalidate({
                scope: { _tag: "Entity", repositoryId, number },
                sequence: Option.none(),
                immediate: true,
              })
            return failed.length
          }),
        )
        .pipe(wrap("retryFailedEntities"))

    return {
      invalidate,
      begin,
      complete,
      get,
      withRun,
      retryDue,
      retryFailedEntities,
      recoverTerminal,
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
