import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { GitHubInstallationId, GitHubRepositoryDatabaseId } from "./Id.ts"
import { GitHubWebhookJournalSequence } from "./WebhookJournal.ts"

/** Repository tracks are separate scopes so one failing track does not block the others. */
export const GitHubRepositoryTrack = Schema.Literals([
  "labels",
  "entities",
  "pull_requests",
]).annotate({ identifier: "GitHubRepositoryTrack" })
export type GitHubRepositoryTrack = typeof GitHubRepositoryTrack.Type

const EntityNumber = Schema.Int.check(Schema.isGreaterThan(0))

/** One synchronization scope. Each scope has exactly one target row. */
export const SyncScope = Schema.Union([
  Schema.TaggedStruct("AppInventory", {}),
  Schema.TaggedStruct("InstallationInventory", { installationId: GitHubInstallationId }),
  Schema.TaggedStruct("RepositoryTrack", {
    repositoryId: GitHubRepositoryDatabaseId,
    track: GitHubRepositoryTrack,
  }),
  Schema.TaggedStruct("Entity", { repositoryId: GitHubRepositoryDatabaseId, number: EntityNumber }),
]).annotate({ identifier: "SyncScope" })
export type SyncScope = typeof SyncScope.Type

export const syncScopeKey = (scope: SyncScope): string => {
  switch (scope._tag) {
    case "AppInventory":
      return "app:installations"
    case "InstallationInventory":
      return `installation:${scope.installationId}`
    case "RepositoryTrack":
      return `repository:${scope.repositoryId}:${scope.track}`
    case "Entity":
      return `entity:${scope.repositoryId}:${scope.number}`
  }
}

const GenerationString = Schema.NonEmptyString.check(Schema.isPattern(/^[0-9]+$/)).annotate({
  identifier: "SyncGenerationString",
})
const GenerationNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
  identifier: "SyncGenerationNumber",
})

/** Versioned generation counter. Postgres BIGINT arrives as a string. */
export const SyncGeneration = GenerationString.pipe(Schema.brand("SyncGeneration")).annotate({
  identifier: "SyncGeneration",
})
export type SyncGeneration = typeof SyncGeneration.Type

export const SyncGenerationFromNumber = GenerationNumber.pipe(
  Schema.decodeTo(GenerationString, SchemaTransformation.numberFromString.flip()),
  Schema.brand("SyncGeneration"),
).annotate({ identifier: "SyncGenerationFromNumber" })

export const SyncGenerationFromStringOrNumber = Schema.Union([
  SyncGenerationFromNumber,
  SyncGeneration,
]).annotate({ identifier: "SyncGenerationFromStringOrNumber" })

export const nextGeneration = (generation: SyncGeneration): SyncGeneration =>
  SyncGeneration.make(String(BigInt(generation) + 1n))

export const SyncHealth = Schema.Literals(["ok", "blocked"]).annotate({ identifier: "SyncHealth" })
export type SyncHealth = typeof SyncHealth.Type

/** The freshness contract for one scope, derived from the target row. */
export const SyncFreshness = Schema.Literals([
  "projected",
  "verified",
  "syncing",
  "stale",
  "blocked",
]).annotate({ identifier: "SyncFreshness" })
export type SyncFreshness = typeof SyncFreshness.Type

export const SyncTargetRecord = Schema.Struct({
  scopeKey: Schema.String,
  scope: SyncScope,
  requestedGeneration: SyncGeneration,
  dispatchedGeneration: SyncGeneration,
  completedGeneration: SyncGeneration,
  verifiedGeneration: SyncGeneration,
  requestedSequence: Schema.NullOr(GitHubWebhookJournalSequence),
  verifiedSequence: Schema.NullOr(GitHubWebhookJournalSequence),
  verifiedAt: Schema.NullOr(Schema.DateTimeUtc),
  health: SyncHealth,
  blockedReason: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
}).annotate({ identifier: "SyncTargetRecord" })
export type SyncTargetRecord = typeof SyncTargetRecord.Type

/** Whole-system view of synchronization, as shown to people. */
export const SyncState = Schema.Literals(["idle", "syncing", "blocked", "failed"]).annotate({
  identifier: "SyncState",
})
export type SyncState = typeof SyncState.Type

export const SyncSummary = Schema.Struct({
  state: SyncState,
  /** Oldest verification across tracked scopes; null if any scope has never verified. */
  lastVerifiedAt: Schema.NullOr(Schema.DateTimeUtc),
  /** Scopes with a run requested and not yet completed. */
  pendingTargets: Schema.Int,
  /** Scopes GitHub will not let Janitor read. */
  blockedTargets: Schema.Int,
  failedTargets: Schema.Int,
}).annotate({ identifier: "SyncSummary" })
export type SyncSummary = typeof SyncSummary.Type
