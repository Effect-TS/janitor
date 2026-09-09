import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Fiber from "effect/Fiber"
import * as Deferred from "effect/Deferred"
import * as Option from "effect/Option"
import { TestClock } from "effect/testing"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import { GitHubTransport, type GitHubRequest } from "../../src/GitHub/Transport.ts"
import {
  AiClassifier,
  AiConsentService,
  ClassifierProvider,
  ClassifierProviderError,
  type ClassifierAnswer,
} from "../../src/Labeling/Classifier.ts"
import { GitHubReadModel } from "../../src/GitHub/ReadModel.ts"
import { RepositoryConnections } from "../../src/RepositoryConnections.ts"
import {
  RuleTestJobLayer,
  TestWorkflow,
  enqueueRuleTest,
  getRuleTest,
} from "../../src/Labeling/RuleTestJob.ts"
import { activityPage } from "../../src/Labeling/Activity.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { ReconcileEntity, ReconcileEntityLayer } from "../../src/Labeling/ReconcileEntity.ts"
import { SnapshotHandoff } from "../../src/Labeling/SnapshotHandoff.ts"
import { SyncTargets } from "../../src/SyncTargets.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import {
  actor,
  installationId,
  feature,
  LabelingLayer,
  repositoryId,
  seed,
  seedPullRequests,
} from "./support.ts"

