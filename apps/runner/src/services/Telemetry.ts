import { Clock, Effect, Exit } from "effect"

/** Only operation names, opaque identities and durations enter infrastructure logs. */
export const timed =
  (operation: string, identity: Readonly<Record<string, string | number>> = {}) =>
  <A, E, R>(program: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis
      return yield* program.pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const finished = yield* Clock.currentTimeMillis
            yield* Effect.logInfo("runner.operation").pipe(
              Effect.annotateLogs({
                operation,
                ...identity,
                durationMs: finished - started,
                outcome: Exit.isSuccess(exit) ? "succeeded" : "failed",
              }),
            )
          }),
        ),
      )
    })
