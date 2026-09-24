import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as TestClock from "effect/testing/TestClock"

/**
 * Runs `effect` while stepping the `TestClock`, so retry backoff and durable
 * sleeps elapse without real waiting. Only for effects that do no I/O between
 * sleeps: a step taken before a sleep registers is lost.
 */
export const withElapsingClock = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  step: Duration.Input = Duration.seconds(1),
  limit = 1000,
) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect)
    for (let tick = 0; fiber.pollUnsafe() === undefined && tick < limit; tick++) {
      yield* Effect.yieldNow
      yield* TestClock.adjust(step)
    }
    return yield* Fiber.join(fiber)
  })
