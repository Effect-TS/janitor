import { assert, layer } from "@effect/vitest"
import * as Prompt from "effect/ai/Prompt"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { RepositoryNotFound } from "@janitor/domain/GitHub/Repository"
import { RunId } from "@janitor/domain/PullRequestReview/Run"
import {
  PrivateRepository,
  RunNotFound,
  TranscriptExpired,
} from "@janitor/domain/PullRequestReview/Settings"
import { GitHubReadModel } from "../../src/GitHub/ReadModel.ts"
import { PullRequestReviewGroupLayer } from "../../src/Ingress/PullRequestReview.ts"
import type { LoopRecord } from "../../src/PullRequestReview/Agent.ts"
import { RunTranscripts, type TranscriptResult } from "../../src/PullRequestReview/RunEntity.ts"
import { RepositoryDisabler } from "../../src/PullRequestReview/Scheduler.ts"
import { PullRequestReviewStore } from "../../src/PullRequestReview/Store.ts"
import { makeClient } from "../support/Api.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"

const publicRepositoryId = GitHubRepositoryDatabaseId.make("9400")
const privateRepositoryId = GitHubRepositoryDatabaseId.make("9401")
/** A repository whose visibility no inventory or event has stated yet. */
const unseenRepositoryId = GitHubRepositoryDatabaseId.make("9402")
const listedRepositoryId = GitHubRepositoryDatabaseId.make("9403")
const unknownRepositoryId = GitHubRepositoryDatabaseId.make("9499")

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO github_installation(access_error,installation_id,account_database_id,account_handle,account_type,repository_selection,status,html_url,projected_sequence) VALUES(NULL,'77','1','test','Organization','selected','active','https://github.com/settings/installations/77',1) ON CONFLICT DO NOTHING`
  yield* sql`INSERT INTO github_repository(repository_id,installation_id,owner,repo,is_private,connected,enabled,access,projected_sequence) VALUES(${publicRepositoryId},'77','test','public',FALSE,TRUE,TRUE,'accessible',1),(${privateRepositoryId},'77','test','private',TRUE,TRUE,TRUE,'accessible',1),(${unseenRepositoryId},'77','test','unseen',NULL,TRUE,TRUE,'accessible',1),(${listedRepositoryId},'77','test','listed',FALSE,TRUE,TRUE,'accessible',1) ON CONFLICT DO NOTHING`
})

/** The deployment's environment; PR review is available while the API URL and key are set. */
const withKey = {
  PR_REVIEW_AI_API_URL: "https://ai.test/v1",
  PR_REVIEW_AI_API_KEY: "test-key",
}

/** The repositories the disable operation was called for, in order. */
const disabled: Array<GitHubRepositoryDatabaseId> = []

/** What each run's entity answers; a run not listed can't be reached, as when its runner is down. */
const transcripts = new Map<RunId, TranscriptResult>()
const transcriptReader = RunTranscripts.of({
  get: (runId) => {
    const found = transcripts.get(runId)
    return found === undefined
      ? Effect.die(new Error("The run's runner is unreachable"))
      : Effect.succeed(found)
  },
})

const client = Effect.gen(function* () {
  yield* seed
  const services = yield* Effect.context<
    PullRequestReviewStore | GitHubReadModel | SqlClient.SqlClient
  >()
  const store = Context.get(services, PullRequestReviewStore)
  // Like the real operation it turns the flag off; it cancels nothing here.
  const disabler = RepositoryDisabler.of({
    disable: (repositoryId) =>
      Effect.sync(() => disabled.push(repositoryId)).pipe(
        Effect.andThen(store.setEnabled(repositoryId, false)),
      ),
  })
  return (env: Record<string, string>) =>
    makeClient(
      ["pullRequestReview"],
      PullRequestReviewGroupLayer,
      services.pipe(
        Context.add(RepositoryDisabler, disabler),
        Context.add(RunTranscripts, transcriptReader),
        Context.add(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
      ),
    )
})

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 14, 12, minute))

const started = (minute: number) => ({
  runId: RunId.make(crypto.randomUUID()),
  repositoryId: listedRepositoryId,
  number: 100 + minute,
  title: `Change ${minute}`,
  headSha: `${minute}`.padStart(40, "a"),
  baseSha: "b".repeat(40),
  trigger: { _tag: "Automatic" } as const,
  startedAt: at(minute),
})

const encodeMessages = Schema.encodeSync(Schema.Array(Prompt.Message))

const text = (text: string) => Prompt.makePart("text", { text })
const messages = [
  Prompt.makeMessage("user", { content: [text("Review this.")] }),
  Prompt.makeMessage("assistant", { content: [text("Reading a.ts.")] }),
]
const records: Array<LoopRecord> = [
  {
    _tag: "FindingReported",
    finding: {
      path: "src/a.ts",
      startLine: 3,
      endLine: 3,
      severity: "blocking",
      comment: "Off by one.",
    },
  },
]

const Services = Layer.mergeAll(PullRequestReviewStore.layer, GitHubReadModel.layer).pipe(
  Layer.provideMerge(MigratedPostgresLayer),
)

layer(Services, { timeout: "2 minutes" })("PullRequestReviewGroup", (it) => {
  it.effect("reports the deployment status, and the flag is off until enabled", () =>
    Effect.gen(function* () {
      const make = yield* client
      const api = yield* make(withKey)
      const params = { repositoryId: publicRepositoryId }
      assert.deepStrictEqual(yield* api.pullRequestReview.getSettings({ params }), {
        repositoryId: publicRepositoryId,
        enabled: false,
        deployment: { available: true, model: "openai/gpt-6.1-sol", reasoningEffort: "medium" },
      })
      const enabled = yield* api.pullRequestReview.updateSettings({
        params,
        payload: { enabled: true },
      })
      assert.isTrue(enabled.enabled)
      assert.isTrue((yield* api.pullRequestReview.getSettings({ params })).enabled)

      const unavailable = yield* make({ PR_REVIEW_AI_REASONING_EFFORT: "high" })
      assert.deepStrictEqual(
        (yield* unavailable.pullRequestReview.getSettings({ params })).deployment,
        { available: false, model: "openai/gpt-6.1-sol", reasoningEffort: "high" },
      )
    }),
  )

  it.effect("refuses unknown repositories and private repositories", () =>
    Effect.gen(function* () {
      const api = yield* (yield* client)(withKey)
      const unknown = { params: { repositoryId: unknownRepositoryId } }
      assert.deepStrictEqual(
        yield* api.pullRequestReview.getSettings(unknown).pipe(Effect.flip),
        new RepositoryNotFound({ repositoryId: unknownRepositoryId }),
      )
      assert.deepStrictEqual(
        yield* api.pullRequestReview
          .updateSettings({ ...unknown, payload: { enabled: true } })
          .pipe(Effect.flip),
        new RepositoryNotFound({ repositoryId: unknownRepositoryId }),
      )
      for (const repositoryId of [privateRepositoryId, unseenRepositoryId]) {
        assert.deepStrictEqual(
          yield* api.pullRequestReview
            .updateSettings({ params: { repositoryId }, payload: { enabled: true } })
            .pipe(Effect.flip),
          new PrivateRepository({ repositoryId }),
        )
        assert.isFalse(
          (yield* api.pullRequestReview.getSettings({ params: { repositoryId } })).enabled,
        )
      }
    }),
  )

  it.effect("disabling goes through the disable operation", () =>
    Effect.gen(function* () {
      const api = yield* (yield* client)(withKey)
      const params = { repositoryId: publicRepositoryId }
      yield* api.pullRequestReview.updateSettings({ params, payload: { enabled: true } })
      disabled.length = 0
      const off = yield* api.pullRequestReview.updateSettings({
        params,
        payload: { enabled: false },
      })
      assert.isFalse(off.enabled)
      assert.deepStrictEqual(disabled, [publicRepositoryId])
    }),
  )

  it.effect("lists runs newest first a page at a time, with counts and skip reasons", () =>
    Effect.gen(function* () {
      const api = yield* (yield* client)(withKey)
      const store = yield* PullRequestReviewStore
      // One more run than the page size, as on Activity.
      const runs = Array.from({ length: 51 }, (_, minute) => started(minute))
      for (const run of runs.slice(0, 49)) yield* store.start(run)
      const reviewed = runs[49]!
      yield* store.finish({
        ...reviewed,
        trigger: { _tag: "Rerun", invoker: "octocat", commentId: "42" },
        status: "changes_requested",
        verdict: "request_changes",
        failedGates: ["sensitive_path"],
        standardsSources: {},
        resumeCount: 0,
        errorCategory: null,
        finishedAt: at(55),
        review: {
          id: "501",
          url: "https://github.com/test/listed/pull/149#pullrequestreview-501",
        },
        checkRun: { id: "601", url: "https://github.com/test/listed/runs/601" },
      })
      yield* store.addFindings(reviewed.runId, [
        ...[
          ["blocking", "new"],
          ["blocking", "addressed"],
          ["nit", "carried_over"],
          ["nit", "new"],
        ].map(([severity, outcome], line) => ({
          path: "src/index.ts",
          startLine: line + 1,
          endLine: line + 1,
          severity: severity as "blocking" | "nit",
          comment: "A finding",
          fingerprint: `fp-${line}`,
          outcome: outcome as "new" | "addressed" | "carried_over",
        })),
      ])
      const skipped = runs[50]!
      yield* store.skip({ ...skipped, reason: "oversized" })

      const params = { repositoryId: listedRepositoryId }
      const first = yield* api.pullRequestReview.listRuns({ params, query: {} })
      assert.deepStrictEqual(
        first.runs.map((run) => run.runId),
        runs
          .slice(1)
          .reverse()
          .map((run) => run.runId),
      )
      assert.deepInclude(first.runs[0], {
        number: skipped.number,
        headSha: skipped.headSha,
        status: "skipped",
        reason: "oversized",
        trigger: { _tag: "Automatic" },
      })
      assert.deepInclude(first.runs[1], {
        number: reviewed.number,
        title: reviewed.title,
        status: "changes_requested",
        trigger: { _tag: "Rerun", invoker: "octocat", commentId: "42" },
        failedGates: ["sensitive_path"],
        blockers: 1,
        nits: 2,
        review: {
          id: "501",
          url: "https://github.com/test/listed/pull/149#pullrequestreview-501",
        },
        checkRun: { id: "601", url: "https://github.com/test/listed/runs/601" },
      })
      assert.isNotNull(first.runs[1]!.finishedAt)
      assert.deepInclude(first.runs[2], { status: "running", finishedAt: null })
      assert.isNotNull(first.cursor)

      const second = yield* api.pullRequestReview.listRuns({
        params,
        query: { cursor: first.cursor! },
      })
      assert.deepStrictEqual(
        second.runs.map((run) => run.runId),
        [runs[0]!.runId],
      )
      assert.isNull(second.cursor)
    }),
  )

  it.effect("serves a run's transcript, as far as it has been committed", () =>
    Effect.gen(function* () {
      const api = yield* (yield* client)(withKey)
      const run = { ...started(40), repositoryId: publicRepositoryId }
      yield* (yield* PullRequestReviewStore).start(run)
      transcripts.set(run.runId, {
        _tag: "Available",
        resumeCount: 1,
        steered: true,
        interrupted: false,
        errorCategory: null,
        expiresAt: null,
        messages,
        records,
      })

      const body = yield* api.pullRequestReview.getRunTranscript({
        params: { repositoryId: publicRepositoryId, runId: run.runId },
      })
      assert.deepInclude(body.run, {
        runId: run.runId,
        number: run.number,
        title: run.title,
        status: "running",
      })
      assert.deepInclude(body, {
        resumeCount: 1,
        steered: true,
        interrupted: false,
        errorCategory: null,
        expiresAt: null,
        records,
      })
      assert.deepStrictEqual(encodeMessages(body.messages), encodeMessages(messages))
    }),
  )

  it.effect("has no transcript for unknown, foreign, expired or unreachable runs", () =>
    Effect.gen(function* () {
      const api = yield* (yield* client)(withKey)
      const store = yield* PullRequestReviewStore
      const expired = { ...started(41), repositoryId: publicRepositoryId }
      const unreachable = { ...started(42), repositoryId: publicRepositoryId }
      yield* store.start(expired)
      yield* store.start(unreachable)
      transcripts.set(expired.runId, { _tag: "Expired" })
      const transcript = (repositoryId: GitHubRepositoryDatabaseId, runId: RunId) =>
        api.pullRequestReview.getRunTranscript({ params: { repositoryId, runId } })
      const unknownRunId = RunId.make(crypto.randomUUID())

      assert.deepStrictEqual(
        yield* transcript(unknownRepositoryId, expired.runId).pipe(Effect.flip),
        new RepositoryNotFound({ repositoryId: unknownRepositoryId }),
      )
      // Looked up in the repository first, so its entity is never asked.
      assert.deepStrictEqual(
        yield* transcript(publicRepositoryId, unknownRunId).pipe(Effect.flip),
        new RunNotFound({ runId: unknownRunId }),
      )
      assert.deepStrictEqual(
        yield* transcript(listedRepositoryId, expired.runId).pipe(Effect.flip),
        new RunNotFound({ runId: expired.runId }),
      )
      assert.deepStrictEqual(
        yield* transcript(publicRepositoryId, expired.runId).pipe(Effect.flip),
        new TranscriptExpired({ runId: expired.runId }),
      )
      // An unreachable runner is an infrastructure failure, so it dies.
      const exit = yield* Effect.exit(transcript(publicRepositoryId, unreachable.runId))
      assert.isTrue(Exit.isFailure(exit))
    }),
  )
})
