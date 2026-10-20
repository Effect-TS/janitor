import { assert, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
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
const bug = GitHubLabelDatabaseId.make("11")

layer(Services, { timeout: "2 minutes" })("Rule action API", (it) => {
  it.effect(
    "accepts independent actions, defaults legacy creates, and rejects invalid actions",
    () =>
      Effect.gen(function* () {
        const { api, policyId } = yield* withClient
        const created = yield* api.rules.create({
          params,
          payload: {
            labelId: bug,
            ai: { target: "pull_request", prompt: "Read {{fact:title}}", minimumConfidence: 0.8 },
            onMatch: "ensure-absent",
            onNoMatch: "ensure-present",
          },
        })
        assert.strictEqual(created.onMatch, "ensure-absent")
        assert.strictEqual(created.onNoMatch, "ensure-present")
        const patched = yield* api.rules.update({
          params: { repositoryId, ruleId: created.id },
          payload: { version: 1, onMatch: "no-action", onNoMatch: "no-action" },
        })
        assert.strictEqual(patched.onMatch, "no-action")
        assert.strictEqual(patched.onNoMatch, "no-action")
        const defaults = yield* api.rules.create({
          params,
          payload: { labelId: GitHubLabelDatabaseId.make("12"), policyId },
        })
        assert.strictEqual(defaults.onMatch, "ensure-present")
        assert.strictEqual(defaults.onNoMatch, "no-action")
        const duplicate = yield* Effect.flip(
          api.rules.create({ params, payload: { labelId: bug, policyId, enabled: false } }),
        )
        assert.strictEqual(duplicate._tag, "RuleInvalid")
        if (duplicate._tag !== "RuleInvalid") return
        assert.strictEqual(duplicate.issues[0]?.code, "duplicate-label")
        assert.include(duplicate.issues[0]?.message, created.id)
        const conflictingEdit = yield* Effect.flip(
          api.rules.update({
            params: { repositoryId, ruleId: defaults.id },
            payload: { version: defaults.version, labelId: bug },
          }),
        )
        assert.deepStrictEqual(conflictingEdit, duplicate)
      }),
  )
})
