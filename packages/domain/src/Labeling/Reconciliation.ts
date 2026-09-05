import * as Schema from "effect/Schema"
import { GitHubLabelDatabaseId, GitHubRepositoryDatabaseId } from "../GitHub/Id.ts"
import { GitHubRepositoryAccess } from "../GitHub/ReadModel.ts"
import { SyncGeneration } from "../GitHub/Sync.ts"
import { GitHubWebhookJournalSequence } from "../GitHub/WebhookJournal.ts"
import { LabelingRevision } from "./Policy/Configuration.ts"
import { Plan } from "./Policy/Plan.ts"

/**
 * A reconciliation identity (design: "Qualified snapshots are evaluation
 * inputs"): entity, synchronized snapshot generation, and the active rules
 * revision. The AI approval revision joins once AI exists.
 */
export const ReconciliationIdentity = Schema.Struct({
  repositoryId: GitHubRepositoryDatabaseId,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  snapshotGeneration: SyncGeneration,
  rulesRevision: LabelingRevision,
}).annotate({ identifier: "ReconciliationIdentity" })
export type ReconciliationIdentity = typeof ReconciliationIdentity.Type

export const reconciliationKey = (identity: ReconciliationIdentity): string =>
  `reconcile:${identity.repositoryId}:${identity.number}:${identity.snapshotGeneration}:${identity.rulesRevision}`

/**
 * `evaluated` is the terminal success. `superseded` means a newer snapshot
 * or revision replaced this identity before it ran. `not-qualified` means the
 * snapshot was no longer verified when the workflow loaded it.
 */
export const ReconciliationOutcome = Schema.Literals([
  "evaluated",
  "superseded",
  "not-qualified",
  "failed",
]).annotate({ identifier: "ReconciliationOutcome" })
export type ReconciliationOutcome = typeof ReconciliationOutcome.Type

export const LabelActionStatus = Schema.Literals(["planned", "applied", "failed"]).annotate({
  identifier: "LabelActionStatus",
})
export type LabelActionStatus = typeof LabelActionStatus.Type

export const LabelActionRecord = Schema.Struct({
  labelId: GitHubLabelDatabaseId,
  action: Schema.Literals(["add", "remove"]),
  ruleId: Schema.String,
  status: LabelActionStatus,
  detail: Schema.NullOr(Schema.String),
}).annotate({ identifier: "LabelActionRecord" })
export type LabelActionRecord = typeof LabelActionRecord.Type

export const ReconciliationRecord = Schema.Struct({
  ...ReconciliationIdentity.fields,
  coveredSequence: GitHubWebhookJournalSequence,
  /** Hash of the fields and labels rules read, so unchanged inputs are recognisable. */
  fingerprint: Schema.String,
  createdAt: Schema.DateTimeUtc,
  outcome: Schema.NullOr(ReconciliationOutcome),
  detail: Schema.NullOr(Schema.String),
  /** Present once the outcome is `evaluated`. */
  plan: Schema.NullOr(Plan),
  /** One row per planned change and what happened to it on GitHub. */
  actions: Schema.Array(LabelActionRecord),
  completedAt: Schema.NullOr(Schema.DateTimeUtc),
}).annotate({ identifier: "ReconciliationRecord" })
export type ReconciliationRecord = typeof ReconciliationRecord.Type

/** One row of the repositories list in the UI. */
export const RepositoryOverview = Schema.Struct({
  repositoryId: GitHubRepositoryDatabaseId,
  owner: Schema.String,
  repo: Schema.String,
  enabled: Schema.Boolean,
  syncEnabled: Schema.optionalKey(Schema.Boolean),
  /** All configured rules, including disabled rules. */
  ruleCount: Schema.Int,
  /** All policies, including unpublished drafts. */
  policyCount: Schema.Int,
  access: GitHubRepositoryAccess,
  configuredRevision: Schema.NullOr(LabelingRevision),
  activeRevision: Schema.NullOr(LabelingRevision),
}).annotate({ identifier: "RepositoryOverview" })
export type RepositoryOverview = typeof RepositoryOverview.Type
