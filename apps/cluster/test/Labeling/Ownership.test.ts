import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { LabelingConfiguration } from "../../src/Labeling/Configuration.ts"
import { actor, bug, feature, repositoryId, seed, Services } from "./support.ts"

const ruleRequest = {
  labelId: bug,
  onMatch: "ensure-present" as const,
  onNoMatch: "no-action" as const,
  group: null,
  priority: 0,
  enabled: false,
}

const request = {
  ...ruleRequest,
  ai: { target: "issue" as const, prompt: "Read {{fact:title}}", minimumConfidence: 0.8 },
}

layer(Services, { timeout: "2 minutes" })("Label ownership", (it) => {
  it.effect("serializes publication against a conflicting create", () =>
    Effect.gen(function* () {
      yield* seed
      const rules = yield* LabelingRules
      const policies = yield* Policies
      const source = {
        target: "pull_request" as const,
        matchesWhen: { fact: "title" as const, operator: "contains" as const, value: "bug" },
      }
      const policy = yield* policies.create(
        repositoryId,
        { name: "Concurrent publication", description: "", source },
        actor,
      )
      const published = yield* policies.publish(repositoryId, policy.policy.policyId, 1, actor)
      yield* rules.create(repositoryId, { ...ruleRequest, policyId: policy.policy.policyId }, actor)
      const draft = yield* policies.save(
        repositoryId,
        policy.policy.policyId,
        { version: published.policy.version, source: { ...source, target: "issue" } },
        actor,
      )
      const outcomes = yield* Effect.all(
        [
          policies
            .publish(repositoryId, policy.policy.policyId, draft.policy.version, actor)
            .pipe(Effect.match({ onSuccess: () => "Saved", onFailure: (error) => error._tag })),
          rules
            .create(repositoryId, request, actor)
            .pipe(Effect.match({ onSuccess: () => "Saved", onFailure: (error) => error._tag })),
        ],
        { concurrency: "unbounded" },
      )
      assert.lengthOf(
        outcomes.filter((outcome) => outcome === "Saved"),
        1,
      )
      assert.isTrue(outcomes.includes("PolicyInvalid") || outcomes.includes("RuleInvalid"))
      for (const rule of yield* rules.list(repositoryId))
        yield* rules.remove(repositoryId, rule.id, rule.version, actor)
    }),
  )
  it.effect(
    "rejects conflicting edits and releases ownership on deletion without deleting labels",
    () =>
      Effect.gen(function* () {
        yield* seed
        const rules = yield* LabelingRules
        const config = yield* LabelingConfiguration
        const owner = yield* rules.create(repositoryId, { ...request, enabled: true }, actor)
        const disabled = yield* rules.patch(
          repositoryId,
          owner.id,
          { version: owner.version, enabled: false },
          actor,
        )
        const other = yield* rules.create(repositoryId, { ...request, labelId: feature }, actor)
        const crossTarget = yield* rules.create(
          repositoryId,
          { ...request, ai: { ...request.ai, target: "pull_request" } },
          actor,
        )
        const before = yield* rules.list(repositoryId)
        for (const [rule, patch] of [
          [other, { labelId: bug }],
          [crossTarget, { ai: request.ai }],
        ] as const) {
          const error = yield* Effect.flip(
            rules.patch(repositoryId, rule.id, { version: rule.version, ...patch }, actor),
          )
          assert.strictEqual(error._tag, "RuleInvalid")
          if (error._tag === "RuleInvalid") assert.include(error.issues[0]!.message, owner.id)
          assert.deepStrictEqual(yield* rules.list(repositoryId), before)
        }
        const labels = (yield* config.labels(repositoryId)).labels
        yield* rules.remove(repositoryId, owner.id, disabled.version, actor)
        assert.deepStrictEqual((yield* config.labels(repositoryId)).labels, labels)
        const replacement = yield* rules.patch(
          repositoryId,
          other.id,
          { version: other.version, labelId: bug },
          actor,
        )
        yield* rules.remove(repositoryId, replacement.id, replacement.version, actor)
        yield* rules.remove(repositoryId, crossTarget.id, crossTarget.version, actor)
      }),
  )
  it.effect(
    "rechecks ownership at publication and keeps the published target reserved while drafting",
    () =>
      Effect.gen(function* () {
        yield* seed
        const rules = yield* LabelingRules
        const policies = yield* Policies
        const source = {
          target: "pull_request" as const,
          matchesWhen: { fact: "title" as const, operator: "contains" as const, value: "bug" },
        }
        const policy = yield* policies.create(
          repositoryId,
          { name: "Publication ownership", description: "", source },
          actor,
        )
        const published = yield* policies.publish(repositoryId, policy.policy.policyId, 1, actor)
        const prOwner = yield* rules.create(
          repositoryId,
          { ...ruleRequest, policyId: policy.policy.policyId },
          actor,
        )
        const draft = yield* policies.save(
          repositoryId,
          policy.policy.policyId,
          { version: published.policy.version, source: { ...source, target: "issue" } },
          actor,
        )
        const prConflict = yield* Effect.flip(
          rules.create(
            repositoryId,
            { ...request, ai: { ...request.ai, target: "pull_request" } },
            actor,
          ),
        )
        assert.strictEqual(prConflict._tag, "RuleInvalid")
        const issueOwner = yield* rules.create(repositoryId, request, actor)
        const error = yield* Effect.flip(
          policies.publish(repositoryId, policy.policy.policyId, draft.policy.version, actor),
        )
        assert.strictEqual(error._tag, "PolicyInvalid")
        assert.strictEqual(
          (yield* policies.get(repositoryId, policy.policy.policyId)).published?.program.target,
          "pull_request",
        )
        yield* rules.remove(repositoryId, issueOwner.id, issueOwner.version, actor)
        const moved = yield* policies.publish(
          repositoryId,
          policy.policy.policyId,
          draft.policy.version,
          actor,
        )
        assert.strictEqual(moved.published?.program.target, "issue")
        const replacement = yield* rules.create(
          repositoryId,
          { ...request, ai: { ...request.ai, target: "pull_request" } },
          actor,
        )
        yield* rules.remove(repositoryId, replacement.id, replacement.version, actor)
        yield* rules.remove(repositoryId, prOwner.id, prOwner.version, actor)
        yield* policies.remove(repositoryId, policy.policy.policyId, moved.policy.version, actor)
      }),
  )
  it.effect("rejects policy target changes that collide with another owner", () =>
    Effect.gen(function* () {
      yield* seed
      const rules = yield* LabelingRules
      const policies = yield* Policies
      const source = {
        target: "pull_request" as const,
        matchesWhen: { fact: "title" as const, operator: "contains" as const, value: "bug" },
      }
      const policy = yield* policies.create(
        repositoryId,
        { name: "Ownership", description: "", source },
        actor,
      )
      const published = yield* policies.publish(repositoryId, policy.policy.policyId, 1, actor)
      const issueOwner = yield* rules.create(repositoryId, request, actor)
      const prOwner = yield* rules.create(
        repositoryId,
        { ...ruleRequest, policyId: policy.policy.policyId },
        actor,
      )
      const error = yield* Effect.flip(
        policies.save(
          repositoryId,
          policy.policy.policyId,
          {
            version: published.policy.version,
            source: { ...source, target: "issue" },
          },
          actor,
        ),
      )
      assert.strictEqual(error._tag, "PolicyInvalid")
      if (error._tag === "PolicyInvalid") assert.include(error.message, issueOwner.id)
      assert.strictEqual(
        (yield* policies.get(repositoryId, policy.policy.policyId)).policy.version,
        published.policy.version,
      )
      yield* rules.remove(repositoryId, issueOwner.id, issueOwner.version, actor)
      yield* rules.remove(repositoryId, prOwner.id, prOwner.version, actor)
      yield* policies.remove(repositoryId, policy.policy.policyId, published.policy.version, actor)
    }),
  )
  it.effect("allows only one concurrent creator, even when the owner is disabled", () =>
    Effect.gen(function* () {
      yield* seed
      const rules = yield* LabelingRules
      const results = yield* Effect.all(
        [
          rules.create(repositoryId, request, actor),
          rules.create(repositoryId, request, actor),
        ].map(Effect.result),
        { concurrency: "unbounded" },
      )
      assert.lengthOf(results.filter(Result.isSuccess), 1)
      const failure = results.find(Result.isFailure)
      assert.isDefined(failure)
      if (failure && Result.isFailure(failure)) {
        assert.strictEqual(failure.failure._tag, "RuleInvalid")
        if (failure.failure._tag === "RuleInvalid") {
          assert.strictEqual(failure.failure.issues[0]?.code, "duplicate-label")
          assert.include(failure.failure.issues[0]!.message, "disabled")
        }
      }
      const owners = yield* rules.list(repositoryId)
      assert.lengthOf(owners, 1)
      yield* rules.remove(repositoryId, owners[0]!.id, owners[0]!.version, actor)
    }),
  )
})
