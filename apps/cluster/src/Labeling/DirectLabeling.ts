import type { GitHubIssueApi } from "@janitor/domain/GitHub/Api"
import { GitHubInstallationId, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { SyncGeneration } from "@janitor/domain/GitHub/Sync"
import type { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import { LabelingRevision } from "@janitor/domain/Labeling/Policy/Configuration"
import {
  ReconciliationIdentity,
  ReconciliationOutcome,
} from "@janitor/domain/Labeling/Reconciliation"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Activity from "effect/unstable/workflow/Activity"
import * as Workflow from "effect/unstable/workflow/Workflow"
import type { WorkflowEngine, WorkflowInstance } from "effect/unstable/workflow/WorkflowEngine"
import {
  logWorkflowFailure,
  SyncActivityError,
  SyncActivityFailure,
  withRateLimitWaits,
} from "../GitHub/SyncSupport.ts"
import { flushLive } from "../LiveUpdates.ts"
import { changedReason, RepositoryEligibility } from "../RepositoryEligibility.ts"
import { describeError } from "../SqlErrors.ts"
import type { WorkflowRegistration } from "../WorkflowDispatcher.ts"
import { WorkflowOutbox } from "../WorkflowOutbox.ts"
import { ClassifierError, EvaluationRetry } from "./Classifier.ts"
import { LabelingConfiguration } from "./Configuration.ts"
import { evaluateLabeling } from "./Evaluation.ts"
import { itemFacts, itemFingerprint, type ObservedItem, type ReadItem } from "./Facts.ts"
import {
  addLabel,
  fetchIssue,
  fetchLabelCatalog,
  removeLabel,
  type RepositoryTarget,
  type Waits,
} from "./GitHubIssue.ts"
import { collectionTracks, readPullRequest } from "./GitHubPullRequest.ts"
import {
  aiConsentRevoked,
  describePlan,
  type EvaluateResult,
  plannedActions,
  type RecordedOutcome,
  recordOutcome,
  retireMissingLabel,
  settleAction,
  settleRemaining,
} from "./Ledger.ts"

export const LABEL_ITEM_TAG = "Janitor/LabelItemV1"

/**
 * The automation-owned identity of one direct evaluation of an issue or
 * pull request: the item, the observation generation its admitting event
 * received, the rules revision configured at admission, and the repository
 * eligibility generation the work was accepted under. Nothing here comes
 * from synchronization.
 */
export const DirectLabelingIdentity = Schema.Struct({
  ...ReconciliationIdentity.fields,
  eligibilityGeneration: Schema.String.check(Schema.isPattern(/^\d+$/)),
}).annotate({ identifier: "DirectLabelingIdentity" })
export type DirectLabelingIdentity = typeof DirectLabelingIdentity.Type

export const labelItemKey = (identity: ReconciliationIdentity): string =>
  `label-item:${identity.repositoryId}:${identity.number}:${identity.snapshotGeneration}:${identity.rulesRevision}`

export class DirectLabelingError extends Data.TaggedError("DirectLabelingError")<{
  readonly operation: string
  readonly message: string
}> {}

export interface AdmissionRequest {
  readonly repositoryId: GitHubRepositoryDatabaseId
  /** The item as the webhook described it; the work rereads GitHub when it runs. */
  readonly item: ObservedItem
  readonly sequence: GitHubWebhookJournalSequence
}

export type AdmissionResult =
  | { readonly _tag: "Admitted"; readonly identity: DirectLabelingIdentity }
  | {
      readonly _tag: "Skipped"
      readonly reason: "closed" | "no-active-revision" | "repository-blocked"
      readonly detail?: string
    }

const ConfiguredRow = Schema.Struct({
  configured_revision: Schema.NullOr(
    Schema.FiniteFromString.pipe(Schema.decodeTo(LabelingRevision)),
  ),
})

/**
 * Admits one issue or pull request event onto the direct path: records the
 * pending evaluation and its outbox row in one transaction. Closed items,
 * including merged pull requests, are outside labeling scope. The caller
 * holds the repository fence, so the observation generation is unique per
 * item and later events always receive a larger one.
 */
export class DirectLabelingAdmission extends Context.Service<
  DirectLabelingAdmission,
  {
    readonly admit: (
      request: AdmissionRequest,
    ) => Effect.Effect<AdmissionResult, DirectLabelingError>
  }
>()("@janitor/cluster/Labeling/DirectLabeling/DirectLabelingAdmission", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const eligibility = yield* RepositoryEligibility
    const outbox = yield* WorkflowOutbox
    const decodeConfigured = Schema.decodeUnknownEffect(Schema.Array(ConfiguredRow))
    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new DirectLabelingError({ operation, message: describeError(error) }),
        )

    const admit = Effect.fn("DirectLabelingAdmission.admit")(function* (request: AdmissionRequest) {
      const { repositoryId, item } = request
      if (!item.open) return { _tag: "Skipped", reason: "closed" } as const
      const repository = yield* eligibility.get(repositoryId).pipe(Effect.result)
      if (repository._tag === "Failure") {
        if (repository.failure._tag !== "@janitor/cluster/RepositoryEligibility/RepositoryBlocked")
          return yield* new DirectLabelingError({
            operation: "eligibility",
            message: repository.failure.message,
          })
        return {
          _tag: "Skipped",
          reason: "repository-blocked",
          detail: repository.failure.reason,
        } as const
      }
      const configured = yield* sql`
        SELECT configured_revision::text FROM labeling_repository_rules WHERE repository_id = ${repositoryId}
      `.pipe(Effect.flatMap(decodeConfigured), wrap("configuredRevision"))
      const rulesRevision = configured[0]?.configured_revision ?? null
      if (rulesRevision === null) return { _tag: "Skipped", reason: "no-active-revision" } as const
      const fingerprint = yield* itemFingerprint(item)
      const identity = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const [row] = yield* sql<{ generation: string }>`
              SELECT GREATEST(${request.sequence}::bigint,
                COALESCE((SELECT MAX(snapshot_generation) + 1 FROM labeling_reconciliation
                  WHERE repository_id = ${repositoryId} AND number = ${item.number}), 0))::text AS generation
            `
            const identity: DirectLabelingIdentity = {
              repositoryId,
              number: item.number,
              snapshotGeneration: SyncGeneration.make(row!.generation),
              rulesRevision,
              eligibilityGeneration: repository.success.generation,
            }
            yield* sql`
              INSERT INTO labeling_reconciliation
                (repository_id, number, snapshot_generation, rules_revision, covered_sequence, fingerprint, source)
              VALUES (${repositoryId}, ${item.number}, ${identity.snapshotGeneration}, ${rulesRevision},
                      ${request.sequence}, ${fingerprint}, 'github')
            `
            yield* outbox.enqueue({
              workflowTag: LABEL_ITEM_TAG,
              executionKey: labelItemKey(identity),
              payload: identity,
            })
            return identity
          }),
        )
        .pipe(wrap("admit"))
      yield* Effect.logInfo("Admitted item for direct labeling").pipe(
        Effect.annotateLogs({
          repositoryId,
          number: item.number,
          kind: item.kind,
          generation: identity.snapshotGeneration,
          rulesRevision,
        }),
      )
      return { _tag: "Admitted", identity } as const
    })

    return { admit }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

