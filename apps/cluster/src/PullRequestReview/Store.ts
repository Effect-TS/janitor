import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
import type * as SqlError from "effect/sql/SqlError"
import type * as Statement from "effect/sql/Statement"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { Finding, FindingOutcome } from "@janitor/domain/PullRequestReview/Finding"
import {
  FinalStatus,
  RunId,
  SkipReason,
  Trigger,
  Verdict,
} from "@janitor/domain/PullRequestReview/Run"
import { describeError } from "../SqlErrors.ts"

/**
 * The Postgres record of PR review: the per-repository enable flag and a
 * read-only row per run with its findings. Runs never read it to make
 * progress; it serves the web app and audits.
 */

export class PullRequestReviewStoreError extends Schema.TaggedError<PullRequestReviewStoreError>()(
  "PullRequestReviewStoreError",
  { operation: Schema.String, message: Schema.String },
) {}

const wrap =
  (operation: string) =>
  <A, R>(effect: Effect.Effect<A, SqlError.SqlError | Schema.SchemaError, R>) =>
    effect.pipe(
      Effect.mapError(
        (error) => new PullRequestReviewStoreError({ operation, message: describeError(error) }),
      ),
    )

/** A GitHub object janitor created for a run: its review or its check run. */
export const GitHubLink = Schema.Struct({ id: Schema.String, url: Schema.String })
export type GitHubLink = typeof GitHubLink.Type

/** What a run is about, known when it starts. */
export interface StartedRun {
  readonly runId: RunId
  readonly repositoryId: GitHubRepositoryDatabaseId
  readonly number: number
  readonly title: string
  readonly headSha: string
  readonly baseSha: string
  readonly trigger: Trigger
  readonly startedAt: DateTime.Utc
}

export interface SkippedRun extends StartedRun {
  readonly reason: SkipReason
}

/** The final record, complete on its own so it can be written without a start row. */
export interface FinishedRun extends StartedRun {
  readonly status: FinalStatus
  readonly verdict: Verdict | null
  readonly failedGates: ReadonlyArray<string>
  /** The review standards sources that applied (EFF-1647). */
  readonly standardsSources: Schema.Json
  readonly resumeCount: number
  readonly errorCategory: string | null
  readonly finishedAt: DateTime.Utc
  readonly review: GitHubLink | null
  readonly checkRun: GitHubLink | null
}

/** A finding as recorded for a run, with its fingerprint and what became of it. */
export const RecordedFinding = Schema.Struct({
  ...Finding.fields,
  fingerprint: Schema.String,
  outcome: FindingOutcome,
})
export type RecordedFinding = typeof RecordedFinding.Type

const summaryFields = {
  runId: RunId,
  repositoryId: GitHubRepositoryDatabaseId,
  number: Schema.Int,
  title: Schema.String,
  headSha: Schema.String,
  baseSha: Schema.String,
  trigger: Trigger,
  verdict: Schema.NullOr(Verdict),
  failedGates: Schema.Array(Schema.String),
  resumeCount: Schema.Int,
  errorCategory: Schema.NullOr(Schema.String),
  review: Schema.NullOr(GitHubLink),
  checkRun: Schema.NullOr(GitHubLink),
  startedAt: Schema.DateTimeUtcFromDate,
  finishedAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
  /** Blocking findings that still stand: new or carried over. */
  blockers: Schema.Int,
  /** Nits that still stand: new or carried over. */
  nits: Schema.Int,
}

/** One row of a repository's runs list; a skipped run carries its reason. */
export const RunSummary = Schema.Union([
  Schema.Struct({
    ...summaryFields,
    status: Schema.Union([Schema.Literal("running"), FinalStatus]),
  }),
  Schema.Struct({ ...summaryFields, status: Schema.Literal("skipped"), reason: SkipReason }),
])
export type RunSummary = typeof RunSummary.Type

export interface RunPage {
  readonly runs: ReadonlyArray<RunSummary>
  /** Pass back as `cursor` for the next, older page. */
  readonly next: Option.Option<string>
}

const FailedGatesJson = Schema.fromJsonString(Schema.Array(Schema.String))
const JsonText = Schema.fromJsonString(Schema.Json)

const triggerColumns = (trigger: Trigger) =>
  trigger._tag === "Automatic"
    ? { trigger: "automatic", invoker_login: null, invoker_comment_id: null }
    : {
        trigger: trigger._tag === "Rerun" ? "rerun" : "forced",
        invoker_login: trigger.invoker,
        invoker_comment_id: trigger.commentId,
      }

