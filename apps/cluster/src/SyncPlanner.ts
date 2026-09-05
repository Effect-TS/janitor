import type { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import {
  GitHubInstallationId,
  GitHubRepositoryDatabaseId as RepositoryIdSchema,
} from "@janitor/domain/GitHub/Id"
import type { GitHubRepositoryTrack, SyncScope } from "@janitor/domain/GitHub/Sync"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describeError } from "./SqlErrors.ts"
import { SyncTargets } from "./SyncTargets.ts"

export class SyncPlannerError extends Schema.TaggedError<SyncPlannerError>()(
  "@janitor/cluster/SyncPlanner/SyncPlannerError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Repair cadence from the design. Schedules are staggered per installation
 * so every installation does not become due in the same minute.
 */
export const RepairPolicy = {
  /** How often the planner itself runs; the cron wakes it every minute. */
  planningInterval: Duration.minutes(5),
  installationInventory: Duration.hours(4),
  labels: Duration.hours(24),
  entities: Duration.hours(4),
  pullRequests: Duration.hours(4),
  fullEntities: Duration.days(7),
  /** Spread across this window by a stable hash of the installation id. */
  stagger: Duration.hours(1),
} as const

export const REPAIR_PLANNER_NAME = "github-sync-repair"

export interface PlanSummary {
  readonly planned: boolean
  readonly created: number
}

const InstallationRow = Schema.Struct({
  installation_id: GitHubInstallationId,
  verified_at: Schema.NullOr(Schema.DateTimeUtcFromDate),
})

const TrackRow = Schema.Struct({
  repository_id: RepositoryIdSchema,
  installation_id: GitHubInstallationId,
  track: Schema.Literals(["labels", "entities", "pull_requests"]),
  verified_at: Schema.NullOr(Schema.DateTimeUtcFromDate),
  last_full_at: Schema.NullOr(Schema.DateTimeUtcFromDate),
  pending: Schema.Boolean,
})

const StateRow = Schema.Struct({ last_planned_at: Schema.DateTimeUtcFromDate })

/** Deterministic offset within the stagger window for one installation. */
export const staggerOffset = (
  installationId: string,
  window: Duration.Duration,
): Duration.Duration => {
  let hash = 2166136261
  for (const char of installationId) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
  }
  return Duration.millis((hash % 1000) * (Duration.toMillis(window) / 1000))
}

const isDue = (
  verifiedAt: DateTime.Utc | null,
  interval: Duration.Duration,
  offset: Duration.Duration,
  now: DateTime.Utc,
): boolean =>
  verifiedAt === null ||
  DateTime.isLessThan(DateTime.addDuration(DateTime.addDuration(verifiedAt, interval), offset), now)

const trackInterval = (track: GitHubRepositoryTrack): Duration.Duration => {
  switch (track) {
    case "labels":
      return RepairPolicy.labels
    case "entities":
      return RepairPolicy.entities
    case "pull_requests":
      return RepairPolicy.pullRequests
  }
}

/**
 * Creates overdue repair generations. Woken by the cron singleton; it never
 * calls GitHub itself and creates at most one generation per scope per plan.
 */
export class SyncPlanner extends Context.Service<
  SyncPlanner,
  {
    /** Runs one planning pass if the policy interval has elapsed. */
    readonly plan: (now: DateTime.Utc) => Effect.Effect<PlanSummary, SyncPlannerError>
    /** Enables or disables mirroring for a repository; enabling requests bootstrap of every track. */
    readonly setRepositoryEnabled: (
      repositoryId: GitHubRepositoryDatabaseId,
      enabled: boolean,
    ) => Effect.Effect<void, SyncPlannerError>
  }