// WORKFLOW

export class LabelItemError extends Schema.TaggedError<LabelItemError>()("LabelItemError", {
  message: Schema.String,
}) {}

export const LabelItemResult = Schema.Struct({
  ...ReconciliationIdentity.fields,
  outcome: ReconciliationOutcome,
})

/**
 * Evaluates one admitted issue or pull request against current GitHub facts
 * (ADR 0006). Requalifies the work against the repository fence and the
 * configured revision, reads the item and, for a pull request, the
 * collections the revision needs from GitHub, evaluates every rule of the
 * revision, records the outcome, and applies the plan with fresh checks
 * inside each write attempt.
 */
export const LabelItem = Workflow.make(LABEL_ITEM_TAG, {
  payload: DirectLabelingIdentity,
  success: LabelItemResult,
  error: LabelItemError,
  idempotencyKey: labelItemKey,
})

type Qualification =
  | { readonly _tag: "Current"; readonly repository: RepositoryTarget }
  | {
      readonly _tag: "Disqualified"
      readonly outcome: "superseded" | "not-qualified"
      readonly detail: string
    }

const failure = (message: string) => new LabelItemError({ message })

const configuredRevision = (repositoryId: GitHubRepositoryDatabaseId) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`SELECT configured_revision::text FROM labeling_repository_rules WHERE repository_id = ${repositoryId}`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ConfiguredRow))),
      Effect.map((rows) => rows[0]?.configured_revision ?? null),
    ),
  )

