import type { GitHubIssueApi } from "@janitor/domain/GitHub/Api"
import { GitHubInstallationId, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { SyncGeneration } from "@janitor/domain/GitHub/Sync"
import type { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import { LabelingRevision } from "@janitor/domain/Labeling/Policy/Configuration"
import { type FactSnapshot, snapshotFacts } from "@janitor/domain/Labeling/Policy/Facts"
import {
  ReconciliationIdentity,
  ReconciliationOutcome,
} from "@janitor/domain/Labeling/Reconciliation"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Activity from "effect/unstable/workflow/Activity"
import * as Workflow from "effect/unstable/workflow/Workflow"
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
import {
  addLabel,
  fetchIssue,
  fetchLabelCatalog,
  removeLabel,
  type RepositoryTarget,
} from "./GitHubIssue.ts"
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

export const LABEL_ISSUE_TAG = "Janitor/LabelIssueV1"

/**
 * The automation-owned identity of one direct issue evaluation: the issue,
 * the observation generation its admitting event received, the rules
 * revision configured at admission, and the repository eligibility
 * generation the work was accepted under. Nothing here comes from
 * synchronization.
 */
export const IssueLabelingIdentity = Schema.Struct({
  ...ReconciliationIdentity.fields,
  eligibilityGeneration: Schema.String.check(Schema.isPattern(/^\d+$/)),
}).annotate({ identifier: "IssueLabelingIdentity" })
export type IssueLabelingIdentity = typeof IssueLabelingIdentity.Type

export const labelIssueKey = (identity: ReconciliationIdentity): string =>
  `label-issue:${identity.repositoryId}:${identity.number}:${identity.snapshotGeneration}:${identity.rulesRevision}`

export class IssueLabelingError extends Data.TaggedError("IssueLabelingError")<{
  readonly operation: string
  readonly message: string
}> {}

export interface AdmissionRequest {
  readonly repositoryId: GitHubRepositoryDatabaseId
  /** The issue as the webhook described it; the work rereads GitHub when it runs. */
  readonly issue: GitHubIssueApi
  readonly sequence: GitHubWebhookJournalSequence
}

export type AdmissionResult =
  | { readonly _tag: "Admitted"; readonly identity: IssueLabelingIdentity }
  | {
      readonly _tag: "Skipped"
      readonly reason: "pull-request" | "closed" | "no-active-revision" | "repository-blocked"
      readonly detail?: string
    }

const ConfiguredRow = Schema.Struct({
  configured_revision: Schema.NullOr(
    Schema.FiniteFromString.pipe(Schema.decodeTo(LabelingRevision)),
  ),
})

const sha256Hex = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) => Encoding.encodeHex(new Uint8Array(digest))),
  )

/** Only what concrete issue rules read, in a stable order. */
export const issueFingerprint = (issue: GitHubIssueApi) =>
  sha256Hex(
    JSON.stringify({
      kind: "issue",
      title: issue.title,
      author: (issue.user?.login ?? "ghost").toLowerCase(),
      state: issue.state,
      baseRef: null,
      draft: null,
      labels: issue.labels.map((label) => label.id).sort(),
    }),
  )

/**
 * Admits one issue event onto the direct path: records the pending
 * evaluation and its outbox row in one transaction. The caller holds the
 * repository fence, so the observation generation is unique per issue and
 * later events always receive a larger one.
 */
export class IssueLabelingAdmission extends Context.Service<
  IssueLabelingAdmission,
  {
    readonly admit: (
      request: AdmissionRequest,
    ) => Effect.Effect<AdmissionResult, IssueLabelingError>
  }
