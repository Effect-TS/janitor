import { SyncIntegration } from "../../src/SyncIntegration.ts"
import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { TestClock } from "effect/testing"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { GitHubInstallationId, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { SyncGeneration } from "@janitor/domain/GitHub/Sync"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import {
  GitHubReadModel,
  type RepositoriesObservation,
  type RepositoriesPresence,
} from "../../src/GitHub/ReadModel.ts"
import { GitHubHttpCache } from "../../src/GitHub/HttpCache.ts"
import {
  SyncInstallationInventory,
  SyncInstallationInventoryLayer,
} from "../../src/GitHub/SyncInstallationInventory.ts"
import {
  GitHubRateLimited,
  GitHubTransport,
  type GitHubRequest,
  type GitHubResponse,
} from "../../src/GitHub/Transport.ts"
import { type BeginResult, type CompleteRequest, SyncTargets } from "../../src/SyncTargets.ts"

interface Recorder {
  readonly requests: Array<GitHubRequest>
  readonly applied: Array<RepositoriesObservation>
  readonly presence: Array<RepositoriesPresence>
  readonly completed: Array<CompleteRequest>
  readonly installations: Array<string>
}

const makeRecorder = (): Recorder => ({
  requests: [],
  applied: [],
  presence: [],
  completed: [],
  installations: [],
})

const installationId = GitHubInstallationId.make("789")
const scope = { _tag: "InstallationInventory" as const, installationId }

const installationBody = {
  id: 789,
  account: { id: 1, login: "effect", type: "Organization" },
  repository_selection: "selected",
  html_url: "https://github.com/settings/installations/789",
  suspended_at: null,
}

const ok = (body: unknown, link?: string): GitHubResponse => ({
  _tag: "Ok",
  status: 200,
  body,
  etag: Option.none(),
  link: Option.fromUndefinedOr(link),
  requestId: Option.none(),
})

const run = (
  recorder: Recorder,
  respond: (
    request: GitHubRequest,
    index: number,
  ) => Effect.Effect<GitHubResponse, GitHubRateLimited>,
  begin: BeginResult = {
    _tag: "Run",
    generation: SyncGeneration.make("1"),
    sequence: Option.some(GitHubWebhookJournalSequence.make("9")),
    watermark: Option.none(),
    full: false,
  },
) =>
  SyncInstallationInventory.execute({ scope, generation: SyncGeneration.make("1") }).pipe(
    Effect.provide(
      SyncInstallationInventoryLayer.pipe(
        Layer.provide(SyncIntegration.noop),
        Layer.provide(
          Layer.succeed(GitHubHttpCache, {
            get: () => Effect.succeedNone,
            put: () => Effect.void,
            purgeScope: () => Effect.void,
            purgeRepository: () => Effect.void,
          }),
        ),
        Layer.provide(
          Layer.succeed(GitHubTransport, {
            request: (request) =>
              Effect.suspend(() => {
                recorder.requests.push(request)
                return respond(request, recorder.requests.length - 1)
              }),
          }),
        ),
        Layer.provide(
          Layer.succeed(SyncTargets, {
            withRun: (_scope, _generation, effect) => Effect.map(effect, Option.some),
            retryDue: Effect.succeed(0),
            retryFailedEntities: () => Effect.succeed(0),
            recoverTerminal: () => Effect.void,
            invalidate: () => Effect.die("unused"),
            begin: () => Effect.succeed(begin),
            complete: (request) =>
              Effect.sync(() => {
                recorder.completed.push(request)
                return true
              }),
            get: () => Effect.succeedNone,
          }),
        ),
        Layer.provide(
          Layer.succeed(GitHubReadModel, {
            listOpenEntityNumbersBefore: () => Effect.succeed([]),
            withTransaction: (effect) => effect,
            applyInstallation: (observation) =>
              Effect.sync(() => void recorder.installations.push(observation.status)),
            applyRepositories: (observation) =>
              Effect.sync(() => void recorder.applied.push(observation)),
            markRepositoriesLost: () => Effect.void,
            markRepositoriesSuspect: (presence) =>
              Effect.sync(() => void recorder.presence.push(presence)),
            applyPullRequest: () => Effect.succeed({ _tag: "Applied" as const }),
            applyLabelCatalog: () => Effect.void,
            applyPullRequests: () => Effect.succeed([]),
            applyIssues: () => Effect.void,
            applyIssue: () => Effect.succeed({ _tag: "Applied" as const }),
            applyPullRequestDetails: () => Effect.succeed({ _tag: "Applied" as const }),
            getInstallation: () => Effect.succeedNone,
            getRepository: () => Effect.succeedNone,
            getEntity: () => Effect.succeedNone,
            listLabels: () => Effect.succeed([]),
            listOpenEntities: () => Effect.succeed([]),
            applyPullRequestCollections: () => Effect.void,
          }),
        ),
        Layer.provideMerge(WorkflowEngine.layerMemory),
      ),
    ),
  )

describe("SyncInstallationInventory", () => {
  it.effect("verifies an installation across paginated repositories", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const result = yield* run(recorder, (request) => {
        if (request.url.startsWith("/app/installations/"))
          return Effect.succeed(ok(installationBody))
        if (request.url === "/installation/repositories?per_page=100") {
          return Effect.succeed(
            ok(
              {
                total_count: 2,
                repositories: [{ id: 1, full_name: "effect/one", private: false }],
              },
              '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"',
            ),
          )
        }
        return Effect.succeed(
          ok({ total_count: 2, repositories: [{ id: 2, full_name: "effect/two", private: true }] }),
        )
      })

      assert.deepStrictEqual(result, {
        installationId,
        generation: SyncGeneration.make("1"),
        outcome: "verified",
        repositoryCount: 2,
      })
      assert.deepStrictEqual(
        recorder.requests.map((request) => [request.scope._tag, request.url]),
        [
          ["App", "/app/installations/789"],
          ["Installation", "/installation/repositories?per_page=100"],
          ["Installation", "https://api.github.com/installation/repositories?per_page=100&page=2"],
        ],
      )
      assert.deepStrictEqual(recorder.installations, ["active"])
      assert.deepStrictEqual(
        recorder.applied[0]?.repositories.map((repository) => repository.id),
        [GitHubRepositoryDatabaseId.make("1"), GitHubRepositoryDatabaseId.make("2")],
      )
      assert.strictEqual(recorder.applied[0]?.sequence, "9")
      assert.deepStrictEqual(recorder.presence[0]?.present, [
        GitHubRepositoryDatabaseId.make("1"),
        GitHubRepositoryDatabaseId.make("2"),
      ])
      assert.deepStrictEqual(recorder.completed, [
        {
          scope,
          generation: SyncGeneration.make("1"),
          outcome: { _tag: "Verified", watermark: Option.none() },
        },
      ])
    }),
  )

  it.effect("blocks when the installation is gone and never lists repositories", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const result = yield* run(recorder, () =>
        Effect.succeed({ _tag: "Failed", status: 404, body: {}, requestId: Option.none() }),
      )

      assert.strictEqual(result.outcome, "blocked")
      assert.strictEqual(recorder.requests.length, 1)
      assert.deepStrictEqual(recorder.completed[0]?.outcome, {
        _tag: "Blocked",
        reason: "installation-not-found",
      })
      assert.deepStrictEqual(recorder.applied, [])
    }),
  )

  it.effect("sleeps on a durable clock when rate limited and then continues", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()
      const start = yield* DateTime.now
      const until = DateTime.addDuration(start, "30 seconds")
      const firstRequest = yield* Deferred.make<void>()

      const fiber = yield* run(recorder, (request, index) => {
        if (index === 0)
          return Deferred.succeed(firstRequest, undefined).pipe(
            Effect.andThen(
              Effect.fail(new GitHubRateLimited({ scopeKey: "app", until, reason: "reserve" })),
            ),
          )
        if (request.url.startsWith("/app/installations/"))
          return Effect.succeed(ok(installationBody))
        return Effect.succeed(ok({ total_count: 0, repositories: [] }))
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Deferred.await(firstRequest)
      yield* TestClock.adjust("29 seconds")
      assert.strictEqual(recorder.requests.length, 1)
      assert.deepStrictEqual(recorder.completed, [])
      yield* TestClock.adjust("2 seconds")

      const result = yield* Fiber.join(fiber)
      assert.strictEqual(result.outcome, "verified")
      assert.strictEqual(recorder.requests.length, 3)
    }),
  )

  it.effect("returns superseded without calling GitHub when a newer generation completed", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const result = yield* run(recorder, () => Effect.succeed(ok({})), { _tag: "Superseded" })

      assert.strictEqual(result.outcome, "superseded")
      assert.deepStrictEqual(recorder.requests, [])
      assert.deepStrictEqual(recorder.completed, [])
    }),
  )

  it.effect("records a failed outcome when a page does not decode", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const result = yield* run(recorder, (request) =>
        Effect.succeed(request.url.startsWith("/app/") ? ok(installationBody) : ok({ nope: true })),
      )

      assert.strictEqual(result.outcome, "failed")
      assert.strictEqual(recorder.completed[0]?.outcome._tag, "Failed")
      assert.deepStrictEqual(recorder.applied, [])
    }),
  )
})
