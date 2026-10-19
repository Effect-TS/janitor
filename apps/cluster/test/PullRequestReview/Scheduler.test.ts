import { assert, layer } from "@effect/vitest"
import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import * as MessageStorage from "effect/cluster/MessageStorage"
import * as RunnerHealth from "effect/cluster/RunnerHealth"
import * as Runners from "effect/cluster/Runners"
import * as RunnerStorage from "effect/cluster/RunnerStorage"
import * as Sharding from "effect/cluster/Sharding"
import * as ShardingConfig from "effect/cluster/ShardingConfig"
import * as TestRunner from "effect/cluster/TestRunner"
import * as ConfigProvider from "effect/ConfigProvider"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as TestClock from "effect/testing/TestClock"
import * as WorkflowEngine from "effect/workflow/WorkflowEngine"
import {
  GitHubCommentDatabaseId,
  GitHubCommitSha,
  GitHubRepositoryDatabaseId,
  GitHubUserDatabaseId,
} from "@janitor/domain/GitHub/Id"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import { RunId } from "@janitor/domain/PullRequestReview/Run"
import {
  AdmitPullRequestReview,
  AdmitPullRequestReviewLayer,
} from "../../src/PullRequestReview/Admission.ts"
import { PullRequestReviewRun } from "../../src/PullRequestReview/RunEntity.ts"
import {
  disableRepository,
  PullRequestScheduler,
  PullRequestSchedulerLayer,
  schedulerEntityId,
} from "../../src/PullRequestReview/Scheduler.ts"
import { PullRequestReviewStore } from "../../src/PullRequestReview/Store.ts"
import { RepositoryEligibility } from "../../src/RepositoryEligibility.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import { FakeReviewGitHub } from "./fakeGitHub.ts"
import { drain, failNextSend, repositoryId, seedRepositories, settle } from "./support.ts"

/** The deployment's environment; the gate is on while the API URL and key are set. */
const env: Record<string, string> = {
  PR_REVIEW_AI_API_URL: "https://ai.test/v1",
  PR_REVIEW_AI_API_KEY: "test-key",
}

type RunMessage =
  | ({ readonly _tag: "Start" | "Skip"; readonly runId: RunId; readonly number: number } & Record<
      string,
      unknown
    >)
  | { readonly _tag: "Cancel"; readonly runId: RunId }

/** What the fake run entity received, in order. */
const received: Array<RunMessage> = []

/**
 * The run entity, faked: it records each message and, like the real one,
 * writes the `running` row when a run starts. Tests send `RunFinished`
 * themselves, so they decide when a run ends.
 */
const FakeRunEntity = PullRequestReviewRun.toLayer(
  Effect.gen(function* () {
    const store = yield* PullRequestReviewStore
    return PullRequestReviewRun.of({
      Start: ({ payload }) =>
        Effect.gen(function* () {
          received.push({ _tag: "Start", ...payload })
          yield* store.start({
            ...payload,
            title: "Change",
            baseSha: "b".repeat(40),
            startedAt: yield* DateTime.now,
          })
        }).pipe(Effect.orDie),
      Cancel: ({ payload }) =>
        Effect.sync(() => {
          received.push({ _tag: "Cancel", ...payload })
        }),
      Skip: ({ payload }) =>
        Effect.sync(() => {
          received.push({ _tag: "Skip", ...payload })
        }),
      // The run entity sends these to itself; the scheduler never does.
      Publish: () => Effect.void,
      Expire: () => Effect.void,
      // Only the web app reads transcripts.
      Transcript: () => Effect.succeed({ _tag: "Expired" } as const),
    })
  }),
)

/** The scheduler's Durable Object storage: SQLite, as on Cloudflare. */
const DurableObjectStorage = Layer.effect(
  CloudflareCluster.DurableObjectSqlClient,
  SqliteClient.make({ filename: ":memory:" }),
).pipe(Layer.provide(Reactivity.layer))

const github = new FakeReviewGitHub(32)

