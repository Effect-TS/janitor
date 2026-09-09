import { flushLive } from "../LiveUpdates.ts"
import {
  ReconciliationIdentity,
  ReconciliationOutcome,
} from "@janitor/domain/Labeling/Reconciliation"
import { LabelingRevision } from "@janitor/domain/Labeling/Policy/Configuration"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import { evaluate, type Resolver } from "@janitor/domain/Labeling/Policy/Evaluate"
import { type Evaluation } from "@janitor/domain/Labeling/Policy/Program"
import { Plan, plan, RuleId } from "@janitor/domain/Labeling/Policy/Plan"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Activity from "effect/unstable/workflow/Activity"
import * as Workflow from "effect/unstable/workflow/Workflow"
import { GitHubReadModel } from "../GitHub/ReadModel.ts"
import { GitHubTransport } from "../GitHub/Transport.ts"
import { describeError } from "../SqlErrors.ts"
import { freshnessOf } from "../SyncFreshness.ts"
import { SyncTargets } from "../SyncTargets.ts"
import type { WorkflowRegistration } from "../WorkflowDispatcher.ts"
import { recordAudit } from "./Audit.ts"
import { classifyAi } from "./Classifier.ts"
import { LabelingConfiguration } from "./Configuration.ts"
import { EVALUATION_MAX_AGE, RECONCILE_ENTITY_TAG, SnapshotHandoff } from "./SnapshotHandoff.ts"
import { entityFacts } from "./Test.ts"

export class ReconcileActivityError extends Schema.TaggedError<ReconcileActivityError>()(
  "ReconcileActivityError",
  { message: Schema.String },
) {}

export const ReconcileEntityResult = Schema.Struct({
  ...ReconciliationIdentity.fields,
  outcome: ReconciliationOutcome,
  plan: Schema.NullOr(Plan),
})

/**
 * Reconciles one qualified snapshot (design: "Workflow activities"): loads
 * and re-qualifies the snapshot, evaluates every rule of the configured
 * revision, plans, and records per-rule outcomes and per-label actions.
 * Applying the plan to GitHub is a later activity.
 */
export const ReconcileEntity = Workflow.make(RECONCILE_ENTITY_TAG, {
  payload: ReconciliationIdentity,
  success: ReconcileEntityResult,
  error: ReconcileActivityError,
  idempotencyKey: (identity) =>
    `${identity.repositoryId}:${identity.number}:${identity.snapshotGeneration}:${identity.rulesRevision}`,
})

const RuleEvaluationRecord = Schema.Struct({
  ruleId: RuleId,
  policyVersionId: Schema.String,
  evaluation: Schema.Struct({
    outcome: Schema.Literals(["match", "no-match", "unknown", "not-applicable", "failed"]),
    reason: Schema.String,
    trace: Schema.Unknown,
  }),
})

const EvaluateResult = Schema.Union([
  Schema.TaggedStruct("Evaluated", { plan: Plan, evaluations: Schema.Array(RuleEvaluationRecord) }),
  Schema.TaggedStruct("Disqualified", {
    outcome: Schema.Literals(["superseded", "not-qualified"]),
    detail: Schema.String,
  }),
])

const ConfiguredRow = Schema.Struct({
  configured_revision: Schema.NullOr(
    Schema.FiniteFromString.pipe(Schema.decodeTo(LabelingRevision)),
  ),
})

/** Retain the event's work when its queued or journaled plan uses an old revision. */
const handoffLatest = (identity: ReconciliationIdentity) =>
  Effect.gen(function* () {
    const targets = yield* SyncTargets
    const handoff = yield* SnapshotHandoff
    const target = yield* targets.get({
      _tag: "Entity",
      repositoryId: identity.repositoryId,
      number: identity.number,
    })
    if (Option.isNone(target)) return
    yield* handoff.publish({
      repositoryId: identity.repositoryId,
      number: identity.number,
      generation: target.value.verifiedGeneration,
      sequence: target.value.verifiedSequence ?? GitHubWebhookJournalSequence.make("0"),
    })
  })

class EvaluateFailure extends Data.TaggedError("EvaluateFailure")<{ readonly message: string }> {}

const failure = (message: string) => new ReconcileActivityError({ message })

const encodePlan = Schema.encodeEffect(Schema.fromJsonString(Plan))

const describePlan = (evaluated: Plan): string =>
  evaluated.actions.length === 0
    ? `no changes (${evaluated.rules.filter((rule) => rule.selected).length} of ${evaluated.rules.length} rules selected)`
    : `${evaluated.actions.length} change${evaluated.actions.length === 1 ? "" : "s"} planned`

