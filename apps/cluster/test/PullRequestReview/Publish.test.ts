import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, layer } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/sql/SqlClient"
import { GitHubCommitSha } from "@janitor/domain/GitHub/Id"
import type { Finding, Severity } from "@janitor/domain/PullRequestReview/Finding"
import { fingerprint } from "@janitor/domain/PullRequestReview/Fingerprint"
import { inlineComment } from "@janitor/domain/PullRequestReview/Render"
import { RunId } from "@janitor/domain/PullRequestReview/Run"
import type { GitHubRequest } from "../../src/GitHub/Transport.ts"
import type { LoopRecord } from "../../src/PullRequestReview/Agent.ts"
import { RunPublisherLayer } from "../../src/PullRequestReview/Publish.ts"
import { PullRequestReviewStore } from "../../src/PullRequestReview/Store.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import { APP_LOGIN, type FakeThreadComment } from "./fakeGitHub.ts"
import { HEAD, makeRunHarnessWith, type RunHarness } from "./runHarness.ts"
import { repositoryId, seedRepositories } from "./support.ts"

/** The deployment's environment; the gate is on while the API URL and key are set. */
const env: Record<string, string> = {
  PR_REVIEW_AI_API_URL: "https://ai.test/v1",
  PR_REVIEW_AI_API_KEY: "test-key",
}

const Services = Layer.mergeAll(PullRequestReviewStore.layer, NodeServices.layer).pipe(
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  Layer.provideMerge(MigratedPostgresLayer),
)

const newRunId = () => RunId.make(crypto.randomUUID())

/** Where the head goes when someone pushes during a run. */
const MOVED = GitHubCommitSha.make("d".repeat(40))

/** `src/a.ts` at the head: line 2 is the only added line. */
const lines = [
  "export const a = 1",
  "export const b = a + 1",
  "export const c = 3",
  "export { a, b, c }",
]
const patch =
  "@@ -1,3 +1,4 @@\n export const a = 1\n+export const b = a + 1\n export const c = 3\n export { a, b, c }"

const blocking: Finding = {
  path: "src/a.ts",
  startLine: 2,
  endLine: 2,
  severity: "blocking",
  comment: "`b` is off by one.",
}

/** Pull request 7 at `headSha`, changing `src/a.ts` and any `extra` paths. */
const putPullRequest = (harness: RunHarness, headSha: string, extra: ReadonlyArray<string> = []) =>
  harness.github.put({
    number: 7,
    title: "Change",
    state: "open",
    labels: [],
    pullRequest: {
      headSha,
      files: [
        { filename: "src/a.ts", status: "modified", patch, additions: 1, deletions: 0 },
        ...extra.map((filename) => ({
          filename,
          status: "added",
          patch: "@@ -0,0 +1 @@\n+x",
          additions: 1,
          deletions: 0,
        })),
      ],
    },
  })

/**
 * Starts a run, commits `records` in one step and ends the loop: completed,
 * or failed on the provider so the review is partial. Returns once `Publish`
 * has been handled.
 */
const reviewWith = (
  harness: RunHarness,
  records: ReadonlyArray<LoopRecord>,
  end: "completed" | "partial" = "completed",
) =>
  Effect.gen(function* () {
    const runId = newRunId()
    yield* harness.start(runId)
    const session = harness.agent.last
    yield* session.step({ history: { _tag: "Appended", messages: [] }, records })
    yield* end === "completed" ? session.complete("Reviewed.") : session.fail("provider down")
    yield* harness.until(
      Effect.sync(() => harness.finishedCount(runId) > 0),
      "RunFinished",
    )
    return runId
  })

/** `reviewWith` for a run that reports `findings` only. */
const review = (
  harness: RunHarness,
  findings: ReadonlyArray<Finding>,
  end: "completed" | "partial" = "completed",
) =>
  reviewWith(
    harness,
    findings.map((finding) => ({ _tag: "FindingReported", finding })),
    end,
  )

/** The SHA an earlier run reviewed. */
const EARLIER_SHA = "e".repeat(40)

/** Janitor's review from an earlier run, as `PRR_earlier`. */
const putEarlierReview = (harness: RunHarness, state: "CHANGES_REQUESTED" | "COMMENTED") =>
  harness.github.reviews.push({
    id: "PRR_earlier",
    databaseId: 800,
    author: APP_LOGIN,
    byApp: true,
    state,
    body: "Earlier.",
    commitOID: EARLIER_SHA,
  })

/**
 * One of janitor's threads from an earlier run, on line 2 of `src/a.ts`,
 * whose code is unchanged at the head. `after` follows janitor's root comment.
 */