/** The columns every run row has, known when the run starts. */
const startColumns = (run: StartedRun) => ({
  run_id: run.runId,
  repository_id: run.repositoryId,
  pull_request_number: run.number,
  pull_request_title: run.title,
  head_sha: run.headSha,
  base_sha: run.baseSha,
  ...triggerColumns(run.trigger),
  started_at: DateTime.toDateUtc(run.startedAt),
})

export class PullRequestReviewStore extends Context.Service<
  PullRequestReviewStore,
  {
    /** Whether the repository has PR review enabled; off until someone enables it. */
    readonly isEnabled: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<boolean, PullRequestReviewStoreError>
    readonly setEnabled: (
      repositoryId: GitHubRepositoryDatabaseId,
      enabled: boolean,
    ) => Effect.Effect<void, PullRequestReviewStoreError>
    /** Writes the `running` row. A row already recorded for the run is left as it is. */
    readonly start: (run: StartedRun) => Effect.Effect<void, PullRequestReviewStoreError>
    /** Writes a `skipped` row for an oversized or run-cap skip. */
    readonly skip: (run: SkippedRun) => Effect.Effect<void, PullRequestReviewStoreError>
    /** Upserts the final record onto the run's start row, or inserts it if there is none. */
    readonly finish: (run: FinishedRun) => Effect.Effect<void, PullRequestReviewStoreError>
    readonly addFindings: (
      runId: RunId,
      findings: ReadonlyArray<RecordedFinding>,
    ) => Effect.Effect<void, PullRequestReviewStoreError>
    /** A run's findings in the order they were recorded. */
    readonly findings: (
      runId: RunId,
    ) => Effect.Effect<ReadonlyArray<RecordedFinding>, PullRequestReviewStoreError>
    /** A repository's runs, newest first, one page at a time. */
    readonly runs: (
      repositoryId: GitHubRepositoryDatabaseId,
      query: { readonly limit: number; readonly cursor: Option.Option<string> },
    ) => Effect.Effect<RunPage, PullRequestReviewStoreError>
    /** A repository's runs that are still running, newest first. */
    readonly running: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<ReadonlyArray<RunSummary>, PullRequestReviewStoreError>
  }
