import { flushLive } from "../LiveUpdates.ts"
import {
  ReconciliationIdentity,
  ReconciliationOutcome,
} from "@janitor/domain/Labeling/Reconciliation"
import { LabelingRevision } from "@janitor/domain/Labeling/Policy/Configuration"
import { syncScopeKey } from "@janitor/domain/GitHub/Sync"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import { Plan } from "@janitor/domain/Labeling/Policy/Plan"
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
import { ClassifierError, EvaluationRetry } from "./Classifier.ts"
import { LabelingConfiguration } from "./Configuration.ts"
import { evaluateLabeling } from "./Evaluation.ts"
import {
  aiConsentRevoked,
  describePlan,
  type EvaluateResult,
  type RecordedOutcome,
  recordOutcome,
  retireMissingLabel,
  settleAction,
  settleRemaining,
} from "./Ledger.ts"
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
 * Reconciles one qualified pull request snapshot (design: "Workflow
 * activities"): loads and re-qualifies the snapshot, evaluates every rule of
 * the configured revision, plans, and records per-rule outcomes and per-label
 * actions. Applying the plan to GitHub is a later activity. Issues no longer
 * take this path (ADR 0006); an issue identity is refused.
 */
export const ReconcileEntity = Workflow.make(RECONCILE_ENTITY_TAG, {
  payload: ReconciliationIdentity,
  success: ReconcileEntityResult,
  error: ReconcileActivityError,
  idempotencyKey: (identity) =>
    `${identity.repositoryId}:${identity.number}:${identity.snapshotGeneration}:${identity.rulesRevision}`,
})

const ConfiguredRow = Schema.Struct({
  configured_revision: Schema.NullOr(
    Schema.FiniteFromString.pipe(Schema.decodeTo(LabelingRevision)),
  ),
})

export const DIRECT_PATH_DETAIL = "issue labeling moved to direct GitHub evaluation"

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

const evaluationIsCurrent = (identity: ReconciliationIdentity) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const readModel = yield* GitHubReadModel
    const targets = yield* SyncTargets
    const repository = yield* readModel.getRepository(identity.repositoryId)
    if (
      Option.isNone(repository) ||
      !repository.value.enabled ||
      repository.value.access !== "accessible"
    )
      return false
    const rows =
      yield* sql`SELECT 1 FROM github_repository r JOIN labeling_repository_rules c USING(repository_id)
    WHERE r.repository_id=${identity.repositoryId} AND r.connected AND c.configured_revision=${identity.rulesRevision}
      AND entity_automation_eligible(${identity.repositoryId}, ${identity.number}, ${identity.snapshotGeneration}::bigint)`
    if (!rows.length) return false
    const target = yield* targets.get({
      _tag: "Entity",
      repositoryId: identity.repositoryId,
      number: identity.number,
    })
    return (
      Option.isSome(target) &&
      target.value.requestedGeneration === identity.snapshotGeneration &&
      target.value.verifiedGeneration === identity.snapshotGeneration &&
      freshnessOf(target, yield* DateTime.now, EVALUATION_MAX_AGE) === "verified"
    )
  })

export const ReconcileEntityLayer = ReconcileEntity.toLayer(
  Effect.fnUntraced(function* (identity) {
    const { repositoryId, number } = identity

    // Evaluation traces belong to deletable repository storage. Keeping them in
    // workflow activity results would preserve facts after disconnection.
    const evaluated: EvaluateResult = yield* Effect.gen(function* () {
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
      const [eligible] = yield* sql<{
        allowed: boolean
      }>`SELECT entity_automation_eligible(${repositoryId}, ${number}, ${identity.snapshotGeneration}::bigint) AS allowed`
      if (!eligible?.allowed)
        return {
          _tag: "Disqualified" as const,
          outcome: "not-qualified" as const,
          detail:
            "Automation requires a new event after successful synchronization of an open item",
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
      if (entity.value.entity.kind === "issue") {
        return {
          _tag: "Disqualified" as const,
          outcome: "not-qualified" as const,
          detail: DIRECT_PATH_DETAIL,
        }
      }
      const result = yield* evaluateLabeling({
        configuration: snapshot.value,
        number,
        facts: entityFacts(entity.value),
        currentLabels: new Set(entity.value.labels.map((label) => label.labelId)),
      }).pipe(
        Effect.provideService(EvaluationRetry, {
          claimKey: `${identity.snapshotGeneration}:${identity.rulesRevision}`,
          isCurrent: evaluationIsCurrent(identity).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(GitHubReadModel, readModel),
            Effect.provideService(SyncTargets, targets),
            Effect.mapError(
              (error) => new ClassifierError({ operation: "qualify", message: error.message }),
            ),
          ),
          report: (message) =>
            sql`UPDATE labeling_reconciliation SET detail=${message}
            WHERE repository_id=${repositoryId} AND number=${number} AND snapshot_generation=${identity.snapshotGeneration} AND rules_revision=${identity.rulesRevision}`.pipe(
              Effect.asVoid,
              Effect.andThen(flushLive),
              Effect.mapError(
                (error) =>
                  new ClassifierError({
                    operation: "retry status",
                    message: error.message,
                  }),
              ),
            ),
        }),
      )
      return { _tag: "Evaluated" as const, ...result }
    }).pipe(Effect.mapError((error) => failure(error.message)))

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
          if (rows[0]?.configured_revision === identity.rulesRevision)
            return yield* evaluationIsCurrent(identity)
          yield* handoffLatest(identity)
          return false
        }).pipe(Effect.mapError((error) => failure(describeError(error)))),
      }))

    const outcome: RecordedOutcome = !current
      ? {
          outcome: "superseded",
          detail: "evaluation was superseded or repository automation became unavailable",
          plan: null,
        }
      : evaluated._tag === "Evaluated"
        ? { outcome: "evaluated", detail: describePlan(evaluated.plan), plan: evaluated.plan }
        : { outcome: evaluated.outcome, detail: evaluated.detail, plan: null }

    yield* Activity.make({
      name: `ReconcileEntity/Record/${outcome.outcome}`,
      error: ReconcileActivityError,
      execute: recordOutcome(identity, outcome, current ? evaluated : null).pipe(
        Effect.mapError((error) => failure(describeError(error))),
      ),
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
    return { ...identity, outcome: outcome.outcome, plan: null }
  }),
)

