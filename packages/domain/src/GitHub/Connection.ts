import * as Schema from "effect/Schema"
/**
 * Whether the repository's cache refreshes and how the last refresh went.
 * `disabled` is a disconnected repository or an installation whose sync
 * setting is off.
 */
export const CacheState = Schema.Literals([
  "access-unavailable",
  "paused",
  "disabled",
  "failed",
  "syncing",
  "ready",
])
export type CacheState = typeof CacheState.Type
export const ConnectionCandidate = Schema.Struct({
  repositoryId: Schema.String,
  installationId: Schema.String,
  owner: Schema.String,
  repo: Schema.String,
  isPrivate: Schema.NullOr(Schema.Boolean),
  connected: Schema.Boolean,
  enabled: Schema.Boolean,
  reconnect: Schema.Boolean,
  access: Schema.String,
  accessError: Schema.optionalKey(Schema.NullOr(Schema.String)),
  installationStatus: Schema.String,
  /** Why repository work is refused, independent of the synchronization cache. */
  blockReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  policyCount: Schema.Int,
  ruleCount: Schema.Int,
  /** Health of the UI cache; never a reason work is refused. */
  syncState: CacheState,
  syncError: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type ConnectionCandidate = typeof ConnectionCandidate.Type
export const ConnectionInventory = Schema.Struct({
  repositories: Schema.Array(ConnectionCandidate),
})