const writes: Array<GitHubRequest> = []
let ask: Effect.Effect<ClassifierAnswer, ClassifierProviderError> = Effect.die(
  "Provider response not set",
)
const services = Layer.mergeAll(
  ReconcileEntityLayer,
  RuleTestJobLayer,
  RepositoryConnections.layer,
).pipe(
  Layer.provideMerge(LabelingLayer),
  Layer.provideMerge(AiClassifier.layer),
  Layer.provideMerge(AiConsentService.layer),
  Layer.provideMerge(
    Layer.succeed(ClassifierProvider, {
      identity: { provider: "test", model: "test" },
      ask: () => Effect.suspend(() => ask),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(GitHubTransport, {
      request: (request) =>
        Effect.sync(() => {
          writes.push(request)
          return {
            _tag: "Ok" as const,
            status: 200,
            body: {},
            etag: Option.none(),
            link: Option.none(),
            requestId: Option.none(),
          }
        }),
    }),
  ),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(MigratedPostgresLayer),
)

let scenario = 0
const prepare = Effect.gen(function* () {
  yield* seed
  yield* seedPullRequests
  writes.length = 0
  const rules = yield* LabelingRules
  const existing = (yield* rules.list(repositoryId))[0]
  const ai = {
    target: "pull_request" as const,
    prompt: "Read {{fact:title}} scenario " + ++scenario,
    minimumConfidence: 0.8,
  }
  if (!existing)
    yield* (yield* LabelingRules).create(
      repositoryId,
      {
        ai,
        labelId: feature,
        onMatch: "ensure-present",
        onNoMatch: "ensure-absent",
        group: null,
        priority: 0,
        enabled: true,
      },
      actor,
    )
  else yield* rules.patch(repositoryId, existing.id, { version: existing.version, ai }, actor)
  yield* (yield* AiConsentService).set(repositoryId, true, actor)
  const targets = yield* SyncTargets
  const scope = { _tag: "Entity" as const, repositoryId, number: 5 }
  const sequence = GitHubWebhookJournalSequence.make("2")
  const { generation } = yield* targets.invalidate({ scope, sequence: Option.some(sequence) })
  yield* targets.begin(scope, generation)
  yield* targets.complete({
    scope,
    generation,
    outcome: { _tag: "Verified", watermark: Option.none() },
  })
  const published = yield* (yield* SnapshotHandoff).publish({
    repositoryId,
    number: 5,
    generation,
    sequence,
  })
  if (published._tag !== "Published") return yield* Effect.die("Expected published snapshot")
  return { identity: published.identity, targets, scope }
})
const page = () => activityPage(repositoryId, { search: "", target: "all", cursor: null })

layer(services, { timeout: "2 minutes" })("AI evaluation retries", (it) => {
  it.effect("a newer event prevents a slow classification from writing labels", () =>
    Effect.gen(function* () {
      const { identity, targets, scope } = yield* prepare
      const started = yield* Deferred.make<void>()
      const answer = yield* Deferred.make<ClassifierAnswer>()
      ask = Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(answer)))
      const fiber = yield* ReconcileEntity.execute(identity).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* targets.invalidate({
        scope,
        sequence: Option.some(GitHubWebhookJournalSequence.make("3")),
      })
      yield* Deferred.succeed(answer, { matches: true, confidence: 1, reason: "Matches old facts" })
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(writes, [])
      assert.strictEqual((yield* page()).entries[0]?.outcome, "superseded")
      const current = yield* targets.get(scope)
      if (Option.isSome(current)) {
        const generation = current.value.requestedGeneration
        yield* targets.begin(scope, generation)
        yield* targets.complete({
          scope,
          generation,
          outcome: { _tag: "Verified", watermark: Option.none() },
        })
      }
    }),
  )
  it.effect("exhausts three attempts with increasing delays and awaits a new event", () =>
    Effect.gen(function* () {
      const { identity } = yield* prepare
      let calls = 0
      ask = Effect.suspend(() => {
        calls++
        return Effect.fail(
          new ClassifierProviderError({
            message: "Temporary provider failure.",
            cause: null,
            retryable: true,
          }),
        )
      })
      const fiber = yield* ReconcileEntity.execute(identity).pipe(Effect.forkChild)
      const waitFor = (attempt: number) =>
        Effect.gen(function* () {
          while (!(yield* page()).entries[0]?.detail?.includes("attempt " + attempt))
            yield* Effect.yieldNow
        })
      yield* waitFor(2)
      assert.deepStrictEqual(writes, [])
      yield* TestClock.adjust("2 seconds")
      yield* waitFor(3)
      assert.include((yield* page()).entries[0]!.detail!, "4 seconds")
      yield* TestClock.adjust("4 seconds")
      yield* Fiber.join(fiber)
      const entry = (yield* page()).entries[0]!
      assert.strictEqual(entry.evaluations?.[0]?.outcome, "failed")
      assert.include(entry.evaluations![0]!.reason, "exhausted after 3 attempts")
      assert.deepStrictEqual(writes, [])
      yield* TestClock.adjust("1 hour")
      yield* ReconcileEntity.execute(identity)
      assert.strictEqual(calls, 3)
    }),
  )
  it.effect("pause cancels a pending retry without making another provider request", () =>
    Effect.gen(function* () {
      const { identity } = yield* prepare
      let calls = 0
      ask = Effect.suspend(() => {
        calls++
        return Effect.fail(
          new ClassifierProviderError({
            message: "Temporary failure",
            cause: null,
            retryable: true,
          }),
        )
      })
      const fiber = yield* ReconcileEntity.execute(identity).pipe(Effect.forkChild)
      while (!(yield* page()).entries[0]?.detail?.includes("Retrying")) yield* Effect.yieldNow
      yield* (yield* RepositoryConnections).change(repositoryId, "pause", actor)
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.join(fiber)
      assert.strictEqual(calls, 1)
      assert.deepStrictEqual(writes, [])
    }),
  )

  it.effect("rule tests expose retry progress and terminal failure without changing labels", () =>
    Effect.gen(function* () {
      yield* seed
      let calls = 0
      ask = Effect.suspend(() => {
        calls++
        return Effect.fail(
          new ClassifierProviderError({
            message: "Temporary failure",
            cause: null,
            retryable: true,
          }),
        )
      })
      const job = yield* enqueueRuleTest(repositoryId, {
        subject: {
          _tag: "Draft",
          source: {
            target: "pull_request",
            classify: {
              prompt: "Test {{fact:title}}",
              evidence: ["title"],
              minimumConfidence: 0.8,
            },
          },
        },
        numbers: [5],
      })
      const fiber = yield* TestWorkflow.execute({ repositoryId, testId: job.testId }).pipe(
        Effect.forkChild,
      )
      const waitFor = (attempt: number) =>
        Effect.gen(function* () {
          while (
            !(yield* getRuleTest(repositoryId, job.testId))?.message?.includes("attempt " + attempt)
          )
            yield* Effect.yieldNow
        })
      yield* waitFor(2)
      assert.strictEqual((yield* getRuleTest(repositoryId, job.testId))?.status, "running")
      yield* TestClock.adjust("2 seconds")
      yield* waitFor(3)
      yield* TestClock.adjust("4 seconds")
      yield* Fiber.join(fiber)
      const result = (yield* getRuleTest(repositoryId, job.testId))!
      assert.strictEqual(result.status, "done")
      assert.strictEqual(result.response?._tag, "Evaluated")
      if (result.response?._tag === "Evaluated") {
        assert.strictEqual(result.response.entities[0]?.evaluation?.outcome, "failed")
        assert.include(
          result.response.entities[0]!.evaluation!.reason,
          "exhausted after 3 attempts",
        )
      }
      assert.strictEqual(calls, 3)
      assert.deepStrictEqual(writes, [])
    }),
  )

  it.effect("the newest event can finish while an outdated retry owns the same AI inputs", () =>
    Effect.gen(function* () {
      const { identity, targets, scope } = yield* prepare
      const replacementAsked = yield* Deferred.make<void>()
      let calls = 0
      ask = Effect.suspend(() =>
        ++calls === 1
          ? Effect.fail(
              new ClassifierProviderError({
                message: "Temporary failure",
                cause: null,
                retryable: true,
              }),
            )
          : Deferred.succeed(replacementAsked, undefined).pipe(
              Effect.as({ matches: true, confidence: 1, reason: "Current classification" }),
            ),
      )
      const old = yield* ReconcileEntity.execute(identity).pipe(Effect.forkChild)
      while (!(yield* page()).entries[0]?.detail?.includes("Retrying")) yield* Effect.yieldNow
      const sequence = GitHubWebhookJournalSequence.make("4")
      const { generation } = yield* targets.invalidate({ scope, sequence: Option.some(sequence) })
      yield* targets.begin(scope, generation)
      yield* targets.complete({
        scope,
        generation,
        outcome: { _tag: "Verified", watermark: Option.none() },
      })
      const published = yield* (yield* SnapshotHandoff).publish({
        repositoryId,
        number: 5,
        generation,
        sequence,
      })
      assert.strictEqual(published._tag, "Published")
      if (published._tag !== "Published") return
      const latest = yield* ReconcileEntity.execute(published.identity).pipe(Effect.forkChild)
      yield* Deferred.await(replacementAsked).pipe(Effect.timeout("2 seconds"), TestClock.withLive)
      yield* Fiber.join(latest)
      assert.strictEqual(writes.length, 1)
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.join(old)
      assert.strictEqual(writes.length, 1)
      assert.strictEqual(calls, 2)
    }),
  )

  for (const change of ["newer event", "lost access", "disconnect"] as const) {
    it.effect(change + " supersedes a pending retry", () =>
      Effect.gen(function* () {
        const { identity, targets, scope } = yield* prepare
        let calls = 0
        ask = Effect.suspend(() => {
          calls++
          return Effect.fail(
            new ClassifierProviderError({
              message: "Temporary failure",
              cause: null,
              retryable: true,
            }),
          )
        })
        const fiber = yield* ReconcileEntity.execute(identity).pipe(Effect.forkChild)
        while (!(yield* page()).entries[0]?.detail?.includes("Retrying")) yield* Effect.yieldNow
        if (change === "newer event")
          yield* targets.invalidate({
            scope,
            sequence: Option.some(GitHubWebhookJournalSequence.make("4")),
          })
        else if (change === "lost access")
          yield* (yield* GitHubReadModel).markRepositoriesLost({
            installationId,
            repositories: [
              { id: repositoryId, fullName: { owner: "effect", repo: "one" }, isPrivate: false },
            ],
            sequence: GitHubWebhookJournalSequence.make("5"),
          })
        else yield* (yield* RepositoryConnections).change(repositoryId, "disconnect", actor)
        yield* TestClock.adjust("2 seconds")
        yield* Fiber.join(fiber)
        assert.strictEqual(calls, 1)
        assert.deepStrictEqual(writes, [])
        const current = yield* targets.get(scope)
        if (
          Option.isSome(current) &&
          current.value.requestedGeneration !== current.value.verifiedGeneration
        ) {
          const generation = current.value.requestedGeneration
          yield* targets.begin(scope, generation)
          yield* targets.complete({
            scope,
            generation,
            outcome: { _tag: "Verified", watermark: Option.none() },
          })
        }
        if (change === "lost access")
          yield* (yield* GitHubReadModel).applyRepositories({
            installationId,
            repositories: [
              { id: repositoryId, fullName: { owner: "effect", repo: "one" }, isPrivate: false },
            ],
            sequence: GitHubWebhookJournalSequence.make("6"),
          })
      }),
    )
  }
})
