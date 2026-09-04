import { assert, layer } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { GitHubBudget, MAX_CONCURRENT_LEASES } from "../../src/GitHub/RateBudget.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"

const BudgetLayer = GitHubBudget.layer.pipe(Layer.provideMerge(MigratedPostgresLayer))

const key = (scopeKey: string) => ({ scopeKey, resource: "core" })

layer(BudgetLayer, { timeout: "2 minutes" })("GitHubBudget against Postgres", (it) => {
  it.effect("grants a lease when nothing is known and releases it", () =>
    Effect.gen(function* () {
      const budget = yield* GitHubBudget

      const decision = yield* budget.acquire({
        ...key("s1"),
        priority: "background",
        leaseToken: "l1",
      })
      assert.deepStrictEqual(decision, { _tag: "Granted", leaseToken: "l1" })
      yield* budget.release("l1")
    }),
  )

  it.effect("keeps a reserve for foreground work once the remaining budget is known", () =>
    Effect.gen(function* () {
      const budget = yield* GitHubBudget
      const now = yield* DateTime.now
      const resetAt = DateTime.addDuration(now, Duration.minutes(30))
      yield* budget.record({
        ...key("s2"),
        observedAt: now,
        headers: {
          "x-ratelimit-limit": 5000,
          "x-ratelimit-remaining": 120,
          "x-ratelimit-used": 4880,
          "x-ratelimit-reset": Math.floor(DateTime.toEpochMillis(resetAt) / 1000),
          "x-ratelimit-resource": "core",
        },
      })

      const background = yield* budget.acquire({
        ...key("s2"),
        priority: "background",
        leaseToken: "l2",
      })
      const foreground = yield* budget.acquire({
        ...key("s2"),
        priority: "foreground",
        leaseToken: "l3",
      })

      assert.strictEqual(background._tag, "Wait")
      if (background._tag === "Wait") {
        assert.strictEqual(background.reason, "reserve")
        assert.strictEqual(
          Math.floor(DateTime.toEpochMillis(background.until) / 1000),
          Math.floor(DateTime.toEpochMillis(resetAt) / 1000),
        )
      }
      assert.deepStrictEqual(foreground, { _tag: "Granted", leaseToken: "l3" })
    }),
  )

  it.effect("honors cooldowns for every priority", () =>
    Effect.gen(function* () {
      const budget = yield* GitHubBudget
      const now = yield* DateTime.now
      const until = DateTime.addDuration(now, Duration.minutes(5))
      yield* budget.cooldown({ ...key("s3"), until, kind: "secondary" })

      const decision = yield* budget.acquire({
        ...key("s3"),
        priority: "foreground",
        leaseToken: "l4",
      })

      assert.strictEqual(decision._tag, "Wait")
      if (decision._tag === "Wait") assert.strictEqual(decision.reason, "cooldown")
    }),
  )

  it.effect("caps concurrent leases per scope", () =>
    Effect.gen(function* () {
      const budget = yield* GitHubBudget
      for (let index = 0; index < MAX_CONCURRENT_LEASES; index++) {
        const decision = yield* budget.acquire({
          ...key("s4"),
          priority: "foreground",
          leaseToken: `c${index}`,
        })
        assert.strictEqual(decision._tag, "Granted")
      }

      const overflow = yield* budget.acquire({
        ...key("s4"),
        priority: "foreground",
        leaseToken: "c-over",
      })
      assert.strictEqual(overflow._tag, "Wait")
      if (overflow._tag === "Wait") assert.strictEqual(overflow.reason, "concurrency")

      yield* budget.release("c0")
      const after = yield* budget.acquire({
        ...key("s4"),
        priority: "foreground",
        leaseToken: "c-after",
      })
      assert.strictEqual(after._tag, "Granted")
    }),
  )

  it.effect("records retry-after as a cooldown and ignores older observations", () =>
    Effect.gen(function* () {
      const budget = yield* GitHubBudget
      const now = yield* DateTime.now
      yield* budget.record({
        ...key("s5"),
        observedAt: now,
        headers: { "retry-after": 120 },
      })
      yield* budget.record({
        ...key("s5"),
        observedAt: DateTime.subtractDuration(now, Duration.minutes(1)),
        headers: { "x-ratelimit-remaining": 0, "x-ratelimit-reset": 1 },
      })

      const decision = yield* budget.acquire({
        ...key("s5"),
        priority: "foreground",
        leaseToken: "l5",
      })
      assert.strictEqual(decision._tag, "Wait")
      if (decision._tag === "Wait") assert.strictEqual(decision.reason, "cooldown")
    }),
  )
  it.effect("bounds concurrent first requests before any response exists", () =>
    Effect.gen(function* () {
      const budget = yield* GitHubBudget
      const decisions = yield* Effect.all(
        Array.from({ length: 24 }, (_, index) =>
          budget.acquire({
            ...key("first-race"),
            priority: "foreground",
            leaseToken: `race-${index}`,
          }),
        ),
        { concurrency: "unbounded" },
      )
      assert.strictEqual(
        decisions.filter((decision) => decision._tag === "Granted").length,
        MAX_CONCURRENT_LEASES,
      )
    }),
  )

  it.effect("does not increase remaining allowance when responses arrive out of order", () =>
    Effect.gen(function* () {
      const budget = yield* GitHubBudget
      const now = yield* DateTime.now
      const reset = Math.floor(
        DateTime.toEpochMillis(DateTime.addDuration(now, Duration.hours(1))) / 1000,
      )
      yield* budget.record({
        ...key("ordering"),
        observedAt: now,
        headers: { "x-ratelimit-remaining": 1, "x-ratelimit-reset": reset },
      })
      yield* budget.record({
        ...key("ordering"),
        observedAt: DateTime.addDuration(now, Duration.seconds(1)),
        headers: { "x-ratelimit-remaining": 100, "x-ratelimit-reset": reset },
      })
      yield* budget.acquire({
        ...key("ordering"),
        priority: "foreground",
        leaseToken: "ordering-1",
      })
      const second = yield* budget.acquire({
        ...key("ordering"),
        priority: "foreground",
        leaseToken: "ordering-2",
      })
      assert.strictEqual(second._tag, "Wait")
    }),
  )

  it.effect("records a shared secondary cooldown before releasing its reservation", () =>
    Effect.gen(function* () {
      const budget = yield* GitHubBudget
      const now = yield* DateTime.now
      yield* budget.acquire({
        ...key("secondary-record"),
        priority: "foreground",
        leaseToken: "secondary-1",
      })
      yield* budget.record({
        ...key("secondary-record"),
        observedAt: now,
        leaseToken: "secondary-1",
        headers: {},
        cooldown: { until: DateTime.addDuration(now, Duration.minutes(1)), kind: "secondary" },
      })
      const next = yield* budget.acquire({
        ...key("secondary-record"),
        priority: "foreground",
        leaseToken: "secondary-2",
      })
      assert.strictEqual(next._tag, "Wait")
      if (next._tag === "Wait") assert.strictEqual(next.reason, "cooldown")
    }),
  )
})
