import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { activityPage } from "../../src/Labeling/Activity.ts"
import { repositoryId, seed, seedPullRequests, Services, bug } from "./support.ts"
layer(Services, { timeout: "2 minutes" })("Activity pagination", (it) => {
  it.effect(
    "pages tied timestamps without gaps or duplicates and distinguishes writes from plans",
    () =>
      Effect.gen(function* () {
        yield* seed
        yield* seedPullRequests
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO labeling_reconciliation(repository_id,number,snapshot_generation,rules_revision,covered_sequence,fingerprint,created_at,outcome)
      SELECT ${repositoryId},5,n,1,1,repeat('a',64),'2026-09-07T10:00:00.123456Z'::timestamptz,'evaluated' FROM generate_series(1,55) n`
        yield* sql`INSERT INTO labeling_label_action(repository_id,number,snapshot_generation,rules_revision,label_id,action,rule_id,status,detail)
      VALUES (${repositoryId},5,55,1,${bug},'add','rule-1','failed','GitHub rejected the write')`
        yield* sql`INSERT INTO labeling_rule_evaluation(repository_id,number,snapshot_generation,rules_revision,rule_id,policy_version_id,outcome,selected,reason,trace)
          VALUES (${repositoryId},5,55,1,'rule-1','historical-version','unknown',false,'appliesWhen: policy release unknown','[{"outcome":"unknown","reason":"changedFiles is unavailable","location":{"root":"appliesWhen","path":[]}}]'::jsonb)`
        const first = yield* activityPage(repositoryId, {
          search: "Change",
          target: "pull_request",
          cursor: null,
        })
        assert.lengthOf(first.entries, 50)
        assert.strictEqual(first.entries[0]?.title, "Change 5")
        assert.strictEqual(first.entries[0]?.actions[0]?.status, "failed")
        assert.strictEqual(first.entries[0]?.actions[0]?.name, "bug")
        assert.strictEqual(
          first.entries[0]?.evaluations?.[0]?.reason,
          "Gate unresolved: changedFiles is unavailable",
        )
        assert.isNotNull(first.cursor)
        yield* sql`INSERT INTO labeling_reconciliation(repository_id,number,snapshot_generation,rules_revision,covered_sequence,fingerprint,outcome)
      VALUES (${repositoryId},5,56,1,1,repeat('a',64),'evaluated')`
        const second = yield* activityPage(repositoryId, {
          search: "Change",
          target: "pull_request",
          cursor: first.cursor,
        })
        assert.lengthOf(second.entries, 5)
        assert.strictEqual(
          new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size,
          55,
        )
        assert.isNull(second.cursor)
        assert.lengthOf(
          (yield* activityPage(repositoryId, { search: "", target: "issue", cursor: null }))
            .entries,
          0,
        )
        assert.lengthOf(
          (yield* activityPage(repositoryId, {
            search: "not a title",
            target: "all",
            cursor: null,
          })).entries,
          0,
        )
      }),
  )
})
