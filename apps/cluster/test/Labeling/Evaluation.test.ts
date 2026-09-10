import { assert, it, layer } from "@effect/vitest"
import { GitHubLabelDatabaseId, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { PolicyId } from "@janitor/domain/Labeling/Policy/Condition"
import {
  type ConfigurationSnapshot,
  type ConfiguredRule,
  LabelingRevision,
  PolicyVersionId,
} from "@janitor/domain/Labeling/Policy/Configuration"
import { snapshotFacts } from "@janitor/domain/Labeling/Policy/Facts"
import { RuleId } from "@janitor/domain/Labeling/Policy/Plan"
import type { Program } from "@janitor/domain/Labeling/Policy/Program"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { evaluateLabeling } from "../../src/Labeling/Evaluation.ts"
import {
  AiClassifier,
  AiConsentService,
  ClassifierProvider,
  ClassifierProviderError,
} from "../../src/Labeling/Classifier.ts"
import { actor, seed, Services } from "./support.ts"

const facts = snapshotFacts({
  kind: "pull_request",
  title: "Change 5",
  body: null,
  authorLogin: "octocat",
  state: "open",
  labels: [],
  pullRequest: { baseRef: "main", draft: false, headSha: "a".repeat(40) },
})

const rule = (id: string, overrides: Partial<ConfiguredRule> = {}): ConfiguredRule => ({
  id: RuleId.make(id),
  version: 3,
  policyId: PolicyId.make(`policy-${id}`),
  policyVersionId: PolicyVersionId.make(`version-${id}`),
  labelId: GitHubLabelDatabaseId.make(id),
  onMatch: "ensure-present",
  onNoMatch: "ensure-absent",
  group: null,
  priority: 0,
  enabled: true,
  ...overrides,
})

const matching: Program = {
  target: "pull_request",
  appliesWhen: null,
  evaluator: {
    _tag: "Conditions",
    matchesWhen: {
      _tag: "Fact",
      fact: "baseRef",
      operator: "equals",
      caseSensitive: false,
      value: "main",
    },
  },
}

const configuration = (
  rules: ReadonlyArray<ConfiguredRule>,
  programs: ReadonlyArray<Program | undefined>,
): ConfigurationSnapshot => ({
  repositoryId: GitHubRepositoryDatabaseId.make("701"),
  revision: LabelingRevision.make(4),
  rules,
  versions: rules.flatMap((entry, index) => {
    const program = programs[index]
    return program === undefined
      ? []
      : [
          {
            versionId: entry.policyVersionId,
            policyId: entry.policyId,
            revision: 1,
            contentHash: `hash-${entry.id}`,
            program,
            manifest: { facts: [], tracks: [], references: [], nodeCount: 1, expandedNodeCount: 1 },
            createdAt: DateTime.makeUnsafe("2026-09-01T00:00:00Z"),
          },
        ]
  }),
  requiredTracks: [],
  preparation: {},
  createdAt: DateTime.makeUnsafe("2026-09-01T00:00:00Z"),
})

it.effect("preserves a missing version's label and recording details while other rules act", () =>
  Effect.gen(function* () {
    const missing = rule("11")
    const present = rule("12")
    const result = yield* evaluateLabeling({
      configuration: configuration([missing, present], [undefined, matching]),
      number: 5,
      facts,
      currentLabels: new Set([missing.labelId]),
    })
    assert.deepStrictEqual(result.evaluations[0], {
      ruleId: missing.id,
      policyVersionId: missing.policyVersionId,
      evaluation: { outcome: "unknown", reason: "policy version is missing", trace: [] },
    })
    assert.deepStrictEqual(result.plan.actions, [
      { ruleId: present.id, labelId: present.labelId, action: "add" },
    ])
    assert.strictEqual(result.evaluations[1]?.evaluation.outcome, "match")
    assert.isNotEmpty(result.evaluations[1]!.evaluation.trace)
  }),
)

it.effect("keeps disabled group membership and selects the highest priority applicable rule", () =>
  Effect.gen(function* () {
    const low = rule("11", { group: "kind", priority: 1 })
    const high = rule("12", { group: "kind", priority: 2 })
    const disabled = rule("13", { group: "kind", priority: 3, enabled: false })
    const result = yield* evaluateLabeling({
      configuration: configuration([low, disabled, high], [matching, undefined, matching]),
      number: 5,
      facts,
      currentLabels: new Set([low.labelId, disabled.labelId]),
    })
    assert.deepStrictEqual(
      result.evaluations.map((entry) => entry.ruleId),
      [low.id, high.id],
    )
    assert.deepStrictEqual(result.plan.actions, [
      { ruleId: low.id, labelId: low.labelId, action: "remove" },
      { ruleId: high.id, labelId: high.labelId, action: "add" },
      { ruleId: disabled.id, labelId: disabled.labelId, action: "remove" },
    ])
  }),
)

it.effect("resolves policy references and preserves unknown and out-of-scope labels", () =>
  Effect.gen(function* () {
    const unknown = rule("11")
    const outside = rule("12")
    const reference = rule("13", { onMatch: "no-action", onNoMatch: "ensure-present" })
    const dependency = rule("14", { enabled: false })
    const result = yield* evaluateLabeling({
      configuration: configuration(
        [unknown, outside, reference, dependency],
        [
          {
            ...matching,
            evaluator: {
              _tag: "Conditions",
              matchesWhen: {
                _tag: "Collection",
                fact: "changedFiles",
                quantifier: "some",
                where: { _tag: "Fact", fact: "path", operator: "notEmpty" },
              },
            },
          },
          { ...matching, target: "issue" },
          {
            ...matching,
            evaluator: {
              _tag: "Conditions",
              matchesWhen: { _tag: "Policy", policyId: dependency.policyId },
            },
          },
          {
            ...matching,
            evaluator: {
              _tag: "Conditions",
              matchesWhen: {
                _tag: "Fact",
                fact: "baseRef",
                operator: "equals",
                caseSensitive: false,
                value: "develop",
              },
            },
          },
        ],
      ),
      number: 5,
      facts,
      currentLabels: new Set([unknown.labelId, outside.labelId]),
    })
    assert.deepStrictEqual(
      result.evaluations.map((entry) => entry.evaluation.outcome),
      ["unknown", "not-applicable", "no-match"],
    )
    assert.deepStrictEqual(result.plan.actions, [
      { ruleId: reference.id, labelId: reference.labelId, action: "add" },
    ])
  }),
)

it.effect("honors match removal, non-match removal, and no-action", () =>
  Effect.gen(function* () {
    const removeMatch = rule("11", { onMatch: "ensure-absent" })
    const removeMiss = rule("12")
    const leaveMatch = rule("13", { onMatch: "no-action" })
    const leaveMiss = rule("14", { onNoMatch: "no-action" })
    const miss: Program = {
      ...matching,
      evaluator: {
        _tag: "Conditions",
        matchesWhen: {
          _tag: "Fact",
          fact: "baseRef",
          operator: "equals",
          caseSensitive: false,
          value: "develop",
        },
      },
    }
    const result = yield* evaluateLabeling({
      configuration: configuration(
        [removeMatch, removeMiss, leaveMatch, leaveMiss],
        [matching, miss, matching, miss],
      ),
      number: 5,
      facts,
      currentLabels: new Set([removeMatch.labelId, removeMiss.labelId, leaveMatch.labelId]),
    })
    assert.deepStrictEqual(result.plan.actions, [
      { ruleId: removeMatch.id, labelId: removeMatch.labelId, action: "remove" },
      { ruleId: removeMiss.id, labelId: removeMiss.labelId, action: "remove" },
    ])
  }),
)

const ai: Program = {
  target: "pull_request",
  appliesWhen: null,
  evaluator: {
    _tag: "Classifier",
    prompt: "Read {{fact:title}}",
    evidence: ["title"],
    minimumConfidence: 0.8,
  },
}

let providerBusy = false
let answerNumber = 0
const services = AiClassifier.layer.pipe(
  Layer.provideMerge(AiConsentService.layer),
  Layer.provideMerge(
    Layer.succeed(ClassifierProvider, {
      identity: { provider: "test", model: "test" },
      ask: (prompt) =>
        Effect.gen(function* () {
          if (providerBusy || prompt.includes("Fail")) {
            return yield* new ClassifierProviderError({
              message: "Provider unavailable",
              cause: null,
            })
          }
          providerBusy = true
          const matches = ++answerNumber % 2 === 1
          yield* Effect.yieldNow
          providerBusy = false
          return {
            matches,
            confidence: 0.95,
            reason: matches ? "First answer matches" : "Second answer does not match",
          }
        }),
    }),
  ),
  Layer.provideMerge(Services),
)

layer(services, { timeout: "2 minutes" })("Shared labeling with the real classifier", (it) => {
  it.effect(
    "evaluates mixed rules sequentially in configuration order and retains configured cache identity",
    () =>
      Effect.gen(function* () {
        yield* seed
        const first = rule("21")
        const deterministic = rule("22")
        const second = rule("23", { onNoMatch: "ensure-present" })
        const configured = configuration([first, deterministic, second], [ai, matching, ai])
        yield* (yield* AiConsentService).set(configured.repositoryId, true, actor)
        answerNumber = 0
        const input = {
          configuration: configured,
          number: 5,
          facts,
          currentLabels: new Set<GitHubLabelDatabaseId>(),
        }
        const result = yield* evaluateLabeling(input)
        assert.deepStrictEqual(
          result.evaluations.map((entry) => [
            entry.ruleId,
            entry.policyVersionId,
            entry.evaluation.outcome,
          ]),
          [
            [first.id, first.policyVersionId, "match"],
            [deterministic.id, deterministic.policyVersionId, "match"],
            [second.id, second.policyVersionId, "no-match"],
          ],
        )
        assert.deepStrictEqual(result.plan.actions, [
          { ruleId: first.id, labelId: first.labelId, action: "add" },
          { ruleId: deterministic.id, labelId: deterministic.labelId, action: "add" },
          { ruleId: second.id, labelId: second.labelId, action: "add" },
        ])
        assert.strictEqual(result.evaluations[0]?.evaluation.reason, "First answer matches")
        assert.isUndefined(result.evaluations[0]?.evaluation.inputDetails)
        const inspectedInput = { ...input, inspectInput: true }
        const cached = yield* evaluateLabeling(inspectedInput)
        assert.isDefined(cached.evaluations[0]?.evaluation.inputDetails)
        assert.isDefined(cached.evaluations[2]?.evaluation.inputDetails)
        assert.isTrue(cached.evaluations[0]?.evaluation.cached)
        assert.isTrue(cached.evaluations[2]?.evaluation.cached)
        assert.deepStrictEqual(cached.plan, result.plan)

        // Each configured-rule field and the published version participate in cache identity.
        for (const change of [
          { id: RuleId.make("other-rule") },
          { version: 4 },
          { labelId: GitHubLabelDatabaseId.make("99") },
          { policyId: PolicyId.make("other-policy") },
          { onMatch: "no-action" as const },
          { onNoMatch: "no-action" as const },
          { group: "kind" },
          { priority: 10 },
          { policyVersionId: PolicyVersionId.make("other-version") },
        ]) {
          const changed = yield* evaluateLabeling({
            ...input,
            configuration: configuration([{ ...first, ...change }], [ai]),
          })
          assert.isFalse(changed.evaluations[0]?.evaluation.cached)
        }
      }),
  )

  it.effect("preserves failed rules and their group labels while unrelated rules still act", () =>
    Effect.gen(function* () {
      yield* seed
      const failed = rule("31", { group: "kind" })
      const peer = rule("32", { group: "kind", priority: 1 })
      const disabled = rule("33", { group: "kind", priority: 2, enabled: false })
      const independent = rule("34")
      const standalone = rule("35")
      const failing: Program = {
        ...ai,
        evaluator: {
          _tag: "Classifier",
          prompt: "Fail {{fact:title}}",
          evidence: ["title"],
          minimumConfidence: 0.8,
        },
      }
      const configured = configuration(
        [failed, peer, disabled, independent, standalone],
        [failing, matching, ai, matching, failing],
      )
      yield* (yield* AiConsentService).set(configured.repositoryId, true, actor)
      const result = yield* evaluateLabeling({
        configuration: configured,
        number: 5,
        facts,
        currentLabels: new Set([
          failed.labelId,
          peer.labelId,
          disabled.labelId,
          standalone.labelId,
        ]),
      })
      assert.deepStrictEqual(
        result.evaluations.map((entry) => entry.evaluation.outcome),
        ["failed", "match", "match", "failed"],
      )
      assert.include(result.evaluations[0]!.evaluation.reason, "Provider unavailable")
      assert.deepStrictEqual(result.plan.actions, [
        { ruleId: independent.id, labelId: independent.labelId, action: "add" },
      ])
    }),
  )
})