>()("@janitor/cluster/SyncPlanner/SyncPlanner", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const targets = yield* SyncTargets
    const decodeInstallations = Schema.decodeUnknownEffect(Schema.Array(InstallationRow))
    const decodeTracks = Schema.decodeUnknownEffect(Schema.Array(TrackRow))
    const decodeState = Schema.decodeUnknownEffect(Schema.Array(StateRow))

    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new SyncPlannerError({ operation, message: describeError(error) }),
        )

    const invalidate = (scope: SyncScope, full: boolean) =>
      targets.invalidate({ scope, sequence: Option.none(), full }).pipe(wrap("plan"))

    const plan = Effect.fn("SyncPlanner.plan")(function* (now: DateTime.Utc) {
      const states = yield* sql`
        SELECT last_planned_at FROM sync_repair_state WHERE name = ${REPAIR_PLANNER_NAME}
      `.pipe(Effect.flatMap(decodeState), wrap("plan"))
      const last = states[0]?.last_planned_at
      if (
        last !== undefined &&
        DateTime.isGreaterThan(DateTime.addDuration(last, RepairPolicy.planningInterval), now)
      ) {
        return { planned: false, created: 0 }
      }

      let created = yield* targets.retryDue.pipe(wrap("retryDue"))
      const discovery = yield* targets.get({ _tag: "AppInventory" }).pipe(wrap("discovery"))
      if (
        Option.isNone(discovery) ||
        (discovery.value.requestedGeneration === discovery.value.completedGeneration &&
          isDue(
            discovery.value.verifiedAt,
            RepairPolicy.installationInventory,
            Duration.millis(0),
            now,
          ))
      ) {
        const requested = yield* invalidate({ _tag: "AppInventory" }, false)
        if (requested.dispatched) created++
      }

      const installations = yield* sql`
        SELECT i.installation_id, t.verified_at
        FROM github_installation i
        LEFT JOIN sync_target t ON t.scope_key = 'installation:' || i.installation_id
        WHERE i.sync_enabled AND i.status <> 'deleted' AND COALESCE(t.requested_generation, 0) = COALESCE(t.completed_generation, 0) AND t.retry_at IS NULL
      `.pipe(Effect.flatMap(decodeInstallations), wrap("plan"))
      for (const row of installations) {
        const offset = staggerOffset(row.installation_id, RepairPolicy.stagger)
        if (isDue(row.verified_at, RepairPolicy.installationInventory, offset, now)) {
          const result = yield* invalidate(
            { _tag: "InstallationInventory", installationId: row.installation_id },
            false,
          )
          if (result.dispatched) created++
        }
      }

      const tracks = yield* sql`
        SELECT r.repository_id, r.installation_id, track.name AS track,
               t.verified_at,
               t.last_full_at,
               COALESCE(
                 t.requested_generation > t.completed_generation,
                 FALSE
               ) AS pending
        FROM github_repository r
        CROSS JOIN (VALUES ('labels'), ('entities'), ('pull_requests')) AS track(name)
        LEFT JOIN sync_target t
          ON t.scope_key = 'repository:' || r.repository_id || ':' || track.name
        WHERE r.sync_enabled AND sync_scope_enabled(jsonb_build_object('_tag', 'RepositoryTrack', 'repositoryId', r.repository_id)) AND r.enabled AND r.access = 'accessible' AND t.retry_at IS NULL
      `.pipe(Effect.flatMap(decodeTracks), wrap("plan"))
      for (const row of tracks) {
        if (row.pending) continue
        const offset = staggerOffset(row.installation_id, RepairPolicy.stagger)
        const scope: SyncScope = {
          _tag: "RepositoryTrack",
          repositoryId: row.repository_id,
          track: row.track,
        }
        const fullDue =
          row.track !== "labels" && isDue(row.last_full_at, RepairPolicy.fullEntities, offset, now)
        if (fullDue || isDue(row.verified_at, trackInterval(row.track), offset, now)) {
          const result = yield* invalidate(scope, fullDue)
          if (result.dispatched) created++
        }
      }

      yield* sql`
        INSERT INTO sync_repair_state ${sql.insert({
          name: REPAIR_PLANNER_NAME,
          last_planned_at: DateTime.toDateUtc(now),
          generations_created: created,
        })}
        ON CONFLICT (name) DO UPDATE SET
          last_planned_at = EXCLUDED.last_planned_at,
          generations_created = EXCLUDED.generations_created
      `.pipe(wrap("plan"))

      return { planned: true, created }
    })

    const setRepositoryEnabled = Effect.fn("SyncPlanner.setRepositoryEnabled")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
      enabled: boolean,
    ) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql`
              UPDATE github_repository SET enabled = ${enabled}, connected = CASE WHEN ${enabled} THEN TRUE ELSE connected END, observed_at = CLOCK_TIMESTAMP()
              WHERE repository_id = ${repositoryId} AND enabled <> ${enabled}
              RETURNING repository_id
            `
            if (!enabled || rows.length === 0) return
            // Bootstrap: durable journaling already runs, so every track can start now.
            for (const track of ["labels", "entities", "pull_requests"] as const) {
              yield* targets.invalidate({
                scope: { _tag: "RepositoryTrack", repositoryId, track },
                sequence: Option.none(),
                full: true,
              })
            }
          }),
        )
        .pipe(wrap("setRepositoryEnabled"))
    })

    return { plan, setRepositoryEnabled }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
