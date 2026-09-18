import { ReviewPublication } from "@janitor/domain/Review/Publication"
import { Reproduction } from "@janitor/domain/Review/Reproduction"
import {
  ReviewClassification,
  type ReviewConclusion,
  ReviewEvidence,
} from "@janitor/domain/Review/Findings"
import { type ReviewRun, ReviewRunId, ReviewRunStatus } from "@janitor/domain/Review/Run"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"
import { describeError } from "../SqlErrors.ts"

/**
 * The durable records of issue review: settings, invocation receipts, runs
 * with their explicitly persisted agent state, applied messages and the
 * per-issue scheduling record. Every transition of a run's lifecycle is a
 * row update here; the agent Entity and the scheduler decide, the store
 * records.
 */

export class IssueReviewError extends Schema.TaggedError<IssueReviewError>()(
  "@janitor/cluster/Review/IssueReviewError",
  { operation: Schema.String, message: Schema.String },
) {}

const Generation = Schema.String.check(Schema.isPattern(/^\d+$/))

export const SettingRow = Schema.Struct({
  repositoryId: Schema.String,
  enabled: Schema.Boolean,
  dryRun: Schema.Boolean,
  admitAfter: Schema.DateTimeUtcFromDate,
  updatedAt: Schema.DateTimeUtcFromDate,
})
export type SettingRow = typeof SettingRow.Type

export const ReceiptOutcome = Schema.Literals(["pending", "admitted", "denied"])
export type ReceiptOutcome = typeof ReceiptOutcome.Type

export const ReceiptRow = Schema.Struct({
  repositoryId: Schema.String,
  commentId: Schema.String,
  deliveryId: Schema.String,
  issueNumber: Schema.Int,
  authorId: Schema.String,
  authorLogin: Schema.String,
  body: Schema.String,
  receivedAt: Schema.DateTimeUtcFromDate,
  eligibilityGeneration: Generation,
  outcome: ReceiptOutcome,
  reason: Schema.NullOr(Schema.String),
  runId: Schema.NullOr(ReviewRunId),
})
export type ReceiptRow = typeof ReceiptRow.Type

export interface NewReceipt {
  readonly repositoryId: string
  readonly commentId: string
  readonly deliveryId: string
  readonly issueNumber: number
  readonly authorId: string
  readonly authorLogin: string
  readonly body: string
  readonly receivedAt: Date
  readonly eligibilityGeneration: string
  /** A receipt recorded as denied at once, for example a bot or a quoted mention. */
  readonly denied?: string | undefined
}

/** A run as the store holds it: the wire shape plus what the agent needs. */
export const RunRecord = Schema.Struct({
  runId: ReviewRunId,
  repositoryId: Schema.String,
  issueNumber: Schema.Int,
  issueId: Schema.String,
  commentId: Schema.String,
  invokerId: Schema.String,
  invokerLogin: Schema.String,
  instructions: Schema.String,
  commentCreatedAt: Schema.DateTimeUtcFromDate,
  eligibilityGeneration: Generation,
  dryRun: Schema.Boolean,
  status: ReviewRunStatus,
  acceptedAt: Schema.DateTimeUtcFromDate,
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
  deadlineAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
  finishedAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
  cancelReason: Schema.NullOr(Schema.String),
  cancelledBy: Schema.NullOr(Schema.String),
  agentState: Schema.Unknown,
  classification: Schema.NullOr(ReviewClassification),
  defaultBranch: Schema.NullOr(Schema.String),
  commitSha: Schema.NullOr(Schema.String),
  findings: Schema.NullOr(Schema.String),
  uncertainty: Schema.NullOr(Schema.String),
  evidence: Schema.Array(ReviewEvidence),
  reproduction: Reproduction,
  publication: ReviewPublication,
  limitation: Schema.NullOr(Schema.String),
})
export type RunRecord = typeof RunRecord.Type