/**
 * Retains the event's work when its configuration changed before it ran:
 * the same observation is re-queued under the latest revision and the
 * current eligibility generation. Idempotent on the identity.
 */
const handoffLatest = (identity: DirectLabelingIdentity, eligibilityGeneration: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const outbox = yield* WorkflowOutbox
    const revision = yield* configuredRevision(identity.repositoryId)
    if (revision === null || revision === identity.rulesRevision) return
    const latest: DirectLabelingIdentity = {
      ...identity,
      rulesRevision: revision,
      eligibilityGeneration,
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const inserted = yield* sql`
          INSERT INTO labeling_reconciliation
            (repository_id, number, snapshot_generation, rules_revision, covered_sequence, fingerprint, source)
          SELECT repository_id, number, snapshot_generation, ${revision}, covered_sequence, fingerprint, 'github'
          FROM labeling_reconciliation
          WHERE repository_id = ${identity.repositoryId} AND number = ${identity.number}
            AND snapshot_generation = ${identity.snapshotGeneration} AND rules_revision = ${identity.rulesRevision}
          ON CONFLICT DO NOTHING
          RETURNING repository_id
        `
        if (inserted.length > 0)
          yield* outbox.enqueue({
            workflowTag: LABEL_ITEM_TAG,
            executionKey: labelItemKey(latest),
            payload: latest,
          })
      }),
    )
  })

/**
 * Whether the work is still the current work for its item: the repository
 * fence and generation, the configured revision, and no later observation.
 * Synchronization state is never consulted.
 */
const qualify = (identity: DirectLabelingIdentity) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const eligibility = yield* RepositoryEligibility
    const repository = yield* eligibility.get(identity.repositoryId).pipe(Effect.result)
    if (repository._tag === "Failure") {
      if (repository.failure._tag !== "@janitor/cluster/RepositoryEligibility/RepositoryBlocked")
        return yield* repository.failure
      return {
        _tag: "Disqualified",
        outcome: "not-qualified",
        detail: repository.failure.reason,
      } satisfies Qualification
    }
    if (repository.success.generation !== identity.eligibilityGeneration)
      return {
        _tag: "Disqualified",
        outcome: "not-qualified",
        detail: changedReason,
      } satisfies Qualification
    const revision = yield* configuredRevision(identity.repositoryId)
    if (revision !== identity.rulesRevision) {
      yield* handoffLatest(identity, repository.success.generation)
      return {
        _tag: "Disqualified",
        outcome: "superseded",
        detail: `rules revision ${identity.rulesRevision} was superseded; handed off to the latest configuration`,
      } satisfies Qualification
    }
    const newer = yield* sql<{ generation: string }>`
      SELECT snapshot_generation::text AS generation FROM labeling_reconciliation
      WHERE repository_id = ${identity.repositoryId} AND number = ${identity.number}
        AND source = 'github' AND snapshot_generation > ${identity.snapshotGeneration}::bigint
      ORDER BY snapshot_generation DESC LIMIT 1
    `
    if (newer[0] !== undefined)
      return {
        _tag: "Disqualified",
        outcome: "superseded",
        detail: `observation ${newer[0].generation} replaced ${identity.snapshotGeneration}`,
      } satisfies Qualification
    const [name] = repository.success.name.split("/")
    return {
      _tag: "Current",
      repository: {
        installationId: GitHubInstallationId.make(repository.success.installationId),
        owner: name!,
        repo: repository.success.name.slice(name!.length + 1),
      },
    } satisfies Qualification
  })

