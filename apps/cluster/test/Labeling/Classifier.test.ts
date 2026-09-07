import { assert, layer } from "@effect/vitest"
import { PolicyVersionId } from "@janitor/domain/Labeling/Policy/Configuration"
import { snapshotFacts } from "@janitor/domain/Labeling/Policy/Facts"
import { MAX_TRACE } from "@janitor/domain/Labeling/Policy/Program"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import {
  AiClassifier,
  AiConsentService,
  ClassifierProvider,
  ClassifierProviderError,
} from "../../src/Labeling/Classifier.ts"
import { RulesetActivation } from "../../src/Labeling/Activation.ts"
import { LabelingConfiguration } from "../../src/Labeling/Configuration.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { LabelingTest } from "../../src/Labeling/Test.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import {
  actor,
  bug,
  LabelingLayer,
  repositoryId,
  seed,
  seedPullRequests,
  verifyTrack,
} from "./support.ts"

/** Answers by title: bumps match, everything else does not; can be made to fail. */
let failing = false
let calls = 0
const ProviderStub = Layer.succeed(ClassifierProvider, {
  identity: { provider: "stub", model: "stub-1" },
  ask: (prompt) =>
    Effect.suspend(() => {
      calls++
      return failing
        ? Effect.fail(new ClassifierProviderError({ message: "down", cause: null }))
        : Effect.succeed({
            matches: prompt.includes("Change 5"),
            confidence: prompt.includes("Change 5") ? 0.95 : 0.6,
            reason: prompt.includes("Change 5") ? "looks like it" : "unsure",
          })
    }),
})

const Services = LabelingLayer.pipe(
  Layer.provideMerge(AiClassifier.layer),
  Layer.provideMerge(AiConsentService.layer),
  Layer.provideMerge(ProviderStub),
  Layer.provideMerge(MigratedPostgresLayer),
)

