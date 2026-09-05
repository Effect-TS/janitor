import { SyncIntegration, type CollectionTrack } from "../../src/SyncIntegration.ts"
import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { GitHubInstallationId, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import type { GitHubRepositoryRecord } from "@janitor/domain/GitHub/ReadModel"
import { SyncGeneration, type GitHubRepositoryTrack } from "@janitor/domain/GitHub/Sync"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import {
  GitHubReadModel,
  type IssueObservation,
  type LabelCatalogObservation,
  type PullRequestDetailsObservation,
} from "../../src/GitHub/ReadModel.ts"
import { GitHubHttpCache } from "../../src/GitHub/HttpCache.ts"
import { RefreshEntity, RefreshEntityLayer } from "../../src/GitHub/RefreshEntity.ts"
import {
  SyncRepositoryTrack,
  SyncRepositoryTrackLayer,
} from "../../src/GitHub/SyncRepositoryTrack.ts"
import {
  GitHubTransport,
  type GitHubRequest,
  type GitHubResponse,
} from "../../src/GitHub/Transport.ts"
import { type BeginResult, type CompleteRequest, SyncTargets } from "../../src/SyncTargets.ts"

const repositoryId = GitHubRepositoryDatabaseId.make("456")
const installationId = GitHubInstallationId.make("789")
const generation = SyncGeneration.make("1")
const sequence = GitHubWebhookJournalSequence.make("9")

const repository: GitHubRepositoryRecord = {
  repositoryId,
  nodeId: null,
  installationId,
  owner: "effect",
  repo: "janitor",
  isPrivate: false,
  access: "accessible",
  enabled: true,
  projectedSequence: sequence,
  observedAt: DateTime.makeUnsafe(0),
}

interface Recorder {
  readonly requests: Array<GitHubRequest>
  readonly labels: Array<LabelCatalogObservation>
  readonly issues: Array<IssueObservation>
  readonly pulls: Array<PullRequestDetailsObservation>
  readonly invalidated: Array<import("../../src/SyncTargets.ts").InvalidateRequest>
  readonly missingOpen: Array<number>
  readonly missingDetails: Set<number>
  readonly completed: Array<CompleteRequest>
  readonly collections: Array<
    import("../../src/GitHub/ReadModel.ts").PullRequestCollectionsObservation
  >
}
const makeRecorder = (): Recorder => ({
  requests: [],
  labels: [],
  issues: [],
  pulls: [],
  completed: [],
  invalidated: [],
  missingOpen: [],
  missingDetails: new Set(),
  collections: [],
})

const ok = (body: unknown, link?: string): GitHubResponse => ({
  _tag: "Ok",
  status: 200,
  body,
  etag: Option.none(),
  link: Option.fromUndefinedOr(link),
  requestId: Option.none(),
})
const failed = (status: number): GitHubResponse => ({
  _tag: "Failed",
  status,
  body: {},
  requestId: Option.none(),
})

const services = (
  recorder: Recorder,
  respond: (request: GitHubRequest) => GitHubResponse,
  begin: BeginResult,
  stored: Option.Option<GitHubRepositoryRecord> = Option.some(repository),
  required: ReadonlyArray<CollectionTrack> = [],
) =>
  Layer.mergeAll(
    Layer.succeed(SyncIntegration, {
      requiredCollections: () => Effect.succeed(required),
      trackVerified: () => Effect.void,
      entityVerified: () => Effect.void,
    }),
    Layer.succeed(GitHubHttpCache, {
      get: () => Effect.succeedNone,
      put: () => Effect.void,
      purgeScope: () => Effect.void,
      purgeRepository: () => Effect.void,
    }),
    Layer.succeed(GitHubTransport, {
      request: (request) =>
        Effect.sync(() => {
          recorder.requests.push(request)
          return respond(request)
        }),
    }),
    Layer.succeed(SyncTargets, {
      withRun: (_scope, _generation, effect) => Effect.map(effect, Option.some),
      retryDue: Effect.succeed(0),
      recoverTerminal: () => Effect.void,
      invalidate: (request) =>
        Effect.sync(() => {
          recorder.invalidated.push(request)
          return { generation, dispatched: true }
        }),
      begin: () => Effect.succeed(begin),
      complete: (request) =>
        Effect.sync(() => {
          recorder.completed.push(request)
          return true
        }),
      get: () => Effect.succeedNone,
    }),
    Layer.succeed(GitHubReadModel, {
      listOpenEntityNumbersBefore: () => Effect.succeed(recorder.missingOpen),
      withTransaction: (effect) => effect,
      applyInstallation: () => Effect.void,
      applyRepositories: () => Effect.void,
      markRepositoriesLost: () => Effect.void,
      markRepositoriesSuspect: () => Effect.void,
      applyPullRequest: () => Effect.succeed({ _tag: "Applied" as const }),
      applyLabelCatalog: (observation) => Effect.sync(() => void recorder.labels.push(observation)),
      applyPullRequests: (observation) =>
        Effect.sync(() => {
          for (const pullRequest of observation.pulls)
            recorder.pulls.push({ ...observation, pullRequest })
          return observation.pulls
            .filter((pull) => recorder.missingDetails.has(pull.number))
            .map((pull) => pull.number)
        }),
      applyIssues: (observation) =>
        Effect.sync(() => {
          for (const issue of observation.issues) recorder.issues.push({ ...observation, issue })
        }),
      applyIssue: (observation) =>
        Effect.sync(() => {
          recorder.issues.push(observation)
          return { _tag: "Applied" as const }
        }),
      applyPullRequestDetails: (observation) =>
        Effect.sync(() => {
          recorder.pulls.push(observation)
          return recorder.missingDetails.has(observation.pullRequest.number)
            ? { _tag: "Missing" as const }
            : { _tag: "Applied" as const }
        }),
      getInstallation: () => Effect.succeedNone,
      getRepository: () => Effect.succeed(stored),
      getEntity: () => Effect.succeedNone,
      listLabels: () => Effect.succeed([]),
      listOpenEntities: () => Effect.succeed([]),
      applyPullRequestCollections: (observation) =>
        Effect.sync(() => void recorder.collections.push(observation)),
    }),
  )

const runTrack = (
  track: GitHubRepositoryTrack,
  recorder: Recorder,
  respond: (request: GitHubRequest) => GitHubResponse,
  watermark: Option.Option<DateTime.Utc> = Option.none(),
  stored?: Option.Option<GitHubRepositoryRecord>,
) =>
  SyncRepositoryTrack.execute({
    scope: { _tag: "RepositoryTrack", repositoryId, track },
    generation,
  }).pipe(
    Effect.provide(
      SyncRepositoryTrackLayer.pipe(
        Layer.provide(
          services(
            recorder,
            respond,
            { _tag: "Run", generation, sequence: Option.some(sequence), watermark, full: false },
            stored,
          ),
        ),
        Layer.provideMerge(WorkflowEngine.layerMemory),
      ),
    ),
  )

const label = (id: number, name: string) => ({ id, node_id: `LA_${id}`, name })
const issue = (number: number, updatedAt: string, pull = false) => ({
  id: 1000 + number,
  node_id: `I_${number}`,
  number,
  title: `Issue ${number}`,
  body: null,
  state: "open",
  user: { id: 5, login: "octocat" },
  labels: [label(1, "bug")],
  updated_at: updatedAt,
  ...(pull ? { pull_request: { url: "https://api.github.com/x" } } : {}),
})
const pull = (number: number, updatedAt: string) => ({
  id: 2000 + number,
  node_id: `PR_${number}`,
  number,
  state: "open",
  draft: false,
  merged_at: null,
  updated_at: updatedAt,
  head: { sha: "a".repeat(40) },
  base: { ref: "main" },
})

describe("SyncRepositoryTrack", () => {
  it.effect("scans the label catalog across pages and verifies with a watermark", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const result = yield* runTrack("labels", recorder, (request) =>
        request.url.endsWith("per_page=100")
          ? ok(
              [label(1, "bug")],
              '<https://api.github.com/repos/effect/janitor/labels?per_page=100&page=2>; rel="next"',
            )
          : ok([label(2, "docs")]),
      )

      assert.strictEqual(result.outcome, "verified")
      assert.strictEqual(result.itemCount, 2)
      assert.strictEqual(recorder.requests[0]?.url, "/repos/effect/janitor/labels?per_page=100")
      assert.strictEqual(recorder.requests[0]?.priority, "background")
      assert.deepStrictEqual(
        recorder.labels[0]?.labels.map((entry) => entry.name),
        ["bug", "docs"],
      )
      assert.strictEqual(recorder.labels[0]?.sequence, sequence)
      const completed = recorder.completed[0]?.outcome
      assert.strictEqual(completed?._tag, "Verified")
      if (completed?._tag === "Verified") assert.isTrue(Option.isSome(completed.watermark))
    }),
  )

  it.effect(
    "bootstraps open entities, then scans incrementally from the watermark with overlap",
    () =>
      Effect.gen(function* () {
        const recorder = makeRecorder()

        const first = yield* runTrack("entities", recorder, () =>
          ok([issue(1, "2026-09-02T10:00:00.000Z"), issue(2, "2026-09-02T09:00:00.000Z", true)]),
        )
        assert.strictEqual(first.outcome, "verified")
        assert.include(recorder.requests[0]?.url, "state=open")
        assert.notInclude(recorder.requests[0]?.url, "since=")
        assert.strictEqual(recorder.issues.length, 2)
        assert.strictEqual(recorder.issues[1]?.issue.pullRequest?.url, "https://api.github.com/x")

        const watermark = DateTime.makeUnsafe("2026-09-02T12:00:00.000Z")
        const second = yield* runTrack("entities", recorder, () => ok([]), Option.some(watermark))
        assert.strictEqual(second.outcome, "verified")
        const url = recorder.requests[1]?.url ?? ""
        assert.include(url, "state=all")
        assert.include(url, `since=${encodeURIComponent("2026-09-02T11:50:00.000Z")}`)
        assert.strictEqual(recorder.requests[1]?.priority, "background")
      }),
  )

  it.effect("applies pull request details and drops entries older than the incremental floor", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()
      const watermark = DateTime.makeUnsafe("2026-09-02T12:00:00.000Z")

      const result = yield* runTrack(
        "pull_requests",
        recorder,
        () => ok([pull(7, "2026-09-02T12:30:00.000Z"), pull(8, "2026-09-02T11:00:00.000Z")]),
        Option.some(watermark),
      )

      assert.strictEqual(result.outcome, "verified")
      assert.deepStrictEqual(
        recorder.pulls.map((entry) => entry.pullRequest.number),
        [7],
      )
    }),
  )

  it.effect("blocks on a 404 without applying anything", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const result = yield* runTrack("labels", recorder, () => failed(404))

      assert.strictEqual(result.outcome, "blocked")
      assert.deepStrictEqual(recorder.labels, [])
      assert.deepStrictEqual(recorder.completed[0]?.outcome, {
        _tag: "Blocked",
        reason: "http-404",
      })
    }),
  )

  it.effect("blocks when the repository is unknown or access is lost", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const unknown = yield* runTrack(
        "labels",
        recorder,
        () => ok([]),
        Option.none(),
        Option.none(),
      )
      const lost = yield* runTrack(
        "labels",
        recorder,
        () => ok([]),
        Option.none(),
        Option.some({ ...repository, access: "lost" }),
      )

      assert.strictEqual(unknown.outcome, "blocked")
      assert.strictEqual(lost.outcome, "blocked")
      assert.deepStrictEqual(recorder.requests, [])
      assert.deepStrictEqual(
        recorder.completed.map((entry) => entry.outcome),
        [
          { _tag: "Blocked", reason: "repository-unknown" },
          { _tag: "Blocked", reason: "repository-access-lost" },
        ],
      )
    }),
  )
  it.effect("stops incremental PR traversal after the raw page crosses the overlap", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()
      const result = yield* runTrack(
        "pull_requests",
        recorder,
        () =>
          ok(
            [pull(7, "2026-09-02T12:30:00.000Z"), pull(8, "2026-09-02T11:00:00.000Z")],
            '<https://api.github.com/repos/effect/janitor/pulls?page=2>; rel="next"',
          ),
        Option.some(DateTime.makeUnsafe("2026-09-02T12:00:00.000Z")),
      )
      assert.strictEqual(result.outcome, "verified")
      assert.strictEqual(recorder.requests.length, 1)
      assert.deepStrictEqual(
        recorder.pulls.map((row) => row.pullRequest.number),
        [7],
      )
    }),
  )

  it.live(
    "commits an entity page before fetching the next and never verifies partial scans",
    () =>
      Effect.gen(function* () {
        const recorder = makeRecorder()
        const result = yield* runTrack("entities", recorder, (request) => {
          if (!request.url.includes("page=2"))
            return ok(
              [issue(1, "2026-09-02T12:00:00.000Z")],
              '<https://api.github.com/repos/effect/janitor/issues?page=2>; rel="next"',
            )
          assert.strictEqual(recorder.issues.length, 1)
          return failed(500)
        })
        assert.strictEqual(result.outcome, "failed")
        assert.strictEqual(recorder.completed[0]?.outcome._tag, "Failed")
        assert.strictEqual(recorder.issues.length, 1)
        assert.strictEqual(recorder.requests.length, 5)
      }),
    { timeout: 30000 },
  )
  it.effect("a complete open scan requests targeted verification of missing local entities", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()
      recorder.missingOpen.push(99)
      yield* runTrack("entities", recorder, () => ok([]))
      assert.deepStrictEqual(
        recorder.invalidated.map((request) => request.scope),
        [{ _tag: "Entity", repositoryId, number: 99 }],
      )
      assert.strictEqual(recorder.issues.length, 0)
    }),
  )

  it.effect("a missing canonical identity refreshes only that entity", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()
      recorder.missingDetails.add(7)
      yield* runTrack("pull_requests", recorder, () => ok([pull(7, "2026-09-02T12:00:00.000Z")]))
      assert.deepStrictEqual(
        recorder.invalidated.map((request) => request.scope),
        [{ _tag: "Entity", repositoryId, number: 7 }],
      )
      assert.strictEqual(recorder.requests.length, 1)
    }),
  )
})