const putEarlierThread = (
  harness: RunHarness,
  options: {
    readonly id: string
    readonly severity: Severity
    readonly after?: ReadonlyArray<Omit<FakeThreadComment, "id">>
    /** The login that resolved it, if anyone did. */
    readonly resolvedBy?: string
  },
) =>
  Effect.gen(function* () {
    const marked = yield* fingerprint("src/a.ts", [lines[1]!])
    harness.github.threads.push({
      id: options.id,
      path: "src/a.ts",
      line: 2,
      startLine: null,
      side: "RIGHT",
      isResolved: options.resolvedBy !== undefined,
      isOutdated: false,
      resolvedBy: options.resolvedBy ?? null,
      comments: [
        {
          id: `${options.id}_root`,
          author: APP_LOGIN,
          byApp: true,
          body: inlineComment({
            comment: blocking.comment,
            fingerprint: marked,
            severity: options.severity,
          }),
          createdAt: "2026-10-13T10:00:00Z",
          reviewId: "PRR_earlier",
        },
        ...(options.after ?? []).map((comment, index) => ({
          ...comment,
          id: `${options.id}_${index}`,
        })),
      ],
    })
  })

/** The comments janitor added to a thread after its first `before`. */
const janitorAdded = (harness: RunHarness, threadId: string, before: number) =>
  harness.github.threads
    .find((thread) => thread.id === threadId)!
    .comments.slice(before)
    .filter((comment) => comment.byApp)

/** The pull request author, without write access in the fake. */
const AUTHOR = "octocat"

/** Janitor's submitted reviews, leaving out any still pending. */
const submitted = (harness: RunHarness) =>
  harness.github.reviews.filter((review) => review.byApp && review.state !== "PENDING")

const count = (harness: RunHarness, write: string) =>
  harness.github.writeNames.filter((name) => name === write).length

/**
 * Lets the next `write` reach GitHub, then never answers, as when the runner
 * stops mid-request. The result tells whether it has landed.
 */
const cutOff = (harness: RunHarness, write: string) =>
  Effect.sync(() => {
    let landed = false
    harness.github.intercept = (request) =>
      harness.github.writeName(request) !== write
        ? Effect.succeed(undefined)
        : Effect.gen(function* () {
            harness.github.intercept = () => Effect.succeed(undefined)
            harness.github.respond(request)
            landed = true
            return yield* Effect.never
          })
    return Effect.sync(() => landed)
  })

const run = <A, E, R>(test: (harness: RunHarness) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* seedRepositories(repositoryId)
    const harness = yield* makeRunHarnessWith({ publisher: RunPublisherLayer })
    putPullRequest(harness, HEAD).file(HEAD, "src/a.ts", lines.join("\n"))
    return yield* test(harness)
  }).pipe(Effect.scoped)

