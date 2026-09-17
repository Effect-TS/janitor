import type { GitHubLabelDatabaseId, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import type { ReconciliationIdentity } from "@janitor/domain/Labeling/Reconciliation"
import { Plan, RuleId } from "@janitor/domain/Labeling/Policy/Plan"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { recordAudit } from "./Audit.ts"
import { LabelingConfiguration } from "./Configuration.ts"

/**
 * The reconciliation ledger shared by the synchronized and the direct
 * labeling paths: per-evaluation outcome, per-rule evaluations, per-label
 * actions, and the rules a missing label retires.
 */

export const RuleEvaluationRecord = Schema.Struct({
  ruleId: RuleId,
  policyVersionId: Schema.String,
  evaluation: Schema.Struct({
    outcome: Schema.Literals(["match", "no-match", "unknown", "not-applicable", "failed"]),
    reason: Schema.String,
    trace: Schema.Unknown,
  }),
})

export const EvaluateResult = Schema.Union([
  Schema.TaggedStruct("Evaluated", { plan: Plan, evaluations: Schema.Array(RuleEvaluationRecord) }),
  Schema.TaggedStruct("Disqualified", {
    outcome: Schema.Literals(["superseded", "not-qualified", "failed"]),
    detail: Schema.String,
  }),
])
export type EvaluateResult = typeof EvaluateResult.Type

export interface RecordedOutcome {
  readonly outcome: "evaluated" | "superseded" | "not-qualified" | "failed"
  readonly detail: string
  readonly plan: Plan | null
}

/** Janitor itself, as the actor on rules it disables. */
export const SYSTEM_ACTOR = { issuer: "janitor", subject: "system" }

const encodePlan = Schema.encodeEffect(Schema.fromJsonString(Plan))

export const describePlan = (evaluated: Plan): string =>
  evaluated.actions.length === 0
    ? `no changes (${evaluated.rules.filter((rule) => rule.selected).length} of ${evaluated.rules.length} rules selected)`
    : `${evaluated.actions.length} change${evaluated.actions.length === 1 ? "" : "s"} planned`

/**
 * Closes the evaluation row and, for a current evaluation, records its rule
 * evaluations and planned actions. Writes nothing when the row is gone
 * (the repository was disconnected meanwhile).
 */
export const recordOutcome = (
  identity: ReconciliationIdentity,
  outcome: RecordedOutcome,
  evaluated: EvaluateResult | null,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { repositoryId, number } = identity
    const encoded = outcome.plan === null ? null : yield* encodePlan(outcome.plan)
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const recorded = yield* sql`
          UPDATE labeling_reconciliation
          SET outcome = ${outcome.outcome}, detail = ${outcome.detail},
              plan = ${encoded}::jsonb, completed_at = CLOCK_TIMESTAMP()
          WHERE repository_id = ${repositoryId} AND number = ${number}
            AND snapshot_generation = ${identity.snapshotGeneration}
            AND rules_revision = ${identity.rulesRevision}
          RETURNING repository_id
        `
        if (!recorded.length || evaluated === null || evaluated._tag !== "Evaluated") return
        const selected = new Set(
          evaluated.plan.rules.filter((rule) => rule.selected).map((rule) => rule.ruleId),
        )
        for (const entry of evaluated.evaluations) {
          yield* sql`
            INSERT INTO labeling_rule_evaluation
              (repository_id, number, snapshot_generation, rules_revision, rule_id,
               policy_version_id, outcome, selected, reason, trace)
            VALUES (${repositoryId}, ${number}, ${identity.snapshotGeneration}, ${identity.rulesRevision},
                    ${entry.ruleId}, ${entry.policyVersionId}, ${entry.evaluation.outcome},
                    ${selected.has(entry.ruleId)}, ${entry.evaluation.reason},
                    ${JSON.stringify(entry.evaluation.trace)}::jsonb)
            ON CONFLICT DO NOTHING
          `
        }
        for (const action of evaluated.plan.actions) {
          yield* sql`
            INSERT INTO labeling_label_action
              (repository_id, number, snapshot_generation, rules_revision, label_id, action, rule_id)
            VALUES (${repositoryId}, ${number}, ${identity.snapshotGeneration}, ${identity.rulesRevision},
                    ${action.labelId}, ${action.action}, ${action.ruleId})
            ON CONFLICT DO NOTHING
          `
        }
      }),
    )
    yield* Effect.logInfo("Recorded labeling evaluation").pipe(
      Effect.annotateLogs({
        repositoryId,
        number,
        outcome: outcome.outcome,
        detail: outcome.detail,
      }),
    )
  })

export const settleAction = (
  identity: ReconciliationIdentity,
  labelId: string,
  status: "applied" | "failed",
  detail: string | null,
) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      UPDATE labeling_label_action
      SET status = ${status}, detail = ${detail}, completed_at = CLOCK_TIMESTAMP()
      WHERE repository_id = ${identity.repositoryId} AND number = ${identity.number}
        AND snapshot_generation = ${identity.snapshotGeneration}
        AND rules_revision = ${identity.rulesRevision} AND label_id = ${labelId}
    `,
  )

/** Every still-planned action of the evaluation fails with one reason. */
export const settleRemaining = (identity: ReconciliationIdentity, reason: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      UPDATE labeling_label_action
      SET status = 'failed', detail = ${reason}, completed_at = CLOCK_TIMESTAMP()
      WHERE repository_id = ${identity.repositoryId} AND number = ${identity.number}
        AND snapshot_generation = ${identity.snapshotGeneration}
        AND rules_revision = ${identity.rulesRevision} AND status = 'planned'
    `,
  )

/** Whether a Classifier rule's label may still be written: AI consent can be revoked mid-flight. */
export const aiConsentRevoked = (identity: ReconciliationIdentity, ruleId: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`SELECT e.rule_id FROM labeling_rule_evaluation e JOIN labeling_policy_version v ON v.version_id=e.policy_version_id
      WHERE e.repository_id=${identity.repositoryId} AND e.number=${identity.number}
        AND e.snapshot_generation=${identity.snapshotGeneration} AND e.rules_revision=${identity.rulesRevision}
        AND e.rule_id=${ruleId} AND v.program->'evaluator'->>'_tag'='Classifier'
        AND NOT EXISTS (SELECT 1 FROM labeling_ai_consent WHERE repository_id=${identity.repositoryId} AND state='enabled')`.pipe(
      Effect.map((rows) => rows.length > 0),
    ),
  )

/**
 * A label GitHub does not know disables the rules bound to it and advances
 * the revision so they stop evaluating.
 */
export const retireMissingLabel = (
  repositoryId: GitHubRepositoryDatabaseId,
  labelId: GitHubLabelDatabaseId,
  name: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const configuration = yield* LabelingConfiguration
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const retired = yield* sql<{ rule_id: string }>`
          UPDATE labeling_rule SET label_status = 'missing', enabled = FALSE,
            version = version + 1, updated_at = CLOCK_TIMESTAMP()
          WHERE repository_id = ${repositoryId} AND label_id = ${labelId} AND enabled
          RETURNING rule_id
        `
        for (const row of retired) {
          yield* recordAudit(sql, {
            repositoryId,
            subject: { _tag: "Rule", ruleId: RuleId.make(row.rule_id) },
            actor: SYSTEM_ACTOR,
            operation: "update",
            before: { enabled: true, labelStatus: "valid" },
            after: {
              enabled: false,
              labelStatus: "missing",
              reason: `label ${name} is missing on GitHub`,
            },
          })
        }
        if (retired.length > 0) yield* configuration.advance(repositoryId, SYSTEM_ACTOR)
      }),
    )
  })