const Services = Layer.mergeAll(
  PullRequestSchedulerLayer,
  FakeRunEntity,
  AdmitPullRequestReviewLayer,
).pipe(
  Layer.provideMerge(DurableObjectStorage),
  Layer.provideMerge(Layer.mergeAll(PullRequestReviewStore.layer, RepositoryEligibility.layer)),
  Layer.provideMerge(github.layer),
  Layer.provideMerge(TestRunner.layer),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  Layer.provideMerge(MigratedPostgresLayer),
)

const otherRepositoryId = GitHubRepositoryDatabaseId.make("801")
const thirdRepositoryId = GitHubRepositoryDatabaseId.make("802")

const seed = seedRepositories(repositoryId, otherRepositoryId, thirdRepositoryId)

const head = (n: number) => GitHubCommitSha.make(n.toString(16).padStart(40, "0"))

/**
 * Moves the clock, in steps the runner's storage polling can follow, then
 * waits until the messages it released have been handled.
 */
const wait = (duration: Duration.Input) =>
  Effect.gen(function* () {
    const total = Duration.toMillis(Duration.fromInputUnsafe(duration))
    for (let elapsed = 0; elapsed < total; elapsed += 5_000)
      yield* TestClock.adjust(Duration.millis(Math.min(5_000, total - elapsed)))
    yield* drain
  })

/** Journal sequences, as admission forwards them: later deliveries get larger ones. */
let journal = 1_000
const nextSequence = () => GitHubWebhookJournalSequence.make(String(++journal))

const scheduler = (number: number, repository = repositoryId) =>
  Effect.gen(function* () {
    const client = (yield* PullRequestScheduler.client)(schedulerEntityId(repository, number))
    const ids = { repositoryId: repository, number }
    const delivery = (options: { readonly sequence?: GitHubWebhookJournalSequence } = {}) => ({
      ...ids,
      sequence: options.sequence ?? nextSequence(),
    })
    type Head = { readonly sequence?: GitHubWebhookJournalSequence; readonly oversized?: boolean }
    return {
      push: (sha: GitHubCommitSha, options: Head = {}) =>
        settle(
          client.HeadChanged({
            ...delivery(options),
            headSha: sha,
            oversized: options.oversized ?? false,
          }),
        ),
      reopen: (sha: GitHubCommitSha, options: Head = {}) =>
        settle(
          client.Reopened({
            ...delivery(options),
            headSha: sha,
            oversized: options.oversized ?? false,
          }),
        ),
      close: Effect.suspend(() => settle(client.Closed(delivery()))),
      convertToDraft: Effect.suspend(() => settle(client.ConvertedToDraft(delivery()))),
      rerun: (sha: GitHubCommitSha, commentId: string) =>
        settle(
          client.Rerun({
            ...delivery(),
            headSha: sha,
            trigger: { _tag: "Rerun", invoker: "maintainer", commentId },
          }),
        ),
      reply: (sha: GitHubCommitSha) =>
        settle(
          client.Rerun({
            ...delivery(),
            headSha: sha,
            trigger: { _tag: "Automatic" },
          }),
        ),
      finish: (runId: RunId) =>
        Effect.flatMap(DateTime.now, (finishedAt) =>
          settle(client.RunFinished({ runId, finishedAt })),
        ),
    }
  })

/** The messages about one pull request's runs, in order. */
const messages = (number: number) => {
  const runs = new Set(
    received.flatMap((message) =>
      message._tag !== "Cancel" && message.number === number ? [message.runId] : [],
    ),
  )
  return received.filter((message) =>
    message._tag === "Cancel" ? runs.has(message.runId) : message.number === number,
  )
}

const starts = (number: number) =>
  messages(number).filter(
    (message): message is Extract<RunMessage, { _tag: "Start" | "Skip" }> =>
      message._tag === "Start",
  )

const lastStart = (number: number) => {
  const start = starts(number).at(-1)
  assert.isDefined(start, `no run started for #${number}`)
  return start!
}