>()("@janitor/cluster/Labeling/IssueLabeling/IssueLabelingAdmission", {
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
          (error) => new IssueLabelingError({ operation, message: describeError(error) }),
        )

    const admit = Effect.fn("IssueLabelingAdmission.admit")(function* (request: AdmissionRequest) {
      const { repositoryId, issue } = request
      if (issue.pullRequest !== undefined)
        return { _tag: "Skipped", reason: "pull-request" } as const
      if (issue.state !== "open") return { _tag: "Skipped", reason: "closed" } as const
      const repository = yield* eligibility.get(repositoryId).pipe(Effect.result)
      if (repository._tag === "Failure") {
        if (repository.failure._tag !== "@janitor/cluster/RepositoryEligibility/RepositoryBlocked")
          return yield* new IssueLabelingError({
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
      const fingerprint = yield* issueFingerprint(issue)
      const identity = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const [row] = yield* sql<{ generation: string }>`
              SELECT GREATEST(${request.sequence}::bigint,
                COALESCE((SELECT MAX(snapshot_generation) + 1 FROM labeling_reconciliation
                  WHERE repository_id = ${repositoryId} AND number = ${issue.number}), 0))::text AS generation
            `
            const identity: IssueLabelingIdentity = {
              repositoryId,
              number: issue.number,
              snapshotGeneration: SyncGeneration.make(row!.generation),
              rulesRevision,
              eligibilityGeneration: repository.success.generation,
            }
            yield* sql`
              INSERT INTO labeling_reconciliation
                (repository_id, number, snapshot_generation, rules_revision, covered_sequence, fingerprint, source)
              VALUES (${repositoryId}, ${issue.number}, ${identity.snapshotGeneration}, ${rulesRevision},
                      ${request.sequence}, ${fingerprint}, 'github')
            `
            yield* outbox.enqueue({
              workflowTag: LABEL_ISSUE_TAG,
              executionKey: labelIssueKey(identity),
              payload: identity,
            })
            return identity
          }),
        )
        .pipe(wrap("admit"))
      yield* Effect.logInfo("Admitted issue for direct labeling").pipe(
        Effect.annotateLogs({
          repositoryId,
          number: issue.number,
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

export class LabelIssueError extends Schema.TaggedError<LabelIssueError>()("LabelIssueError", {
  message: Schema.String,
}) {}

export const LabelIssueResult = Schema.Struct({
  ...ReconciliationIdentity.fields,
  outcome: ReconciliationOutcome,
})

/**
 * Evaluates one admitted issue against current GitHub facts (ADR 0006).
 * Requalifies the work against the repository fence and the configured
 * revision, reads the issue from GitHub, evaluates every rule of the
 * revision, records the outcome, and applies the plan with fresh checks
 * inside each write attempt.
 */
export const LabelIssue = Workflow.make(LABEL_ISSUE_TAG, {
  payload: IssueLabelingIdentity,
  success: LabelIssueResult,
  error: LabelIssueError,
  idempotencyKey: labelIssueKey,
})

type Qualification =
  | { readonly _tag: "Current"; readonly repository: RepositoryTarget }
  | {
      readonly _tag: "Disqualified"
      readonly outcome: "superseded" | "not-qualified"
      readonly detail: string
    }

const failure = (message: string) => new LabelIssueError({ message })

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
const handoffLatest = (identity: IssueLabelingIdentity, eligibilityGeneration: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const outbox = yield* WorkflowOutbox
    const revision = yield* configuredRevision(identity.repositoryId)
    if (revision === null || revision === identity.rulesRevision) return
    const latest: IssueLabelingIdentity = {
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
            workflowTag: LABEL_ISSUE_TAG,
            executionKey: labelIssueKey(latest),
            payload: latest,
          })
      }),
    )
  })

/**
 * Whether the work is still the current work for its issue: the repository
 * fence and generation, the configured revision, and no later observation.
 * Synchronization state is never consulted.
 */
const qualify = (identity: IssueLabelingIdentity) =>
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

const issueFacts = (issue: GitHubIssueApi): FactSnapshot =>
  snapshotFacts({
    kind: "issue",
    title: issue.title,
    body: issue.body,
    authorLogin: issue.user?.login ?? "ghost",
    state: issue.state,
    labels: issue.labels.map((label) => label.id),
    pullRequest: null,
  })

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
 * attempt, rereads the issue and the label catalog from GitHub, and treats
 * an already-present or already-absent label as done. A throttle releases
 * the fence and the workflow waits durably before the next attempt.
 */
const applyPlan = (identity: IssueLabelingIdentity) =>
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
        return yield* skip(`Issue could not be read: ${fetched.message}`)
      const issue = fetched.issue
      if (issue.pullRequest !== undefined) return yield* skip("item is a pull request")
      if (issue.state !== "open") return yield* skip("issue is closed on GitHub")
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
      yield* Effect.logInfo("Applied issue label plan").pipe(
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

export const LabelIssueLayer = LabelIssue.toLayer(
  Effect.fnUntraced(function* (identity) {
    const { repositoryId, number } = identity

    // Facts and traces belong to deletable repository storage, so the fetch
    // and the evaluation run in the workflow body and only outcomes become
    // activity results. A replay refetches.
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
      const fetched = yield* withRateLimitWaits("LabelIssue/Issue", () =>
        fetchIssue(qualified.repository, number, "foreground"),
      ).pipe(Effect.result)
      if (fetched._tag === "Failure")
        return { _tag: "Disqualified", outcome: "failed", detail: fetched.failure.message } as const
      if (fetched.success._tag === "Unavailable")
        return {
          _tag: "Disqualified",
          outcome: "failed",
          detail: `Issue could not be read: ${fetched.success.message}`,
        } as const
      const issue = fetched.success.issue
      if (issue.pullRequest !== undefined)
        return {
          _tag: "Disqualified",
          outcome: "not-qualified",
          detail: "item is a pull request; pull requests use the synchronized path",
        } as const
      if (issue.state !== "open")
        return {
          _tag: "Disqualified",
          outcome: "not-qualified",
          detail: "issue is closed on GitHub",
        } as const
      const snapshot = yield* configuration.load(repositoryId, identity.rulesRevision)
      if (Option.isNone(snapshot))
        return yield* failure(`configuration revision ${identity.rulesRevision} does not exist`)
      const result = yield* evaluateLabeling({
        configuration: snapshot.value,
        number,
        facts: issueFacts(issue),
        currentLabels: new Set(issue.labels.map((label) => label.id)),
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
        name: "LabelIssue/CheckCurrent",
        success: Schema.Boolean,
        error: LabelIssueError,
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
      name: `LabelIssue/Record/${outcome.outcome}`,
      success: ReconciliationOutcome,
      error: LabelIssueError,
      execute: recordOutcome(identity, outcome, current ? evaluated : null).pipe(
        Effect.as(outcome.outcome),
        Effect.mapError((error) => failure(describeError(error))),
      ),
    })

    if (recorded === "evaluated") {
      const applied = yield* withRateLimitWaits("LabelIssue/Apply", (attempt) =>
        Activity.make({
          name: `LabelIssue/Apply/${attempt}`,
          success: ApplyResult,
          error: SyncActivityFailure,
          execute: applyPlan(identity),
        }),
      ).pipe(Effect.result)
      if (applied._tag === "Failure") {
        // GitHub stayed unavailable through the bounded retries: the plan
        // failed operationally, which is not a non-match.
        yield* Activity.make({
          name: "LabelIssue/ApplyFailed",
          error: LabelIssueError,
          execute: settleRemaining(identity, applied.failure.message).pipe(
            Effect.asVoid,
            Effect.mapError((error) => failure(describeError(error))),
          ),
        })
      }
    }

    yield* flushLive
    return { ...identity, outcome: recorded }
  }, logWorkflowFailure("LabelIssue")),
)

const decodePayload = Schema.decodeUnknownEffect(IssueLabelingIdentity)

export const LabelIssueRegistration: WorkflowRegistration = {
  tag: LABEL_ISSUE_TAG,
  submit: (payload) =>
    decodePayload(payload).pipe(
      Effect.flatMap((decoded) => LabelIssue.execute(decoded, { discard: true })),
      Effect.asVoid,
    ),
}