export const ReconcileEntityLayer = ReconcileEntity.toLayer(
  Effect.fnUntraced(function* (identity) {
    const { repositoryId, number } = identity

    const evaluated = yield* Activity.make({
      name: "ReconcileEntity/Evaluate",
      success: EvaluateResult,
      error: ReconcileActivityError,
      execute: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const targets = yield* SyncTargets
        const readModel = yield* GitHubReadModel
        const configuration = yield* LabelingConfiguration
        const configured = yield* sql`
          SELECT configured_revision::text FROM labeling_repository_rules
          WHERE repository_id = ${repositoryId}
        `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ConfiguredRow))),
          Effect.mapError((error) => new EvaluateFailure({ message: describeError(error) })),
        )
        const configuredRevision = configured[0]?.configured_revision ?? null
        if (configuredRevision !== identity.rulesRevision) {
          yield* handoffLatest(identity).pipe(
            Effect.mapError((error) => new EvaluateFailure({ message: error.message })),
          )
          return {
            _tag: "Disqualified" as const,
            outcome: "superseded" as const,
            detail: `rules revision ${identity.rulesRevision} was superseded; handed off to the latest configuration`,
          }
        }
        const target = yield* targets
          .get({ _tag: "Entity", repositoryId, number })
          .pipe(Effect.mapError((error) => new EvaluateFailure({ message: error.message })))
        if (
          Option.isSome(target) &&
          BigInt(target.value.verifiedGeneration) > BigInt(identity.snapshotGeneration)
        ) {
          return {
            _tag: "Disqualified" as const,
            outcome: "superseded" as const,
            detail: `snapshot generation ${target.value.verifiedGeneration} replaced ${identity.snapshotGeneration}`,
          }
        }
        const freshness = freshnessOf(target, yield* DateTime.now, EVALUATION_MAX_AGE)
        if (freshness !== "verified") {
          return {
            _tag: "Disqualified" as const,
            outcome: "not-qualified" as const,
            detail: `snapshot is ${freshness}`,
          }
        }
        const snapshot = yield* configuration
          .load(repositoryId, identity.rulesRevision)
          .pipe(Effect.mapError((error) => new EvaluateFailure({ message: error.message })))
        if (Option.isNone(snapshot)) {
          return yield* new EvaluateFailure({
            message: `configuration revision ${identity.rulesRevision} does not exist`,
          })
        }
        const entity = yield* readModel
          .getEntity(repositoryId, number)
          .pipe(Effect.mapError((error) => new EvaluateFailure({ message: error.message })))
        if (Option.isNone(entity)) {
          return {
            _tag: "Disqualified" as const,
            outcome: "not-qualified" as const,
            detail: "entity is no longer in the read model",
          }
        }
        const facts = entityFacts(entity.value)
        const versions = new Map(
          snapshot.value.versions.map((version) => [version.versionId, version]),
        )
        const byPolicy = new Map(
          snapshot.value.versions.map((version) => [version.policyId, version]),
        )
        const resolve: Resolver = (policyId) => byPolicy.get(policyId)
        const outcomes = new Map<RuleId, Evaluation["outcome"]>()
        const evaluations: Array<typeof RuleEvaluationRecord.Type> = []
        for (const rule of snapshot.value.rules) {
          if (!rule.enabled) continue
          const version = versions.get(rule.policyVersionId)
          const evaluation: Evaluation =
            version === undefined
              ? { outcome: "unknown", reason: "policy version is missing", trace: [] }
              : version.program.evaluator._tag === "Classifier"
                ? yield* classifyAi({
                    repositoryId,
                    number,
                    policyVersionId: version.versionId,
                    program: version.program,
                    evaluator: version.program.evaluator,
                    snapshot: facts,
                    resolve,
                  })
                : evaluate({ program: version.program, snapshot: facts, resolve })
          outcomes.set(rule.id, evaluation.outcome)
          evaluations.push({ ruleId: rule.id, policyVersionId: rule.policyVersionId, evaluation })
        }
        const planned = plan({
          rules: snapshot.value.rules,
          outcomes,
          currentLabels: new Set(entity.value.labels.map((label) => label.labelId)),
        })
        return { _tag: "Evaluated" as const, plan: planned, evaluations }
      }).pipe(Effect.mapError((error) => failure(error.message))),
    })

    // A slow evaluation (for example a classifier) may overlap a publication.
    // Check even empty plans so a former no-match cannot swallow the event.
    const current =
      evaluated._tag !== "Evaluated" ||
      (yield* Activity.make({
        name: "ReconcileEntity/CheckRevision",
        success: Schema.Boolean,
        error: ReconcileActivityError,
        execute: Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const rows = yield* sql`
          SELECT configured_revision::text FROM labeling_repository_rules
          WHERE repository_id = ${repositoryId}
        `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ConfiguredRow))))
          if (rows[0]?.configured_revision === identity.rulesRevision) return true
          yield* handoffLatest(identity)
          return false
        }).pipe(Effect.mapError((error) => failure(describeError(error)))),
      }))

    const outcome = !current
      ? {
          outcome: "superseded" as const,
          detail: "configuration changed during evaluation; handed off to the latest configuration",
          plan: null,
        }
      : evaluated._tag === "Evaluated"
        ? {
            outcome: "evaluated" as const,
            detail: describePlan(evaluated.plan),
            plan: evaluated.plan,
          }
        : { outcome: evaluated.outcome, detail: evaluated.detail, plan: null }

    yield* Activity.make({
      name: `ReconcileEntity/Record/${outcome.outcome}`,
      error: ReconcileActivityError,
      execute: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const encoded =
          outcome.plan === null
            ? null
            : yield* encodePlan(outcome.plan).pipe(
                Effect.mapError((error) => failure(describeError(error))),
              )
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`
                UPDATE labeling_reconciliation
                SET outcome = ${outcome.outcome}, detail = ${outcome.detail},
                    plan = ${encoded}::jsonb, completed_at = CLOCK_TIMESTAMP()
                WHERE repository_id = ${repositoryId} AND number = ${number}
                  AND snapshot_generation = ${identity.snapshotGeneration}
                  AND rules_revision = ${identity.rulesRevision}
              `
              if (evaluated._tag !== "Evaluated" || !current) return
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
          .pipe(Effect.mapError((error) => failure(describeError(error))))
        yield* Effect.logInfo("Reconciled entity snapshot").pipe(
          Effect.annotateLogs({
            repositoryId,
            number,
            outcome: outcome.outcome,
            detail: outcome.detail,
          }),
        )
      }),
    })

    if (current && evaluated._tag === "Evaluated" && evaluated.plan.actions.length > 0) {
      yield* Activity.make({
        name: "ReconcileEntity/Apply",
        success: ApplyResult,
        error: ReconcileActivityError,
        execute: applyPlan(identity, evaluated.plan).pipe(
          Effect.mapError((error) => failure(error.message)),
        ),
      })
    }

    yield* flushLive
    return { ...identity, outcome: outcome.outcome, plan: outcome.plan }
  }),
)

