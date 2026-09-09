import { assert, layer } from "@effect/vitest"
import { PolicyVersionId } from "@janitor/domain/Labeling/Policy/Configuration"
import { PolicyId } from "@janitor/domain/Labeling/Policy/Condition"
import { RuleId } from "@janitor/domain/Labeling/Policy/Plan"
import { snapshotFacts } from "@janitor/domain/Labeling/Policy/Facts"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Deferred from "effect/Deferred"
import * as Fiber from "effect/Fiber"
import * as Clock from "effect/Clock"
import { TestClock } from "effect/testing"
import {
  AiClassifier,
  AiCacheTtl,
  ClassifierProviderError,
  AiConsentService,
  ClassifierProvider,
  EvaluationRetry,
} from "../../src/Labeling/Classifier.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { LabelingTest } from "../../src/Labeling/Test.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import {
  actor,
  bug,
  feature,
  LabelingLayer,
  repositoryId,
  seed,
  seedPullRequests,
} from "./support.ts"

let requests = 0
const Provider = Layer.succeed(ClassifierProvider, {
  identity: { provider: "cache-test", model: "one" },
  ask: () =>
    Effect.sync(() => ({
      matches: ++requests % 2 === 1,
      confidence: 0.95,
      reason: `Answer ${requests}`,
    })),
})
const Services = LabelingLayer.pipe(
  Layer.provideMerge(AiClassifier.layer),
  Layer.provideMerge(AiConsentService.layer),
  Layer.provideMerge(Provider),
  Layer.provideMerge(MigratedPostgresLayer),
)

const input = (version: string) => {
  const evaluator = {
    _tag: "Classifier" as const,
    prompt: "Read {{fact:title}}",
    evidence: ["title"] as const,
    minimumConfidence: 0.8,
  }
  return {
    repositoryId,
    number: 5,
    policyVersionId: PolicyVersionId.make(version),
    program: { target: "pull_request" as const, appliesWhen: null, evaluator },
    evaluator,
    snapshot: snapshotFacts({
      kind: "pull_request",
      title: "Change 5",
      body: "Unreferenced body",
      authorLogin: "octocat",
      state: "open",
      labels: [],
      pullRequest: { baseRef: "main", draft: false, headSha: "a".repeat(40) },
    }),
    resolve: () => undefined,
  }
}

