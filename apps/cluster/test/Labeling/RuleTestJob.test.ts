import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import {
  RuleTestJobLayer,
  TestWorkflow,
  enqueueRuleTest,
  getRuleTest,
} from "../../src/Labeling/RuleTestJob.ts"
import { baseMain, repositoryId, seed, seedPullRequests, Services } from "./support.ts"
const TestLayer = RuleTestJobLayer.pipe(
  Layer.provideMerge(Services),
  Layer.provideMerge(WorkflowEngine.layerMemory),
)
layer(TestLayer, { timeout: "2 minutes" })("Rule test jobs", (it) => {
  it.effect("persists and evaluates a non-mutating test through the workflow", () =>
    Effect.gen(function* () {
      yield* seed
      yield* seedPullRequests
      const job = yield* enqueueRuleTest(repositoryId, {
        subject: { _tag: "Draft", source: baseMain },
        numbers: [5],
      })
      assert.strictEqual(job.status, "queued")
      yield* TestWorkflow.execute({ repositoryId, testId: job.testId })
      const result = yield* getRuleTest(repositoryId, job.testId)
      assert.strictEqual(result?.status, "done")
      assert.strictEqual(result?.response?._tag, "Evaluated")
      const sql = yield* SqlClient.SqlClient
      assert.lengthOf(yield* sql`SELECT * FROM labeling_label_action`, 0)
      const expired = yield* enqueueRuleTest(repositoryId, {
        subject: { _tag: "Draft", source: baseMain },
        numbers: [5],
      })
      yield* sql`UPDATE labeling_rule_test SET expires_at=CLOCK_TIMESTAMP()-INTERVAL '1 minute' WHERE test_id=${expired.testId}`
      assert.strictEqual((yield* getRuleTest(repositoryId, expired.testId))?.status, "failed")
      yield* TestWorkflow.execute({ repositoryId, testId: expired.testId })
      assert.strictEqual((yield* getRuleTest(repositoryId, expired.testId))?.status, "failed")
    }),
  )
})