// APPLY

const ApplyResult = Schema.Struct({
  applied: Schema.Int,
  failed: Schema.Int,
  skipped: Schema.String,
})

class ApplyFailure extends Data.TaggedError("ApplyFailure")<{ readonly message: string }> {}

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
          const { repositoryId, number } = identity
          const wrapSql = <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
            Effect.mapError(effect, (error) => new ApplyFailure({ message: describeError(error) }))

          const skip = (reason: string) =>
            settleRemaining(identity, reason).pipe(
              wrapSql,
              Effect.as({ applied: 0, failed: planned.actions.length, skipped: reason }),
            )
          const settle = (labelId: string, status: "applied" | "failed", detail: string | null) =>
            settleAction(identity, labelId, status, detail).pipe(wrapSql)

          // Serialize disconnect against the complete external-write attempt.
          const [membership] = yield* sql<{
            connected: boolean
          }>`SELECT connected FROM github_repository WHERE repository_id=${repositoryId} FOR NO KEY UPDATE`.pipe(
            wrapSql,
          )
          if (!membership?.connected) return yield* skip("repository is disconnected")
          // Serialize newer invalidations with the freshness check and external writes.
          // The repository lock allows foreign-key checks by a refresh holding this target.
          yield* sql`SELECT scope_key FROM sync_target WHERE scope_key=${syncScopeKey({ _tag: "Entity", repositoryId, number })} FOR UPDATE`.pipe(
            wrapSql,
          )
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
          if (!(yield* evaluationIsCurrent(identity).pipe(wrapSql)))
            return yield* skip("evaluation is superseded or no longer qualified")
          const entity = yield* readModel.getEntity(repositoryId, number).pipe(wrapSql)
          if (Option.isNone(entity)) return yield* skip("entity is gone")
          if (entity.value.entity.kind === "issue") return yield* skip(DIRECT_PATH_DETAIL)
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
            if (yield* aiConsentRevoked(identity, action.ruleId).pipe(wrapSql)) {
              yield* settle(
                action.labelId,
                "failed",
                "AI access was disabled before applying labels",
              )
              failed++
              continue
            }
            const name = nameOf.get(action.labelId)
            if (name === undefined) {
              yield* settle(action.labelId, "failed", "label is no longer synchronized")
              failed++
              continue
            }
            // Already in the desired state: the write is done, whoever did it.
            const done =
              action.action === "add" ? present.has(action.labelId) : !present.has(action.labelId)
            if (done) {
              yield* settle(action.labelId, "applied", "already in the desired state")
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
              yield* settle(action.labelId, "applied", null)
              applied++
              continue
            }
            // Removing a label GitHub already dropped is the desired state.
            if (action.action === "remove" && response.status === 404) {
              yield* settle(action.labelId, "applied", "already absent on GitHub")
              applied++
              continue
            }
            yield* settle(action.labelId, "failed", `GitHub answered ${response.status}`)
            failed++
            // Adding a label GitHub does not know: retire the rules bound to it.
            if (action.action === "add" && response.status === 404)
              yield* retireMissingLabel(repositoryId, action.labelId, name).pipe(wrapSql)
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
