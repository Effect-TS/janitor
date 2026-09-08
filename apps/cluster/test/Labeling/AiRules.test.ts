import { GitHubLabelDatabaseId } from "@janitor/domain/GitHub/Id"
import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { LabelingConfiguration } from "../../src/Labeling/Configuration.ts"
import { actor, bug, repositoryId, seed, Services } from "./support.ts"
layer(Services, { timeout: "2 minutes" })("Owned AI rules", (it) => {
  it.effect(
    "creates and edits atomically, hides owned policies, preserves history and rejects foreign bindings",
    () =>
      Effect.gen(function* () {
        yield* seed
        const rules = yield* LabelingRules
        const policies = yield* Policies
        const config = yield* LabelingConfiguration
        const sql = yield* SqlClient.SqlClient
        const ai = {
          target: "pull_request" as const,
          prompt: "Is {{fact:title}} a bug?",
          minimumConfidence: 0.8,
        }
        const created = yield* rules.create(
          repositoryId,
          {
            requestId: "create-once",
            ai,
            labelId: bug,
            onNoMatch: "preserve",
            group: null,
            priority: 0,
            enabled: true,
          },
          actor,
        )
        const retry = yield* rules.create(
          repositoryId,
          {
            requestId: "create-once",
            ai,
            labelId: bug,
            onNoMatch: "preserve",
            group: null,
            priority: 0,
            enabled: true,
          },
          actor,
        )
        assert.strictEqual(retry.id, created.id)
        assert.lengthOf(yield* rules.list(repositoryId), 1)
        assert.deepStrictEqual(created.ai, ai)
        assert.lengthOf(yield* policies.list(repositoryId), 0)
        assert.strictEqual((yield* config.view(repositoryId)).rules[0]?.ai?.prompt, ai.prompt)
        assert.strictEqual(
          (yield* Effect.flip(policies.get(repositoryId, created.policyId)))._tag,
          "PolicyNotFound",
        )
        assert.strictEqual(
          (yield* Effect.flip(
            rules.create(
              repositoryId,
              {
                policyId: created.policyId,
                labelId: bug,
                onNoMatch: "preserve",
                group: null,
                priority: 0,
                enabled: true,
              },
              actor,
            ),
          ))._tag,
          "RuleInvalid",
        )
        const changed = yield* rules.patch(
          repositoryId,
          created.id,
          { version: created.version, ai: { ...ai, minimumConfidence: 0.95 } },
          actor,
        )
        assert.strictEqual(changed.ai?.minimumConfidence, 0.95)
        assert.strictEqual(
          (yield* Effect.flip(
            rules.patch(
              repositoryId,
              created.id,
              { version: created.version, enabled: false },
              actor,
            ),
          ))._tag,
          "RuleConflict",
        )
        yield* rules.patch(
          repositoryId,
          created.id,
          { version: changed.version, enabled: false },
          actor,
        )
        const versions =
          yield* sql`SELECT version_id FROM labeling_policy_version WHERE policy_id=${created.policyId}`
        assert.lengthOf(versions, 2)
        const countBefore = (yield* sql`SELECT policy_id FROM labeling_policy`).length
        assert.strictEqual(
          (yield* Effect.flip(
            rules.create(
              repositoryId,
              {
                ai,
                labelId: GitHubLabelDatabaseId.make("999"),
                onNoMatch: "preserve",
                group: null,
                priority: 0,
                enabled: true,
              },
              actor,
            ),
          ))._tag,
          "RuleInvalid",
        )
        assert.strictEqual((yield* sql`SELECT policy_id FROM labeling_policy`).length, countBefore)
        assert.strictEqual(
          (yield* Effect.flip(
            rules.create(
              repositoryId,
              {
                ai: { ...ai, prompt: "{{fact:diff}}" },
                labelId: bug,
                onNoMatch: "preserve",
                group: null,
                priority: 0,
                enabled: true,
              },
              actor,
            ),
          ))._tag,
          "RuleInvalid",
        )
        assert.strictEqual((yield* sql`SELECT policy_id FROM labeling_policy`).length, countBefore)
        yield* rules.remove(repositoryId, created.id, changed.version + 1, actor)
        assert.lengthOf(yield* rules.list(repositoryId), 0)
        assert.lengthOf(yield* policies.list(repositoryId), 0)
        assert.lengthOf(
          yield* sql`SELECT version_id FROM labeling_policy_version WHERE policy_id=${created.policyId}`,
          2,
        )
      }),
  )
})
