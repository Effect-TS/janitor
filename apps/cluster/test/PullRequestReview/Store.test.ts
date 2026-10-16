import { assert, layer } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/sql/SqlClient"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { RunId } from "@janitor/domain/PullRequestReview/Run"
import { PullRequestReviewStore } from "../../src/PullRequestReview/Store.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"

const repositoryId = GitHubRepositoryDatabaseId.make("9300")
const otherRepositoryId = GitHubRepositoryDatabaseId.make("9301")
const thirdRepositoryId = GitHubRepositoryDatabaseId.make("9302")

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO github_installation(access_error,installation_id,account_database_id,account_handle,account_type,repository_selection,status,html_url,projected_sequence) VALUES(NULL,'77','1','test','Organization','selected','active','https://github.com/settings/installations/77',1) ON CONFLICT DO NOTHING`
  yield* sql`INSERT INTO github_repository(repository_id,installation_id,owner,repo,connected,enabled,access,projected_sequence) VALUES(${repositoryId},'77','test','example',TRUE,TRUE,'accessible',1),(${otherRepositoryId},'77','test','other',TRUE,TRUE,'accessible',1),(${thirdRepositoryId},'77','test','third',TRUE,TRUE,'accessible',1) ON CONFLICT DO NOTHING`
})

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 14, 12, minute))

const started = (
  minute: number,
  overrides: { repositoryId?: GitHubRepositoryDatabaseId } = {},
) => ({
  runId: RunId.make(crypto.randomUUID()),
  repositoryId,
  number: 100 + minute,
  title: `Change ${minute}`,
  headSha: `${minute}`.padStart(40, "a"),
  baseSha: "b".repeat(40),
  trigger: { _tag: "Automatic" } as const,
  startedAt: at(minute),
  ...overrides,
})

const finished = (run: ReturnType<typeof started>) => ({
  ...run,
  status: "changes_requested" as const,
  verdict: "request_changes" as const,
  failedGates: ["sensitive_path"],
  standardsSources: { baseSha: run.baseSha, files: [{ path: "AGENTS.md", bytes: 812 }] },
  resumeCount: 1,
  errorCategory: null,
  finishedAt: at(59),
  review: { id: "501", url: "https://github.com/test/example/pull/101#pullrequestreview-501" },
  checkRun: { id: "601", url: "https://github.com/test/example/runs/601" },
})

const finding = (
  severity: "blocking" | "nit",
  outcome: "new" | "carried_over" | "addressed" | "withdrawn",
  line: number,
) => ({
  path: "src/index.ts",
  startLine: line,
  endLine: line + 1,
  severity,
  comment: `Finding on line ${line}`,
  fingerprint: `fp-${line}`,
  outcome,
})

const Services = PullRequestReviewStore.layer.pipe(Layer.provideMerge(MigratedPostgresLayer))

layer(Services, { timeout: "2 minutes" })("PR review store", (it) => {
  it.effect("keeps the per-repository enable flag off until it is set", () =>
    Effect.gen(function* () {
      yield* seed
      const store = yield* PullRequestReviewStore
      assert.isFalse(yield* store.isEnabled(repositoryId))
      yield* store.setEnabled(repositoryId, true)
      assert.isTrue(yield* store.isEnabled(repositoryId))
      assert.isFalse(yield* store.isEnabled(otherRepositoryId))
      yield* store.setEnabled(repositoryId, false)
      assert.isFalse(yield* store.isEnabled(repositoryId))
    }),
  )

  it.effect("upserts the final record onto the start row and counts standing findings", () =>
    Effect.gen(function* () {
      yield* seed
      const store = yield* PullRequestReviewStore
      const run = started(1, { repositoryId: otherRepositoryId })
      yield* store.start(run)
      assert.deepStrictEqual(
        (yield* store.running(otherRepositoryId)).map((summary) => summary.runId),
        [run.runId],
      )

      const findings = [
        finding("blocking", "new", 10),
        finding("blocking", "carried_over", 20),
        finding("nit", "carried_over", 30),
        finding("blocking", "addressed", 40),
        finding("nit", "withdrawn", 50),
        finding("nit", "new", 60),
      ]
      yield* store.finish(finished(run))
      yield* store.addFindings(run.runId, findings)

      assert.deepStrictEqual(yield* store.running(otherRepositoryId), [])
      const page = yield* store.runs(otherRepositoryId, { limit: 10, cursor: Option.none() })
      assert.lengthOf(page.runs, 1)
      assert.deepInclude(page.runs[0]!, {
        runId: run.runId,
        number: run.number,
        title: run.title,
        headSha: run.headSha,
        status: "changes_requested",
        verdict: "request_changes",
        failedGates: ["sensitive_path"],
        resumeCount: 1,
        review: finished(run).review,
        checkRun: finished(run).checkRun,
        blockers: 2,
        nits: 2,
      })
      assert.deepStrictEqual(
        (yield* store.findings(run.runId)).map(({ startLine, severity, outcome }) => ({
          startLine,
          severity,
          outcome,
        })),
        findings.map(({ startLine, severity, outcome }) => ({ startLine, severity, outcome })),
      )
    }),
  )

  it.effect("records a final row without a start row, and skip rows with their reason", () =>
    Effect.gen(function* () {
      yield* seed
      const store = yield* PullRequestReviewStore
      const unstarted = started(2)
      yield* store.finish({ ...finished(unstarted), status: "failed", verdict: null })
      const skipped = started(3)
      yield* store.skip({ ...skipped, reason: "oversized" })

      const page = yield* store.runs(repositoryId, { limit: 10, cursor: Option.none() })
      assert.deepInclude(
        page.runs.find((run) => run.runId === skipped.runId)!,
        {
          status: "skipped",
          reason: "oversized",
          blockers: 0,
          nits: 0,
        },
      )
      assert.deepInclude(
        page.runs.find((run) => run.runId === unstarted.runId)!,
        {
          status: "failed",
          verdict: null,
        },
      )
      assert.deepStrictEqual(yield* store.running(repositoryId), [])
    }),
  )

  it.effect("finds runs by pull request title or number", () =>
    Effect.gen(function* () {
      yield* seed
      const store = yield* PullRequestReviewStore
      const runs = [
        started(20, { repositoryId: thirdRepositoryId }),
        { ...started(21, { repositoryId: thirdRepositoryId }), title: "Fix Flaky retry" },
        { ...started(22, { repositoryId: thirdRepositoryId }), number: 7 },
      ]
      for (const run of runs) yield* store.start(run)
      const found = (search: string) =>
        store
          .runs(thirdRepositoryId, { limit: 10, cursor: Option.none(), search })
          .pipe(Effect.map((page) => page.runs.map((run) => run.runId)))

      assert.deepStrictEqual(yield* found("flaky"), [runs[1]!.runId])
      assert.deepStrictEqual(yield* found("#7"), [runs[2]!.runId])
      assert.deepStrictEqual(yield* found("120"), [runs[0]!.runId])
      assert.deepStrictEqual(yield* found("nothing like it"), [])
    }),
  )

  it.effect("lists a repository's runs newest first across cursor pages", () =>
    Effect.gen(function* () {
      yield* seed
      const store = yield* PullRequestReviewStore
      // Two runs share a start time, so the cursor has to break the tie.
      const runs = [started(10), started(11), started(12), started(12), started(13)]
      for (const run of runs) yield* store.start(run)
      yield* store.start(started(14, { repositoryId: thirdRepositoryId }))
      yield* store.finish(finished(runs[1]!))

      const listed: Array<{ runId: RunId; startedAt: DateTime.Utc }> = []
      let cursor = Option.none<string>()
      for (let pages = 0; pages < 10; pages++) {
        const page = yield* store.runs(repositoryId, { limit: 2, cursor })
        assert.isAtMost(page.runs.length, 2)
        listed.push(...page.runs)
        if (Option.isNone(page.next)) break
        cursor = page.next
      }
      const ours = listed.filter((run) => runs.some(({ runId }) => runId === run.runId))
      assert.strictEqual(new Set(ours.map((run) => run.runId)).size, runs.length)
      assert.deepStrictEqual(
        ours.map((run) => DateTime.toEpochMillis(run.startedAt)),
        [13, 12, 12, 11, 10].map((minute) => DateTime.toEpochMillis(at(minute))),
      )

      assert.sameMembers(
        (yield* store.running(repositoryId))
          .map((run) => run.runId)
          .filter((id) => runs.some(({ runId }) => runId === id)),
        [runs[0]!, runs[2]!, runs[3]!, runs[4]!].map((run) => run.runId),
      )
    }),
  )
})
