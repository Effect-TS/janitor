import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import * as AgentExecutor from "clanka/AgentExecutor"
import * as Prompt from "effect/ai/Prompt"
import * as Clock from "effect/Clock"
import * as Entity from "effect/cluster/Entity"
import * as MessageStorage from "effect/cluster/MessageStorage"
import * as RunnerHealth from "effect/cluster/RunnerHealth"
import * as Runners from "effect/cluster/Runners"
import * as RunnerStorage from "effect/cluster/RunnerStorage"
import * as Sharding from "effect/cluster/Sharding"
import * as ShardingConfig from "effect/cluster/ShardingConfig"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as Scope from "effect/Scope"
import type * as SqlClient from "effect/sql/SqlClient"
import * as TestClock from "effect/testing/TestClock"
import { GitHubCommitSha } from "@janitor/domain/GitHub/Id"
import type { RunId, Trigger } from "@janitor/domain/PullRequestReview/Run"
import type { GitHubTransport } from "../../src/GitHub/Transport.ts"
import { RepositoryEligibility } from "../../src/RepositoryEligibility.ts"
import {
  type AgentStep,
  type LoopEnd,
  type LoopOutcome,
  ReviewAgent,
  type ReviewSession,
  type StartOptions,
} from "../../src/PullRequestReview/Agent.ts"
import {
  PullRequestReviewRun,
  PullRequestReviewRunLayer,
  RunPublisher,
} from "../../src/PullRequestReview/RunEntity.ts"
import {
  ContainerUnavailable,
  type AcquireInput,
  WorkspaceReleased,
} from "../../src/PullRequestReview/Sandbox/Workspace.ts"
import { SandboxWorkspaces } from "../../src/PullRequestReview/Sandbox/WorkspaceClient.ts"
import { PullRequestScheduler } from "../../src/PullRequestReview/Scheduler.ts"
import {
  PullRequestReviewStore,
  PullRequestReviewStoreError,
} from "../../src/PullRequestReview/Store.ts"
import { FakeReviewGitHub } from "./fakeGitHub.ts"
import { drain, failNextSend, repositoryId, settle } from "./support.ts"

/**
 * The run entity under test, the way the cluster runs it: an in-memory runner
 * over message storage and Durable Object SQLite that outlive it, so a test
 * can restart the runner the way a deploy or an eviction rebuilds the entity.
 * Around it are fakes for what it drives: the agent, the sandbox workspace,
 * the `Publish` batch and the per-PR scheduler. GitHub is `FakeReviewGitHub`
 * for pull request 7 of `effect/one`, and Postgres is the test database.
 */

/** The head every run in the harness reviews, unless a test moves it. */
export const HEAD = GitHubCommitSha.make("a".repeat(40))

/** The executor the fake workspace hands out by default. The fake agent never runs a command. */
const neverRuns = Layer.effect(
  AgentExecutor.AgentExecutor,
  Effect.die(new Error("The fake agent never runs commands")),
)

/**
 * One agent loop, driven by the test: `step` reports what a step did and
 * waits for the run entity to commit it, `complete` and `fail` end the loop. `sent` is what the loop was told, in order: the prompt it started
 * from, then each steering message.
 */
export class FakeSession {
  readonly history: ReadonlyArray<Prompt.Message>
  readonly sent: Array<string> = []
  /** Interrupted, or its scope closed, while the loop ran. */
  stopped = false
  /** Its runner restarted: like a process that died, it no longer answers. */
  lost = false
  private readonly end = Deferred.makeUnsafe<LoopEnd>()

  constructor(
    private readonly options: StartOptions,
    private readonly events: Array<string>,
    /** The review standards sources the loop reports it applied. */
    private readonly standardsSources: ReadonlyArray<string> = [],
  ) {
    this.history = options.history
    if (options.prompt !== undefined) this.sent.push(options.prompt)
  }

  get runId() {
    return this.options.runId
  }

  step(step: AgentStep) {
    return this.options.onStep(step)
  }

  complete(summary: string) {
    return Deferred.succeed(this.end, { _tag: "Completed", summary })
  }