layer(Services, { timeout: "2 minutes" })("PR review Publish batch", (it) => {
  it.effect(
    "posts a review pinned to the reviewed head, then the check run, the run record and RunFinished",
    () =>
      run((harness) =>
        Effect.gen(function* () {
          harness.agent.standardsSources = ["protocol", "rubric", "AGENTS.md"]
          const runId = newRunId()
          yield* harness.start(runId)
          const started = yield* harness.row(runId)
          yield* harness.agent.last.step({
            history: { _tag: "Appended", messages: [] },
            records: [{ _tag: "FindingReported", finding: blocking }],
          })
          yield* harness.agent.last.complete("Reviewed.")
          yield* harness.drain

          assert.deepStrictEqual(harness.github.writeNames, [
            "createCheckRun",
            "addPullRequestReview",
            "addPullRequestReviewThread",
            "submitPullRequestReview",
            "updateCheckRun",
          ])
          const created = harness.github.requests.find(
            (request) => harness.github.writeName(request) === "addPullRequestReview",
          )!
          assert.strictEqual(harness.github.mutationInput(created)?.commitOID, HEAD)
          assert.deepStrictEqual(
            submitted(harness).map((review) => [review.state, review.commitOID]),
            [["CHANGES_REQUESTED", HEAD]],
          )
          assert.deepStrictEqual(
            harness.github.threads.map((thread) => [thread.path, thread.line]),
            [["src/a.ts", 2]],
          )
          assert.deepStrictEqual(
            harness.github.checkRuns.map((check) => [
              check.headSha,
              check.status,
              check.conclusion,
            ]),
            [[HEAD, "completed", "failure"]],
          )
          // The new blocking thread is what the check run reports.
          assert.strictEqual(harness.github.checkRuns[0]?.output.title, "1 blocking finding")

          // The final record lands on the start row.
          const row = yield* harness.row(runId)
          assert.strictEqual(row?.status, "changes_requested")
          assert.strictEqual(row?.verdict, "request_changes")
          assert.deepStrictEqual(row?.startedAt, started?.startedAt)
          assert.isNotNull(row?.finishedAt)
          assert.isNotNull(row?.review)
          assert.deepStrictEqual(row?.checkRun, {
            id: "9000",
            url: "https://github.com/checks/9000",
          })
          assert.deepStrictEqual(yield* harness.findings(runId), [
            {
              ...blocking,
              fingerprint: yield* fingerprint("src/a.ts", [lines[1]!]),
              outcome: "new",
            },
          ])
          // The review standards sources the loop applied are kept with the record.
          const sql = yield* SqlClient.SqlClient
          const [record] = yield* sql<{ sources: unknown }>`
            SELECT standards_sources AS sources FROM pr_review_runs WHERE run_id = ${runId}`
          assert.deepStrictEqual(record?.sources, ["protocol", "rubric", "AGENTS.md"])
          assert.strictEqual(harness.finishedCount(runId), 1)
        }),
      ),
  )

  const crashes: ReadonlyArray<{
    readonly step: string
    /** Sets up the crash; the result tells when it has happened. */
    readonly crash: (harness: RunHarness) => Effect.Effect<Effect.Effect<boolean>>
    /** Whether the runner stops, or only the handler fails and is retried. */
    readonly restart: boolean
  }> = [
    {
      step: "creating the pending review",
      crash: (harness) => cutOff(harness, "addPullRequestReview"),
      restart: true,
    },
    {
      step: "adding a thread",
      crash: (harness) => cutOff(harness, "addPullRequestReviewThread"),
      restart: true,
    },
    {
      step: "submitting the review",
      crash: (harness) => cutOff(harness, "submitPullRequestReview"),
      restart: true,
    },
    {
      step: "updating the check run",
      crash: (harness) => cutOff(harness, "updateCheckRun"),
      restart: true,
    },
    {
      step: "recording the findings",
      crash: (harness) =>
        Effect.sync(() => {
          harness.postgres.cutOffFindings = true
          return Effect.sync(() => !harness.postgres.cutOffFindings)
        }),
      restart: true,
    },
    {
      step: "sending RunFinished",
      crash: (harness) => Effect.as(harness.failNextSend("RunFinished"), Effect.succeed(true)),
      restart: false,
    },
  ]

  for (const { step, crash, restart } of crashes)
    it.effect(`a crash while ${step} replays without posting anything twice`, () =>
      run((harness) =>
        Effect.gen(function* () {
          const crashed = yield* crash(harness)
          const runId = newRunId()
          yield* harness.start(runId)
          yield* harness.agent.last.step({
            history: { _tag: "Appended", messages: [] },
            records: [{ _tag: "FindingReported", finding: blocking }],
          })
          yield* harness.agent.last.complete("Reviewed.")
          if (restart) {
            yield* harness.waitFor(crashed, `the crash while ${step}`)
            yield* harness.restart
          }
          yield* harness.until(
            Effect.sync(() => harness.finishedCount(runId) > 0),
            "RunFinished",
          )

          // A write that landed before the crash is found on GitHub, not made again.
          for (const create of [
            "addPullRequestReview",
            "addPullRequestReviewThread",
            "submitPullRequestReview",
          ])
            assert.strictEqual(count(harness, create), 1, create)
          // Replaying skips the recorded steps, so the run's own pending review is never cleared.
          assert.strictEqual(count(harness, "deletePullRequestReview"), 0)
          assert.deepStrictEqual(
            harness.github.reviews.map((review) => [review.state, review.commitOID]),
            [["CHANGES_REQUESTED", HEAD]],
          )
          assert.strictEqual(harness.github.threads.length, 1)
          assert.strictEqual(harness.github.threads[0]!.comments.length, 1)
          assert.deepStrictEqual(
            harness.github.checkRuns.map((check) => [check.status, check.conclusion]),
            [["completed", "failure"]],
          )
          assert.strictEqual((yield* harness.row(runId))?.status, "changes_requested")
          assert.strictEqual((yield* harness.findings(runId)).length, 1)
          assert.strictEqual(harness.finishedCount(runId), 1)
        }),
      ),
    )

  it.effect(
    "a 422 on submit retries once with the inline comments in the body, then records the failure without throwing",
    () =>
      run((harness) =>
        Effect.gen(function* () {
          /** Every review submission GitHub refused: its body and how many inline comments it carried. */
          const refused: Array<{ readonly body: string; readonly inline: number }> = []
          harness.github.intercept = (request) =>
            Effect.sync(() => {
              const name = harness.github.writeName(request)
              const input = harness.github.mutationInput(request)
              // A pending review submitted, or a review created already submitted.
              const submits =
                name === "submitPullRequestReview" ||
                (name === "addPullRequestReview" && input?.event !== undefined)
              if (!submits) return undefined
              const pending = harness.github.threads.filter((thread) =>
                thread.comments.some((comment) => comment.reviewId === input?.pullRequestReviewId),
              )
              refused.push({
                body: String(input?.body ?? ""),
                inline: pending.length + ((input?.threads as Array<unknown>)?.length ?? 0),
              })
              return harness.github.refusal(request, "UNPROCESSABLE", "Unprocessable Entity")
            })
          const runId = yield* review(harness, [blocking])

          assert.strictEqual(refused.length, 2)
          assert.strictEqual(refused[0]!.inline, 1)
          assert.strictEqual(refused[1]!.inline, 0)
          assert.include(refused[1]!.body, "src/a.ts:2")
          assert.deepStrictEqual(submitted(harness), [])
          assert.deepStrictEqual(
            harness.github.checkRuns.map((check) => [check.status, check.conclusion]),
            [["completed", "neutral"]],
          )
          const row = yield* harness.row(runId)
          assert.strictEqual(row?.status, "failed")
          assert.strictEqual(row?.errorCategory, "publish_failed")
          assert.strictEqual(harness.finishedCount(runId), 1)

          // Recorded, not thrown: nothing replays the batch.
          yield* harness.restart
          yield* harness.wait("5 minutes")
          assert.strictEqual(refused.length, 2)
          assert.strictEqual(harness.finishedCount(runId), 1)
        }),
      ),
  )

  it.effect("an approval has no review body and leaves its nits inline", () =>
    run((harness) =>
      Effect.gen(function* () {
        const nit: Finding = { ...blocking, severity: "nit", comment: "Prefer a clearer name." }
        yield* review(harness, [nit])

        assert.deepStrictEqual(
          harness.github.threads.map((thread) => [thread.path, thread.line]),
          [["src/a.ts", 2]],
        )
        assert.strictEqual(harness.github.threads[0]!.comments.length, 1)
        assert.include(harness.github.threads[0]!.comments[0]!.body, nit.comment)
        const reviews = submitted(harness)
        assert.strictEqual(reviews.length, 1)
        assert.strictEqual(reviews[0]?.state, "APPROVED")
        assert.strictEqual(reviews[0]!.body, "")
      }),
    ),
  )

  it.effect(
    "a forbidden dismissal is noted in the check run, the batch goes on, and a replay doesn't retry it",
    () =>
      run((harness) =>
        Effect.gen(function* () {
          harness.github.dismissalForbidden = true
          // A sensitive path from an author without write access withholds the approval that
          // would otherwise replace the earlier review, so janitor dismisses it instead.
          putPullRequest(harness, HEAD, [".github/workflows/ci.yml"])
          putEarlierReview(harness, "CHANGES_REQUESTED")
          // The runner stops after the dismissal failed, before the check run is saved.
          const crashed = yield* cutOff(harness, "updateCheckRun")
          const runId = newRunId()
          yield* harness.start(runId)
          yield* harness.agent.last.complete("Reviewed.")
          yield* harness.waitFor(crashed, "the crash while updating the check run")
          yield* harness.restart
          yield* harness.until(
            Effect.sync(() => harness.finishedCount(runId) > 0),
            "RunFinished",
          )

          // The permanent failure was journalled, so the replay only redoes the check run.
          assert.deepStrictEqual(harness.github.writeNames, [
            "createCheckRun",
            "addPullRequestReview",
            "submitPullRequestReview",
            "dismissReview",
            "updateCheckRun",
            "updateCheckRun",
          ])
          assert.deepStrictEqual(
            harness.github.reviews.map((review) => review.state),
            ["CHANGES_REQUESTED", "COMMENTED"],
          )
          const [check] = harness.github.checkRuns
          assert.deepStrictEqual([check?.status, check?.conclusion], ["completed", "success"])
          assert.include(check?.output.summary, "Couldn't dismiss janitor's earlier review")
          assert.strictEqual((yield* harness.row(runId))?.status, "commented")
          assert.strictEqual(harness.finishedCount(runId), 1)
        }),
      ),
  )

  // GitHub counts a reviewer's latest review that isn't a comment: an approval dismissed as stale
  // after a push still supersedes the change request before it.
  for (const [name, earlier, after] of [
    [
      "a change request superseded by an approval later dismissed as stale stays superseded",
      ["CHANGES_REQUESTED", "DISMISSED"],
      ["CHANGES_REQUESTED", "DISMISSED"],
    ],
    [
      "a change request after an approval is dismissed",
      ["APPROVED", "CHANGES_REQUESTED"],
      ["APPROVED", "DISMISSED", "COMMENTED"],
    ],
  ] as const)
    it.effect(name, () =>
      run((harness) =>
        Effect.gen(function* () {
          // A sensitive path from an author without write access withholds approval.
          putPullRequest(harness, HEAD, [".github/workflows/ci.yml"])
          for (const [index, state] of earlier.entries())
            harness.github.reviews.push({
              id: `PRR_earlier_${index}`,
              databaseId: 800 + index,
              author: APP_LOGIN,
              byApp: true,
              state,
              body: state === "CHANGES_REQUESTED" ? "Earlier." : "",
              commitOID: EARLIER_SHA,
            })
          yield* review(harness, [])

          assert.deepStrictEqual(
            submitted(harness).map((review) => review.state),
            [...after],
          )
        }),
      ),
    )

  it.effect("a head that moved before publishing posts no review and cancels the check run", () =>
    run((harness) =>
      Effect.gen(function* () {
        const runId = newRunId()
        yield* harness.start(runId)
        putPullRequest(harness, MOVED)
        yield* harness.agent.last.step({
          history: { _tag: "Appended", messages: [] },
          records: [{ _tag: "FindingReported", finding: blocking }],
        })
        yield* harness.agent.last.complete("Reviewed.")
        yield* harness.until(
          Effect.sync(() => harness.finishedCount(runId) > 0),
          "RunFinished",
        )

        assert.deepStrictEqual(harness.github.writeNames, ["createCheckRun", "updateCheckRun"])
        assert.deepStrictEqual(
          harness.github.checkRuns.map((check) => [check.headSha, check.status, check.conclusion]),
          [[HEAD, "completed", "cancelled"]],
        )
        assert.strictEqual((yield* harness.row(runId))?.status, "cancelled")
        assert.strictEqual(harness.finishedCount(runId), 1)
      }),
    ),
  )

  for (const [findings, from, to, verdict] of [
    [[], "APPROVE", "COMMENTED", "comment"],
    [[blocking], "REQUEST_CHANGES", "CHANGES_REQUESTED", "request_changes"],
  ] as const)
    it.effect(`a head that moves before submit turns ${from} into ${to}`, () =>
      run((harness) =>
        Effect.gen(function* () {
          harness.github.intercept = (request: GitHubRequest) => {
            if (harness.github.writeName(request) !== "addPullRequestReview")
              return Effect.succeed(undefined)
            harness.github.intercept = () => Effect.succeed(undefined)
            const response = harness.github.respond(request)
            putPullRequest(harness, MOVED)
            return Effect.succeed(response)
          }
          const runId = yield* review(harness, findings)

          // The review stays on the reviewed commit.
          assert.deepStrictEqual(
            submitted(harness).map((review) => [review.state, review.commitOID]),
            [[to, HEAD]],
          )
          // The record keeps the verdict posted and the late head move among its gates.
          const row = yield* harness.row(runId)
          assert.strictEqual(row?.verdict, verdict)
          assert.include(row?.failedGates ?? [], "HeadMoved")
          assert.strictEqual(harness.finishedCount(runId), 1)
        }),
      ),
    )

  it.effect(
    "a submit cut off and replayed after a push records the head as it stood when it was submitted",
    () =>
      run((harness) =>
        Effect.gen(function* () {
          // The approval lands on the reviewed head, then its response is lost.
          const crashed = yield* cutOff(harness, "submitPullRequestReview")
          const runId = newRunId()
          yield* harness.start(runId)
          yield* harness.agent.last.complete("Reviewed.")
          yield* harness.waitFor(crashed, "the crash while submitting the review")
          // A push before the replay doesn't change what was submitted.
          putPullRequest(harness, MOVED)
          yield* harness.restart
          yield* harness.until(
            Effect.sync(() => harness.finishedCount(runId) > 0),
            "RunFinished",
          )

          assert.deepStrictEqual(
            submitted(harness).map((review) => [review.state, review.commitOID]),
            [["APPROVED", HEAD]],
          )
          const row = yield* harness.row(runId)
          assert.strictEqual(row?.verdict, "approve")
          assert.deepStrictEqual(row?.failedGates, [])
          assert.strictEqual(harness.github.checkRuns[0]?.output.title, "No blocking findings")
        }),
      ),
  )

  it.effect(
    "a partial run's neutral check run still lists its findings and the late head move",
    () =>
      run((harness) =>
        Effect.gen(function* () {
          harness.github.intercept = (request: GitHubRequest) => {
            if (harness.github.writeName(request) !== "addPullRequestReview")
              return Effect.succeed(undefined)
            harness.github.intercept = () => Effect.succeed(undefined)
            const response = harness.github.respond(request)
            putPullRequest(harness, MOVED)
            return Effect.succeed(response)
          }
          const runId = yield* review(harness, [blocking], "partial")

          assert.deepStrictEqual(
            submitted(harness).map((review) => review.state),
            ["CHANGES_REQUESTED"],
          )
          assert.include((yield* harness.row(runId))?.failedGates ?? [], "HeadMoved")
          const [check] = harness.github.checkRuns
          assert.deepStrictEqual([check?.status, check?.conclusion], ["completed", "neutral"])
          // The incomplete explanation, with the finding and the gates the check run owes.
          assert.include(check?.output.summary, "The review ended before it finished")
          assert.include(check?.output.summary, "https://github.com/effect/one/pull/7/files")
          assert.include(check?.output.summary, "the head moved during the review")
        }),
      ),
  )

  it.effect("a quiet partial run never approves and only updates the check run", () =>
    run((harness) =>
      Effect.gen(function* () {
        const runId = yield* review(harness, [], "partial")

        assert.deepStrictEqual(harness.github.writeNames, ["createCheckRun", "updateCheckRun"])
        assert.deepStrictEqual(harness.github.reviews, [])
        assert.strictEqual(harness.github.checkRuns[0]?.status, "completed")
        const row = yield* harness.row(runId)
        assert.strictEqual(row?.status, "partial")
        assert.isNull(row?.verdict)
        assert.strictEqual(harness.finishedCount(runId), 1)
      }),
    ),
  )

  it.effect(
    "a run record that fails to write is retried until Postgres comes back, without posting again",
    () =>
      run((harness) =>
        Effect.gen(function* () {
          harness.postgres.failFinalRow = true
          const runId = yield* review(harness, [blocking])
          // RunFinished doesn't wait for Postgres.
          assert.strictEqual(harness.finishedCount(runId), 1)
          assert.strictEqual((yield* harness.row(runId))?.status, "running")

          // Postgres comes back, across a restart; the retry lands within the hour.
          yield* harness.restart
          harness.postgres.failFinalRow = false
          yield* harness.wait("1 hour", "1 minute")
          assert.strictEqual((yield* harness.row(runId))?.status, "changes_requested")
          assert.strictEqual((yield* harness.findings(runId)).length, 1)
          for (const create of [
            "addPullRequestReview",
            "addPullRequestReviewThread",
            "submitPullRequestReview",
          ])
            assert.strictEqual(count(harness, create), 1, create)
          assert.strictEqual(harness.finishedCount(runId), 1)
        }),
      ),
  )

  it.effect("an addressed finding resolves its earlier thread without a resolution reply", () =>
    run((harness) =>
      Effect.gen(function* () {
        yield* putEarlierThread(harness, { id: "PRRT_addressed", severity: "blocking" })
        harness.github.file(HEAD, "src/a.ts", lines.join("\n").replace("a + 1", "a"))

        yield* reviewWith(harness, [
          {
            _tag: "ThreadUpdated",
            threadId: "PRRT_addressed",
            judgement: { judgement: "addressed", note: "The off-by-one is fixed." },
          },
        ])

        const thread = harness.github.threads.find((thread) => thread.id === "PRRT_addressed")
        assert.deepStrictEqual(
          { resolved: thread?.isResolved, replies: janitorAdded(harness, "PRRT_addressed", 1) },
          { resolved: true, replies: [] },
        )
      }),
    ),
  )

  it.effect("an addressed finding resolves its thread without minimizing inline comments", () =>
    run((harness) =>
      Effect.gen(function* () {
        yield* putEarlierThread(harness, {
          id: "PRRT_addressed",
          severity: "blocking",
          after: [
            {
              author: AUTHOR,
              byApp: false,
              body: "Fixed in the latest push.",
              createdAt: "2026-10-13T11:00:00Z",
              viewerCanMinimize: true,
            },
          ],
        })
        yield* putEarlierThread(harness, { id: "PRRT_active", severity: "blocking" })
        harness.github.file(HEAD, "src/a.ts", lines.join("\n").replace("a + 1", "a"))

        yield* reviewWith(harness, [
          {
            _tag: "ThreadUpdated",
            threadId: "PRRT_addressed",
            judgement: { judgement: "addressed", note: "The off-by-one is fixed." },
          },
          {
            _tag: "ThreadUpdated",
            threadId: "PRRT_active",
            judgement: { judgement: "still_applies" },
          },
        ])

        assert.deepStrictEqual(
          harness.github.threads.map((thread) => ({
            id: thread.id,
            resolved: thread.isResolved,
            comments: thread.comments.map((comment) => ({
              id: comment.id,
              minimized: comment.isMinimized ?? false,
              reason: comment.minimizedReason ?? null,
            })),
          })),
          [
            {
              id: "PRRT_addressed",
              resolved: true,
              comments: [
                { id: "PRRT_addressed_root", minimized: false, reason: null },
                { id: "PRRT_addressed_0", minimized: false, reason: null },
              ],
            },
            {
              id: "PRRT_active",
              resolved: false,
              comments: [{ id: "PRRT_active_root", minimized: false, reason: null }],
            },
          ],
        )
      }),
    ),
  )

  for (const unknownOwnership of [false, true])
    it.effect(
      unknownOwnership
        ? "unknown thread ownership preserves earlier reviews, including on replay"
        : "only an eligible superseded Janitor review is minimized once after its response is lost",
      () =>
        run((harness) =>
          Effect.gen(function* () {
            putEarlierReview(harness, "COMMENTED")
            const earlier = harness.github.reviews[0]!
            harness.github.reviews.push(
              { ...earlier, id: "PRR_standing", databaseId: 801 },
              {
                ...earlier,
                id: "PRR_human",
                databaseId: 802,
                author: AUTHOR,
                byApp: false,
                viewerCanMinimize: true,
              },
              { ...earlier, id: "PRR_denied", databaseId: 803, viewerCanMinimize: false },
              {
                ...earlier,
                id: "PRR_listed",
                databaseId: 804,
                body: "Blocking findings that couldn't go inline:\n\nUnanchorable finding remains unsafe.",
              },
            )
            yield* putEarlierThread(harness, { id: "PRRT_addressed", severity: "blocking" })
            yield* putEarlierThread(harness, { id: "PRRT_standing", severity: "blocking" })
            const standing = harness.github.threads.find((thread) => thread.id === "PRRT_standing")!
            standing.comments = standing.comments.map((comment) => ({
              ...comment,
              reviewId: "PRR_standing",
            }))
            for (const name of ["denied", "listed"]) {
              yield* putEarlierThread(harness, { id: "PRRT_" + name, severity: "blocking" })
              const thread = harness.github.threads.find((thread) => thread.id === "PRRT_" + name)!
              thread.comments = thread.comments.map((comment) => ({
                ...comment,
                reviewId: "PRR_" + name,
              }))
            }
            if (unknownOwnership) {
              yield* putEarlierThread(harness, { id: "PRRT_unknown", severity: "blocking" })
              const thread = harness.github.threads.find((thread) => thread.id === "PRRT_unknown")!
              thread.comments = thread.comments.map(({ reviewId: _, ...comment }) => comment)
            }
            harness.github.file(HEAD, "src/a.ts", lines.join("\n").replace("a + 1", "a"))

            // GitHub commits the write but never answers, so restart happens before journalling.
            const crashed = yield* cutOff(
              harness,
              unknownOwnership ? "updateCheckRun" : "minimizeComment",
            )
            const runId = newRunId()
            yield* harness.start(runId)
            yield* harness.agent.last.step({
              history: { _tag: "Appended", messages: [] },
              records: [
                {
                  _tag: "ThreadUpdated",
                  threadId: "PRRT_addressed",
                  judgement: { judgement: "addressed", note: "The off-by-one is fixed." },
                },
                {
                  _tag: "ThreadUpdated",
                  threadId: "PRRT_standing",
                  judgement: { judgement: "still_applies" },
                },
                ...["denied", "listed"].map((name): LoopRecord => ({
                  _tag: "ThreadUpdated",
                  threadId: "PRRT_" + name,
                  judgement: { judgement: "addressed", note: "The off-by-one is fixed." },
                })),
              ],
            })
            yield* harness.agent.last.complete("Reviewed.")
            yield* harness.waitFor(crashed, "the lost response during review cleanup")
            assert.strictEqual(earlier.isMinimized ?? false, !unknownOwnership)
            assert.strictEqual(harness.finishedCount(runId), 0)
            if (!unknownOwnership) {
              assert.strictEqual(count(harness, "minimizeComment"), 1)
              assert.strictEqual(count(harness, "updateCheckRun"), 0)
            }
            yield* harness.restart
            yield* harness.until(
              Effect.sync(() => harness.finishedCount(runId) > 0),
              "RunFinished",
            )

            const current = harness.github.reviews.find((review) => review.commitOID === HEAD)!
            assert.isDefined(current)
            assert.deepStrictEqual(
              harness.github.reviews.map((review) => ({
                id: review.id,
                minimized: review.isMinimized ?? false,
              })),
              [
                { id: "PRR_earlier", minimized: !unknownOwnership },
                { id: "PRR_standing", minimized: false },
                { id: "PRR_human", minimized: false },
                { id: "PRR_denied", minimized: false },
                { id: "PRR_listed", minimized: false },
                { id: current.id, minimized: false },
              ],
            )
            assert.strictEqual(
              harness.github.reviews.find((review) => review.id === "PRR_human")?.body,
              "Earlier.",
            )
            assert.deepStrictEqual(
              harness.github.requests
                .filter((request) => harness.github.writeName(request) === "minimizeComment")
                .map((request) => harness.github.mutationInput(request)?.subjectId),
              unknownOwnership ? [] : ["PRR_earlier"],
            )
            assert.strictEqual(count(harness, "submitPullRequestReview"), 1)
            assert.strictEqual(harness.finishedCount(runId), 1)
          }),
        ),
    )

  it.effect("a resolution with a lost response replays without another mutation or reply", () =>
    run((harness) =>
      Effect.gen(function* () {
        yield* putEarlierThread(harness, { id: "PRRT_addressed", severity: "blocking" })
        harness.github.file(HEAD, "src/a.ts", lines.join("\n").replace("a + 1", "a"))
        const crashed = yield* cutOff(harness, "resolveReviewThread")
        const runId = newRunId()
        yield* harness.start(runId)
        yield* harness.agent.last.step({
          history: { _tag: "Appended", messages: [] },
          records: [
            {
              _tag: "ThreadUpdated",
              threadId: "PRRT_addressed",
              judgement: { judgement: "addressed", note: "The off-by-one is fixed." },
            },
          ],
        })
        yield* harness.agent.last.complete("Reviewed.")
        yield* harness.waitFor(crashed, "the lost response while resolving the thread")
        assert.strictEqual(
          harness.github.threads.find((thread) => thread.id === "PRRT_addressed")?.isResolved,
          true,
        )

        yield* harness.restart
        yield* harness.until(
          Effect.sync(() => harness.finishedCount(runId) > 0),
          "RunFinished",
        )

        assert.strictEqual(count(harness, "resolveReviewThread"), 1)
        assert.deepStrictEqual(janitorAdded(harness, "PRRT_addressed", 1), [])
        assert.strictEqual(
          harness.github.threads.find((thread) => thread.id === "PRRT_addressed")?.isResolved,
          true,
        )
        assert.strictEqual((yield* harness.row(runId))?.status, "approved")
        assert.strictEqual(harness.finishedCount(runId), 1)
      }),
    ),
  )

  it.effect(
    "replies when a human replied or an outside author resolved since janitor last spoke, even with nothing else to say",
    () =>
      run((harness) =>
        Effect.gen(function* () {
          // The author disputes the finding after janitor's root comment.
          yield* putEarlierThread(harness, {
            id: "PRRT_disputed",
            severity: "blocking",
            after: [
              {
                author: AUTHOR,
                byApp: false,
                body: "This is intended.",
                createdAt: "2026-10-13T11:00:00Z",
              },
            ],
          })
          // Janitor replied while the thread was open; the author resolved it later, saying nothing.
          yield* putEarlierThread(harness, {
            id: "PRRT_resolved",
            severity: "blocking",
            after: [
              {
                author: APP_LOGIN,
                byApp: true,
                body: "Still applies.",
                createdAt: "2026-10-13T11:00:00Z",
              },
            ],
            resolvedBy: AUTHOR,
          })
          const runId = yield* reviewWith(harness, [
            {
              _tag: "ThreadUpdated",
              threadId: "PRRT_disputed",
              judgement: { judgement: "still_applies", note: "`b` is still off by one." },
            },
            {
              _tag: "ThreadUpdated",
              threadId: "PRRT_resolved",
              judgement: { judgement: "still_applies" },
            },
          ])

          const [posted] = submitted(harness)
          assert.strictEqual(posted?.state, "COMMENTED")
          const disputed = janitorAdded(harness, "PRRT_disputed", 2)
          assert.deepStrictEqual(
            disputed.map((comment) => comment.reviewId),
            [posted?.id],
          )
          assert.include(disputed[0]?.body, "`b` is still off by one.")
          assert.deepStrictEqual(
            janitorAdded(harness, "PRRT_resolved", 2).map((comment) => comment.reviewId),
            [posted?.id],
          )
          assert.strictEqual(harness.finishedCount(runId), 1)
        }),
      ),
  )

  it.effect(
    "a withdrawn blocker gets its reply in a silent approval that replaces the earlier REQUEST_CHANGES",
    () =>
      run((harness) =>
        Effect.gen(function* () {
          putEarlierReview(harness, "CHANGES_REQUESTED")
          yield* putEarlierThread(harness, { id: "PRRT_withdrawn", severity: "blocking" })
          const runId = yield* reviewWith(harness, [
            {
              _tag: "ThreadUpdated",
              threadId: "PRRT_withdrawn",
              judgement: { judgement: "withdrawn", note: "`b` is meant to be one more." },
            },
          ])

          // The approval supersedes the earlier review, so nothing is dismissed with a message.
          assert.deepStrictEqual(
            harness.github.reviews.map((review) => review.state),
            ["CHANGES_REQUESTED", "APPROVED"],
          )
          assert.strictEqual(submitted(harness)[1]?.body, "")
          assert.strictEqual(count(harness, "dismissReview"), 0)
          const [reply] = janitorAdded(harness, "PRRT_withdrawn", 1)
          assert.match(reply?.body ?? "", /^Withdrawn:/)
          assert.strictEqual(harness.finishedCount(runId), 1)
        }),
      ),
  )

  it.effect("the body-only fallback after a 422 keeps the replies to earlier threads", () =>
    run((harness) =>
      Effect.gen(function* () {
        yield* putEarlierThread(harness, {
          id: "PRRT_nit",
          severity: "nit",
          after: [
            {
              author: AUTHOR,
              byApp: false,
              body: "Why does this matter?",
              createdAt: "2026-10-13T11:00:00Z",
            },
          ],
        })
        // GitHub refuses the first submission only.
        let refused = 0
        harness.github.intercept = (request) =>
          Effect.sync(() => {
            if (harness.github.writeName(request) !== "submitPullRequestReview" || refused > 0)
              return undefined
            refused += 1
            return harness.github.refusal(request, "UNPROCESSABLE", "Unprocessable Entity")
          })
        const runId = yield* reviewWith(harness, [
          { _tag: "FindingReported", finding: blocking },
          {
            _tag: "ThreadUpdated",
            threadId: "PRRT_nit",
            judgement: { judgement: "still_applies", note: "It hides the real value." },
          },
        ])

        const [posted] = submitted(harness)
        assert.strictEqual(posted?.state, "CHANGES_REQUESTED")
        assert.include(posted?.body, "src/a.ts:2")
        const [reply] = janitorAdded(harness, "PRRT_nit", 2)
        assert.strictEqual(reply?.reviewId, posted?.id)
        assert.include(reply?.body, "It hides the real value.")
        assert.strictEqual(harness.finishedCount(runId), 1)
      }),
    ),
  )
})