export const ActionKind = Schema.Literals(["prepare", "model", "publish"])
export type ActionKind = typeof ActionKind.Type

/** One action of a run: its identity is the run and its sequence number. */
export const ActionRow = Schema.Struct({
  runId: ReviewRunId,
  sequence: Schema.Int,
  kind: ActionKind,
  status: Schema.Literals(["pending", "completed"]),
  result: Schema.Unknown,
  createdAt: Schema.DateTimeUtcFromDate,
  completedAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
})
export type ActionRow = typeof ActionRow.Type

export const PriorConclusion = Schema.Struct({
  invokerLogin: Schema.String,
  acceptedAt: Schema.DateTimeUtcFromDate,
  commitSha: Schema.NullOr(Schema.String),
  classification: ReviewClassification,
  findings: Schema.String,
  uncertainty: Schema.String,
})
export type PriorConclusion = typeof PriorConclusion.Type

/** How many earlier conclusions of an issue a new run receives as evidence. */
export const PRIOR_CONCLUSION_LIMIT = 3

export interface NewRun {
  readonly repositoryId: string
  readonly issueNumber: number
  readonly issueId: string
  readonly commentId: string
  readonly invokerId: string
  readonly invokerLogin: string
  readonly instructions: string
  readonly commentCreatedAt: Date
  readonly eligibilityGeneration: string
  readonly dryRun: boolean
}

/** Which live runs a cancellation covers; every field narrows the selection. */
export interface CancelSelection {
  readonly repositoryId: string
  readonly issueNumber?: number | undefined
  readonly commentId?: string | undefined
  readonly runId?: string | undefined
}

/** Why a run stops and who asked. `messageId` names the source so the agent applies it once. */
export interface Cancellation {
  readonly messageId: string
  readonly reason: string
  readonly actor: string | null
}

export interface RunTransition {
  readonly status: ReviewRunStatus
  readonly startedAt?: Date | undefined
  readonly deadlineAt?: Date | undefined
  readonly finishedAt?: Date | undefined
  readonly cancelReason?: string | undefined
  readonly cancelledBy?: string | undefined
  readonly agentState?: unknown
  /** The validated conclusion, or the limitation that ended the run without one. */
  readonly conclusion?:
    | (Omit<ReviewConclusion, "evidence"> & { readonly evidence: ReadonlyArray<ReviewEvidence> })
    | undefined
  readonly evidence?: ReadonlyArray<ReviewEvidence> | undefined
  readonly limitation?: string | undefined
}

const HistoryRow = Schema.Struct({
  ...RunRecord.fields,
  issueTitle: Schema.NullOr(Schema.String),
  queuePosition: Schema.NullOr(Schema.Int),
})

const runColumnsOf = (t: string) => `
  ${t}run_id::text AS "runId", ${t}repository_id AS "repositoryId", ${t}issue_number AS "issueNumber",
  ${t}issue_id AS "issueId", ${t}comment_id AS "commentId", ${t}invoker_id AS "invokerId",
  ${t}invoker_login AS "invokerLogin", ${t}instructions, ${t}comment_created_at AS "commentCreatedAt",
  ${t}eligibility_generation::text AS "eligibilityGeneration", ${t}dry_run AS "dryRun", ${t}status,
  ${t}accepted_at AS "acceptedAt", ${t}started_at AS "startedAt", ${t}deadline_at AS "deadlineAt",
  ${t}finished_at AS "finishedAt", ${t}cancel_reason AS "cancelReason", ${t}cancelled_by AS "cancelledBy",
  ${t}agent_state AS "agentState", ${t}classification, ${t}default_branch AS "defaultBranch",
  ${t}commit_sha AS "commitSha", ${t}findings, ${t}uncertainty, ${t}evidence, ${t}limitation, ${t}reproduction, ${t}publication`
const runColumns = runColumnsOf("")

const settingColumns = `
  repository_id AS "repositoryId", enabled, dry_run AS "dryRun",
  admit_after AS "admitAfter", updated_at AS "updatedAt"`