  fail(message: string) {
    return Deferred.succeed(this.end, { _tag: "Failed", message })
  }

  /** Records the loop stopping, once, however it was stopped. */
  stop() {
    if (this.stopped || this.lost) return
    this.stopped = true
    this.events.push("agent stopped")
  }

  get handle(): ReviewSession {
    return {
      standardsSources: this.standardsSources,
      steer: (message) =>
        Effect.sync(() => {
          if (!this.lost) this.sent.push(message)
        }),
      interrupt: Effect.suspend(() => {
        if (this.lost) return Effect.void
        this.stop()
        return Deferred.succeed(this.end, { _tag: "Interrupted" })
      }),
      result: Deferred.await(this.end),
    }
  }
}

/** The agent behind the run entity: every acquire starts one `FakeSession`. */
export class FakeReviewAgent {
  readonly sessions: Array<FakeSession> = []
  /** While set, a starting loop waits for it, as a slow agent start would. */
  held: Deferred.Deferred<void> | undefined
  /** How many starts were asked for, including ones still held. */
  starts = 0
  /** The review standards sources every loop started from now on applies. */
  standardsSources: ReadonlyArray<string> = []

  constructor(private readonly events: Array<string>) {}

  /** The session the run's latest acquire started. */
  get last(): FakeSession {
    const session = this.sessions.at(-1)
    if (session === undefined) throw new Error("No agent session started")
    return session
  }

  get layer() {
    return Layer.succeed(ReviewAgent, {
      start: (options) =>
        Effect.gen({ self: this }, function* () {
          this.starts += 1
          if (this.held !== undefined) yield* Deferred.await(this.held)
          const session = new FakeSession(options, this.events, this.standardsSources)
          yield* Effect.addFinalizer(() => Effect.sync(() => session.stop()))
          this.sessions.push(session)
          return session.handle
        }),
    })
  }
}

/**
 * The sandbox workspaces: every acquire succeeds unless `unavailable` says
 * otherwise. Releasing a workspace destroys its container, so a loop still
 * running on it fails, as a real one would. Like the workspace DO, a released
 * workspace stays released: a later acquire for the run fails.
 */
export class FakeWorkspaces {
  readonly acquires: Array<AcquireInput & { readonly at: number }> = []
  readonly releases: Array<string> = []
  /** How many more acquires find no container, as at `max_instances`. */
  unavailable = 0

  constructor(
    private readonly events: Array<string>,
    private readonly agent: FakeReviewAgent,
    /** The executor each acquire hands out, by acquire number from 0; one that never runs a command by default. */
    private readonly executor: (acquire: number) => Layer.Layer<AgentExecutor.AgentExecutor> = () =>
      neverRuns,
  ) {}

  get layer() {
    return Layer.succeed(SandboxWorkspaces, {
      acquire: (input) =>
        Effect.flatMap(
          Clock.currentTimeMillis,
          (at): ReturnType<SandboxWorkspaces["Service"]["acquire"]> => {
            this.acquires.push({ ...input, at })
            if (this.releases.includes(input.runId)) return Effect.fail(new WorkspaceReleased())
            if (this.unavailable <= 0)
              return Effect.succeed(this.executor(this.acquires.length - 1))
            this.unavailable -= 1
            return Effect.fail(new ContainerUnavailable({ reason: "max_instances reached" }))
          },
        ),
      release: (runId) =>
        Effect.gen({ self: this }, function* () {
          this.releases.push(runId)
          this.events.push("workspace released")
          for (const session of this.agent.sessions)
            if (session.runId === runId && !session.stopped && !session.lost)
              yield* session.fail("the sandbox was destroyed")
        }),
    })
  }
}

/**
 * One runner with the run entity on it. Every runner built from this opens
 * the Durable Object's SQLite file afresh and closes it when it stops, so
 * work a stopped runner left behind can't write to the next one's storage.
 */
