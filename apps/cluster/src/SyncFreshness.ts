import type { SyncFreshness, SyncTargetRecord } from "@janitor/domain/GitHub/Sync"
import * as DateTime from "effect/DateTime"
import type * as Duration from "effect/Duration"
import * as Option from "effect/Option"

/**
 * Derives the freshness status of one scope from its target row. Purpose
 * decides `maxAge`: configuration display tolerates older verification than
 * evaluation or mutation.
 */
export const freshnessOf = (
  target: Option.Option<SyncTargetRecord>,
  now: DateTime.Utc,
  maxAge: Duration.Duration,
): SyncFreshness => {
  if (Option.isNone(target)) {
    return "projected"
  }
  const row = target.value
  if (row.health === "blocked") {
    return "blocked"
  }
  const requested = BigInt(row.requestedGeneration)
  const verified = BigInt(row.verifiedGeneration)
  if (requested > verified) {
    return requested > BigInt(row.completedGeneration) ? "syncing" : "stale"
  }
  if (row.verifiedAt === null) {
    return "projected"
  }
  const expiresAt = DateTime.addDuration(row.verifiedAt, maxAge)
  return DateTime.isLessThan(expiresAt, now) ? "stale" : "verified"
}
