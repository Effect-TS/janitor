import { readFileSync } from "node:fs"
import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { LabelingConfiguration } from "../../src/Labeling/Configuration.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { actor, baseMain, bug, feature, repositoryId, seed, Services } from "./support.ts"

layer(Services, { timeout: "2 minutes" })("Result action migration", (it) => {
  it.effect("retains existing rules and configuration revisions with equivalent actions", () =>
    Effect.gen(function* () {
      yield* seed
      const rules = yield* LabelingRules
      const config = yield* LabelingConfiguration
      const policies = yield* Policies
      const policy = yield* policies.create(
        repositoryId,
        {
          name: "Main",
          description: "",
          source: baseMain,
        },
        actor,
      )
      yield* policies.publish(repositoryId, policy.policy.policyId, 1, actor)
      const emptyRevision = (yield* config.view(repositoryId)).configuredRevision
      yield* rules.create(
        repositoryId,
        {
          policyId: policy.policy.policyId,
          labelId: bug,
          onMatch: "ensure-present",
          onNoMatch: "ensure-absent",
          group: "kind",
          priority: 3,
          enabled: true,
        },
        actor,
      )
      yield* rules.create(
        repositoryId,
        {
          ai: { target: "pull_request", prompt: "Read {{fact:title}}", minimumConfidence: 0.8 },
          labelId: feature,
          onMatch: "ensure-present",
          onNoMatch: "no-action",
          group: null,
          priority: 7,
          enabled: true,
        },
        actor,
      )
      const before = yield* rules.list(repositoryId)
      const revision = (yield* config.view(repositoryId)).configuredRevision
      const snapshot = yield* config.load(repositoryId, revision)
      const sql = yield* SqlClient.SqlClient
      // Recreate the pre-0015 persisted representation, including revision snapshots.
      yield* sql.unsafe(`
        ALTER TABLE labeling_rule DROP CONSTRAINT labeling_rule_on_no_match_check;
        ALTER TABLE labeling_rule DROP COLUMN on_match;
        UPDATE labeling_rule SET on_no_match = 'preserve' WHERE on_no_match = 'no-action';
        ALTER TABLE labeling_rule ADD CONSTRAINT labeling_rule_on_no_match_check
          CHECK (on_no_match IN ('ensure-absent', 'preserve'));
        ALTER TABLE labeling_rule ADD CONSTRAINT ai_preserve
          CHECK (ai_definition IS NULL OR on_no_match = 'preserve');
        UPDATE labeling_configuration c SET rules = (
          SELECT coalesce(jsonb_agg((rule - 'onMatch') || jsonb_build_object('onNoMatch',
            CASE WHEN rule->>'onNoMatch' = 'no-action' THEN 'preserve' ELSE rule->>'onNoMatch' END
          ) ORDER BY ordinal), '[]'::jsonb)
          FROM jsonb_array_elements(c.rules) WITH ORDINALITY AS entries(rule, ordinal)
        );
      `)
      yield* sql.unsafe(
        readFileSync(
          new URL("../../migrations/0015_configurable_label_actions.sql", import.meta.url),
          "utf8",
        ),
      )
      assert.deepStrictEqual(yield* rules.list(repositoryId), before)
      assert.deepStrictEqual(yield* config.load(repositoryId, revision), snapshot)
      const empty = yield* config.load(repositoryId, emptyRevision)
      assert.isTrue(Option.isSome(empty))
      if (Option.isSome(empty)) assert.deepStrictEqual(empty.value.rules, [])
    }),
  )
})