const receiptColumns = `
  repository_id AS "repositoryId", comment_id AS "commentId", delivery_id AS "deliveryId",
  issue_number AS "issueNumber", author_id AS "authorId", author_login AS "authorLogin", body,
  received_at AS "receivedAt", eligibility_generation::text AS "eligibilityGeneration",
  outcome, reason, run_id::text AS "runId"`

const actionColumns = `
  run_id::text AS "runId", sequence, kind, status, result, created_at AS "createdAt",
  completed_at AS "completedAt"`

const ById = Schema.Struct({ runId: Schema.String })
const ByAction = Schema.Struct({ runId: Schema.String, sequence: Schema.Int })
const ByRepository = Schema.Struct({ repositoryId: Schema.String })
const ByComment = Schema.Struct({ repositoryId: Schema.String, commentId: Schema.String })
const ByIssue = Schema.Struct({ repositoryId: Schema.String, issueNumber: Schema.Int })

export class IssueReviewStore extends Context.Service<
  IssueReviewStore,
  {
    readonly savePublication: (
      runId: string,
      publication: ReviewPublication,
    ) => Effect.Effect<void, IssueReviewError>
    readonly settings: (
      repositoryId: string,
    ) => Effect.Effect<Option.Option<SettingRow>, IssueReviewError>
    /** Moves the admission boundary whenever `enabled` changes. */
    readonly upsertSettings: (
      repositoryId: string,
      settings: { readonly enabled: boolean; readonly dryRun: boolean },
    ) => Effect.Effect<SettingRow, IssueReviewError>
    /** False when the comment already has a receipt: a replay creates nothing. */
    readonly recordReceipt: (receipt: NewReceipt) => Effect.Effect<boolean, IssueReviewError>
    readonly receipt: (
      repositoryId: string,
      commentId: string,
    ) => Effect.Effect<Option.Option<ReceiptRow>, IssueReviewError>
    /** Settles a pending receipt; a settled receipt is never changed again. */
    readonly decideReceipt: (
      repositoryId: string,
      commentId: string,
      decision: {
        readonly outcome: "admitted" | "denied"
        readonly reason?: string | undefined
        readonly runId?: string | undefined
      },
    ) => Effect.Effect<boolean, IssueReviewError>
    readonly insertRun: (run: NewRun) => Effect.Effect<RunRecord, IssueReviewError>
    readonly run: (runId: string) => Effect.Effect<Option.Option<RunRecord>, IssueReviewError>
    /** Holds the run row for the transaction. */
    readonly lockRun: (runId: string) => Effect.Effect<Option.Option<RunRecord>, IssueReviewError>
    /**
     * Ends every live run the selection covers, in the caller's transaction,
     * and clears their issues' active run. Returns the runs as cancelled.
     */
    readonly cancelRuns: (
      selection: CancelSelection,
      cancellation: Cancellation,
    ) => Effect.Effect<ReadonlyArray<RunRecord>, IssueReviewError>
    /** Queued and running runs, oldest first; for one issue when given. */
    readonly liveRuns: (
      repositoryId: string,
      issueNumber?: number,
    ) => Effect.Effect<ReadonlyArray<RunRecord>, IssueReviewError>
    readonly transition: (
      runId: string,
      patch: RunTransition,
    ) => Effect.Effect<RunRecord, IssueReviewError>
    /** Records the default-branch revision the run reads its evidence from. */
    readonly saveReproduction: (
      runId: string,
      reproduction: Reproduction,
    ) => Effect.Effect<void, IssueReviewError>
    readonly recordRevision: (
      runId: string,
      revision: { readonly defaultBranch: string; readonly commitSha: string },
    ) => Effect.Effect<void, IssueReviewError>
    /** Adds the next pending action; joins the caller's transaction. */
    readonly insertAction: (
      runId: string,
      sequence: number,
      kind: ActionKind,
    ) => Effect.Effect<ActionRow, IssueReviewError>
    readonly action: (
      runId: string,
      sequence: number,
    ) => Effect.Effect<Option.Option<ActionRow>, IssueReviewError>
    /** Every action of the run in sequence order. */
    readonly actions: (runId: string) => Effect.Effect<ReadonlyArray<ActionRow>, IssueReviewError>
    /** False when the action was already completed: a result is recorded once. */
    readonly completeAction: (
      runId: string,
      sequence: number,
      result: unknown,
    ) => Effect.Effect<boolean, IssueReviewError>
    /** False when the message was already recorded for the run. */
    readonly recordMessage: (message: {
      readonly runId: string
      readonly messageId: string
      readonly kind: string
      readonly payload: unknown
      readonly applied: boolean
    }) => Effect.Effect<boolean, IssueReviewError>
    /** The issue's scheduling record, created on first use and held for the transaction. */
    readonly lockIssue: (
      repositoryId: string,
      issueNumber: number,
    ) => Effect.Effect<{ readonly activeRunId: string | null }, IssueReviewError>
    readonly setActiveRun: (
      repositoryId: string,
      issueNumber: number,
      runId: string | null,
    ) => Effect.Effect<void, IssueReviewError>
    readonly nextQueued: (
      repositoryId: string,
      issueNumber: number,
    ) => Effect.Effect<Option.Option<RunRecord>, IssueReviewError>
    /** Concluded runs of the issue other than `runId`, newest first, bounded. */
    readonly priorConclusions: (
      repositoryId: string,
      issueNumber: number,
      runId: string,
    ) => Effect.Effect<ReadonlyArray<PriorConclusion>, IssueReviewError>
    /** The repository's runs, newest first, with each live run's queue position. */
    readonly history: (
      repositoryId: string,
    ) => Effect.Effect<ReadonlyArray<ReviewRun>, IssueReviewError>
  }