describe("RefreshEntity", () => {
  const runRefresh = (
    recorder: Recorder,
    respond: (request: GitHubRequest) => GitHubResponse,
    required: ReadonlyArray<CollectionTrack> = [],
  ) =>
    RefreshEntity.execute({ scope: { _tag: "Entity", repositoryId, number: 42 }, generation }).pipe(
      Effect.provide(
        RefreshEntityLayer.pipe(
          Layer.provide(
            services(
              recorder,
              respond,
              {
                _tag: "Run",
                generation,
                sequence: Option.some(sequence),
                watermark: Option.none(),
                full: false,
              },
              Option.some(repository),
              required,
            ),
          ),
          Layer.provideMerge(WorkflowEngine.layerMemory),
        ),
      ),
    )

  it.effect("fetches the issue and pull request details for a pull request entity", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const result = yield* runRefresh(recorder, (request) =>
        request.url.endsWith("/issues/42")
          ? ok(issue(42, "2026-09-02T10:00:00.000Z", true))
          : ok(pull(42, "2026-09-02T10:00:00.000Z")),
      )

      assert.strictEqual(result.outcome, "verified")
      assert.deepStrictEqual(
        recorder.requests.map((request) => [request.url, request.priority]),
        [
          ["/repos/effect/janitor/issues/42", "background"],
          ["/repos/effect/janitor/pulls/42", "background"],
        ],
      )
      assert.strictEqual(recorder.issues.length, 1)
      assert.strictEqual(recorder.pulls.length, 1)
      assert.deepStrictEqual(recorder.completed[0]?.outcome, {
        _tag: "Verified",
        watermark: Option.none(),
      })
    }),
  )

  it.effect("treats a 404 as ambiguous and blocks instead of deleting", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const result = yield* runRefresh(recorder, () => failed(404))

      assert.strictEqual(result.outcome, "blocked")
      assert.deepStrictEqual(recorder.issues, [])
      assert.deepStrictEqual(recorder.completed[0]?.outcome, {
        _tag: "Blocked",
        reason: "entity-http-404",
      })
    }),
  )
  it.effect("fetches only required reviews and follows all review pages", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()
      const review = (id: number, state: string) => ({
        id,
        user: { id: 5, login: "octocat" },
        state,
      })
      const result = yield* runRefresh(
        recorder,
        (request) => {
          if (request.url.endsWith("/issues/42"))
            return ok(issue(42, "2026-09-02T10:00:00.000Z", true))
          if (request.url.endsWith("/pulls/42")) return ok(pull(42, "2026-09-02T10:00:00.000Z"))
          if (request.url.includes("page=2")) return ok([review(2, "CHANGES_REQUESTED")])
          return ok(
            [review(1, "APPROVED")],
            '<https://api.github.com/repos/effect/janitor/pulls/42/reviews?per_page=100&page=2>; rel="next"',
          )
        },
        ["reviews"],
      )
      assert.strictEqual(result.outcome, "verified")
      assert.strictEqual(recorder.requests.length, 4)
      assert.isFalse(
        recorder.requests.some(
          (request) => request.url.includes("/files") || request.url.includes("/check-runs"),
        ),
      )
      assert.deepStrictEqual(recorder.collections[0]?.collections.reviews, [
        { reviewer: "octocat", state: "CHANGES_REQUESTED" },
      ])
    }),
  )
})
