import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { GitHubInstallationId, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { SyncGeneration, type SyncScope } from "@janitor/domain/GitHub/Sync"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import { SyncTargets } from "../src/SyncTargets.ts"
import { WorkflowOutbox } from "../src/WorkflowOutbox.ts"
import { MigratedPostgresLayer } from "./support/Postgres.ts"

const TargetsLayer = SyncTargets.layer.pipe(
  Layer.provideMerge(WorkflowOutbox.layer),
  Layer.provideMerge(MigratedPostgresLayer),
)

const scope = (id: string): SyncScope => ({
  _tag: "InstallationInventory",
  installationId: GitHubInstallationId.make(id),
})
const seq = (n: number) => Option.some(GitHubWebhookJournalSequence.make(String(n)))
const gen = (n: number) => SyncGeneration.make(String(n))

const outboxRows = (key: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ execution_key: string; accepted_at: Date | null }>`
      SELECT execution_key, accepted_at FROM workflow_outbox
      WHERE execution_key LIKE ${`${key}:%`} ORDER BY execution_key
    `,
  )

layer(TargetsLayer, { timeout: "2 minutes" })("SyncTargets against Postgres", (it) => {
  it.effect("coalesces a burst of invalidations into one pending run", () =>
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      const s = scope("1")

      const first = yield* targets.invalidate({ scope: s, sequence: seq(10) })
      const second = yield* targets.invalidate({ scope: s, sequence: seq(12) })
      const third = yield* targets.invalidate({ scope: s, sequence: seq(11) })

      assert.deepStrictEqual(first, { generation: gen(1), dispatched: true })
      assert.deepStrictEqual(second, { generation: gen(2), dispatched: false })
      assert.deepStrictEqual(third, { generation: gen(3), dispatched: false })
      assert.deepStrictEqual(
        (yield* outboxRows("installation:1")).map((row) => row.execution_key),
        ["installation:1:1"],
      )
      const target = Option.getOrThrow(yield* targets.get(s))
      assert.strictEqual(target.requestedGeneration, "3")
      assert.strictEqual(target.dispatchedGeneration, "1")
      assert.strictEqual(target.requestedSequence, "12")
    }),
  )

  it.effect("begin covers the latest generation and completion verifies it", () =>
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      const s = scope("2")
      yield* targets.invalidate({ scope: s, sequence: seq(5) })
      yield* targets.invalidate({ scope: s, sequence: seq(7) })

      const begun = yield* targets.begin(s, gen(1))
      assert.deepStrictEqual(begun, {
        _tag: "Run",
        generation: gen(2),
        sequence: seq(7),
        watermark: Option.none(),
        full: false,
      })

      const followUp = yield* targets.complete({
        scope: s,
        generation: gen(2),
        outcome: { _tag: "Verified", watermark: Option.none() },
      })
      assert.isTrue(followUp)

      const target = Option.getOrThrow(yield* targets.get(s))
      assert.strictEqual(target.completedGeneration, "2")
      assert.strictEqual(target.verifiedGeneration, "2")
      assert.strictEqual(target.verifiedSequence, "7")
      assert.isNotNull(target.verifiedAt)
      assert.strictEqual(target.health, "ok")

      const stale = yield* targets.begin(s, gen(2))
      assert.deepStrictEqual(stale, { _tag: "Superseded" })
    }),
  )

  it.effect("work arriving during a run produces exactly one follow-up at completion", () =>
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      const s = scope("3")
      yield* targets.invalidate({ scope: s, sequence: seq(1) })
      const begun = yield* targets.begin(s, gen(1))
      assert.strictEqual(begun._tag, "Run")

      const during = yield* targets.invalidate({ scope: s, sequence: seq(2) })
      const duringAgain = yield* targets.invalidate({ scope: s, sequence: seq(3) })
      assert.isFalse(during.dispatched)
      assert.isFalse(duringAgain.dispatched)

      const followUp = yield* targets.complete({
        scope: s,
        generation: gen(1),
        outcome: { _tag: "Verified", watermark: Option.none() },
      })
      assert.isTrue(followUp)
      assert.deepStrictEqual(
        (yield* outboxRows("installation:3")).map((row) => row.execution_key),
        ["installation:3:1", "installation:3:3"],
      )
      const target = Option.getOrThrow(yield* targets.get(s))
      assert.strictEqual(target.dispatchedGeneration, "3")
      assert.strictEqual(target.completedGeneration, "1")
    }),
  )

  it.effect("a long-running or suspended workflow is not replaced by elapsed time", () =>
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      const sql = yield* SqlClient.SqlClient
      const s = scope("9")
      yield* targets.invalidate({ scope: s, sequence: seq(1) })
      yield* targets.begin(s, gen(1))

      const fresh = yield* targets.invalidate({ scope: s, sequence: seq(2) })
      assert.isFalse(fresh.dispatched)

      yield* sql`
        UPDATE sync_target SET updated_at = CLOCK_TIMESTAMP() - INTERVAL '31 minutes'
        WHERE scope_key = 'installation:9'
      `
      const expired = yield* targets.invalidate({ scope: s, sequence: seq(3) })
      assert.deepStrictEqual(expired, { generation: gen(3), dispatched: false })
      assert.deepStrictEqual(
        (yield* outboxRows("installation:9")).map((row) => row.execution_key),
        ["installation:9:1"],
      )
    }),
  )

  it.effect("records blocked and failed outcomes without verifying", () =>
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      const s = scope("4")
      yield* targets.invalidate({ scope: s, sequence: Option.none() })

      yield* targets.begin(s, gen(1))
      yield* targets.complete({
        scope: s,
        generation: gen(1),
        outcome: { _tag: "Blocked", reason: "suspended" },
      })
      let target = Option.getOrThrow(yield* targets.get(s))
      assert.strictEqual(target.health, "blocked")
      assert.strictEqual(target.blockedReason, "suspended")
      assert.strictEqual(target.verifiedGeneration, "0")

      yield* targets.invalidate({ scope: s, sequence: Option.none() })
      yield* targets.begin(s, gen(2))
      yield* targets.complete({
        scope: s,
        generation: gen(2),
        outcome: { _tag: "Failed", error: "boom" },
      })
      target = Option.getOrThrow(yield* targets.get(s))
      assert.strictEqual(target.health, "ok")
      assert.strictEqual(target.lastError, "boom")
      assert.strictEqual(target.completedGeneration, "2")
    }),
  )
  it.effect("serializes simultaneous first invalidations into one dispatch", () =>
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      const s = scope("501")
      const results = yield* Effect.all(
        Array.from({ length: 20 }, () => targets.invalidate({ scope: s, sequence: Option.none() })),
        { concurrency: "unbounded" },
      )
      assert.strictEqual(results.filter((result) => result.dispatched).length, 1)
      assert.strictEqual((yield* outboxRows("installation:501")).length, 1)
      assert.strictEqual(Option.getOrThrow(yield* targets.get(s)).requestedGeneration, "20")
    }),
  )

  it.effect("captures coverage and preserves a full repair requested after begin", () =>
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      const s = scope("502")
      yield* targets.invalidate({ scope: s, sequence: seq(10) })
      const original = yield* targets.begin(s, gen(1))
      yield* targets.invalidate({ scope: s, sequence: seq(20), full: true })
      assert.deepStrictEqual(yield* targets.begin(s, gen(1)), original)
      yield* targets.complete({
        scope: s,
        generation: gen(1),
        outcome: { _tag: "Verified", watermark: Option.none() },
      })
      assert.strictEqual(Option.getOrThrow(yield* targets.get(s)).verifiedSequence, "10")
      const follow = yield* targets.begin(s, gen(2))
      assert.strictEqual(follow._tag, "Run")
      if (follow._tag === "Run") assert.isTrue(follow.full)
      assert.isFalse(
        yield* targets.complete({
          scope: s,
          generation: gen(1),
          outcome: { _tag: "Blocked", reason: "old" },
        }),
      )
      const target = Option.getOrThrow(yield* targets.get(s))
      assert.strictEqual(target.health, "ok")
      assert.strictEqual(target.completedGeneration, "1")
      assert.isTrue(
        Option.isNone(yield* targets.withRun(s, gen(1), Effect.die("stale write must not run"))),
      )
    }),
  )

  it.effect("rolls back target completion when enqueueing the follow-up fails", () =>
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      const sql = yield* SqlClient.SqlClient
      const s = scope("503")
      yield* targets.invalidate({ scope: s, sequence: Option.none() })
      yield* targets.begin(s, gen(1))
      yield* targets.invalidate({ scope: s, sequence: Option.none() })
      yield* sql.unsafe(
        "CREATE FUNCTION reject_sync_followup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.execution_key = 'installation:503:2' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$",
      )
      yield* sql.unsafe(
        "CREATE TRIGGER reject_sync_followup BEFORE INSERT ON workflow_outbox FOR EACH ROW EXECUTE FUNCTION reject_sync_followup()",
      )
      const failed = yield* targets
        .complete({
          scope: s,
          generation: gen(1),
          outcome: { _tag: "Verified", watermark: Option.none() },
        })
        .pipe(Effect.result)
      yield* sql.unsafe("DROP TRIGGER reject_sync_followup ON workflow_outbox")
      assert.strictEqual(failed._tag, "Failure")
      assert.strictEqual(Option.getOrThrow(yield* targets.get(s)).completedGeneration, "0")
    }),
  )

  it.effect("recovers a terminal execution and retries a failed entity target", () =>
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      const sql = yield* SqlClient.SqlClient
      const s: SyncScope = {
        _tag: "Entity",
        repositoryId: GitHubRepositoryDatabaseId.make("77"),
        number: 9,
      }
      yield* targets.invalidate({ scope: s, sequence: seq(1), full: true })
      yield* targets.begin(s, gen(1))
      yield* targets.recoverTerminal(s, gen(1))
      yield* sql`UPDATE sync_target SET retry_at = CLOCK_TIMESTAMP() - INTERVAL '1 second' WHERE scope_key = 'entity:77:9'`
      yield* targets.retryDue
      const next = yield* targets.begin(s, gen(2))
      assert.strictEqual(next._tag, "Run")
      if (next._tag === "Run") assert.isTrue(next.full)
      yield* targets.recoverTerminal(s, gen(1))
      assert.strictEqual(Option.getOrThrow(yield* targets.get(s)).completedGeneration, "1")
    }),
  )
  it.effect("manual requests accelerate the original debounced payload", () =>
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      const sql = yield* SqlClient.SqlClient
      const s = scope("504")
      yield* targets.invalidate({ scope: s, sequence: Option.none() })
      const before = yield* sql<{
        due_at: Date
      }>`SELECT due_at FROM workflow_outbox WHERE execution_key = 'installation:504:1'`
      yield* targets.invalidate({ scope: s, sequence: Option.none(), immediate: true })
      const after = yield* sql<{
        due_at: Date
        payload: { generation: string }
      }>`SELECT due_at, payload FROM workflow_outbox WHERE execution_key = 'installation:504:1'`
      assert.strictEqual(before[0]!.due_at.getTime() - after[0]!.due_at.getTime(), 5000)
      assert.strictEqual(after[0]!.payload.generation, "1")
      assert.strictEqual((yield* outboxRows("installation:504")).length, 1)
    }),
  )
})
