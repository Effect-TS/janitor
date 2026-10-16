import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, layer } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { GitHubCommitSha } from "@janitor/domain/GitHub/Id"
import type { Finding } from "@janitor/domain/PullRequestReview/Finding"
import { fingerprint } from "@janitor/domain/PullRequestReview/Fingerprint"
import { RunId } from "@janitor/domain/PullRequestReview/Run"
import type { GitHubRequest } from "../../src/GitHub/Transport.ts"
import { RunPublisherLayer } from "../../src/PullRequestReview/Publish.ts"
import { PullRequestReviewStore } from "../../src/PullRequestReview/Store.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import { APP_LOGIN } from "./fakeGitHub.ts"
import { HEAD, makeRunHarnessWith, type RunHarness } from "./runHarness.ts"
import { repositoryId, seedRepositories } from "./support.ts"

/** The deployment's environment; the gate is on while the API key is set. */
const env: Record<string, string> = { PR_REVIEW_OPENROUTER_API_KEY: "test-key" }

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

/** Pull request 7 at `headSha`, changing `src/a.ts`. */
const putPullRequest = (harness: RunHarness, headSha: string) =>
  harness.github.put({
    number: 7,
    title: "Change",
    state: "open",
    labels: [],
    pullRequest: {
      headSha,
      files: [{ filename: "src/a.ts", status: "modified", patch, additions: 1, deletions: 0 }],
    },
  })

/**
 * Starts a run, reports `findings` in one step and ends the loop: completed,
 * or failed on the provider so the review is partial. Returns once `Publish`
 * has been handled.
 */
const review = (
  harness: RunHarness,
  findings: ReadonlyArray<Finding>,
  end: "completed" | "partial" = "completed",
) =>
  Effect.gen(function* () {
    const runId = newRunId()
    yield* harness.start(runId)
    const session = harness.agent.last
    yield* session.step({
      history: { _tag: "Appended", messages: [] },
      records: findings.map((finding) => ({ _tag: "FindingReported", finding })),
    })
    yield* end === "completed" ? session.complete("Reviewed.") : session.fail("provider down")
    yield* harness.drain
    return runId
  })

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

          // A write that landed before the crash is found by its marker, not made again.
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
            [["completed", "failure"]],
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

  it.effect("a forbidden dismissal is noted in the check run and the batch goes on", () =>
    run((harness) =>
      Effect.gen(function* () {
        harness.github.dismissalForbidden = true
        harness.github.reviews.push({
          id: "PRR_earlier",
          databaseId: 800,
          author: APP_LOGIN,
          byApp: true,
          state: "CHANGES_REQUESTED",
          body: `Earlier.\n\n<!-- janitor:review run=${newRunId()} sha=${"e".repeat(40)} -->`,
          commitOID: "e".repeat(40),
        })
        const runId = yield* review(harness, [])

        assert.deepStrictEqual(harness.github.writeNames, [
          "createCheckRun",
          "addPullRequestReview",
          "submitPullRequestReview",
          "dismissReview",
          "updateCheckRun",
        ])
        assert.deepStrictEqual(
          harness.github.reviews.map((review) => review.state),
          ["CHANGES_REQUESTED", "APPROVED"],
        )
        const [check] = harness.github.checkRuns
        assert.deepStrictEqual([check?.status, check?.conclusion], ["completed", "success"])
        assert.include(check?.output.summary, "Couldn't dismiss janitor's earlier review")
        assert.strictEqual((yield* harness.row(runId))?.status, "approved")
        assert.strictEqual(harness.finishedCount(runId), 1)
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
        yield* harness.drain

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

  for (const [findings, from, to] of [
    [[], "APPROVE", "COMMENTED"],
    [[blocking], "REQUEST_CHANGES", "CHANGES_REQUESTED"],
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
          assert.strictEqual(harness.finishedCount(runId), 1)
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
})