/** Waits on the workflow's durable clock, so a restart resumes the wait. */
const durableWaits: Waits<WorkflowEngine | WorkflowInstance> = (name, effect) =>
  withRateLimitWaits(name, () => effect)

const closedDetail = (issue: GitHubIssueApi) =>
  issue.pullRequest === undefined
    ? "issue is closed on GitHub"
    : "pull request is closed or merged on GitHub"

type ItemRead =
  | { readonly _tag: "Found"; readonly item: ReadItem }
  | {
      readonly _tag: "Disqualified"
      readonly outcome: "not-qualified" | "failed"
      readonly detail: string
    }

/**
 * Reads the item as the evaluation will see it. A pull request also needs
 * its own record and the collections the revision's rules read; those are
 * gathered as one observation of the same head.
 */
const readItem = (
  repository: RepositoryTarget,
  number: number,
  requiredTracks: Parameters<typeof collectionTracks>[0],
) =>
  Effect.gen(function* () {
    const fetched = yield* withRateLimitWaits("LabelItem/Issue", () =>
      fetchIssue(repository, number, "foreground"),
    ).pipe(Effect.result)
    if (fetched._tag === "Failure")
      return { _tag: "Disqualified", outcome: "failed", detail: fetched.failure.message } as const
    if (fetched.success._tag === "Unavailable")
      return {
        _tag: "Disqualified",
        outcome: "failed",
        detail: `Item could not be read: ${fetched.success.message}`,
      } as const
    const issue = fetched.success.issue
    if (issue.state !== "open")
      return {
        _tag: "Disqualified",
        outcome: "not-qualified",
        detail: closedDetail(issue),
      } as const
    if (issue.pullRequest === undefined)
      return { _tag: "Found", item: { issue, pullRequest: null, collections: {} } } as const
    const read = yield* readPullRequest(
      "LabelItem/PullRequest",
      repository,
      number,
      collectionTracks(requiredTracks),
      durableWaits,
    ).pipe(Effect.result)
    if (read._tag === "Failure")
      return { _tag: "Disqualified", outcome: "failed", detail: read.failure.message } as const
    switch (read.success._tag) {
      case "Unavailable":
        return {
          _tag: "Disqualified",
          outcome: "failed",
          detail: `Pull request could not be read: ${read.success.message}`,
        } as const
      case "Changed":
        return { _tag: "Disqualified", outcome: "failed", detail: read.success.detail } as const
      case "Found": {
        const { pullRequest, collections } = read.success
        if (pullRequest.state !== "open" || pullRequest.merged === true)
          return {
            _tag: "Disqualified",
            outcome: "not-qualified",
            detail: closedDetail(issue),
          } as const
        return { _tag: "Found", item: { issue, pullRequest, collections } } as const
      }
    }
  }) satisfies Effect.Effect<ItemRead, never, any>

const ApplyResult = Schema.Struct({
  applied: Schema.Int,
  failed: Schema.Int,
  skipped: Schema.String,
})

const sqlFailure = <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
  Effect.mapError(effect, (error) => new SyncActivityError({ message: describeError(error) }))

/**
 * One write attempt (design: "Each actual label-write attempt obtains the
 * needed current remote state"). Holds the repository fence for the whole
 * attempt, rereads the item and the label catalog from GitHub, and treats
 * an already-present or already-absent label as done. A closed item, which
 * includes a merged pull request, is out of scope. A throttle releases the
 * fence and the workflow waits durably before the next attempt.
 */
