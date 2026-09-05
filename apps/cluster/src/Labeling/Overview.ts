import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { GitHubRepositoryAccess } from "@janitor/domain/GitHub/ReadModel"
import { SyncGeneration } from "@janitor/domain/GitHub/Sync"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import {
  LabelActionRecord,
  type ReconciliationRecord,
  ReconciliationOutcome,
  type RepositoryOverview,
} from "@janitor/domain/Labeling/Reconciliation"
import { LabelingRevision } from "@janitor/domain/Labeling/Policy/Configuration"
import { Plan } from "@janitor/domain/Labeling/Policy/Plan"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describeError } from "../SqlErrors.ts"

export class LabelingOverviewError extends Data.TaggedError("LabelingOverviewError")<{
  readonly operation: string
  readonly message: string
}> {}

const RevisionFromText = Schema.FiniteFromString.pipe(Schema.decodeTo(LabelingRevision))

const RepositoryRow = Schema.Struct({
  repository_id: GitHubRepositoryDatabaseId,
  owner: Schema.String,
  repo: Schema.String,
  enabled: Schema.Boolean,
  sync_enabled: Schema.Boolean,
  rule_count: Schema.Int,
  policy_count: Schema.Int,
  access: GitHubRepositoryAccess,
  configured_revision: Schema.NullOr(RevisionFromText),
  active_revision: Schema.NullOr(RevisionFromText),
})

const ReconciliationRow = Schema.Struct({
  repository_id: GitHubRepositoryDatabaseId,
  number: Schema.Int,
  snapshot_generation: SyncGeneration,
  rules_revision: RevisionFromText,
  covered_sequence: GitHubWebhookJournalSequence,
  fingerprint: Schema.String,
  created_at: Schema.DateTimeUtcFromDate,
  outcome: Schema.NullOr(ReconciliationOutcome),
  detail: Schema.NullOr(Schema.String),
  plan: Schema.NullOr(Plan),
  completed_at: Schema.NullOr(Schema.DateTimeUtcFromDate),
})

export const RECONCILIATION_LIST_LIMIT = 50

/** Read-only views for the repository page. */
export class LabelingOverview extends Context.Service<
  LabelingOverview,
  {
    readonly repositories: Effect.Effect<ReadonlyArray<RepositoryOverview>, LabelingOverviewError>
    readonly reconciliations: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<ReadonlyArray<ReconciliationRecord>, LabelingOverviewError>
  }
>()("@janitor/cluster/Labeling/Overview/LabelingOverview", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const decodeRepositories = Schema.decodeUnknownEffect(Schema.Array(RepositoryRow))
    const decodeReconciliations = Schema.decodeUnknownEffect(Schema.Array(ReconciliationRow))

    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new LabelingOverviewError({ operation, message: describeError(error) }),
        )

    const repositories = sql`
      SELECT r.repository_id, r.owner, r.repo, r.enabled, r.sync_enabled, r.access,
             l.configured_revision::text, l.active_revision::text,
             (SELECT count(*)::int FROM labeling_rule WHERE repository_id = r.repository_id) AS rule_count,
             (SELECT count(*)::int FROM labeling_policy WHERE repository_id = r.repository_id) AS policy_count
      FROM github_repository r
      LEFT JOIN labeling_repository_rules l ON l.repository_id = r.repository_id
      WHERE r.connected
      ORDER BY r.owner, r.repo
    `.pipe(
      Effect.flatMap(decodeRepositories),
      Effect.map((rows) =>
        rows.map((row): RepositoryOverview => ({
          repositoryId: row.repository_id,
          owner: row.owner,
          repo: row.repo,
          enabled: row.enabled,
          syncEnabled: row.sync_enabled,
          ruleCount: row.rule_count,
          policyCount: row.policy_count,
          access: row.access,
          configuredRevision: row.configured_revision,
          activeRevision: row.active_revision,
        })),
      ),
      wrap("repositories"),
      Effect.withSpan("LabelingOverview.repositories"),
    )

    const decodeActions = Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          number: Schema.Int,
          snapshot_generation: SyncGeneration,
          rules_revision: RevisionFromText,
          label_id: LabelActionRecord.fields.labelId,
          action: LabelActionRecord.fields.action,
          rule_id: Schema.String,
          status: LabelActionRecord.fields.status,
          detail: Schema.NullOr(Schema.String),
        }),
      ),
    )

    const reconciliations = Effect.fn("LabelingOverview.reconciliations")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
    ) {
      const actions = yield* sql`
        SELECT a.number, a.snapshot_generation::text, a.rules_revision::text, a.label_id, a.action,
               a.rule_id, a.status, a.detail
        FROM labeling_label_action a
        JOIN (
          SELECT number, snapshot_generation, rules_revision FROM labeling_reconciliation
          WHERE repository_id = ${repositoryId} ORDER BY created_at DESC LIMIT ${RECONCILIATION_LIST_LIMIT}
        ) r USING (number, snapshot_generation, rules_revision)
        WHERE a.repository_id = ${repositoryId}
        ORDER BY a.label_id
      `.pipe(Effect.flatMap(decodeActions), wrap("reconciliations"))
      const actionsFor = (number: number, generation: string, revision: number) =>
        actions
          .filter(
            (row) =>
              row.number === number &&
              row.snapshot_generation === generation &&
              row.rules_revision === revision,
          )
          .map((row) => ({
            labelId: row.label_id,
            action: row.action,
            ruleId: row.rule_id,
            status: row.status,
            detail: row.detail,
          }))
      const rows = yield* sql`
        SELECT repository_id, number, snapshot_generation::text, rules_revision::text,
               covered_sequence::text, fingerprint, created_at, outcome, detail, plan, completed_at
        FROM labeling_reconciliation
        WHERE repository_id = ${repositoryId}
        ORDER BY created_at DESC
        LIMIT ${RECONCILIATION_LIST_LIMIT}
      `.pipe(Effect.flatMap(decodeReconciliations), wrap("reconciliations"))
      return rows.map((row): ReconciliationRecord => ({
        repositoryId: row.repository_id,
        number: row.number,
        snapshotGeneration: row.snapshot_generation,
        rulesRevision: row.rules_revision,
        coveredSequence: row.covered_sequence,
        fingerprint: row.fingerprint,
        createdAt: row.created_at,
        outcome: row.outcome,
        detail: row.detail,
        plan: row.plan,
        actions: actionsFor(row.number, row.snapshot_generation, row.rules_revision),
        completedAt: row.completed_at,
      }))
    })

    return { repositories, reconciliations }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
