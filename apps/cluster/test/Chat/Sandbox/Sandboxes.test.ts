import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as TestClock from "effect/testing/TestClock"
import type { ChatSandboxPoolShape, PoolGrant } from "../../../src/Chat/Sandbox/PoolObject.ts"
import { ChatSandboxes } from "../../../src/Chat/Sandbox/Sandboxes.ts"
import type { ChatWorkspaceShape } from "../../../src/Chat/Sandbox/WorkspaceObject.ts"

const SESSION = "slack/T1/C1/1700000000.000100"

const grant: PoolGrant = { fresh: true, generation: 7, destroy: [] }

/** Runs `effect` against stub pool and workspace objects. */
const withSandboxes = <A, E>(
  pool: ChatSandboxPoolShape,
  workspace: ChatWorkspaceShape,
  effect: Effect.Effect<A, E, ChatSandboxes>,
) =>
  Effect.provide(
    effect,
    ChatSandboxes.layer({
      pools: { getByName: () => pool },
      workspaces: { getByName: () => workspace },
      namespace: { getByName: () => ({ fetch: () => Promise.reject(new Error("unused")) }) },
    }),
  )

describe("chat sandboxes", () => {
  it.effect("a turn stopped while its sandbox starts gives the pool its grant back", () =>
    Effect.gen(function* () {
      const released: Array<string> = []
      const starting = yield* Deferred.make<void>()
      const pool: ChatSandboxPoolShape = {
        acquire: () => Effect.succeed(grant),
        release: ({ sessionId, generation }) =>
          Effect.sync(() => {
            released.push(`${sessionId}@${generation}`)
            return { destroy: [] }
          }),
        queuePosition: () => Effect.succeed(null),
      }
      const workspace: ChatWorkspaceShape = {
        acquire: () => Deferred.succeed(starting, undefined).pipe(Effect.andThen(Effect.never)),
        destroy: () => Effect.void,
      }

      yield* withSandboxes(
        pool,
        workspace,
        Effect.gen(function* () {
          const sandboxes = yield* ChatSandboxes
          const turn = yield* Effect.forkChild(
            sandboxes.acquire({ sessionId: SESSION, startBudget: "1 minute" }),
          )
          yield* Deferred.await(starting)
          yield* Fiber.interrupt(turn)
        }),
      )
      assert.deepStrictEqual(released, [`${SESSION}@7`])
    }),
  )

  it.effect("a turn queued for less than the poll interval still hears its position", () =>
    Effect.gen(function* () {
      const heard: Array<number> = []
      const pool: ChatSandboxPoolShape = {
        acquire: () => Effect.as(Effect.sleep("1 second"), grant),
        release: () => Effect.succeed({ destroy: [] }),
        queuePosition: () => Effect.succeed(0),
      }
      const workspace: ChatWorkspaceShape = {
        acquire: () => Effect.succeed({ fresh: false }),
        destroy: () => Effect.void,
      }

      yield* withSandboxes(
        pool,
        workspace,
        Effect.gen(function* () {
          const sandboxes = yield* ChatSandboxes
          const turn = yield* Effect.forkChild(
            sandboxes.acquire({
              sessionId: SESSION,
              startBudget: "1 minute",
              onQueued: (ahead) => Effect.sync(() => heard.push(ahead)),
            }),
          )
          yield* Effect.yieldNow
          yield* TestClock.adjust("1 second")
          yield* Fiber.join(turn)
        }),
      )
      assert.deepStrictEqual(heard, [0])
    }),
  )
})