/** Ten automatic runs, each finished and past its cooldown. */
const exhaust = (pr: Effect.Success<ReturnType<typeof scheduler>>, number: number) =>
  Effect.gen(function* () {
    for (let run = 1; run <= 10; run++) {
      yield* pr.push(head(number * 100 + run))
      yield* pr.finish(lastStart(number).runId)
      yield* wait("3 minutes")
    }
    assert.strictEqual(starts(number).length, 10)
  })

layer(Services, { timeout: "2 minutes" })("PR review scheduler", (it) => {
  it.effect(
    "cancels the active run on a push, and starts the next only on that run's RunFinished",
    () =>
      Effect.gen(function* () {
        yield* seed
        const pr = yield* scheduler(11)

        yield* pr.push(head(1))
        const first = lastStart(11)
        // Ids only: the repository, pull request, head, run id and trigger.
        assert.deepStrictEqual(first, {
          _tag: "Start",
          runId: first.runId,
          repositoryId,
          number: 11,
          headSha: head(1),
          trigger: { _tag: "Automatic" },
        })

        yield* pr.push(head(2))
        assert.deepStrictEqual(received.at(-1), { _tag: "Cancel", runId: first.runId })
        assert.strictEqual(starts(11).length, 1)

        // Another run's RunFinished, say a cancelled run's that arrives late, is ignored.
        yield* pr.finish(RunId.make(crypto.randomUUID()))
        assert.strictEqual(starts(11).length, 1)

        yield* pr.finish(first.runId)
        const second = lastStart(11)
        assert.strictEqual(starts(11).length, 2)
        assert.strictEqual(second.headSha, head(2))
        assert.notStrictEqual(second.runId, first.runId)
      }),
  )

  it.effect(
    "starts the next run at the active run's deadline plus a margin when RunFinished never arrives",
    () =>
      Effect.gen(function* () {
        yield* seed
        const pr = yield* scheduler(12)
        yield* pr.push(head(1))
        yield* pr.push(head(2))
        assert.strictEqual(starts(12).length, 1)

        // The deadline is 15 minutes from the start, and the margin 2 more.
        yield* wait("16 minutes")
        assert.strictEqual(starts(12).length, 1)
        yield* wait("90 seconds")
        assert.strictEqual(lastStart(12).headSha, head(2))
        assert.strictEqual(starts(12).length, 2)
      }),
  )

  it.effect("queues a push within 2 minutes of a completed run, and the newest head wins", () =>
    Effect.gen(function* () {
      yield* seed
      const pr = yield* scheduler(13)
      yield* pr.push(head(1))
      yield* pr.finish(lastStart(13).runId)

      yield* wait("30 seconds")
      yield* pr.push(head(2))
      yield* wait("30 seconds")
      yield* pr.push(head(3))
      yield* wait("30 seconds")
      assert.strictEqual(starts(13).length, 1)

      yield* wait("45 seconds")
      assert.strictEqual(starts(13).length, 2)
      assert.strictEqual(lastStart(13).headSha, head(3))
    }),
  )

  it.effect("doesn't start a queued run once the repository is disabled or the gate is off", () =>
    Effect.gen(function* () {
      yield* seed
      const store = yield* PullRequestReviewStore
      const pr = yield* scheduler(14)

      // Released by RunFinished.
      yield* pr.push(head(1))
      yield* pr.push(head(2))
      yield* store.setEnabled(repositoryId, false)
      yield* pr.finish(lastStart(14).runId)
      assert.strictEqual(starts(14).length, 1)
      yield* store.setEnabled(repositoryId, true)

      // Released by the cooldown.
      yield* wait("3 minutes")
      yield* pr.push(head(3))
      yield* pr.finish(lastStart(14).runId)
      yield* pr.push(head(4))
      delete env["PR_REVIEW_AI_API_KEY"]
      yield* wait("3 minutes")
      env["PR_REVIEW_AI_API_KEY"] = "test-key"
      assert.deepStrictEqual(
        starts(14).map((start) => start.headSha),
        [head(1), head(3)],
      )
    }),
  )

  it.effect("cancels the active run on close, merge or conversion to draft", () =>
    Effect.gen(function* () {
      yield* seed
      const closed = yield* scheduler(15)
      yield* closed.push(head(1))
      yield* closed.close
      assert.deepStrictEqual(received.at(-1), { _tag: "Cancel", runId: lastStart(15).runId })

      const drafted = yield* scheduler(16)
      yield* drafted.push(head(1))
      yield* drafted.convertToDraft
      assert.deepStrictEqual(received.at(-1), { _tag: "Cancel", runId: lastStart(16).runId })
    }),
  )

  it.effect("pauses automatic runs after 10, and a /janitor re-run resets the count", () =>
    Effect.gen(function* () {
      yield* seed
      const pr = yield* scheduler(17)
      yield* exhaust(pr, 17)

      yield* pr.push(head(1))
      assert.strictEqual(starts(17).length, 10)
      const skip = messages(17).at(-1)!
      assert.deepStrictEqual(skip, {
        _tag: "Skip",
        runId: skip.runId,
        repositoryId,
        number: 17,
        headSha: head(1),
        trigger: { _tag: "Automatic" },
        reason: "run_cap",
      })

      yield* pr.rerun(head(1), "501")
      assert.deepStrictEqual(lastStart(17).trigger, {
        _tag: "Rerun",
        invoker: "maintainer",
        commentId: "501",
      })
      yield* pr.finish(lastStart(17).runId)
      yield* wait("3 minutes")

      yield* pr.push(head(2))
      assert.deepStrictEqual(lastStart(17).trigger, { _tag: "Automatic" })
      assert.strictEqual(starts(17).length, 12)
    }),
  )

  it.effect("a same-head reply leaves the last permitted automatic review running", () =>
    Effect.gen(function* () {
      yield* seed
      const pr = yield* scheduler(31)
      for (let run = 1; run <= 10; run++) {
        yield* pr.push(head(run))
        if (run < 10) {
          yield* pr.finish(lastStart(31).runId)
          yield* wait("3 minutes")
        }
      }
      assert.strictEqual(starts(31).length, 10)
      const client = (yield* PullRequestScheduler.client)(schedulerEntityId(repositoryId, 31))
      yield* settle(
        client.Rerun({
          repositoryId,
          number: 31,
          sequence: nextSequence(),
          headSha: head(10),
          trigger: { _tag: "Automatic" },
        }),
      )

      assert.deepStrictEqual(messages(31).slice(10), [])
    }),
  )

  it.effect(
    "rapid thread replies coalesce into one follow-up without cancelling the active review",
    () =>
      Effect.gen(function* () {
        yield* seed
        const pr = yield* scheduler(33)
        yield* pr.push(head(1))
        const active = lastStart(33)
        const client = (yield* PullRequestScheduler.client)(schedulerEntityId(repositoryId, 33))

        // Admission forwards replies from every thread on this PR as automatic Reruns.
        for (let reply = 0; reply < 3; reply++) {
          yield* settle(
            client.Rerun({
              repositoryId,
              number: 33,
              sequence: nextSequence(),
              headSha: head(1),
              trigger: { _tag: "Automatic" },
            }),
          )
          yield* wait("1 second")
        }

        assert.deepStrictEqual(messages(33), [active])
        yield* pr.finish(active.runId)
        assert.strictEqual(starts(33).length, 1)
        yield* wait("3 minutes")
        assert.deepStrictEqual(
          messages(33).map((message) => message._tag),
          ["Start", "Start"],
        )
        assert.strictEqual(lastStart(33).headSha, head(1))
      }),
  )

  it.effect("idle replies retain their trailing-edge deadline across a runner restart", () =>
    Effect.gen(function* () {
      yield* seed
      // Rebuild the runner, but retain both its mailbox and Durable Object SQLite.
      const storage = yield* Layer.build(MessageStorage.MemoryDriver.layer)
      const Cluster = Sharding.layer.pipe(
        Layer.provideMerge(Runners.layerNoop),
        Layer.provideMerge(
          Layer.effect(
            MessageStorage.MessageStorage,
            Effect.map(MessageStorage.MemoryDriver, (driver) => driver.storage),
          ),
        ),
        Layer.provide([RunnerStorage.layerMemory, RunnerHealth.layerNoop]),
        Layer.provide(ShardingConfig.layer()),
        Layer.provideMerge(Layer.succeedContext(storage)),
      )
      const Runner = Layer.mergeAll(PullRequestSchedulerLayer, FakeRunEntity).pipe(
        Layer.provideMerge(Cluster),
      )
      let scope = yield* Scope.make()
      let runner = yield* Layer.buildWithScope(Runner, scope)
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const use = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.suspend(() => Effect.provideContext(effect, runner))

      const pr = yield* use(scheduler(34))
      yield* use(pr.reply(head(1)))
      assert.deepStrictEqual(messages(34), [])
      yield* use(wait("20 seconds"))
      yield* use(pr.reply(head(1)))
      assert.deepStrictEqual(messages(34), [])

      yield* use(settle(Scope.close(scope, Exit.void)))
      scope = yield* Scope.make()
      runner = yield* Layer.buildWithScope(Runner, scope)

      // Cross the first reply's timer, but not the extended quiet deadline.
      yield* use(wait("15 seconds"))
      assert.deepStrictEqual(messages(34), [])
      yield* use(wait("10 seconds"))
      assert.deepStrictEqual(messages(34), [])
      yield* use(wait("10 seconds"))
      assert.strictEqual(starts(34).length, 1)
      assert.strictEqual(lastStart(34).headSha, head(1))
      assert.deepStrictEqual(lastStart(34).trigger, { _tag: "Automatic" })
      yield* use(wait("1 minute"))
      assert.strictEqual(starts(34).length, 1)
    }).pipe(Effect.scoped),
  )

  it.effect("a late reply extends quiet time beyond cooldown without an early follow-up", () =>
    Effect.gen(function* () {
      yield* seed
      const pr = yield* scheduler(35)
      yield* pr.push(head(1))
      yield* pr.finish(lastStart(35).runId)
      yield* pr.reply(head(1))
      yield* wait("105 seconds")
      yield* pr.reply(head(1))

      // The original cooldown timer must not release the refreshed reply.
      yield* wait("20 seconds")
      assert.strictEqual(starts(35).length, 1)
      yield* wait("5 seconds")
      assert.strictEqual(starts(35).length, 1)
      yield* wait("10 seconds")
      assert.deepStrictEqual(
        messages(35).map((message) => message._tag),
        ["Start", "Start"],
      )
      assert.strictEqual(lastStart(35).headSha, head(1))
      yield* wait("1 minute")
      assert.strictEqual(starts(35).length, 2)
    }),
  )

  it.effect("replies preserve queued /janitor reviews and do not delay or duplicate them", () =>
    Effect.gen(function* () {
      yield* seed
      for (const [number, tag] of [
        [36, "Rerun"],
        [37, "Forced"],
      ] as const) {
        const pr = yield* scheduler(number)
        yield* pr.push(head(1))
        const active = lastStart(number)
        const client = (yield* PullRequestScheduler.client)(schedulerEntityId(repositoryId, number))
        const trigger = { _tag: tag, invoker: "maintainer", commentId: "701" } as const
        yield* settle(
          client.Rerun({
            repositoryId,
            number,
            sequence: nextSequence(),
            headSha: head(1),
            trigger,
          }),
        )
        yield* pr.reply(head(1))
        yield* wait("10 seconds")
        yield* pr.reply(head(1))
        assert.deepStrictEqual(messages(number), [active, { _tag: "Cancel", runId: active.runId }])

        // Cancellation completion releases the authorized run immediately, not after quiet time.
        yield* pr.finish(active.runId)
        assert.strictEqual(starts(number).length, 2)
        assert.deepStrictEqual(lastStart(number).trigger, trigger)
        assert.strictEqual(lastStart(number).headSha, head(1))
        yield* pr.finish(lastStart(number).runId)
        yield* wait("3 minutes")
        assert.deepStrictEqual(
          messages(number).map((message) => message._tag),
          ["Start", "Cancel", "Start"],
        )
      }
    }),
  )

  it.effect("an oversized thread reply leaves a forced review and its check alone", () =>
    Effect.gen(function* () {
      yield* seed
      github.put({
        number: 32,
        title: "Large change",
        state: "open",
        labels: [],
        pullRequest: {
          headSha: head(1),
          files: [{ filename: "src/large.ts", status: "modified", additions: 10001, deletions: 0 }],
        },
      })
      github.permissions.set("maintainer", { id: 31, permission: "write" })
      yield* settle(
        AdmitPullRequestReview.execute({
          repositoryId,
          number: 32,
          sequence: nextSequence(),
          event: {
            _tag: "Invoked",
            commentId: GitHubCommentDatabaseId.make("601"),
            authorId: GitHubUserDatabaseId.make("31"),
            authorLogin: "maintainer",
          },
        }),
      )
      assert.deepStrictEqual(lastStart(32).trigger, {
        _tag: "Forced",
        invoker: "maintainer",
        commentId: "601",
      })
      // The fake run entity records starts, but leaves GitHub check creation to the test.
      github.checkRuns = [
        {
          id: 700,
          headSha: head(1),
          status: "in_progress",
          conclusion: null,
          output: { title: "Review in progress", summary: "Reviewing the large change." },
        },
      ]
      github.requests.length = 0

      yield* settle(
        AdmitPullRequestReview.execute({
          repositoryId,
          number: 32,
          sequence: nextSequence(),
          event: { _tag: "Replied", commentId: GitHubCommentDatabaseId.make("602") },
        }),
      )

      assert.deepStrictEqual(
        {
          messages: messages(32).slice(1),
          writes: github.writeNames,
        },
        { messages: [], writes: [] },
      )
    }),
  )

  it.effect(
    "wipes itself the configured days after close, and a reopen cancels the wipe",
    () =>
      Effect.gen(function* () {
        yield* seed
        // The 30-day default, shortened so the clock has less to step through.
        env["PR_REVIEW_SCHEDULER_WIPE_DAYS"] = "1"

        const wiped = yield* scheduler(18)
        yield* exhaust(wiped, 18)
        yield* wiped.close
        yield* wait(Duration.sum(Duration.days(1), Duration.minutes(1)))
        // After the wipe the count starts from zero again.
        yield* wiped.reopen(head(1))
        assert.strictEqual(starts(18).length, 11)

        const reopened = yield* scheduler(19)
        yield* exhaust(reopened, 19)
        yield* reopened.close
        yield* wait("12 hours")
        yield* reopened.reopen(head(1))
        yield* wait("1 day")
        // The wipe never ran, so the count still stands.
        yield* reopened.push(head(2))
        assert.strictEqual(starts(19).length, 10)
        assert.deepStrictEqual(
          messages(19)
            .slice(-2)
            .map((message) => [message._tag, message._tag === "Skip" ? message.reason : null]),
          [
            ["Skip", "run_cap"],
            ["Skip", "run_cap"],
          ],
        )
      }).pipe(Effect.ensuring(Effect.sync(() => delete env["PR_REVIEW_SCHEDULER_WIPE_DAYS"]))),
    // Stepping the clock through two and a half days takes several seconds.
    60_000,
  )

  it.effect("disabling a repository cancels the runs of its pull requests", () =>
    Effect.gen(function* () {
      yield* seed
      const store = yield* PullRequestReviewStore
      const first = yield* scheduler(21, otherRepositoryId)
      const second = yield* scheduler(22, otherRepositoryId)
      const elsewhere = yield* scheduler(23, thirdRepositoryId)
      yield* first.push(head(1))
      yield* second.push(head(1))
      yield* elsewhere.push(head(1))

      yield* settle(disableRepository(otherRepositoryId))

      assert.isFalse(yield* store.isEnabled(otherRepositoryId))
      const cancelled = received.flatMap((message) =>
        message._tag === "Cancel" ? [message.runId] : [],
      )
      assert.includeMembers(cancelled, [lastStart(21).runId, lastStart(22).runId])
      assert.notInclude(cancelled, lastStart(23).runId)
    }),
  )

  it.effect("ignores an event older than one it already handled", () =>
    Effect.gen(function* () {
      yield* seed
      const pr = yield* scheduler(24)
      const older = nextSequence()
      // Admission of the later push finished first.
      yield* pr.push(head(2))
      yield* pr.push(head(1), { sequence: older })
      assert.deepStrictEqual(
        messages(24).map((message) => [
          message._tag,
          message._tag === "Start" ? message.headSha : null,
        ]),
        [["Start", head(2)]],
      )
    }),
  )

  it.effect("an oversized push cancels the active run and drops the queued head", () =>
    Effect.gen(function* () {
      yield* seed
      const pr = yield* scheduler(25)
      yield* pr.push(head(1))
      const first = lastStart(25)
      yield* pr.push(head(2))
      yield* pr.push(head(3), { oversized: true })
      yield* pr.finish(first.runId)
      // Neither the queued head nor the oversized one runs.
      assert.deepStrictEqual(
        messages(25).map((message) => message._tag),
        ["Start", "Cancel"],
      )

      // An oversized push mid-run cancels it too.
      yield* wait("3 minutes")
      yield* pr.push(head(4))
      yield* pr.push(head(5), { oversized: true })
      assert.deepStrictEqual(received.at(-1), { _tag: "Cancel", runId: lastStart(25).runId })
    }),
  )

  it.effect("sends what a crash lost between saving its state and sending", () =>
    Effect.gen(function* () {
      yield* seed
      const pr = yield* scheduler(26)

      // The run is saved as active, but its Start never leaves.
      yield* failNextSend("Start")
      yield* pr.push(head(1))
      assert.strictEqual(lastStart(26).headSha, head(1))

      // The run is saved as cancelled, but its Cancel never leaves.
      yield* failNextSend("Cancel")
      yield* pr.push(head(2))
      assert.deepStrictEqual(received.at(-1), { _tag: "Cancel", runId: lastStart(26).runId })
    }),
  )

  it.effect(
    "a newer event that shows the pull request is open cancels the wipe a delayed reopen would have",
    () =>
      Effect.gen(function* () {
        yield* seed
        env["PR_REVIEW_SCHEDULER_WIPE_DAYS"] = "1"
        type Pr = Effect.Success<ReturnType<typeof scheduler>>
        const overtakers: ReadonlyArray<readonly [number, (pr: Pr) => ReturnType<Pr["push"]>]> = [
          [27, (pr) => pr.push(head(2))],
          [28, (pr) => pr.push(head(2), { oversized: true })],
          [29, (pr) => pr.convertToDraft],
          [30, (pr) => pr.rerun(head(2), "503")],
        ]
        const reopens = new Map<number, GitHubWebhookJournalSequence>()
        for (const [number, overtake] of overtakers) {
          const pr = yield* scheduler(number)
          yield* pr.close
          // Reopened, but that admission finishes after a later event's.
          const reopen = nextSequence()
          reopens.set(number, reopen)
          yield* overtake(pr)
          yield* pr.reopen(head(1), { sequence: reopen })
        }

        // Past the close's wipe. Had it run, the scheduler would have forgotten the
        // newest event it handled, along with its run count and any active run, and
        // would now take an older event as new.
        yield* wait(Duration.sum(Duration.days(1), Duration.minutes(1)))
        const restarted: Record<number, number> = {}
        for (const [number] of overtakers) {
          const started = starts(number).length
          yield* (yield* scheduler(number)).push(head(3), { sequence: reopens.get(number)! })
          restarted[number] = starts(number).length - started
        }
        assert.deepStrictEqual(restarted, { 27: 0, 28: 0, 29: 0, 30: 0 })
      }).pipe(Effect.ensuring(Effect.sync(() => delete env["PR_REVIEW_SCHEDULER_WIPE_DAYS"]))),
    // Stepping the clock through a day takes a few seconds.
    60_000,
  )
})
