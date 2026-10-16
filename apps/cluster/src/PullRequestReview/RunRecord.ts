import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { FinalStatus, RunId, Trigger, Verdict } from "@janitor/domain/PullRequestReview/Run"
import { errorFields } from "./Log.ts"
import type { RunStorage } from "./RunStorage.ts"
import { GitHubLink, type PullRequestReviewStore, RecordedFinding } from "./Store.ts"

/**
 * The final Postgres record of a run that reached `Publish` (EFF-1848 point 1,
 * amended by EFF-1930): the row upserted onto its start row, and its
 * findings. `Publish` journals it before the first write, so the run entity
 * can write it again until Postgres takes it, without redoing anything on
 * GitHub.
 */
export const RunRecord = Schema.Struct({
  runId: RunId,
  repositoryId: GitHubRepositoryDatabaseId,
  number: Schema.Int,
  title: Schema.String,
  headSha: Schema.String,
  baseSha: Schema.String,
  trigger: Trigger,
  startedAt: Schema.DateTimeUtcFromString,
  status: FinalStatus,
  verdict: Schema.NullOr(Verdict),
  failedGates: Schema.Array(Schema.String),
  standardsSources: Schema.Json,
  resumeCount: Schema.Int,
  errorCategory: Schema.NullOr(Schema.String),
  finishedAt: Schema.DateTimeUtcFromString,
  review: Schema.NullOr(GitHubLink),
  checkRun: Schema.NullOr(GitHubLink),
  findings: Schema.Array(RecordedFinding),
})
export type RunRecord = typeof RunRecord.Type

const RecordJson = Schema.fromJsonString(RunRecord)

const RECORD_STEP = "record"
/** Set before the first write, so a later one checks for findings that already landed. */
const ATTEMPT_STEP = "record:attempt"

/** Journals the record, once; a record already journalled is kept as it is. */
export const saveRunRecord = (storage: RunStorage, record: RunRecord) =>
  Effect.gen(function* () {
    if (Option.isSome(yield* storage.publishStep(RECORD_STEP))) return
    yield* storage.recordPublishStep(RECORD_STEP, yield* Schema.encodeEffect(RecordJson)(record))
  }).pipe(Effect.orDie)

/** The journalled record, if `Publish` got as far as making it. */
export const loadRunRecord = (storage: RunStorage) =>
  storage.publishStep(RECORD_STEP).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<RunRecord>()),
        onSome: (json) => Effect.map(Schema.decodeEffect(RecordJson)(json), Option.some),
      }),
    ),
    Effect.orDie,
  )

/**
 * Writes the record: the row, then the findings. The findings insert is one
 * statement, so after an earlier attempt they are either all there or none
 * are. `false` when Postgres failed, for the caller to retry.
 */
export const writeRunRecord = (
  store: PullRequestReviewStore["Service"],
  storage: RunStorage,
  record: RunRecord,
) =>
  Effect.gen(function* () {
    const attempted = Option.isSome(yield* storage.publishStep(ATTEMPT_STEP).pipe(Effect.orDie))
    if (!attempted) yield* storage.recordPublishStep(ATTEMPT_STEP, "").pipe(Effect.orDie)
    const { findings, ...row } = record
    yield* store.finish(row)
    if (!attempted || (yield* store.findings(record.runId)).length === 0)
      yield* store.addFindings(record.runId, findings)
    return true
  }).pipe(
    Effect.catchTag("PullRequestReviewStoreError", (error) =>
      Effect.as(
        Effect.logWarning("Couldn't record the PR review run").pipe(
          Effect.annotateLogs(errorFields(error)),
        ),
        false,
      ),
    ),
  )