const applyPlan = (identity: DirectLabelingIdentity) =>
  Effect.gen(function* () {
    const eligibility = yield* RepositoryEligibility
    const { repositoryId, number } = identity
    const attempt = Effect.gen(function* () {
      // The recorded plan, not the in-memory one: a replay re-evaluates
      // fresh facts, but only the ledger's planned actions may be written.
      const planned = yield* plannedActions(identity).pipe(sqlFailure)
      if (planned.length === 0) return { applied: 0, failed: 0, skipped: "" }
      const skip = (reason: string) =>
        settleRemaining(identity, reason).pipe(
          sqlFailure,
          Effect.as({ applied: 0, failed: planned.length, skipped: reason }),
        )
      const qualified = yield* qualify(identity).pipe(sqlFailure)
      if (qualified._tag === "Disqualified") return yield* skip(qualified.detail)
      const { repository } = qualified
      const fetched = yield* fetchIssue(repository, number, "foreground")
      if (fetched._tag === "Unavailable")
        return yield* skip(`Item could not be read: ${fetched.message}`)
      const issue = fetched.issue
      if (issue.state !== "open") return yield* skip(closedDetail(issue))
      const present = new Map(issue.labels.map((label) => [label.id, label.name]))
      const catalog = planned.some((action) => action.action === "add")
        ? new Map((yield* fetchLabelCatalog(repository)).map((label) => [label.id, label.name]))
        : new Map<string, string>()
      let applied = 0
      let failed = 0
      const settle = (labelId: string, status: "applied" | "failed", detail: string | null) =>
        settleAction(identity, labelId, status, detail).pipe(sqlFailure)
      for (const action of planned) {
        if (yield* aiConsentRevoked(identity, action.ruleId).pipe(sqlFailure)) {
          yield* settle(action.labelId, "failed", "AI access was disabled before applying labels")
          failed++
          continue
        }
        const done =
          action.action === "add" ? present.has(action.labelId) : !present.has(action.labelId)
        if (done) {
          yield* settle(action.labelId, "applied", "already in the desired state")
          applied++
          continue
        }
        if (action.action === "remove") {
          const written = yield* removeLabel(repository, number, present.get(action.labelId)!)
          // Removing a label GitHub already dropped is the desired state.
          if (written._tag === "Written" || written._tag === "Missing") {
            yield* settle(
              action.labelId,
              "applied",
              written._tag === "Missing" ? "already absent on GitHub" : null,
            )
            applied++
          } else {
            yield* settle(action.labelId, "failed", written.message)
            failed++
          }
          continue
        }
        const name = catalog.get(action.labelId)
        if (name === undefined) {
          yield* settle(action.labelId, "failed", "label is missing on GitHub")
          failed++
          yield* retireMissingLabel(repositoryId, action.labelId, `ID ${action.labelId}`).pipe(
            sqlFailure,
          )
          continue
        }
        const written = yield* addLabel(repository, number, name)
        if (written._tag === "Written") {
          yield* settle(action.labelId, "applied", null)
          applied++
          continue
        }
        yield* settle(action.labelId, "failed", written.message)
        failed++
        // Adding a label GitHub does not know: retire the rules bound to it.
        if (written._tag === "Missing")
          yield* retireMissingLabel(repositoryId, action.labelId, name).pipe(sqlFailure)
      }
      yield* Effect.logInfo("Applied label plan").pipe(
        Effect.annotateLogs({ repositoryId, number, applied, failed }),
      )
      return { applied, failed, skipped: "" }
    })
    const result = yield* eligibility
      .run(repositoryId, attempt, { generation: identity.eligibilityGeneration })
      .pipe(
        Effect.catchTag("@janitor/cluster/RepositoryEligibility/RepositoryBlocked", (blocked) =>
          settleRemaining(identity, blocked.reason).pipe(
            sqlFailure,
            Effect.map((settled) => ({
              applied: 0,
              failed: settled.length,
              skipped: blocked.reason,
            })),
          ),
        ),
        Effect.catchTag("SqlError", (error) => sqlFailure(Effect.fail(error))),
      )
    yield* flushLive
    return result
  })

