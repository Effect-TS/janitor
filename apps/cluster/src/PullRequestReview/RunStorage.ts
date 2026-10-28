import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as SqlClient from "effect/sql/SqlClient"
import { GitHubCommitSha, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import type { RunError } from "@janitor/domain/PullRequestReview/Render"
import { Trigger } from "@janitor/domain/PullRequestReview/Run"
import { decodeMessage, encodeMessage } from "../AgentHistory.ts"
import type { HistoryChange } from "../AgentLoop.ts"
import { LoopOutcome, LoopRecord } from "./Agent.ts"
import { GitHubLink } from "./Store.ts"

/**
 * A PR review run's own storage, in its entity's Durable Object SQLite
 * (EFF-1651, EFF-1848): the run state, one history row per prompt message,
 * the loop records, and the `Publish` batch's steps. Every transaction here
 * is short and only runs SQL. The `cluster_` prefix belongs to the cluster.
 */

/** Where a run is. Every status but `running` and `publishing` is final. */
export const RunPhase = Schema.Literals([
  "running",
  "publishing",
  "published",
  "skipped",
  "cancelled",
  "failed",
])
export type RunPhase = typeof RunPhase.Type

/** The repository and pull request, as GitHub calls them. */
const Target = Schema.Struct({
  installationId: Schema.String,
  owner: Schema.String,
  repo: Schema.String,
})

/** Why a run ended without a review, as its check run reports it. */
const ErrorCategory = Schema.Literals([
  "checkout_failed",
  "sandbox_unavailable",
  "resume_limit",
  "incomplete",
  "publish_failed",
] satisfies ReadonlyArray<RunError>)

export const RunState = Schema.Struct({
  repositoryId: GitHubRepositoryDatabaseId,
  number: Schema.Int,
  headSha: GitHubCommitSha,
  trigger: Trigger,
  /** Absent when the pull request couldn't be read at start. */
  target: Schema.NullOr(Target),
  title: Schema.String,
  baseSha: Schema.String,
  /** The base branch at start, for the base-changed approval gate; absent before it was saved. */
  baseRef: Schema.optionalKey(Schema.String),
  phase: RunPhase,
  /** Epoch millis of the first start; the deadline and wrap-up count from it. */
  startedAt: Schema.Finite,
  /** Resource acquires so far. Every one after the first is a resume. */
  acquires: Schema.Int,
  steered: Schema.Boolean,
  interrupted: Schema.Boolean,
  /** Why a `failed` run failed. */
  errorCategory: Schema.NullOr(ErrorCategory),
  checkRun: Schema.NullOr(GitHubLink),
  /**
   * Saved before `Start` asks GitHub for the check run, so a check run whose
   * id was never saved, because the response was lost or the runner stopped,
   * is still concluded.
   */
  checkRunAttempted: Schema.Boolean,
  /** Saved when the loop finishes, for `Publish`. */
  outcome: Schema.NullOr(LoopOutcome),
  /** The review standards sources the latest loop applied, for the run record. */
  standardsSources: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Epoch millis the run became final. */
  finishedAt: Schema.NullOr(Schema.Finite),
  /** A run that ends before `Publish` writes its final Postgres row once. */
  finalRowWritten: Schema.Boolean,
  /** Failed attempts at the final row, each followed by a retry. */
  finalRowAttempts: Schema.Int,
  /** The run entity is the only sender of `RunFinished`, once per run. */
  runFinishedSent: Schema.Boolean,
})
export type RunState = typeof RunState.Type

const StateJson = Schema.fromJsonString(RunState)
const RecordJson = Schema.fromJsonString(LoopRecord)

/** The run's storage over its entity's SQLite, keyed by run id. */
export const makeRunStorage = (sql: SqlClient.SqlClient, runId: string) => {
  const ensureTables = Effect.all(
    [
      sql`CREATE TABLE IF NOT EXISTS pr_review_run_state (
        run_id TEXT PRIMARY KEY, state TEXT NOT NULL)`,
      sql`CREATE TABLE IF NOT EXISTS pr_review_run_history (
        run_id TEXT NOT NULL, seq INTEGER NOT NULL, message TEXT NOT NULL,
        PRIMARY KEY (run_id, seq))`,
      sql`CREATE TABLE IF NOT EXISTS pr_review_run_records (
        run_id TEXT NOT NULL, seq INTEGER NOT NULL, record TEXT NOT NULL,
        PRIMARY KEY (run_id, seq))`,
      sql`CREATE TABLE IF NOT EXISTS pr_review_run_cancel_requests (run_id TEXT PRIMARY KEY)`,
      sql`CREATE TABLE IF NOT EXISTS publish_steps (
        run_id TEXT NOT NULL, step TEXT NOT NULL, output TEXT NOT NULL,
        PRIMARY KEY (run_id, step))`,
    ],
    { discard: true },
  )

  const load = sql<{ state: string }>`
    SELECT state FROM pr_review_run_state WHERE run_id = ${runId}`.pipe(
    Effect.flatMap(([row]) =>
      row === undefined
        ? Effect.succeed(Option.none<RunState>())
        : Effect.map(Schema.decodeEffect(StateJson)(row.state), Option.some),
    ),
  )

  const save = (state: RunState) =>
    Effect.flatMap(
      Schema.encodeEffect(StateJson)(state),
      (json) => sql`
        INSERT INTO pr_review_run_state (run_id, state) VALUES (${runId}, ${json})
        ON CONFLICT (run_id) DO UPDATE SET state = excluded.state`,
    )

  /**
   * Moves the state on in one transaction. `move` returns the next state, or
   * `undefined` to leave it as it is; the result is the saved state.
   */
  const update = (move: (state: RunState) => RunState | undefined) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* load
        if (Option.isNone(current)) return Option.none<RunState>()
        const next = move(current.value)
        if (next === undefined) return Option.none<RunState>()
        yield* save(next)
        return Option.some(next)
      }),
    )

  /**
   * Cancels the run in one transaction. A running run becomes `cancelled`
   * (`Cancelled`). A run with no state yet, because its `Start` hasn't saved
   * it, keeps the request for `Start` to find (`Requested`). Anything else
   * has already ended (`Ended`).
   */
  const cancel = (finishedAt: number) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* load
        if (Option.isNone(current)) {
          yield* sql`INSERT INTO pr_review_run_cancel_requests (run_id) VALUES (${runId})
            ON CONFLICT DO NOTHING`
          return "Requested" as const
        }
        if (current.value.phase !== "running") return "Ended" as const
        yield* save({ ...current.value, phase: "cancelled", finishedAt })
        return "Cancelled" as const
      }),
    )

  /**
   * Saves a started run as `running`, in one transaction with the check for a
   * `Cancel` that arrived first; then it is saved as `cancelled` instead.
   * The result is the saved state.
   */
  const begin = (state: RunState) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const [requested] = yield* sql`
          SELECT run_id FROM pr_review_run_cancel_requests WHERE run_id = ${runId}`
        const saved: RunState =
          requested === undefined
            ? { ...state, phase: "running" }
            : { ...state, phase: "cancelled", finishedAt: state.startedAt }
        yield* save(saved)
        return saved
      }),
    )

  /**
   * Commits one step: its history rows and its loop records, in one
   * transaction. A replacement replaces every row. The system message is
   * never stored.
   */
  const commitStep = (history: HistoryChange, records: ReadonlyArray<LoopRecord>) =>
    Effect.gen(function* () {
      const rows = yield* Effect.forEach(
        history.messages.filter((message) => message.role !== "system"),
        encodeMessage,
      )
      const recordRows = yield* Effect.forEach(records, (record) =>
        Schema.encodeEffect(RecordJson)(record),
      )
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (history._tag === "Replaced")
            yield* sql`DELETE FROM pr_review_run_history WHERE run_id = ${runId}`
          const [history_] = yield* sql<{ next: number }>`
            SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM pr_review_run_history WHERE run_id = ${runId}`
          const [record] = yield* sql<{ next: number }>`
            SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM pr_review_run_records WHERE run_id = ${runId}`
          for (const [index, message] of rows.entries())
            yield* sql`INSERT INTO pr_review_run_history (run_id, seq, message)
              VALUES (${runId}, ${history_!.next + index}, ${message})`
          for (const [index, row] of recordRows.entries())
            yield* sql`INSERT INTO pr_review_run_records (run_id, seq, record)
              VALUES (${runId}, ${record!.next + index}, ${row})`
        }),
      )
    })

  /**
   * The history to resume from. A trailing assistant message, left by a
   * snapshot taken mid-step, is dropped from the rows as well.
   */
  const resumeHistory = Effect.gen(function* () {
    const rows = yield* sql<{ seq: number; message: string }>`
      SELECT seq, message FROM pr_review_run_history WHERE run_id = ${runId} ORDER BY seq`
    const messages = yield* Effect.forEach(rows, (row) => decodeMessage(row.message))
    const last = rows.at(-1)
    if (last === undefined || messages.at(-1)?.role !== "assistant") return messages
    yield* sql`DELETE FROM pr_review_run_history WHERE run_id = ${runId} AND seq = ${last.seq}`
    return messages.slice(0, -1)
  })

  /** A `Publish` step's recorded output, if the step was recorded. */
  const publishStep = (step: string) =>
    sql<{ output: string }>`
      SELECT output FROM publish_steps WHERE run_id = ${runId} AND step = ${step}`.pipe(
      Effect.map(([row]) => Option.fromNullishOr(row?.output)),
    )

  /** Records a `Publish` step in its own short transaction. */
  const recordPublishStep = (step: string, output: string) =>
    sql`
      INSERT INTO publish_steps (run_id, step, output) VALUES (${runId}, ${step}, ${output})
      ON CONFLICT (run_id, step) DO UPDATE SET output = excluded.output`.pipe(Effect.asVoid)

  const records = sql<{ record: string }>`
    SELECT record FROM pr_review_run_records WHERE run_id = ${runId} ORDER BY seq`.pipe(
    Effect.flatMap(Effect.forEach((row) => Schema.decodeEffect(RecordJson)(row.record))),
  )

  /**
   * What the run's transcript shows: its state, history and records as
   * committed, read in one transaction. Unlike `resumeHistory` it changes
   * nothing, so a trailing reply stays.
   */
  const transcript = sql.withTransaction(
    Effect.all({
      state: load,
      messages: sql<{ message: string }>`
        SELECT message FROM pr_review_run_history WHERE run_id = ${runId} ORDER BY seq`.pipe(
        Effect.flatMap(Effect.forEach((row) => decodeMessage(row.message))),
      ),
      records,
    }),
  )

  /** Deletes janitor's tables, in one transaction, when the run expires. */
  const drop = sql.withTransaction(
    Effect.all(
      [
        sql`DROP TABLE IF EXISTS pr_review_run_state`,
        sql`DROP TABLE IF EXISTS pr_review_run_history`,
        sql`DROP TABLE IF EXISTS pr_review_run_records`,
        sql`DROP TABLE IF EXISTS pr_review_run_cancel_requests`,
        sql`DROP TABLE IF EXISTS publish_steps`,
      ],
      { discard: true },
    ),
  )

  return {
    ensureTables,
    load,
    save,
    update,
    cancel,
    begin,
    commitStep,
    resumeHistory,
    records,
    transcript,
    publishStep,
    recordPublishStep,
    drop,
  }
}

export type RunStorage = ReturnType<typeof makeRunStorage>