layer(Services, { timeout: "2 minutes" })("Classifier against Postgres", (it) => {
  it.effect("evaluates unknown without consent, then classifies under a lease and caches", () =>
    Effect.gen(function* () {
      yield* seed
      yield* seedPullRequests
      const policies = yield* Policies
      const rules = yield* LabelingRules
      const consent = yield* AiConsentService
      const test = yield* LabelingTest
      const sql = yield* SqlClient.SqlClient

      const created = yield* policies.create(
        repositoryId,
        {
          name: "Is a change five",
          description: "",
          source: {
            target: "pull_request",
            classify: {
              prompt: "Is {{fact:title}} the fifth change?",
              evidence: ["title"],
              minimumConfidence: 0.9,
            },
          },
        },
        actor,
      )
      // The prompt must only name declared evidence.
      const bad = yield* Effect.flip(
        policies
          .validate(
            repositoryId,
            {
              target: "pull_request",
              classify: { prompt: "{{fact:body}}", evidence: ["title"], minimumConfidence: 0.8 },
            },
            Option.none(),
          )
          .pipe(
            Effect.flatMap((result) =>
              result._tag === "Invalid" ? Effect.fail(result) : Effect.succeed(result),
            ),
          ),
      )
      assert.include(bad.message, "not listed as evidence")
      const published = yield* policies.publish(repositoryId, created.policy.policyId, 1, actor)

      // Bound rules may only preserve on a miss.
      const rejected = yield* Effect.flip(
        rules.create(
          repositoryId,
          {
            labelId: bug,
            policyId: created.policy.policyId,
            onNoMatch: "ensure-absent",
            group: null,
            priority: 0,
            enabled: true,
          },
          actor,
        ),
      )
      assert.strictEqual(
        rejected._tag === "RuleInvalid" ? rejected.issues[0]?.code : rejected._tag,
        "classifier-preserve-only",
      )
      yield* rules.create(
        repositoryId,
        {
          labelId: bug,
          policyId: created.policy.policyId,
          onNoMatch: "preserve",
          group: null,
          priority: 0,
          enabled: true,
        },
        actor,
      )

      // Without consent nothing is sent and every outcome is unknown.
      const before = yield* test.run(repositoryId, {
        subject: { _tag: "Policy", policyId: created.policy.policyId },
        numbers: [5, 6],
      })
      assert.deepStrictEqual(
        before._tag === "Evaluated"
          ? before.entities.map((entity) => entity.evaluation?.outcome)
          : before._tag,
        ["unknown", "unknown"],
      )
      assert.strictEqual(calls, 0)

      const enabled = yield* consent.set(repositoryId, true, actor)
      assert.strictEqual(enabled.state, "enabled")
      assert.strictEqual(enabled.model, "stub-1")
      const after = yield* test.run(repositoryId, {
        subject: { _tag: "Policy", policyId: created.policy.policyId },
        numbers: [5, 6],
      })
      assert.deepStrictEqual(
        after._tag === "Evaluated"
          ? after.entities.map((entity) => [entity.number, entity.evaluation?.outcome])
          : after._tag,
        [
          [5, "match"],
          [6, "unknown"],
        ],
      )
      assert.strictEqual(calls, 2)
      // Same evidence, same version: served from the decision cache.
      yield* test.run(repositoryId, {
        subject: { _tag: "Policy", policyId: created.policy.policyId },
        numbers: [5],
      })
      assert.strictEqual(calls, 2)
      const decisions = yield* sql<{ outcome: string; provider: string }>`
        SELECT outcome, provider FROM labeling_ai_decision WHERE repository_id = ${repositoryId} ORDER BY number
      `
      assert.deepStrictEqual(decisions, [
        { outcome: "match", provider: "stub" },
        { outcome: "unknown", provider: "stub" },
      ])
      const leases = yield* sql<{ released: boolean }>`
        SELECT released_at IS NOT NULL AS released FROM labeling_ai_lease WHERE repository_id = ${repositoryId}
      `
      assert.deepStrictEqual(
        leases.map((row) => row.released),
        [true, true],
      )

      // A provider failure is unknown, never a miss.
      failing = true
      const failed = yield* test.run(repositoryId, {
        subject: {
          _tag: "Draft",
          source: {
            target: "pull_request",
            classify: { prompt: "{{fact:title}}?", evidence: ["title"], minimumConfidence: 0.8 },
          },
        },
        numbers: [5],
      })
      assert.strictEqual(
        failed._tag === "Evaluated" ? failed.entities[0]?.evaluation?.outcome : failed._tag,
        "unknown",
      )
      failing = false

      // Unknown applicability must stop before cache lookup or a provider call.
      const classifier = yield* AiClassifier
      const callsBeforeScope = calls
      const evaluator = {
        _tag: "Classifier" as const,
        prompt: "Is this the fifth change?",
        evidence: ["title"] as const,
        minimumConfidence: 0.9,
      }
      const scoped = yield* classifier.classify({
        repositoryId,
        number: 5,
        policyVersionId: PolicyVersionId.make("draft"),
        program: {
          target: "pull_request",
          appliesWhen: {
            _tag: "All",
            conditions: [
              ...Array.from({ length: MAX_TRACE }, () => ({
                _tag: "Fact" as const,
                fact: "title" as const,
                operator: "notEmpty" as const,
              })),
              {
                _tag: "Collection",
                fact: "changedFiles",
                quantifier: "some",
                where: { _tag: "Fact", fact: "path", operator: "notEmpty" },
              },
            ],
          },
          evaluator,
        },
        evaluator,
        snapshot: snapshotFacts({
          kind: "pull_request",
          title: "Change 5",
          body: null,
          authorLogin: "octocat",
          state: "open",
          labels: [],
          pullRequest: { baseRef: "main", draft: false, headSha: "a".repeat(40) },
        }),
        resolve: () => undefined,
      })
      assert.strictEqual(scoped.outcome, "unknown")
      assert.strictEqual(scoped.trace.length, MAX_TRACE)
      assert.isFalse(scoped.trace.some((entry) => entry.outcome === "unknown"))
      assert.strictEqual(calls, callsBeforeScope)

      // Drafts share an identity, but changes to their question or threshold need fresh decisions.
      const draft = (prompt: string, minimumConfidence: number) =>
        test.run(repositoryId, {
          subject: {
            _tag: "Draft",
            source: {
              target: "pull_request",
              classify: { prompt, evidence: ["title"], minimumConfidence },
            },
          },
          numbers: [5],
        })
      yield* draft("First question", 0.9)
      assert.strictEqual(calls, callsBeforeScope + 1)
      yield* draft("First question", 0.9)
      assert.strictEqual(calls, callsBeforeScope + 1)
      yield* draft("Second question", 0.9)
      assert.strictEqual(calls, callsBeforeScope + 2)
      const stricter = yield* draft("Second question", 0.99)
      assert.strictEqual(calls, callsBeforeScope + 3)
      assert.strictEqual(
        stricter._tag === "Evaluated" ? stricter.entities[0]?.evaluation?.outcome : stricter._tag,
        "unknown",
      )

      // Revoking with no live lease disables at once; the configuration still evaluates.
      const revoked = yield* consent.set(repositoryId, false, actor)
      assert.strictEqual(revoked.state, "disabled")
      yield* verifyTrack("entities")
      const activation = yield* RulesetActivation
      yield* activation.promote(repositoryId)
      const configuration = yield* LabelingConfiguration
      assert.isNotNull((yield* configuration.view(repositoryId)).activeRevision)
      const whole = yield* test.run(repositoryId, {
        subject: { _tag: "Configuration" },
        numbers: [5],
      })
      // Revoked consent also blocks cached decisions from proposing new actions.
      assert.deepStrictEqual(
        whole._tag === "Evaluated"
          ? whole.entities[0]?.plan?.actions.map((action) => action.action)
          : whole._tag,
        [],
      )
      assert.strictEqual(published.published?.manifest.tracks[0], "entities")
    }),
  )
  it.effect("gates owned AI evaluation and validates referenced policy changes", () =>
    Effect.gen(function* () {
      yield* seed
      yield* seedPullRequests
      failing = false
      calls = 0
      const policies = yield* Policies
      const rules = yield* LabelingRules
      const test = yield* LabelingTest
      const consent = yield* AiConsentService
      const gate = yield* policies.create(
        repositoryId,
        {
          name: "Only five",
          description: "",
          source: {
            target: "pull_request",
            matchesWhen: { fact: "title", operator: "equals", value: "Change 5" },
          },
        },
        actor,
      )
      const gateId = gate.policy.policyId
      const ai = {
        target: "pull_request" as const,
        prompt: "Is {{fact:title}} the fifth change?",
        minimumConfidence: 0.8,
        gatePolicyId: gateId,
      }
      const request = {
        ai,
        labelId: bug,
        onNoMatch: "preserve" as const,
        group: null,
        priority: 0,
        enabled: true,
      }
      assert.strictEqual(
        (yield* Effect.flip(rules.create(repositoryId, request, actor)))._tag,
        "RuleInvalid",
      )
      yield* policies.publish(repositoryId, gateId, 1, actor)
      const rule = yield* rules.create(repositoryId, request, actor)
      assert.strictEqual(rule.ai?.gatePolicyId, gateId)
      const gateDetail = yield* policies.get(repositoryId, gateId)
      assert.strictEqual(
        (yield* Effect.flip(
          policies.remove(repositoryId, gateId, gateDetail.policy.version, actor),
        ))._tag,
        "PolicyInUse",
      )
      yield* consent.set(repositoryId, true, actor)
      const result = yield* test.run(repositoryId, {
        subject: { _tag: "Policy", policyId: rule.policyId },
        numbers: [5, 6],
      })
      assert.deepStrictEqual(
        result._tag === "Evaluated"
          ? result.entities.map((e) => e.evaluation?.outcome)
          : result._tag,
        ["match", "not-applicable"],
      )
      assert.strictEqual(calls, 1)
      const draft = yield* test.run(repositoryId, {
        subject: {
          _tag: "Draft",
          source: {
            target: "pull_request",
            appliesWhen: { policy: gateId },
            classify: { prompt: ai.prompt, evidence: ["title"], minimumConfidence: 0.8 },
          },
        },
        numbers: [6],
      })
      assert.strictEqual(
        draft._tag === "Evaluated" ? draft.entities[0]?.evaluation?.outcome : draft._tag,
        "not-applicable",
      )
      assert.strictEqual(calls, 1)
      const bad = yield* rules
        .patch(
          repositoryId,
          rule.id,
          { version: rule.version, ai: { ...ai, target: "issue" } },
          actor,
        )
        .pipe(Effect.flip)
      assert.strictEqual(bad._tag, "RuleInvalid")
      const classifierGate = yield* policies.validate(
        repositoryId,
        {
          target: "pull_request",
          classify: { prompt: ai.prompt, evidence: ["title"], minimumConfidence: 0.8 },
        },
        Option.some(gateId),
      )
      assert.strictEqual(classifierGate._tag, "Invalid")
      const cleared = yield* rules.patch(
        repositoryId,
        rule.id,
        { version: rule.version, ai: { ...ai, gatePolicyId: null } },
        actor,
      )
      assert.strictEqual(cleared.ai?.gatePolicyId, null)
    }),
  )
  it.effect("retains input reports on cache hits and failures, and hashes omitted evidence", () =>
    Effect.gen(function* () {
      yield* seed
      yield* seedPullRequests
      failing = false
      calls = 0
      yield* (yield* AiConsentService).set(repositoryId, true, actor)
      const classifier = yield* AiClassifier
      const evaluator = {
        _tag: "Classifier" as const,
        prompt: "Classify {{fact:title}} using {{fact:body}}",
        evidence: ["title", "body"] as const,
        minimumConfidence: 0.8,
      }
      const run = (middle: string) =>
        classifier.classify({
          repositoryId,
          number: 5,
          policyVersionId: PolicyVersionId.make("draft"),
          program: { target: "pull_request", appliesWhen: null, evaluator },
          evaluator,
          snapshot: snapshotFacts({
            kind: "pull_request",
            title: "Change 5",
            body: "begin\n" + "a".repeat(20000) + middle + "b".repeat(20000) + "\nend",
            authorLogin: "octocat",
            state: "open",
            labels: [],
            pullRequest: { baseRef: "main", draft: false, headSha: "a".repeat(40) },
          }),
          resolve: () => undefined,
          inspectInput: true,
        })
      const first = yield* run("x")
      assert.strictEqual(first.inputReport?.status, "shortened")
      assert.isAtMost(first.inputReport!.suppliedBytes, 16000)
      assert.isDefined(first.inputDetails)
      const cached = yield* run("x")
      assert.strictEqual(cached.cached, true)
      assert.deepStrictEqual(cached.inputReport, first.inputReport)
      assert.deepStrictEqual(cached.inputDetails, first.inputDetails)
      assert.strictEqual(calls, 1)
      yield* run("y")
      assert.strictEqual(calls, 2)
      failing = true
      const failed = yield* run("z").pipe(
        Effect.ensuring(
          Effect.sync(() => {
            failing = false
          }),
        ),
      )
      assert.strictEqual(failed.outcome, "unknown")
      assert.strictEqual(failed.reasonCode, "provider-failed")
      assert.strictEqual(failed.inputReport?.status, "shortened")
      assert.isDefined(failed.inputDetails)
      assert.strictEqual(calls, 3)
    }),
  )
})