export const LabelItemLayer = LabelItem.toLayer(
  Effect.fnUntraced(function* (identity) {
    const { repositoryId, number } = identity

    // Facts and traces belong to deletable repository storage, so the reads
    // and the evaluation run in the workflow body and only outcomes become
    // activity results. A replay rereads.
    const evaluated: EvaluateResult = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const configuration = yield* LabelingConfiguration
      const eligibility = yield* RepositoryEligibility
      const outbox = yield* WorkflowOutbox
      const admitted = yield* sql`
        SELECT 1 FROM labeling_reconciliation WHERE repository_id = ${repositoryId} AND number = ${number}
          AND snapshot_generation = ${identity.snapshotGeneration} AND rules_revision = ${identity.rulesRevision}
      `
      if (!admitted.length) return yield* failure("the admitted evaluation no longer exists")
      const qualified = yield* qualify(identity)
      if (qualified._tag === "Disqualified") return qualified
      const snapshot = yield* configuration.load(repositoryId, identity.rulesRevision)
      if (Option.isNone(snapshot))
        return yield* failure(`configuration revision ${identity.rulesRevision} does not exist`)
      const read = yield* readItem(qualified.repository, number, snapshot.value.requiredTracks)
      if (read._tag === "Disqualified") return read
      const result = yield* evaluateLabeling({
        configuration: snapshot.value,
        number,
        facts: itemFacts(read.item),
        currentLabels: new Set(read.item.issue.labels.map((label) => label.id)),
      }).pipe(
        Effect.provideService(EvaluationRetry, {
          claimKey: `${identity.snapshotGeneration}:${identity.rulesRevision}`,
          isCurrent: qualify(identity).pipe(
            Effect.map((qualified) => qualified._tag === "Current"),
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(RepositoryEligibility, eligibility),
            Effect.provideService(WorkflowOutbox, outbox),
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
                  new ClassifierError({ operation: "retry status", message: error.message }),
              ),
            ),
        }),
      )
      return { _tag: "Evaluated", ...result } as const
    }).pipe(Effect.mapError((error) => failure(error.message)))

    // A slow evaluation (for example a classifier) may overlap a rule change
    // or a newer event. Check even empty plans so a former no-match cannot
    // swallow the event.
    const current =
      evaluated._tag !== "Evaluated" ||
      (yield* Activity.make({
        name: "LabelItem/CheckCurrent",
        success: Schema.Boolean,
        error: LabelItemError,
        execute: qualify(identity).pipe(
          Effect.map((qualified) => qualified._tag === "Current"),
          Effect.mapError((error) => failure(describeError(error))),
        ),
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

    // The memoized outcome, not the replayed evaluation, decides whether to
    // apply: after a restart the ledger already holds the plan to write.
    const recorded = yield* Activity.make({
      name: `LabelItem/Record/${outcome.outcome}`,
      success: ReconciliationOutcome,
      error: LabelItemError,
      execute: recordOutcome(identity, outcome, current ? evaluated : null).pipe(
        Effect.as(outcome.outcome),
        Effect.mapError((error) => failure(describeError(error))),
      ),
    })

    if (recorded === "evaluated") {
      const applied = yield* withRateLimitWaits("LabelItem/Apply", (attempt) =>
        Activity.make({
          name: `LabelItem/Apply/${attempt}`,
          success: ApplyResult,
          error: SyncActivityFailure,
          execute: applyPlan(identity),
        }),
      ).pipe(Effect.result)
      if (applied._tag === "Failure") {
        // GitHub stayed unavailable through the bounded retries: the plan
        // failed operationally, which is not a non-match.
        yield* Activity.make({
          name: "LabelItem/ApplyFailed",
          error: LabelItemError,
          execute: settleRemaining(identity, applied.failure.message).pipe(
            Effect.asVoid,
            Effect.mapError((error) => failure(describeError(error))),
          ),
        })
      }
    }

    yield* flushLive
    return { ...identity, outcome: recorded }
  }, logWorkflowFailure("LabelItem")),
)

const decodePayload = Schema.decodeUnknownEffect(DirectLabelingIdentity)

export const LabelItemRegistration: WorkflowRegistration = {
  tag: LABEL_ITEM_TAG,
  submit: (payload) =>
    decodePayload(payload).pipe(
      Effect.flatMap((decoded) => LabelItem.execute(decoded, { discard: true })),
      Effect.asVoid,
    ),
}
