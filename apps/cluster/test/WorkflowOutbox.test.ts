import { assert, layer } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { WorkflowOutbox, OutboxWake } from "../src/WorkflowOutbox.ts"
import { MigratedPostgresLayer } from "./support/Postgres.ts"

const OutboxLayer = WorkflowOutbox.layer.pipe(Layer.provideMerge(MigratedPostgresLayer))

const lease = Duration.seconds(60)

layer(OutboxLayer, { timeout: "2 minutes" })("WorkflowOutbox against Postgres", (it) => {
  it.effect("wakes once after the producer transaction commits", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      let wakes = 0
      const outbox = yield* WorkflowOutbox.make.pipe(
        Effect.provideService(
          OutboxWake,
          Effect.gen(function* () {
            const rows =
              yield* sql`SELECT execution_key FROM workflow_outbox WHERE workflow_tag='wake-test'`
            assert.strictEqual(rows.length, 2)
            wakes++
          }),
        ),
      )
      yield* Effect.scoped(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* outbox.enqueue({ workflowTag: "wake-test", executionKey: "one", payload: {} })
            yield* outbox.enqueue({ workflowTag: "wake-test", executionKey: "two", payload: {} })
            assert.strictEqual(wakes, 0)
          }),
        ),
      )
      assert.strictEqual(wakes, 1)
    }),
  )
  it.effect("enqueue is idempotent per workflow tag and execution key", () =>
    Effect.gen(function* () {
      const outbox = yield* WorkflowOutbox
      const sql = yield* SqlClient.SqlClient

      yield* outbox.enqueue({ workflowTag: "T", executionKey: "idem", payload: { n: 1 } })
      yield* outbox.enqueue({ workflowTag: "T", executionKey: "idem", payload: { n: 2 } })

      const rows = yield* sql<{ payload: { n: number } }>`
        SELECT payload FROM workflow_outbox WHERE workflow_tag = ${"T"} AND execution_key = ${"idem"}
      `
      assert.deepStrictEqual(rows, [{ payload: { n: 1 } }])
    }),
  )

  it.effect("claims due rows once per lease and fences completion by token", () =>
    Effect.gen(function* () {
      const outbox = yield* WorkflowOutbox

      yield* outbox.enqueue({ workflowTag: "T", executionKey: "claim-1", payload: { a: 1 } })

      const first = yield* outbox.claimDue({
        leaseToken: "token-a",
        leaseDuration: lease,
        limit: 10,
        only: { workflowTag: "T", executionKey: "claim-1" },
      })
      const second = yield* outbox.claimDue({
        leaseToken: "token-b",
        leaseDuration: lease,
        limit: 10,
        only: { workflowTag: "T", executionKey: "claim-1" },
      })

      assert.deepStrictEqual(
        first.map((row) => [row.execution_key, row.attempts, row.payload]),
        [["claim-1", 1, { a: 1 }]],
      )
      assert.deepStrictEqual(second, [])

      const staleAccept = yield* outbox.markAccepted({
        workflowTag: "T",
        executionKey: "claim-1",
        leaseToken: "token-b",
      })
      const accept = yield* outbox.markAccepted({
        workflowTag: "T",
        executionKey: "claim-1",
        leaseToken: "token-a",
      })
      const again = yield* outbox.markAccepted({
        workflowTag: "T",
        executionKey: "claim-1",
        leaseToken: "token-a",
      })

      assert.isFalse(staleAccept)
      assert.isTrue(accept)
      assert.isFalse(again)

      const afterAccept = yield* outbox.claimDue({
        leaseToken: "token-c",
        leaseDuration: lease,
        limit: 10,
        only: { workflowTag: "T", executionKey: "claim-1" },
      })
      assert.deepStrictEqual(afterAccept, [])
    }),
  )

  it.effect("release returns the row to the due set after the retry delay", () =>
    Effect.gen(function* () {
      const outbox = yield* WorkflowOutbox
      const only = { workflowTag: "T", executionKey: "release-1" }

      yield* outbox.enqueue({ ...only, payload: {} })
      const claimed = yield* outbox.claimDue({
        leaseToken: "t1",
        leaseDuration: lease,
        limit: 10,
        only,
      })
      assert.strictEqual(claimed.length, 1)

      const releasedFar = yield* outbox.release({ ...only, leaseToken: "t1" }, Duration.hours(1))
      assert.isTrue(releasedFar)
      const notDue = yield* outbox.claimDue({
        leaseToken: "t2",
        leaseDuration: lease,
        limit: 10,
        only,
      })
      assert.deepStrictEqual(notDue, [])

      const releasedWrongToken = yield* outbox.release({ ...only, leaseToken: "t1" }, Duration.zero)
      assert.isFalse(releasedWrongToken)

      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE workflow_outbox SET due_at = CLOCK_TIMESTAMP() WHERE execution_key = ${"release-1"}`
      const dueAgain = yield* outbox.claimDue({
        leaseToken: "t3",
        leaseDuration: lease,
        limit: 10,
        only,
      })
      assert.deepStrictEqual(
        dueAgain.map((row) => [row.execution_key, row.attempts]),
        [["release-1", 2]],
      )
    }),
  )

  it.effect("claims rows across tags in due order up to the limit", () =>
    Effect.gen(function* () {
      const outbox = yield* WorkflowOutbox
      const sql = yield* SqlClient.SqlClient

      yield* outbox.enqueue({ workflowTag: "A", executionKey: "order-1", payload: {} })
      yield* outbox.enqueue({ workflowTag: "B", executionKey: "order-2", payload: {} })
      yield* sql`UPDATE workflow_outbox SET due_at = due_at - make_interval(secs => 10) WHERE execution_key = ${"order-2"}`

      const claimed = yield* outbox.claimDue({
        leaseToken: "order",
        leaseDuration: lease,
        limit: 1,
      })

      assert.deepStrictEqual(
        claimed.map((row) => row.execution_key),
        ["order-2"],
      )
    }),
  )
})