layer(Services, { timeout: "2 minutes" })("AI result cache", (it) => {
  it.effect("does not return a cached answer for superseded work", () =>
    Effect.gen(function* () {
      yield* seed
      yield* (yield* AiConsentService).set(repositoryId, true, actor)
      const classifier = yield* AiClassifier
      const request = input("superseded-cache")
      assert.strictEqual((yield* classifier.classify(request)).cached, false)
      const result = yield* classifier.classify(request).pipe(
        Effect.provideService(EvaluationRetry, {
          isCurrent: Effect.succeed(false),
          report: () => Effect.void,
        }),
      )
      assert.strictEqual(result.outcome, "failed")
      assert.include(result.reason, "superseded")
    }),
  )
  it.effect(
    "invalidates configured AI rules on action and priority edits without requesting AI until evaluation",
    () =>
      Effect.gen(function* () {
        yield* seed
        yield* seedPullRequests
        yield* (yield* AiConsentService).set(repositoryId, true, actor)
        requests = 0
        const rules = yield* LabelingRules
        const test = yield* LabelingTest
        let rule = yield* rules.create(
          repositoryId,
          {
            ai: { target: "pull_request", prompt: "Read {{fact:title}}", minimumConfidence: 0.8 },
            labelId: bug,
            onMatch: "ensure-present",
            onNoMatch: "ensure-absent",
            group: null,
            priority: 0,
            enabled: true,
          },
          actor,
        )
        const run = test.run(repositoryId, { subject: { _tag: "Configuration" }, numbers: [5] })
        yield* run
        yield* run
        assert.strictEqual(requests, 1)
        for (const patch of [
          { onMatch: "no-action" as const },
          { onMatch: "ensure-present" as const },
          { onNoMatch: "no-action" as const },
          { priority: 7 },
          { priority: 0 },
          { group: "triage" },
          {
            ai: {
              target: "pull_request" as const,
              prompt: "Read {{fact:title}}",
              minimumConfidence: 0.9,
            },
          },
        ]) {
          const before = requests
          rule = yield* rules.patch(
            repositoryId,
            rule.id,
            { version: rule.version, ...patch },
            actor,
          )
          assert.strictEqual(requests, before)
          yield* run
          assert.strictEqual(requests, before + 1)
          yield* run
          assert.strictEqual(requests, before + 1)
        }
      }),
  )

  it.effect("concurrent refreshes wait for a fresh answer under a custom deployment lifetime", () =>
    Effect.gen(function* () {
      yield* seed
      yield* (yield* AiConsentService).set(repositoryId, true, actor)
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      let refreshing = false
      let sent = 0
      const classifier = yield* AiClassifier.make.pipe(
        Effect.provideService(AiCacheTtl, 60),
        Effect.provideService(ClassifierProvider, {
          identity: { provider: "cache-test", model: "one" },
          ask: () =>
            Effect.gen(function* () {
              sent++
              if (refreshing) {
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(finish)
              }
              return {
                matches: true,
                confidence: 1,
                reason: refreshing ? "Fresh answer" : "Old answer",
              }
            }),
        }),
      )
      const request = input("concurrent-expiry")
      assert.strictEqual((yield* classifier.classify(request)).reason, "Old answer")
      yield* TestClock.adjust("59 seconds")
      assert.strictEqual((yield* classifier.classify(request)).cached, true)
      yield* TestClock.adjust("1 second")
      assert.strictEqual(sent, 1)
      refreshing = true
      const owner = yield* classifier.classify(request).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const clock = yield* Clock.Clock
      const waiter = yield* classifier.classify(request).pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          sleep: (duration) => TestClock.withLive(Effect.sleep(duration)),
        }),
        Effect.forkChild,
      )
      // Keep cache age fixed while giving the concurrent caller time to return an invalid hit.
      yield* TestClock.withLive(Effect.sleep("3 seconds"))
      assert.isUndefined(waiter.pollUnsafe())
      yield* Deferred.succeed(finish, undefined)
      const fresh = yield* Fiber.join(owner)
      assert.strictEqual(fresh.reason, "Fresh answer")
      assert.strictEqual(fresh.cached, false)
      const joined = yield* Fiber.join(waiter)
      assert.strictEqual(joined.reason, "Fresh answer")
      assert.strictEqual(joined.cached, true)
      assert.strictEqual((yield* classifier.classify(request)).reason, "Fresh answer")
      assert.strictEqual(sent, 2)
    }),
  )

  it.effect(
    "invalidates referenced facts, confidence, provider and model, while retaining reuse for unrelated facts",
    () =>
      Effect.gen(function* () {
        yield* seed
        const request = input("cache-inputs")
        const withProvider = (provider: string, model: string) =>
          Effect.gen(function* () {
            const boundary = {
              identity: { provider, model },
              ask: () =>
                Effect.succeed({ matches: true, confidence: 0.85, reason: provider + "/" + model }),
            }
            const consent = yield* AiConsentService.make.pipe(
              Effect.provideService(ClassifierProvider, boundary),
            )
            yield* consent.set(repositoryId, true, actor)
            return yield* AiClassifier.make.pipe(
              Effect.provideService(ClassifierProvider, boundary),
              Effect.provideService(AiConsentService, consent),
            )
          })
        const classifier = yield* withProvider("cache-test", "one")
        assert.strictEqual((yield* classifier.classify(request)).cached, false)
        const unrelated = {
          ...request,
          snapshot: {
            ...request.snapshot,
            facts: {
              ...request.snapshot.facts,
              body: { _tag: "Text" as const, value: "Edited unreferenced body" },
            },
          },
        }
        assert.strictEqual((yield* classifier.classify(unrelated)).cached, true)
        const changed = {
          ...request,
          snapshot: {
            ...request.snapshot,
            facts: {
              ...request.snapshot.facts,
              title: { _tag: "Text" as const, value: "Changed title" },
            },
          },
        }
        assert.strictEqual((yield* classifier.classify(changed)).cached, false)
        assert.strictEqual((yield* classifier.classify(changed)).cached, true)
        const evaluator = { ...request.evaluator, minimumConfidence: 0.9 }
        const strict = { ...request, evaluator, program: { ...request.program, evaluator } }
        const below = yield* classifier.classify(strict)
        assert.strictEqual(below.cached, false)
        assert.strictEqual(below.outcome, "no-match")
        assert.strictEqual((yield* classifier.classify(strict)).cached, true)
        const nextModel = yield* withProvider("cache-test", "two")
        assert.strictEqual((yield* nextModel.classify(request)).cached, false)
        assert.strictEqual((yield* nextModel.classify(request)).cached, true)
        const nextProvider = yield* withProvider("other", "two")
        const fresh = yield* nextProvider.classify(request)
        assert.strictEqual(fresh.cached, false)
        assert.strictEqual(fresh.reason, "other/two")
      }),
  )

  it.effect("does not reuse operational failures as successful answers", () =>
    Effect.gen(function* () {
      yield* seed
      yield* (yield* AiConsentService).set(repositoryId, true, actor)
      let failing = true
      const classifier = yield* AiClassifier.make.pipe(
        Effect.provideService(ClassifierProvider, {
          identity: { provider: "cache-test", model: "one" },
          ask: () =>
            failing
              ? Effect.fail(new ClassifierProviderError({ message: "Unavailable", cause: null }))
              : Effect.succeed({ matches: true, confidence: 1, reason: "Recovered" }),
        }),
      )
      const request = input("cache-failure")
      assert.strictEqual((yield* classifier.classify(request)).outcome, "failed")
      failing = false
      const recovered = yield* classifier.classify(request)
      assert.strictEqual(recovered.cached, false)
      assert.strictEqual(recovered.reason, "Recovered")
      assert.strictEqual((yield* classifier.classify(request)).cached, true)
    }),
  )

  it.effect("a priority edit does not join a request for superseded rule parameters", () =>
    Effect.gen(function* () {
      yield* seed
      yield* (yield* AiConsentService).set(repositoryId, true, actor)
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      let first = true
      let current = true
      const classifier = yield* AiClassifier.make.pipe(
        Effect.provideService(ClassifierProvider, {
          identity: { provider: "cache-test", model: "one" },
          ask: () =>
            Effect.gen(function* () {
              if (first) {
                first = false
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(finish)
                return { matches: true, confidence: 1, reason: "Old parameters" }
              }
              return { matches: false, confidence: 1, reason: "New parameters" }
            }),
        }),
      )
      const request = {
        ...input("concurrent-parameters"),
        rule: {
          id: RuleId.make("cache-rule"),
          policyId: PolicyId.make("cache-policy"),
          labelId: bug,
          onMatch: "ensure-present" as const,
          onNoMatch: "no-action" as const,
          enabled: true,
          group: null,
          priority: 0,
        },
      }
      const old = yield* classifier.classify(request).pipe(
        Effect.provideService(EvaluationRetry, {
          isCurrent: Effect.sync(() => current),
          report: () => Effect.void,
        }),
        Effect.forkChild,
      )
      yield* Deferred.await(started)
      current = false
      const changed = { ...request, rule: { ...request.rule, priority: 1 } }
      const fresh = yield* classifier.classify(changed)
      assert.strictEqual(fresh.cached, false)
      assert.strictEqual(fresh.reason, "New parameters")
      yield* Deferred.succeed(finish, undefined)
      assert.strictEqual((yield* Fiber.join(old)).outcome, "failed")
      const reused = yield* classifier.classify(changed)
      assert.strictEqual(reused.cached, true)
      assert.strictEqual(reused.reason, "New parameters")
    }),
  )

  it.effect("rejects a configuration test whose rules changed during the AI request", () =>
    Effect.gen(function* () {
      yield* seed
      yield* seedPullRequests
      yield* (yield* AiConsentService).set(repositoryId, true, actor)
      const rules = yield* LabelingRules
      const rule = yield* rules.create(
        repositoryId,
        {
          ai: {
            target: "pull_request",
            prompt: "Concurrent configuration {{fact:title}}",
            minimumConfidence: 0.8,
          },
          labelId: feature,
          onMatch: "ensure-present",
          onNoMatch: "no-action",
          enabled: true,
          group: null,
          priority: 0,
        },
        actor,
      )
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const classifier = yield* AiClassifier.make.pipe(
        Effect.provideService(ClassifierProvider, {
          identity: { provider: "cache-test", model: "one" },
          ask: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(finish)
              return { matches: true, confidence: 1, reason: "Old configuration" }
            }),
        }),
      )
      const test = yield* LabelingTest
      const run = yield* test
        .run(repositoryId, { subject: { _tag: "Configuration" }, numbers: [5] })
        .pipe(Effect.provideService(AiClassifier, classifier), Effect.forkChild)
      yield* Deferred.await(started)
      yield* rules.patch(repositoryId, rule.id, { version: rule.version, priority: 1 }, actor)
      yield* Deferred.succeed(finish, undefined)
      const result = yield* Fiber.join(run)
      assert.strictEqual(result._tag, "Rejected")
      if (result._tag === "Rejected") assert.include(result.message, "changed")
    }),
  )
})