// APPLY

const ApplyResult = Schema.Struct({
  applied: Schema.Int,
  failed: Schema.Int,
  skipped: Schema.String,
})

/** Janitor itself, as the actor on rules it disables. */
const SYSTEM_ACTOR = { issuer: "janitor", subject: "system" }

class ApplyFailure extends Data.TaggedError("ApplyFailure")<{ readonly message: string }> {}

const settle = (
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

/**
 * Applies the remaining set difference (design: "Reconciliation"). GitHub
 * writes are at-least-once, so every attempt rechecks the fences, reloads
 * the entity's current labels, and treats an already-present or
 * already-absent label as done. A label GitHub no longer knows disables
 * the rules bound to it and advances the revision so they stop evaluating.
 */
const applyPlan = (identity: ReconciliationIdentity, planned: Plan) =>
  Effect.flatMap(SqlClient.SqlClient, (transactionSql) =>
    transactionSql
      .withTransaction(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const readModel = yield* GitHubReadModel
          const transport = yield* GitHubTransport
          const configuration = yield* LabelingConfiguration
          const { repositoryId, number } = identity
          const wrapSql = <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
            Effect.mapError(effect, (error) => new ApplyFailure({ message: describeError(error) }))

          const skip = (reason: string) =>
            Effect.forEach(
              planned.actions,
              (action) => settle(identity, action.labelId, "failed", reason),
              {
                discard: true,
              },
            ).pipe(
              wrapSql,
              Effect.as({ applied: 0, failed: planned.actions.length, skipped: reason }),
            )

          // Serialize disconnect against the complete external-write attempt.
          const [membership] = yield* sql<{
            connected: boolean
          }>`SELECT connected FROM github_repository WHERE repository_id=${repositoryId} FOR UPDATE`.pipe(
            wrapSql,
          )
          if (!membership?.connected) return yield* skip("repository is disconnected")
          // Fences: repository still enabled, revision still active, snapshot not superseded.
          const repository = yield* readModel.getRepository(repositoryId).pipe(wrapSql)
          if (Option.isNone(repository)) return yield* skip("repository is gone")
          if (!repository.value.enabled) return yield* skip("repository is paused")
          if (repository.value.access !== "accessible")
            return yield* skip("repository access is unavailable")
          const configured = yield* sql`
      SELECT configured_revision::text FROM labeling_repository_rules WHERE repository_id = ${repositoryId}
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ConfiguredRow))), wrapSql)
          if ((configured[0]?.configured_revision ?? null) !== identity.rulesRevision) {
            yield* handoffLatest(identity).pipe(wrapSql)
            return yield* skip(
              `rules revision ${identity.rulesRevision} was superseded; handed off to the latest configuration`,
            )
          }
          const entity = yield* readModel.getEntity(repositoryId, number).pipe(wrapSql)
          if (Option.isNone(entity)) return yield* skip("entity is gone")
          const labels = yield* readModel.listLabels(repositoryId).pipe(wrapSql)
          const nameOf = new Map(labels.map((label) => [label.labelId, label.name]))
          const present = new Set(entity.value.labels.map((label) => label.labelId))
          const base = `/repos/${repository.value.owner}/${repository.value.repo}/issues/${number}/labels`
          const scope = {
            _tag: "Installation" as const,
            installationId: repository.value.installationId,
          }

          let applied = 0
          let failed = 0
          for (const action of planned.actions) {
            const blockedAi =
              yield* sql`SELECT e.rule_id FROM labeling_rule_evaluation e JOIN labeling_policy_version v ON v.version_id=e.policy_version_id
              WHERE e.repository_id=${repositoryId} AND e.number=${number} AND e.snapshot_generation=${identity.snapshotGeneration} AND e.rules_revision=${identity.rulesRevision}
              AND e.rule_id=${action.ruleId} AND v.program->'evaluator'->>'_tag'='Classifier'
              AND NOT EXISTS (SELECT 1 FROM labeling_ai_consent WHERE repository_id=${repositoryId} AND state='enabled')`.pipe(
                wrapSql,
              )
            if (blockedAi.length) {
              yield* settle(
                identity,
                action.labelId,
                "failed",
                "AI access was disabled before applying labels",
              ).pipe(wrapSql)
              failed++
              continue
            }
            const name = nameOf.get(action.labelId)
            if (name === undefined) {
              yield* settle(
                identity,
                action.labelId,
                "failed",
                "label is no longer synchronized",
              ).pipe(wrapSql)
              failed++
              continue
            }
            // Already in the desired state: the write is done, whoever did it.
            const done =
              action.action === "add" ? present.has(action.labelId) : !present.has(action.labelId)
            if (done) {
              yield* settle(
                identity,
                action.labelId,
                "applied",
                "already in the desired state",
              ).pipe(wrapSql)
              applied++
              continue
            }
            const response = yield* transport
              .request(
                action.action === "add"
                  ? {
                      scope,
                      priority: "foreground",
                      method: "POST",
                      url: base,
                      body: { labels: [name] },
                    }
                  : {
                      scope,
                      priority: "foreground",
                      method: "DELETE",
                      url: `${base}/${encodeURIComponent(name)}`,
                    },
              )
              .pipe(Effect.mapError((error) => new ApplyFailure({ message: error.message })))
            if (response._tag === "Ok" || response._tag === "NotModified") {
              yield* settle(identity, action.labelId, "applied", null).pipe(wrapSql)
              applied++
              continue
            }
            // Removing a label GitHub already dropped is the desired state.
            if (action.action === "remove" && response.status === 404) {
              yield* settle(identity, action.labelId, "applied", "already absent on GitHub").pipe(
                wrapSql,
              )
              applied++
              continue
            }
            yield* settle(
              identity,
              action.labelId,
              "failed",
              `GitHub answered ${response.status}`,
            ).pipe(wrapSql)
            failed++
            // Adding a label GitHub does not know: retire the rules bound to it.
            if (action.action === "add" && response.status === 404) {
              yield* sql
                .withTransaction(
                  Effect.gen(function* () {
                    const retired = yield* sql<{ rule_id: string }>`
                UPDATE labeling_rule SET label_status = 'missing', enabled = FALSE,
                  version = version + 1, updated_at = CLOCK_TIMESTAMP()
                WHERE repository_id = ${repositoryId} AND label_id = ${action.labelId} AND enabled
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
                .pipe(wrapSql)
            }
          }
          yield* flushLive
          yield* Effect.logInfo("Applied label plan").pipe(
            Effect.annotateLogs({ repositoryId, number, applied, failed }),
          )
          return { applied, failed, skipped: "" }
        }),
      )
      .pipe(Effect.mapError((error) => new ApplyFailure({ message: error.message }))),
  )

const decodePayload = Schema.decodeUnknownEffect(ReconciliationIdentity)

export const ReconcileEntityRegistration: WorkflowRegistration = {
  tag: RECONCILE_ENTITY_TAG,
  submit: (payload) =>
    decodePayload(payload).pipe(
      Effect.flatMap((decoded) => ReconcileEntity.execute(decoded, { discard: true })),
      Effect.asVoid,
    ),
}