const makeRunner = (options: {
  readonly filename: string
  readonly storage: Context.Context<MessageStorage.MemoryDriver>
  readonly services: Layer.Layer<
    | SandboxWorkspaces
    | ReviewAgent
    | RunPublisher
    | PullRequestReviewStore
    | RepositoryEligibility
    | GitHubTransport,
    never,
    SqlClient.SqlClient | Sharding.Sharding
  >
  readonly scheduler: Layer.Layer<never, never, Sharding.Sharding>
}) => {
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
    Layer.provideMerge(Layer.succeedContext(options.storage)),
  )
  const DurableObjectStorage = Layer.effect(
    CloudflareCluster.DurableObjectSqlClient,
    SqliteClient.make({ filename: options.filename }),
  ).pipe(Layer.provide(Reactivity.layer))
  return Layer.mergeAll(PullRequestReviewRunLayer, options.scheduler).pipe(
    Layer.provideMerge(options.services),
    Layer.provideMerge(DurableObjectStorage),
    Layer.provideMerge(Cluster),
  )
}

/** Lets the event loop run, so real I/O such as a Postgres reply can land; the test clock stays put. */
const yieldToIo = TestClock.withLive(Effect.sleep(Duration.millis(1)))

/** What a `RunPublisher` layer handed to the harness may use. */
export type PublisherServices =
  | PullRequestReviewStore
  | RepositoryEligibility
  | GitHubTransport
  | Sharding.Sharding
  | SqlClient.SqlClient

export interface RunHarnessOptions {
  /**
   * The `Publish` batch to run. Without one, a fake records what it was
   * handed in `published` and does nothing else.
   */
  readonly publisher?: Layer.Layer<RunPublisher, never, PublisherServices>
  /** The agent to run. Without one, `agent` is a `FakeReviewAgent` the test drives. */
  readonly agent?: Layer.Layer<ReviewAgent>
  /** The executor each acquire hands out, by acquire number from 0. */
  readonly executor?: (acquire: number) => Layer.Layer<AgentExecutor.AgentExecutor>
}

/**
 * Builds the harness for one test. Each test gets its own Durable Object
 * storage, so a run's tables are its own, as on Cloudflare.
 */
