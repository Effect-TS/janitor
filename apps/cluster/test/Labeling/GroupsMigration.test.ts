import { readFileSync } from "node:fs"
import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { LabelingConfiguration } from "../../src/Labeling/Configuration.ts"
import { describeError } from "../../src/SqlErrors.ts"
import { actor, bug, feature, repositoryId, seed, Services } from "./support.ts"

layer(Services, { timeout: "2 minutes" })("Labeling group migration", (it) => {
  it.effect(
    "reports mixed targets and ties, then preserves old precedence and disabled membership",
    () =>
      Effect.gen(function* () {
        yield* seed
        const rules = yield* LabelingRules
        const sql = yield* SqlClient.SqlClient
        const request = {
          labelId: bug,
          onMatch: "ensure-present" as const,
          onNoMatch: "no-action" as const,
          group: null,
          priority: -2147483648,
          enabled: true,
          ai: { target: "issue" as const, prompt: "Read {{fact:title}}", minimumConfidence: 0.8 },
        }
        const a = yield* rules.create(repositoryId, request, actor)
        const b = yield* rules.create(
          repositoryId,
          {
            ...request,
            labelId: feature,
            enabled: false,
            priority: 2147483647,
            ai: { ...request.ai, target: "pull_request" },
          },
          actor,
        )
        const migration = readFileSync(
          new URL("../../migrations/0017_labeling_groups.sql", import.meta.url),
          "utf8",
        )
        yield* sql`UPDATE labeling_rule SET rule_group = 'legacy' WHERE repository_id = ${repositoryId}`
        const before = yield* rules.list(repositoryId)
        const error = yield* Effect.flip(sql.unsafe(migration))
        for (const value of [repositoryId, "legacy", a.id, b.id])
          assert.include(describeError(error), value)
        assert.deepStrictEqual(yield* rules.list(repositoryId), before)
        yield* sql`UPDATE labeling_rule SET policy_id = ${a.policyId}, priority = ${a.priority} WHERE rule_id = ${b.id}`
        assert.include(describeError(yield* Effect.flip(sql.unsafe(migration))), "priority")
        yield* sql`UPDATE labeling_rule SET priority = ${b.priority} WHERE rule_id = ${b.id}`
        // Recreate the old snapshot omission of disabled rules.
        const configuration = yield* LabelingConfiguration
        yield* configuration.advance(repositoryId, actor)
        yield* sql`UPDATE labeling_configuration SET rules = (SELECT jsonb_agg(rule) FROM jsonb_array_elements(rules) rule WHERE (rule->>'enabled')::boolean) WHERE repository_id = ${repositoryId}`
        const previousView = yield* configuration.view(repositoryId)
        const previousSnapshot = yield* configuration.load(
          repositoryId,
          previousView.configuredRevision,
        )
        yield* sql.unsafe(migration)
        assert.deepStrictEqual(
          yield* configuration.load(repositoryId, previousView.configuredRevision),
          previousSnapshot,
        )
        const migrated = yield* rules.list(repositoryId)
        assert.deepStrictEqual(
          migrated.map((rule) => [rule.priority, rule.enabled, rule.version]),
          [
            [2147483647, true, 2],
            [-2147483648, false, 2],
          ],
        )
        const view = yield* configuration.view(repositoryId)
        assert.strictEqual(view.configuredRevision, previousView.configuredRevision + 1)
        const loaded = yield* configuration.load(repositoryId, view.configuredRevision)
        assert.isTrue(Option.isSome(loaded))
        if (Option.isSome(loaded))
          assert.deepStrictEqual(
            loaded.value.rules.map((rule) => [rule.id, rule.priority, rule.enabled]),
            [
              [a.id, 2147483647, true],
              [b.id, -2147483648, false],
            ],
          )
      }),
  )
})