>()("@janitor/cluster/PullRequestReview/Store/PullRequestReviewStore", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    /** A row already recorded for the run is left as it is. */
    const insertStarted = (columns: Record<string, unknown>) =>
      sql`INSERT INTO pr_review_runs ${sql.insert(columns)} ON CONFLICT (run_id) DO NOTHING`.pipe(
        Effect.asVoid,
      )

    const summaries = (
      repositoryId: GitHubRepositoryDatabaseId,
      filter: Statement.Fragment,
      limit: number | null,
    ) =>
      sql`
        SELECT r.run_id AS "runId", r.repository_id AS "repositoryId", r.pull_request_number AS number,
          r.pull_request_title AS title, r.head_sha AS "headSha", r.base_sha AS "baseSha",
          CASE r.trigger WHEN 'automatic' THEN jsonb_build_object('_tag', 'Automatic')
            ELSE jsonb_build_object('_tag', CASE r.trigger WHEN 'rerun' THEN 'Rerun' ELSE 'Forced' END,
              'invoker', r.invoker_login, 'commentId', r.invoker_comment_id) END AS trigger,
          r.status, r.skip_reason AS reason, r.verdict, r.failed_gates AS "failedGates",
          r.resume_count AS "resumeCount", r.error_category AS "errorCategory",
          CASE WHEN r.review_id IS NULL THEN NULL
            ELSE jsonb_build_object('id', r.review_id, 'url', r.review_url) END AS review,
          CASE WHEN r.check_run_id IS NULL THEN NULL
            ELSE jsonb_build_object('id', r.check_run_id, 'url', r.check_run_url) END AS "checkRun",
          r.started_at AS "startedAt", r.finished_at AS "finishedAt",
          f.blockers, f.nits
        FROM pr_review_runs r
        CROSS JOIN LATERAL (
          SELECT
            (count(*) FILTER (WHERE severity = 'blocking' AND outcome IN ('new', 'carried_over')))::int AS blockers,
            (count(*) FILTER (WHERE severity = 'nit' AND outcome IN ('new', 'carried_over')))::int AS nits
          FROM pr_review_findings WHERE run_id = r.run_id
        ) f
        WHERE r.repository_id = ${repositoryId} AND ${filter}
        ORDER BY r.started_at DESC, r.run_id DESC
        LIMIT ${limit}`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RunSummary))))

    return {
      isEnabled: (repositoryId) =>
        sql<{ enabled: boolean }>`
          SELECT enabled FROM pr_review_repository WHERE repository_id = ${repositoryId}`.pipe(
          Effect.map((rows) => rows[0]?.enabled ?? false),
          wrap("isEnabled"),
        ),
      setEnabled: (repositoryId, enabled) =>
        sql`
          INSERT INTO pr_review_repository (repository_id, enabled) VALUES (${repositoryId}, ${enabled})
          ON CONFLICT (repository_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = CLOCK_TIMESTAMP()`.pipe(
          Effect.asVoid,
          wrap("setEnabled"),
        ),
      start: (run) =>
        insertStarted({ ...startColumns(run), status: "running" }).pipe(wrap("start")),
      skip: (run) =>
        insertStarted({ ...startColumns(run), status: "skipped", skip_reason: run.reason }).pipe(
          wrap("skip"),
        ),
      finish: (run) =>
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO pr_review_runs ${sql.insert({
              ...startColumns(run),
              status: run.status,
              verdict: run.verdict,
              failed_gates: yield* Schema.encodeEffect(FailedGatesJson)(run.failedGates),
              standards_sources: yield* Schema.encodeEffect(JsonText)(run.standardsSources),
              finished_at: DateTime.toDateUtc(run.finishedAt),
              resume_count: run.resumeCount,
              error_category: run.errorCategory,
              review_id: run.review?.id ?? null,
              review_url: run.review?.url ?? null,
              check_run_id: run.checkRun?.id ?? null,
              check_run_url: run.checkRun?.url ?? null,
            })}
            ON CONFLICT (run_id) DO UPDATE SET
              pull_request_title = EXCLUDED.pull_request_title, head_sha = EXCLUDED.head_sha,
              base_sha = EXCLUDED.base_sha, status = EXCLUDED.status, skip_reason = NULL,
              verdict = EXCLUDED.verdict, failed_gates = EXCLUDED.failed_gates,
              standards_sources = EXCLUDED.standards_sources, finished_at = EXCLUDED.finished_at,
              resume_count = EXCLUDED.resume_count, error_category = EXCLUDED.error_category,
              review_id = EXCLUDED.review_id, review_url = EXCLUDED.review_url,
              check_run_id = EXCLUDED.check_run_id, check_run_url = EXCLUDED.check_run_url`
        }).pipe(wrap("finish")),
      addFindings: (runId, findings) =>
        findings.length === 0
          ? Effect.void
          : sql`
              INSERT INTO pr_review_findings ${sql.insert(
                findings.map((finding) => ({
                  run_id: runId,
                  path: finding.path,
                  start_line: finding.startLine,
                  end_line: finding.endLine,
                  severity: finding.severity,
                  comment: finding.comment,
                  fingerprint: finding.fingerprint,
                  outcome: finding.outcome,
                })),
              )}`.pipe(Effect.asVoid, wrap("addFindings")),
      findings: (runId) =>
        sql`
          SELECT path, start_line AS "startLine", end_line AS "endLine", severity, comment,
            fingerprint, outcome
          FROM pr_review_findings WHERE run_id = ${runId}::uuid ORDER BY finding_id`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RecordedFinding))),
          wrap("findings"),
        ),
      runs: (repositoryId, query) =>
        Effect.gen(function* () {
          const cursor = yield* Option.match(query.cursor, {
            onNone: () => Effect.succeed(null),
            onSome: Schema.decodeUnknownEffect(RunId),
          })
          // The cursor is the last run on the previous page; its start time is read back
          // from the row so no precision is lost.
          const rows = yield* summaries(
            repositoryId,
            cursor === null
              ? sql`TRUE`
              : sql`(r.started_at, r.run_id) < (
                  SELECT started_at, run_id FROM pr_review_runs WHERE run_id = ${cursor}::uuid)`,
            query.limit + 1,
          )
          const runs = rows.slice(0, query.limit)
          const last = runs.at(-1)
          return {
            runs,
            next: rows.length > query.limit && last ? Option.some(last.runId) : Option.none(),
          } satisfies RunPage
        }).pipe(wrap("runs")),
      running: (repositoryId) =>
        summaries(repositoryId, sql`r.status = 'running'`, null).pipe(wrap("running")),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
