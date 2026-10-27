import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Queue from "effect/Queue"
import * as TestClock from "effect/testing/TestClock"
import {
  makeSandboxPool,
  SandboxBusy,
  type PoolSnapshot,
  type SandboxPoolOptions,
} from "../../../src/Chat/Sandbox/Pool.ts"

const makePool = (capacity: number, storage?: SandboxPoolOptions["storage"]) =>
  Effect.gen(function* () {
    const destroyed: Array<string> = []
    const destroyedGenerations: Array<number> = []
    const queued = yield* Queue.unbounded<string>()
    const pool = yield* makeSandboxPool({
      capacity,
      warmFor: Duration.minutes(30),
      queueTimeout: Duration.minutes(15),
      abandonAfter: Duration.minutes(25),
      destroy: (sessionId, generation) =>
        Effect.sync(() => {
          destroyed.push(sessionId)
          destroyedGenerations.push(generation)
        }),
      storage,
    })
    /** Starts a turn that queues, reporting each position as `<session>:<ahead>`. */
    const queue = (sessionId: string) =>
      Effect.forkChild(
        pool.acquire(sessionId, (ahead) => Queue.offer(queued, `${sessionId}:${ahead}`)),
      )
    return { pool, destroyed, destroyedGenerations, queue, nextQueued: Queue.take(queued) }
  })

/** Lets forked turns reach their next wait before the clock moves. */
const settle = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
  discard: true,
})

describe("chat sandbox pool", () => {
  it.effect("a turn inside the warm window gets the session's sandbox back", () =>
    Effect.gen(function* () {
      const { pool, destroyed } = yield* makePool(1)
      const lease = yield* pool.acquire("a")
      assert.isTrue(lease.fresh)
      yield* pool.release("a", lease.generation)
      yield* TestClock.adjust("29 minutes")

      assert.isFalse((yield* pool.acquire("a")).fresh)
      assert.deepStrictEqual(destroyed, [])
    }),
  )

  it.effect("a turn after the warm window starts on a fresh sandbox", () =>
    Effect.gen(function* () {
      const { pool, destroyed } = yield* makePool(1)
      const lease = yield* pool.acquire("a")
      yield* pool.release("a", lease.generation)
      yield* TestClock.adjust("31 minutes")

      assert.isTrue((yield* pool.acquire("a")).fresh)
      assert.deepStrictEqual(destroyed, ["a"])
    }),
  )

  it.effect("a full pool destroys the sandbox idle longest", () =>
    Effect.gen(function* () {
      const { pool, destroyed } = yield* makePool(2)
      const a = yield* pool.acquire("a")
      const b = yield* pool.acquire("b")
      yield* pool.release("a", a.generation)
      yield* TestClock.adjust("1 minute")
      yield* pool.release("b", b.generation)

      const c = yield* pool.acquire("c")
      assert.isTrue(c.fresh)
      assert.deepStrictEqual(destroyed, ["a"])
      yield* pool.release("c", c.generation)
      assert.isFalse((yield* pool.acquire("b")).fresh)
    }),
  )

  it.effect("queued turns get sandboxes first come, first served, and hear their position", () =>
    Effect.gen(function* () {
      const { pool, queue, nextQueued } = yield* makePool(1)
      const a = yield* pool.acquire("a")
      const b = yield* queue("b")
      assert.strictEqual(yield* nextQueued, "b:0")
      const c = yield* queue("c")
      assert.strictEqual(yield* nextQueued, "c:1")

      yield* pool.release("a", a.generation)
      const granted = yield* Fiber.join(b)
      assert.strictEqual(yield* nextQueued, "c:0")
      yield* settle
      assert.isUndefined(c.pollUnsafe())

      yield* pool.release("b", granted.generation)
      yield* Fiber.join(c)
    }),
  )

  it.effect("a queued turn gives up as busy after the queue timeout", () =>
    Effect.gen(function* () {
      const { pool, queue, nextQueued } = yield* makePool(1)
      yield* pool.acquire("a")
      const b = yield* queue("b")
      assert.strictEqual(yield* nextQueued, "b:0")
      yield* settle

      yield* TestClock.adjust("14 minutes")
      yield* settle
      assert.isUndefined(b.pollUnsafe())
      yield* TestClock.adjust("1 minute")
      assert.instanceOf(yield* Fiber.join(b).pipe(Effect.flip), SandboxBusy)
    }),
  )

  it.effect(
    "a turn that takes over its session's sandbox isn't ended by the earlier turn's release",
    () =>
      Effect.gen(function* () {
        const { pool, destroyed, queue, nextQueued } = yield* makePool(1)
        const earlier = yield* pool.acquire("a")
        const later = yield* pool.acquire("a")
        assert.isTrue(later.generation > earlier.generation)

        yield* pool.release("a", earlier.generation)
        const b = yield* queue("b")
        assert.strictEqual(yield* nextQueued, "b:0")
        yield* settle
        assert.isUndefined(b.pollUnsafe())
        assert.deepStrictEqual(destroyed, [])

        yield* pool.release("a", later.generation)
        yield* Fiber.join(b)
      }),
  )

  it.effect("a queued turn gets the sandbox when the grant ahead of it is abandoned", () =>
    Effect.gen(function* () {
      const { pool, destroyed, destroyedGenerations, queue, nextQueued } = yield* makePool(1)
      const abandoned = yield* pool.acquire("a")
      yield* TestClock.adjust("20 minutes")
      const b = yield* queue("b")
      assert.strictEqual(yield* nextQueued, "b:0")
      yield* settle

      yield* TestClock.adjust("4 minutes")
      yield* settle
      assert.isUndefined(b.pollUnsafe())
      yield* TestClock.adjust("1 minute")
      assert.isTrue((yield* Fiber.join(b)).fresh)
      assert.deepStrictEqual(destroyed, ["a"])
      assert.deepStrictEqual(destroyedGenerations, [abandoned.generation])
    }),
  )

  it.effect("grants keep counting up after the pool restarts", () =>
    Effect.gen(function* () {
      let stored: PoolSnapshot | undefined
      const storage = {
        load: Effect.sync(() => stored),
        save: (snapshot: PoolSnapshot) =>
          Effect.sync(() => {
            stored = snapshot
          }),
      }
      const before = yield* makePool(2, storage)
      const first = yield* before.pool.acquire("a")

      const after = yield* makePool(2, storage)
      assert.isTrue((yield* after.pool.acquire("b")).generation > first.generation)
    }),
  )
})