>()("@janitor/cluster/Review/IssueReviewStore", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new IssueReviewError({ operation, message: describeError(error) }),
        )
    const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

    const findSetting = SqlSchema.findOneOption({
      Request: ByRepository,
      Result: SettingRow,
      execute: ({ repositoryId }) =>
        sql`SELECT ${sql.literal(settingColumns)} FROM issue_review_setting WHERE repository_id = ${repositoryId}`,
    })
    const settings = (repositoryId: string) => findSetting({ repositoryId }).pipe(wrap("settings"))

    const upsertSettings = (
      repositoryId: string,
      { enabled, dryRun }: { readonly enabled: boolean; readonly dryRun: boolean },
    ) =>
      SqlSchema.findOne({
        Request: Schema.Struct({
          repositoryId: Schema.String,
          enabled: Schema.Boolean,
          dryRun: Schema.Boolean,
        }),
        Result: SettingRow,
        execute: ({ repositoryId, enabled, dryRun }) => sql`
          INSERT INTO issue_review_setting (repository_id, enabled, dry_run)
          VALUES (${repositoryId}, ${enabled}, ${dryRun})
          ON CONFLICT (repository_id) DO UPDATE SET
            enabled = EXCLUDED.enabled, dry_run = EXCLUDED.dry_run,
            admit_after = CASE WHEN issue_review_setting.enabled IS DISTINCT FROM EXCLUDED.enabled
              THEN CLOCK_TIMESTAMP() ELSE issue_review_setting.admit_after END,
            updated_at = CLOCK_TIMESTAMP()
          RETURNING ${sql.literal(settingColumns)}`,
      })({ repositoryId, enabled, dryRun }).pipe(wrap("upsertSettings"))

    const recordReceipt = (receipt: NewReceipt) =>
      sql`
        INSERT INTO issue_review_receipt
          (repository_id, comment_id, delivery_id, issue_number, author_id, author_login, body,
           received_at, eligibility_generation, outcome, reason, decided_at)
        VALUES (${receipt.repositoryId}, ${receipt.commentId}, ${receipt.deliveryId},
          ${receipt.issueNumber}, ${receipt.authorId}, ${receipt.authorLogin}, ${receipt.body},
          ${receipt.receivedAt}, ${receipt.eligibilityGeneration}::bigint,
          ${receipt.denied === undefined ? "pending" : "denied"}, ${receipt.denied ?? null},
          CASE WHEN ${receipt.denied !== undefined} THEN CLOCK_TIMESTAMP() END)
        ON CONFLICT (repository_id, comment_id) DO NOTHING
        RETURNING comment_id
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        wrap("recordReceipt"),
      )

    const findReceipt = SqlSchema.findOneOption({
      Request: ByComment,
      Result: ReceiptRow,
      execute: ({ repositoryId, commentId }) =>
        sql`SELECT ${sql.literal(receiptColumns)} FROM issue_review_receipt
          WHERE repository_id = ${repositoryId} AND comment_id = ${commentId}`,
    })
    const receipt = (repositoryId: string, commentId: string) =>
      findReceipt({ repositoryId, commentId }).pipe(wrap("receipt"))

    const decideReceipt = (
      repositoryId: string,
      commentId: string,
      decision: {
        readonly outcome: "admitted" | "denied"
        readonly reason?: string | undefined
        readonly runId?: string | undefined
      },
    ) =>
      sql`
        UPDATE issue_review_receipt SET outcome = ${decision.outcome}, reason = ${decision.reason ?? null},
          run_id = ${decision.runId ?? null}::uuid, decided_at = CLOCK_TIMESTAMP()
        WHERE repository_id = ${repositoryId} AND comment_id = ${commentId} AND outcome = 'pending'
        RETURNING comment_id
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        wrap("decideReceipt"),
      )

    const findRun = SqlSchema.findOneOption({
      Request: ById,
      Result: RunRecord,
      execute: ({ runId }) =>
        sql`SELECT ${sql.literal(runColumns)} FROM issue_review_run WHERE run_id::text = ${runId}`,
    })
    const lockRunQuery = SqlSchema.findOneOption({
      Request: ById,
      Result: RunRecord,
      execute: ({ runId }) =>
        sql`SELECT ${sql.literal(runColumns)} FROM issue_review_run WHERE run_id::text = ${runId} FOR UPDATE`,
    })
    const cancelQuery = SqlSchema.findAll({
      Request: Schema.Struct({
        repositoryId: Schema.String,
        issueNumber: Schema.NullOr(Schema.Int),
        commentId: Schema.NullOr(Schema.String),
        runId: Schema.NullOr(Schema.String),
        reason: Schema.String,
        actor: Schema.NullOr(Schema.String),
      }),
      Result: RunRecord,
      execute: ({ repositoryId, issueNumber, commentId, runId, reason, actor }) => sql`
        WITH ended AS (
          UPDATE issue_review_run SET status = 'cancelled', finished_at = CLOCK_TIMESTAMP(),
            cancel_reason = ${reason}, cancelled_by = ${actor},
            agent_state = jsonb_build_object('phase', 'cancelled')
          WHERE repository_id = ${repositoryId} AND status IN ('queued', 'running')
            AND (${issueNumber === null} OR issue_number = ${issueNumber ?? 0})
            AND (${commentId === null} OR comment_id = ${commentId ?? ""})
            AND (${runId === null} OR run_id::text = ${runId ?? ""})
          RETURNING *
        ), released AS (
          UPDATE issue_review_issue i SET active_run_id = NULL, updated_at = CLOCK_TIMESTAMP()
          FROM ended WHERE i.repository_id = ended.repository_id AND i.active_run_id = ended.run_id
        )
        SELECT ${sql.literal(runColumns)} FROM ended ORDER BY accepted_at, run_id`,
    })
    const cancelRuns = (selection: CancelSelection, cancellation: Cancellation) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT repository_id FROM github_repository WHERE repository_id = ${selection.repositoryId} FOR NO KEY UPDATE`
            yield* sql`SELECT issue_number FROM issue_review_issue WHERE repository_id = ${selection.repositoryId} ORDER BY issue_number FOR UPDATE`
            return yield* cancelQuery({
              repositoryId: selection.repositoryId,
              issueNumber: selection.issueNumber ?? null,
              commentId: selection.commentId ?? null,
              runId: selection.runId ?? null,
              reason: cancellation.reason,
              actor: cancellation.actor,
            })
          }),
        )
        .pipe(wrap("cancelRuns"))
    const findLive = SqlSchema.findAll({
      Request: Schema.Struct({
        repositoryId: Schema.String,
        issueNumber: Schema.NullOr(Schema.Int),
      }),
      Result: RunRecord,
      execute: ({ repositoryId, issueNumber }) =>
        sql`SELECT ${sql.literal(runColumns)} FROM issue_review_run
          WHERE repository_id = ${repositoryId} AND status IN ('queued', 'running')
            AND (${issueNumber === null} OR issue_number = ${issueNumber ?? 0})
          ORDER BY accepted_at, run_id`,
    })
    const findNextQueued = SqlSchema.findOneOption({
      Request: ByIssue,
      Result: RunRecord,
      execute: ({ repositoryId, issueNumber }) =>
        sql`SELECT ${sql.literal(runColumns)} FROM issue_review_run
          WHERE repository_id = ${repositoryId} AND issue_number = ${issueNumber} AND status = 'queued'
          ORDER BY accepted_at, run_id LIMIT 1`,
    })

    const insertRun = (run: NewRun) =>
      SqlSchema.findOne({
        Request: Schema.Void,
        Result: RunRecord,
        execute: () => sql`
          INSERT INTO issue_review_run
            (run_id, repository_id, issue_number, issue_id, comment_id, invoker_id, invoker_login,
             instructions, comment_created_at, eligibility_generation, dry_run)
          VALUES (gen_random_uuid(), ${run.repositoryId}, ${run.issueNumber}, ${run.issueId},
            ${run.commentId}, ${run.invokerId}, ${run.invokerLogin}, ${run.instructions},
            ${run.commentCreatedAt}, ${run.eligibilityGeneration}::bigint, ${run.dryRun})
          RETURNING ${sql.literal(runColumns)}`,
      })(undefined).pipe(wrap("insertRun"))

    const encodeEvidence = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(ReviewEvidence)))

    const transition = (runId: string, patch: RunTransition) =>
      Effect.gen(function* () {
        const agentState =
          patch.agentState === undefined ? undefined : yield* encodeJson(patch.agentState)
        const evidence = patch.conclusion?.evidence ?? patch.evidence
        const encodedEvidence = evidence === undefined ? null : yield* encodeEvidence(evidence)
        return yield* SqlSchema.findOne({
          Request: Schema.Void,
          Result: RunRecord,
          execute: () => sql`
            UPDATE issue_review_run SET status = ${patch.status},
              started_at = COALESCE(${patch.startedAt ?? null}, started_at),
              deadline_at = COALESCE(${patch.deadlineAt ?? null}, deadline_at),
              finished_at = COALESCE(${patch.finishedAt ?? null}, finished_at),
              cancel_reason = COALESCE(${patch.cancelReason ?? null}, cancel_reason),
              cancelled_by = COALESCE(${patch.cancelledBy ?? null}, cancelled_by),
              agent_state = COALESCE(${agentState ?? null}::jsonb, agent_state),
              classification = COALESCE(${patch.conclusion?.classification ?? null}, classification),
              findings = COALESCE(${patch.conclusion?.findings ?? null}, findings),
              uncertainty = COALESCE(${patch.conclusion?.uncertainty ?? null}, uncertainty),
              evidence = COALESCE(${encodedEvidence}::jsonb, evidence),
              limitation = COALESCE(${patch.limitation ?? null}, limitation)
            WHERE run_id::text = ${runId}
            RETURNING ${sql.literal(runColumns)}`,
        })(undefined)
      }).pipe(wrap("transition"))

    const recordRevision = (
      runId: string,
      revision: { readonly defaultBranch: string; readonly commitSha: string },
    ) =>
      sql`UPDATE issue_review_run SET default_branch = ${revision.defaultBranch},
        commit_sha = ${revision.commitSha} WHERE run_id::text = ${runId}`.pipe(
        Effect.asVoid,
        wrap("recordRevision"),
      )

    const insertAction = (runId: string, sequence: number, kind: ActionKind) =>
      SqlSchema.findOne({
        Request: Schema.Void,
        Result: ActionRow,
        execute: () => sql`
          INSERT INTO issue_review_action (run_id, sequence, kind)
          VALUES (${runId}::uuid, ${sequence}, ${kind})
          RETURNING ${sql.literal(actionColumns)}`,
      })(undefined).pipe(wrap("insertAction"))

    const findAction = SqlSchema.findOneOption({
      Request: ByAction,
      Result: ActionRow,
      execute: ({ runId, sequence }) =>
        sql`SELECT ${sql.literal(actionColumns)} FROM issue_review_action
          WHERE run_id::text = ${runId} AND sequence = ${sequence}`,
    })
    const findActions = SqlSchema.findAll({
      Request: ById,
      Result: ActionRow,
      execute: ({ runId }) =>
        sql`SELECT ${sql.literal(actionColumns)} FROM issue_review_action
          WHERE run_id::text = ${runId} ORDER BY sequence`,
    })

    const completeAction = (runId: string, sequence: number, result: unknown) =>
      Effect.gen(function* () {
        const encoded = yield* encodeJson(result)
        const rows = yield* sql`
          UPDATE issue_review_action SET status = 'completed', result = ${encoded}::jsonb,
            completed_at = CLOCK_TIMESTAMP()
          WHERE run_id::text = ${runId} AND sequence = ${sequence} AND status = 'pending'
          RETURNING sequence`
        return rows.length === 1
      }).pipe(wrap("completeAction"))

    const recordMessage = (message: {
      readonly runId: string
      readonly messageId: string
      readonly kind: string
      readonly payload: unknown
      readonly applied: boolean
    }) =>
      Effect.gen(function* () {
        const payload = yield* encodeJson(message.payload)
        const rows = yield* sql`
          INSERT INTO issue_review_message (run_id, message_id, kind, payload, applied)
          VALUES (${message.runId}::uuid, ${message.messageId}, ${message.kind}, ${payload}::jsonb, ${message.applied})
          ON CONFLICT (run_id, message_id) DO NOTHING
          RETURNING message_id`
        return rows.length === 1
      }).pipe(wrap("recordMessage"))

    const lockIssue = (repositoryId: string, issueNumber: number) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO issue_review_issue (repository_id, issue_number)
          VALUES (${repositoryId}, ${issueNumber}) ON CONFLICT DO NOTHING`
        const [row] = yield* sql<{ active_run_id: string | null }>`
          SELECT active_run_id::text AS active_run_id FROM issue_review_issue
          WHERE repository_id = ${repositoryId} AND issue_number = ${issueNumber} FOR UPDATE`
        return { activeRunId: row?.active_run_id ?? null }
      }).pipe(wrap("lockIssue"))

    const setActiveRun = (repositoryId: string, issueNumber: number, runId: string | null) =>
      sql`UPDATE issue_review_issue SET active_run_id = ${runId}::uuid, updated_at = CLOCK_TIMESTAMP()
        WHERE repository_id = ${repositoryId} AND issue_number = ${issueNumber}`.pipe(
        Effect.asVoid,
        wrap("setActiveRun"),
      )

    const historyQuery = SqlSchema.findAll({
      Request: ByRepository,
      Result: HistoryRow,
      execute: ({ repositoryId }) => sql`
        SELECT ${sql.literal(runColumnsOf("r."))}, e.title AS "issueTitle",
          CASE WHEN r.status IN ('queued', 'running') THEN (
            SELECT count(*)::int + 1 FROM issue_review_run q
            WHERE q.repository_id = r.repository_id AND q.issue_number = r.issue_number
              AND q.status IN ('queued', 'running')
              AND (q.accepted_at, q.run_id) < (r.accepted_at, r.run_id)
          ) END AS "queuePosition"
        FROM issue_review_run r
        LEFT JOIN github_entity e ON e.repository_id = r.repository_id AND e.number = r.issue_number
        WHERE r.repository_id = ${repositoryId}
        ORDER BY r.accepted_at DESC, r.run_id DESC
        LIMIT 200`,
    })
    const priorQuery = SqlSchema.findAll({
      Request: Schema.Struct({
        repositoryId: Schema.String,
        issueNumber: Schema.Int,
        runId: Schema.String,
      }),
      Result: PriorConclusion,
      execute: ({ repositoryId, issueNumber, runId }) => sql`
        SELECT invoker_login AS "invokerLogin", accepted_at AS "acceptedAt",
          commit_sha AS "commitSha", classification, findings, uncertainty
        FROM issue_review_run
        WHERE repository_id = ${repositoryId} AND issue_number = ${issueNumber}
          AND run_id::text <> ${runId} AND status = 'completed' AND findings IS NOT NULL
        ORDER BY accepted_at DESC, run_id DESC
        LIMIT ${PRIOR_CONCLUSION_LIMIT}`,
    })
    const priorConclusions = (repositoryId: string, issueNumber: number, runId: string) =>
      priorQuery({ repositoryId, issueNumber, runId }).pipe(wrap("priorConclusions"))

    const history = (repositoryId: string) =>
      historyQuery({ repositoryId }).pipe(
        Effect.map((rows) =>
          rows.map(
            ({
              issueId: _issueId,
              eligibilityGeneration: _g,
              commentCreatedAt: _c,
              agentState: _s,
              ...run
            }) => run,
          ),
        ),
        wrap("history"),
      )

    return {
      savePublication: (runId, publication) =>
        sql`UPDATE issue_review_run SET publication = ${JSON.stringify(publication)}::jsonb WHERE run_id::text = ${runId}`.pipe(
          Effect.asVoid,
          wrap("savePublication"),
        ),
      settings,
      upsertSettings,
      recordReceipt,
      receipt,
      decideReceipt,
      insertRun,
      run: (runId) => findRun({ runId }).pipe(wrap("run")),
      lockRun: (runId) => lockRunQuery({ runId }).pipe(wrap("lockRun")),
      cancelRuns,
      liveRuns: (repositoryId, issueNumber) =>
        findLive({ repositoryId, issueNumber: issueNumber ?? null }).pipe(wrap("liveRuns")),
      transition,
      recordRevision,
      saveReproduction: (runId, reproduction) =>
        Schema.encodeEffect(Schema.fromJsonString(Reproduction))(reproduction).pipe(
          Effect.flatMap(
            (value) =>
              sql`UPDATE issue_review_run SET reproduction = ${value}::jsonb WHERE run_id::text = ${runId} AND status = 'running'`,
          ),
          Effect.asVoid,
          wrap("saveReproduction"),
        ),
      insertAction,
      action: (runId, sequence) => findAction({ runId, sequence }).pipe(wrap("action")),
      actions: (runId) => findActions({ runId }).pipe(wrap("actions")),
      completeAction,
      recordMessage,
      lockIssue,
      setActiveRun,
      nextQueued: (repositoryId, issueNumber) =>
        findNextQueued({ repositoryId, issueNumber }).pipe(wrap("nextQueued")),
      priorConclusions,
      history,
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
