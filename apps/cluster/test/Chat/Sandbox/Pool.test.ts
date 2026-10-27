import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Queue from "effect/Queue"
import * as TestClock from "effect/testing/TestClock"
import { makeSandboxPool, SandboxBusy } from "../../../src/Chat/Sandbox/Pool.ts"

const makePool = (capacity: number) =>
  Effect.gen(function* () {
    const destroyed: Array<string> = []
    const queued = yield* Queue.unbounded<string>()
    const pool = yield* makeSandboxPool({
      capacity,
      warmFor: Duration.minutes(30),
      queueTimeout: Duration.minutes(15),
      destroy: (sessionId) => Effect.sync(() => destroyed.push(sessionId)),
    })
    /** Starts a turn that queues, reporting each position as `<session>:<ahead>`. */
    const queue = (sessionId: string) =>
      Effect.forkChild(
        pool.acquire(sessionId, (ahead) => Queue.offer(queued, `${sessionId}:${ahead}`)),
      )
    return { pool, destroyed, queue, nextQueued: Queue.take(queued) }
  })

/** Lets forked turns reach their next wait before the clock moves. */
const settle = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
  discard: true,
})

describe("chat sandbox pool", () => {
  it.effect("a turn inside the warm window gets the session's sandbox back", () =>
    Effect.gen(function* () {
      const { pool, destroyed } = yield* makePool(1)
      assert.isTrue((yield* pool.acquire("a")).fresh)
      yield* pool.release("a")
      yield* TestClock.adjust("29 minutes")

      assert.isFalse((yield* pool.acquire("a")).fresh)
      assert.deepStrictEqual(destroyed, [])
    }),
  )

  it.effect("a turn after the warm window starts on a fresh sandbox", () =>
    Effect.gen(function* () {
      const { pool, destroyed } = yield* makePool(1)
      yield* pool.acquire("a")
      yield* pool.release("a")
      yield* TestClock.adjust("31 minutes")

      assert.isTrue((yield* pool.acquire("a")).fresh)
      assert.deepStrictEqual(destroyed, ["a"])
    }),
  )

  it.effect("a full pool destroys the sandbox idle longest", () =>
    Effect.gen(function* () {
      const { pool, destroyed } = yield* makePool(2)
      yield* pool.acquire("a")
      yield* pool.acquire("b")
      yield* pool.release("a")
      yield* TestClock.adjust("1 minute")
      yield* pool.release("b")

      assert.isTrue((yield* pool.acquire("c")).fresh)
      assert.deepStrictEqual(destroyed, ["a"])
      yield* pool.release("c")
      assert.isFalse((yield* pool.acquire("b")).fresh)
    }),
  )

  it.effect("queued turns get sandboxes first come, first served, and hear their position", () =>
    Effect.gen(function* () {
      const { pool, queue, nextQueued } = yield* makePool(1)
      yield* pool.acquire("a")
      const b = yield* queue("b")
      assert.strictEqual(yield* nextQueued, "b:0")
      const c = yield* queue("c")
      assert.strictEqual(yield* nextQueued, "c:1")

      yield* pool.release("a")
      yield* Fiber.join(b)
      assert.strictEqual(yield* nextQueued, "c:0")
      yield* settle
      assert.isUndefined(c.pollUnsafe())

      yield* pool.release("b")
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
})
