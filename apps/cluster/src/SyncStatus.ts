import {
  SyncScope as SyncScopeSchema,
  type SyncScope,
  type SyncSummary,
} from "@janitor/domain/GitHub/Sync"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
import { GitHubInstallationId, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import {
  RepositoryBlocked,
  RepositoryBlockReason,
  RepositoryNotFound,
  SynchronizationDisabled,
} from "@janitor/domain/GitHub/Repository"
import { SyncTargets } from "./SyncTargets.ts"

const SummaryRow = Schema.Struct({
  pending: Schema.FiniteFromString.pipe(Schema.decodeTo(Schema.Int)),
  blocked: Schema.FiniteFromString.pipe(Schema.decodeTo(Schema.Int)),
  failed: Schema.FiniteFromString.pipe(Schema.decodeTo(Schema.Int)),
  queued: Schema.FiniteFromString.pipe(Schema.decodeTo(Schema.Int)),
  running: Schema.FiniteFromString.pipe(Schema.decodeTo(Schema.Int)),
  retrying: Schema.FiniteFromString.pipe(Schema.decodeTo(Schema.Int)),
  stalled: Schema.FiniteFromString.pipe(Schema.decodeTo(Schema.Int)),
  applied: Schema.FiniteFromString.pipe(Schema.decodeTo(Schema.Int)),
  last_verified_at: Schema.NullOr(Schema.DateTimeUtcFromDate),
})

const InstallationRow = Schema.Struct({ installation_id: GitHubInstallationId })
const RepositoryRow = Schema.Struct({ repository_id: GitHubRepositoryDatabaseId })
const RepositorySyncRow = Schema.Struct({
  reason: Schema.NullOr(RepositoryBlockReason),
  eligible: Schema.Boolean,
})

export interface RequestAllResult {
  readonly summary: SyncSummary
  /** Scopes that received a new generation. */
  readonly requested: number
}

/**
 * The whole-system sync view behind the re-sync button: one summary and one
 * "sync everything" request. Requests go through sync targets, so debounce,
 * in-flight suppression, and follow-ups apply exactly as they do for
 * webhooks and repair. Infrastructure failures die; only a refused repository
 * request fails, with the reason.
 */
export class SyncStatus extends Context.Service<
  SyncStatus,
  {
    readonly requestRepository: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<
      RequestAllResult,
      RepositoryNotFound | RepositoryBlocked | SynchronizationDisabled
    >
    readonly summary: Effect.Effect<SyncSummary>
    readonly requestAll: Effect.Effect<RequestAllResult>
  }
>()("@janitor/cluster/SyncStatus/SyncStatus", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const targets = yield* SyncTargets
    const decodeSummary = Schema.decodeUnknownEffect(Schema.Array(SummaryRow))
    const decodeInstallations = Schema.decodeUnknownEffect(Schema.Array(InstallationRow))
    const decodeRepositories = Schema.decodeUnknownEffect(Schema.Array(RepositoryRow))
    const decodeRepositorySync = Schema.decodeUnknownEffect(Schema.Array(RepositorySyncRow))

    const summary = Effect.gen(function* () {
      const rows = yield* sql`
        SELECT
          COUNT(*) FILTER (
            WHERE requested_generation > completed_generation
          )::text AS pending,
          COUNT(*) FILTER (WHERE health = 'blocked')::text AS blocked,
          COUNT(*) FILTER (WHERE last_error IS NOT NULL)::text AS failed,
          COUNT(*) FILTER (WHERE requested_generation > completed_generation AND active_generation IS NULL)::text AS queued,
          COUNT(*) FILTER (WHERE requested_generation > completed_generation AND active_generation IS NOT NULL)::text AS running,
          COUNT(*) FILTER (WHERE retry_at IS NOT NULL)::text AS retrying,
          COUNT(*) FILTER (WHERE requested_generation > completed_generation AND no_result_since IS NOT NULL
            AND progressed_at < CLOCK_TIMESTAMP() - INTERVAL '5 minutes')::text AS stalled,
          COALESCE(SUM(progress_items) FILTER (WHERE requested_generation > completed_generation),0)::text AS applied,
          CASE WHEN COUNT(*) FILTER (WHERE verified_at IS NULL) > 0 THEN NULL ELSE MIN(verified_at) END AS last_verified_at
        FROM sync_target WHERE sync_scope_enabled(scope)
      `.pipe(Effect.flatMap(decodeSummary))
      const row = rows[0]
      const pending = row?.pending ?? 0
      const blocked = row?.blocked ?? 0
      const failed = row?.failed ?? 0
      const result: SyncSummary = {
        state: pending > 0 ? "syncing" : failed > 0 ? "failed" : blocked > 0 ? "blocked" : "idle",
        lastVerifiedAt: row?.last_verified_at ?? null,
        pendingTargets: pending,
        blockedTargets: blocked,
        failedTargets: failed,
        queuedTargets: row?.queued ?? 0,
        runningTargets: row?.running ?? 0,
        retryingTargets: row?.retrying ?? 0,
        stalledTargets: row?.stalled ?? 0,
        appliedItems: row?.applied ?? 0,
      }
      return result
    }).pipe(Effect.orDie, Effect.withSpan("SyncStatus.summary"))

    const requestAll = Effect.gen(function* () {
      const requested = yield* sql.withTransaction(
        Effect.gen(function* () {
          const installations = yield* sql`
              SELECT installation_id FROM github_installation WHERE status <> 'deleted' AND sync_enabled
            `.pipe(Effect.flatMap(decodeInstallations))
          const repositories = yield* sql`
              SELECT repository_id FROM github_repository
              WHERE sync_scope_enabled(jsonb_build_object('_tag', 'RepositoryTrack', 'repositoryId', repository_id))
            `.pipe(Effect.flatMap(decodeRepositories))

          const scopes: Array<SyncScope> = [
            { _tag: "AppInventory" },
            ...installations.map((row): SyncScope => ({
              _tag: "InstallationInventory",
              installationId: row.installation_id,
            })),
          ]
          for (const row of repositories) {
            for (const track of ["labels", "entities", "pull_requests"] as const) {
              scopes.push({ _tag: "RepositoryTrack", repositoryId: row.repository_id, track })
            }
          }
          const entities =
            yield* sql`SELECT scope FROM sync_target WHERE scope->>'_tag' = 'Entity' AND sync_scope_enabled(scope)
              AND (last_error IS NOT NULL OR health = 'blocked')`.pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ scope: SyncScopeSchema }))),
              ),
            )
          scopes.push(...entities.map((row) => row.scope))
          for (const scope of scopes) {
            yield* targets.invalidate({ scope, sequence: Option.none(), immediate: true })
          }
          return scopes.length
        }),
      )
      yield* Effect.logInfo("Requested a sync of every scope").pipe(
        Effect.annotateLogs({ requested }),
      )
      return { summary: yield* summary, requested }
    }).pipe(Effect.orDie, Effect.withSpan("SyncStatus.requestAll"))

    const requestRepository = (repositoryId: GitHubRepositoryDatabaseId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const [repository] = yield* sql`SELECT repository_block_reason(repository_id) AS reason,
            sync_scope_enabled(jsonb_build_object('_tag','RepositoryTrack','repositoryId',repository_id)) AS eligible
          FROM github_repository WHERE repository_id = ${repositoryId} FOR NO KEY UPDATE`.pipe(
              Effect.flatMap(decodeRepositorySync),
            )
            if (repository === undefined) return yield* new RepositoryNotFound({ repositoryId })
            if (repository.reason !== null)
              return yield* new RepositoryBlocked({ repositoryId, reason: repository.reason })
            if (!repository.eligible) return yield* new SynchronizationDisabled()
            for (const track of ["labels", "entities", "pull_requests"] as const)
              yield* targets.invalidate({
                scope: { _tag: "RepositoryTrack", repositoryId, track },
                sequence: Option.none(),
                immediate: true,
              })
            const failed = yield* targets.retryFailedEntities(repositoryId)
            return { summary: yield* summary, requested: 3 + failed }
          }),
        )
        .pipe(
          Effect.catchTag(
            ["SqlError", "SchemaError", "@janitor/cluster/SyncTargets/SyncTargetError"],
            Effect.die,
          ),
          Effect.withSpan("SyncStatus.requestRepository"),
        )

    return { summary, requestAll, requestRepository }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
