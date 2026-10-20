import { assert, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { GitHubLabelDatabaseId } from "@janitor/domain/GitHub/Id"
import { CurrentAccessIdentity } from "../../src/Ingress/Middleware.ts"
import { RulesGroupLayer } from "../../src/Ingress/Rules.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { LabelingConfiguration } from "../../src/Labeling/Configuration.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { makeClient } from "../support/Api.ts"
import { actor, baseMain, repositoryId, seed, Services } from "./support.ts"

const withClient = Effect.gen(function* () {
  yield* seed
  const policies = yield* Policies
  const policy = yield* policies.create(
    repositoryId,
    { name: "Main", description: "", source: baseMain },
    actor,
  )
  yield* policies.publish(repositoryId, policy.policy.policyId, 1, actor)
  const services = yield* Effect.context<LabelingRules | LabelingConfiguration>()
  const api = yield* makeClient(
    ["rules"],
    RulesGroupLayer,
    Context.add(services, CurrentAccessIdentity, {
      ...actor,
      email: undefined,
      expiresAt: DateTime.makeUnsafe("2026-09-03T12:00:00.000Z"),
    }),
  )
  return { api, policyId: policy.policy.policyId }
})

const params = { repositoryId }
const ai = { prompt: "Read {{fact:title}}", minimumConfidence: 0.8 }

layer(Services, { timeout: "2 minutes" })("Labeling group API", (it) => {
  it.effect(
    "reserves disabled priorities, rejects target changes, and atomically swaps with concurrency checks",
    () =>
      Effect.gen(function* () {
        const { api, policyId } = yield* withClient
        const a = yield* api.rules.create({
          params,
          payload: {
            labelId: GitHubLabelDatabaseId.make("11"),
            policyId,
            group: "kind",
            priority: 10,
            enabled: false,
          },
        })
        const duplicate = yield* Effect.flip(
          api.rules.create({
            params,
            payload: {
              labelId: GitHubLabelDatabaseId.make("12"),
              policyId,
              group: "kind",
              priority: 10,
            },
          }),
        )
        assert.strictEqual(duplicate._tag, "RuleInvalid")
        if (duplicate._tag === "RuleInvalid")
          assert.strictEqual(duplicate.issues[0]?.code, "duplicate-priority")
        const mixed = yield* Effect.flip(
          api.rules.create({
            params,
            payload: {
              labelId: GitHubLabelDatabaseId.make("12"),
              ai: { ...ai, target: "issue" },
              group: "kind",
              priority: 20,
            },
          }),
        )
        assert.strictEqual(mixed._tag, "RuleInvalid")
        const b = yield* api.rules.create({
          params,
          payload: {
            labelId: GitHubLabelDatabaseId.make("12"),
            ai: { ...ai, target: "pull_request" },
            group: "kind",
            priority: 20,
          },
        })
        const targetChange = yield* Effect.flip(
          api.rules.update({
            params: { repositoryId, ruleId: b.id },
            payload: { version: b.version, ai: { ...ai, target: "issue" } },
          }),
        )
        assert.strictEqual(targetChange._tag, "RuleInvalid")
        const policies = yield* Policies
        const current = yield* policies.get(repositoryId, a.policyId)
        const invalidDraft = yield* Effect.flip(
          policies.save(
            repositoryId,
            a.policyId,
            {
              version: current.policy.version,
              source: {
                target: "issue",
                matchesWhen: { fact: "title", operator: "contains", value: "x" },
              },
            },
            actor,
          ),
        )
        assert.strictEqual(invalidDraft._tag, "PolicyInvalid")
        const reorder = {
          group: "kind",
          rules: [
            { id: a.id, version: a.version, priority: 20 },
            { id: b.id, version: b.version, priority: 10 },
          ],
        }
        const concurrent = yield* Effect.all(
          [
            Effect.result(api.rules.reorder({ params, payload: reorder })),
            Effect.result(api.rules.reorder({ params, payload: reorder })),
          ],
          { concurrency: "unbounded" },
        )
        assert.deepStrictEqual(
          concurrent
            .map((result) => (Result.isSuccess(result) ? "Reordered" : result.failure._tag))
            .sort(),
          ["GroupConflict", "Reordered"],
        )
        const rules = yield* LabelingRules
        const after = yield* rules.list(repositoryId)
        assert.deepStrictEqual(
          after.map((rule) => [rule.priority, rule.version, rule.enabled]),
          [
            [20, 2, false],
            [10, 2, true],
          ],
        )
        const invalid = yield* Effect.flip(
          api.rules.reorder({
            params,
            payload: {
              group: "kind",
              rules: after.map((rule) => ({ id: rule.id, version: rule.version, priority: 0 })),
            },
          }),
        )
        assert.strictEqual(invalid._tag, "RuleInvalid")
        const missing = yield* Effect.flip(
          api.rules.reorder({
            params,
            payload: { group: "kind", rules: [{ id: a.id, version: 2, priority: 30 }] },
          }),
        )
        assert.strictEqual(missing._tag, "GroupConflict")
        assert.deepStrictEqual(yield* rules.list(repositoryId), after)
      }),
  )
})