export const makeRunHarnessWith = Effect.fnUntraced(function* (options: RunHarnessOptions) {
  const github = new FakeReviewGitHub(7).put({
    number: 7,
    title: "Change",
    state: "open",
    labels: [],
    pullRequest: { headSha: HEAD },
  })
  /** The agent and workspace lifecycle, in the order it happened. */
  const events: Array<string> = []
  const agent = new FakeReviewAgent(events)
  const workspaces = new FakeWorkspaces(events, agent, options.executor)
  /** What the `Publish` batch was handed, in order. */
  const published: Array<{ readonly runId: RunId; readonly outcome: LoopOutcome }> = []
  /** The `RunFinished` messages the per-PR scheduler received, in order. */
  const finished: Array<{ readonly runId: RunId; readonly finishedAt: DateTime.Utc }> = []
  /**
   * While set, writing a run's start row, or its final row, fails, as when
   * Postgres is down. `cutOffFindings` lets the next findings insert land,
   * then never answers, as when the runner stops mid-request; it clears
   * itself once it has.
   */
  const postgres = { failStartRow: false, failFinalRow: false, cutOffFindings: false }

  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "janitor-run-entity-" })
  const filename = path.join(directory, "durable-object.sqlite")
  const storage = yield* Layer.build(MessageStorage.MemoryDriver.layer)

  const store = Layer.effect(
    PullRequestReviewStore,
    Effect.map(PullRequestReviewStore.make, (live) => ({
      ...live,
      start: (run: Parameters<typeof live.start>[0]) =>
        postgres.failStartRow
          ? Effect.fail(
              new PullRequestReviewStoreError({
                operation: "start",
                message: "Postgres is down",
              }),
            )
          : live.start(run),
      finish: (run: Parameters<typeof live.finish>[0]) =>
        postgres.failFinalRow
          ? Effect.fail(
              new PullRequestReviewStoreError({
                operation: "finish",
                message: "Postgres is down",
              }),
            )
          : live.finish(run),
      addFindings: (...args: Parameters<typeof live.addFindings>) =>
        postgres.cutOffFindings
          ? Effect.andThen(
              live.addFindings(...args),
              Effect.suspend(() => {
                postgres.cutOffFindings = false
                return Effect.never
              }),
            )
          : live.addFindings(...args),
    })),
  )
  const fakePublisher = Layer.succeed(RunPublisher, {
    publish: (run) =>
      Effect.sync(() => {
        published.push({ runId: run.runId, outcome: run.outcome })
      }),
  })
  const publisher =
    options.publisher === undefined
      ? fakePublisher
      : options.publisher.pipe(
          Layer.provide(Layer.mergeAll(store, RepositoryEligibility.layer, github.layer)),
        )
  const ignore = () => Effect.void
  const scheduler = PullRequestScheduler.toLayer(
    PullRequestScheduler.of({
      HeadChanged: ignore,
      Reopened: ignore,
      Closed: ignore,
      ConvertedToDraft: ignore,
      Rerun: ignore,
      RunFinished: ({ payload }) =>
        Effect.sync(() => {
          finished.push(payload)
        }),
      RunOverdue: ignore,
      RepoDisabled: ignore,
      CooldownElapsed: ignore,
      Wipe: ignore,
    }),
  )
  const Runner = makeRunner({
    filename,
    storage,
    services: Layer.mergeAll(
      options.agent ?? agent.layer,
      workspaces.layer,
      publisher,
      store,
      RepositoryEligibility.layer,
      github.layer,
    ),
    scheduler,
  })

  let scope = yield* Scope.make()
  let runner = yield* Layer.buildWithScope(Runner, scope)
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))

  /** Runs `effect` against the current runner. */
  const use = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => Effect.provideContext(effect, runner))

  const client = (runId: RunId) =>
    use(Effect.map(PullRequestReviewRun.client, (make) => make(runId)))

  /**
   * Moves the clock in small steps, the way the runner's polling can follow,
   * until `done` holds, then drains.
   */
  const until = (done: Effect.Effect<boolean>, what: string) =>
    Effect.gen(function* () {
      for (let step = 0; !(yield* done); step++) {
        if (step === 2_000) return yield* Effect.die(new Error(`Timed out waiting for ${what}`))
        yield* yieldToIo
        yield* TestClock.adjust(Duration.millis(100))
      }
      yield* use(drain)
    })

  /**
   * Runs `effect` to completion while moving the clock, as `settle` does, but
   * without draining: a stopping runner leaves work for the next one.
   */
  const stepping = <A, E>(effect: Effect.Effect<A, E>, what: string) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(effect)
      for (let step = 0; fiber.pollUnsafe() === undefined; step++) {
        if (step === 2_000) return yield* Effect.die(new Error(`Timed out waiting for ${what}`))
        yield* yieldToIo
        yield* TestClock.adjust(Duration.millis(100))
      }
      return yield* Fiber.join(fiber)
    })

  const startPayload = (
    runId: RunId,
    options: { readonly headSha?: GitHubCommitSha; readonly trigger?: Trigger },
  ) => ({
    runId,
    repositoryId,
    number: 7,
    headSha: options.headSha ?? HEAD,
    trigger: options.trigger ?? { _tag: "Automatic" as const },
  })

  return {
    github,
    agent,
    workspaces,
    events,
    published,
    finished,
    postgres,

    /** Sends `Start` for a new run, as the scheduler does, and waits until it is handled. */
    start: (
      runId: RunId,
      options: { readonly headSha?: GitHubCommitSha; readonly trigger?: Trigger } = {},
    ) =>
      Effect.flatMap(client(runId), (run) => use(settle(run.Start(startPayload(runId, options))))),

    /** Sends `Start` without waiting for it, for a start that takes as long as its deadline. */
    send: (runId: RunId) =>
      Effect.flatMap(client(runId), (run) =>
        Effect.asVoid(Effect.forkChild(run.Start(startPayload(runId, {})))),
      ),

    cancel: (runId: RunId) =>
      Effect.flatMap(client(runId), (run) => use(settle(run.Cancel({ runId })))),

    /** Sends `Cancel` and waits for its reply, without waiting for a `Start` still in flight. */
    cancelNow: (runId: RunId) =>
      Effect.flatMap(client(runId), (run) => stepping(run.Cancel({ runId }), "Cancel")),

    /** Moves the clock in small steps until `done` holds, without draining. */
    waitFor: (done: Effect.Effect<boolean>, what: string) =>
      stepping(
        Effect.gen(function* () {
          while (!(yield* done)) yield* Effect.sleep(Duration.millis(100))
        }),
        what,
      ),

    /** Loses the next message with RPC tag `tag`, as a crash before it was stored would. */
    failNextSend: (tag: string) => use(failNextSend(tag)),

    /** Waits until the runner handled everything that's due, including what that sent on. */
    drain: use(drain),

    until,

    /**
     * Moves the clock by `duration` in steps of at most `step`, then drains.
     * Small steps let timers inside the run, and the runner's polling for
     * messages it delivers later, fire close to their time.
     */
    wait: (duration: Duration.Input, step: Duration.Input = "5 seconds") =>
      Effect.gen(function* () {
        const total = Duration.toMillis(Duration.fromInputUnsafe(duration))
        const each = Duration.toMillis(Duration.fromInputUnsafe(step))
        for (let elapsed = 0; elapsed < total; elapsed += each) {
          yield* TestClock.adjust(Duration.millis(Math.min(each, total - elapsed)))
          yield* yieldToIo
        }
        yield* use(drain)
      }),

    /**
     * Stops the runner, the way a deploy or an eviction does, and starts a new
     * one over the same storage. The old runner's agent sessions are lost.
     */
    restart: Effect.gen(function* () {
      for (const session of agent.sessions) session.lost = true
      yield* stepping(Scope.close(scope, Exit.void), "the runner to stop")
      scope = yield* Scope.make()
      runner = yield* Layer.buildWithScope(Runner, scope)
    }),

    /** Whether the run's entity holds keep-alive, so the runner rebuilds it after a restart. */
    keptAlive: (runId: RunId) =>
      Effect.sync(() =>
        [...Context.get(storage, MessageStorage.MemoryDriver).unprocessed].some(
          (envelope) =>
            envelope._tag === "Request" &&
            envelope.tag === Entity.KeepAliveRpc._tag &&
            envelope.address.entityId === runId,
        ),
      ),

    /** The tables in the run's Durable Object storage. */
    tables: use(
      Effect.gen(function* () {
        const sql = yield* CloudflareCluster.DurableObjectSqlClient
        const rows = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
        return rows.map((row) => row.name)
      }).pipe(Effect.orDie),
    ),

    /** The run's history rows, in order, without changing them as a resume would. */
    history: (runId: RunId) =>
      use(
        Effect.gen(function* () {
          const sql = yield* CloudflareCluster.DurableObjectSqlClient
          const rows = yield* sql<{ message: string }>`
          SELECT message FROM pr_review_run_history WHERE run_id = ${runId} ORDER BY seq`
          return yield* Effect.forEach(rows, (row) =>
            Schema.decodeEffect(Schema.fromJsonString(Prompt.Message))(row.message),
          )
        }).pipe(Effect.orDie),
      ),

    /** The run's Postgres row, if it has one. */
    row: (runId: RunId) =>
      Effect.gen(function* () {
        const store = yield* PullRequestReviewStore
        const page = yield* store.runs(repositoryId, { limit: 100, cursor: Option.none() })
        return page.runs.find((run) => run.runId === runId)
      }).pipe(use),

    /** The findings recorded for the run in Postgres. */
    findings: (runId: RunId) =>
      Effect.gen(function* () {
        const store = yield* PullRequestReviewStore
        return yield* store.findings(runId)
      }).pipe(use),

    /** How many `RunFinished` messages the scheduler received for the run. */
    finishedCount: (runId: RunId) => finished.filter((message) => message.runId === runId).length,
  }
})

/** The harness with the fake `Publish` batch. */
export const makeRunHarness = makeRunHarnessWith({})

export type RunHarness = Effect.Success<typeof makeRunHarness>
