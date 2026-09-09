import { readFileSync } from "node:fs"
import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { describeError } from "../../src/SqlErrors.ts"
import { actor, bug, repositoryId, seed, Services } from "./support.ts"

layer(Services, { timeout: "2 minutes" })("Ownership migration", (it) => {
  it.effect(
    "reports legacy conflicts without changing records and accepts cross-target reuse",
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
          priority: 0,
          enabled: false,
          ai: { target: "issue" as const, prompt: "Read {{fact:title}}", minimumConfidence: 0.8 },
        }
        const owner = yield* rules.create(repositoryId, request, actor)
        yield* rules.create(
          repositoryId,
          { ...request, ai: { ...request.ai, target: "pull_request" } },
          actor,
        )
        // Simulate a record written by a pre-ownership release.
        yield* sql`INSERT INTO labeling_rule (rule_id, repository_id, label_id, policy_id, on_match, on_no_match, enabled, version)
        VALUES ('legacy-duplicate', ${repositoryId}, ${bug}, ${owner.policyId}, 'no-action', 'no-action', FALSE, 1)`
        const before = yield* rules.list(repositoryId)
        const migration = readFileSync(
          new URL("../../migrations/0016_label_ownership.sql", import.meta.url),
          "utf8",
        )
        const error = yield* Effect.flip(sql.unsafe(migration))
        const message = describeError(error)
        for (const value of [repositoryId, bug, "issue", owner.id, "legacy-duplicate"])
          assert.include(message, value)
        assert.deepStrictEqual(yield* rules.list(repositoryId), before)
        const duplicate = before.find((rule) => rule.id === "legacy-duplicate")!
        yield* rules.remove(repositoryId, duplicate.id, duplicate.version, actor)
        const resolved = yield* rules.list(repositoryId)
        yield* sql.unsafe(migration)
        assert.deepStrictEqual(yield* rules.list(repositoryId), resolved)
      }),
  )
})
