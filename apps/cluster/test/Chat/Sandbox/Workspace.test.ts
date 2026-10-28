import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as TestClock from "effect/testing/TestClock"
import { ChatCredentials } from "../../../src/Chat/Egress/BotApp.ts"
import {
  CHAT_GENERATION_HEADER,
  makeChatWorkspace,
  type ChatWorkspaceState,
} from "../../../src/Chat/Sandbox/Workspace.ts"
import { ChatSkills, MULTICA_SKILL } from "../../../src/Chat/Sandbox/Skills.ts"
import { makeState } from "./support.ts"

/** A workspace without the bot's credentials: its egress hands out no token. */
const makeWorkspace = (state: ChatWorkspaceState) =>
  makeChatWorkspace(state).pipe(
    Effect.provide(Layer.mergeAll(ChatCredentials.disabled, ChatSkills.bundled)),
  )

const TRIAGE = { name: "triage", files: [{ path: "SKILL.md", content: "" }] }

/** A workspace whose skills come from a repository, counting each load in `counter`. */
const makeSkilledWorkspace = (state: ChatWorkspaceState, counter: { loads: number }) =>
  makeChatWorkspace(state).pipe(
    Effect.provide(
      Layer.mergeAll(
        ChatCredentials.disabled,
        Layer.succeed(ChatSkills, {
          load: Effect.sync(() => {
            counter.loads++
            return [MULTICA_SKILL, TRIAGE]
          }),
        }),
      ),
    ),
  )

const acquireInput = (generation: number) => ({
  sessionId: "slack/T1/C1/1700000000.000100",
  fresh: false,
  generation,
  multicaWorkspaceId: "workspace",
  startBudget: 60_000,
  warmFor: 1_800_000,
})

describe("chat workspace", () => {
  it.effect("a warm reacquire keeps the skills its sandbox was first provisioned with", () =>
    Effect.gen(function* () {
      const state = makeState()
      const counter = { loads: 0 }
      const workspace = yield* makeSkilledWorkspace(state, counter)
      yield* workspace.acquire(acquireInput(1))
      // The container is still running and healthy: the next turn finds it warm.
      yield* workspace.acquire(acquireInput(2))

      assert.strictEqual(counter.loads, 1)
      assert.deepStrictEqual(
        state.container.provisions.flatMap((request) => request.skills.map((skill) => skill.name)),
        [MULTICA_SKILL.name, "triage"],
      )
    }),
  )

  it.effect("a warm container whose first provisioning failed still gets its skills", () =>
    Effect.gen(function* () {
      const state = makeState()
      const counter = { loads: 0 }
      state.container.provisionStatus = 500
      const failing = yield* makeSkilledWorkspace(state, counter)
      const first = yield* Effect.forkChild(Effect.exit(failing.acquire(acquireInput(1))))
      yield* TestClock.adjust(Duration.minutes(1))
      assert.isTrue(Exit.isFailure(yield* Fiber.join(first)))

      // The object restarts, and finds the container it started running and healthy.
      state.container.provisionStatus = 204
      const restarted = yield* makeSkilledWorkspace(state, counter)
      yield* restarted.acquire(acquireInput(2))

      assert.strictEqual(counter.loads, 2)
      assert.deepStrictEqual(
        state.container.provisions.at(-1)?.skills.map((skill) => skill.name),
        [MULTICA_SKILL.name, "triage"],
      )
    }),
  )

  it.effect("executor calls from a superseded grant are refused", () =>
    Effect.gen(function* () {
      const workspace = yield* makeWorkspace(makeState())
      yield* workspace.acquire(acquireInput(1))
      yield* workspace.acquire(acquireInput(2))
      const call = (generation: number) =>
        workspace.forward(
          new Request("http://workspace/rpc", {
            method: "POST",
            headers: { [CHAT_GENERATION_HEADER]: String(generation) },
            body: "{}",
          }),
        )

      assert.strictEqual((yield* call(1)).status, 409)
      assert.strictEqual((yield* call(2)).status, 200)
    }),
  )

  it.effect(
    "an acquire for an older grant that arrives late is refused, even after a restart",
    () =>
      Effect.gen(function* () {
        const state = makeState()
        const workspace = yield* makeWorkspace(state)
        yield* workspace.acquire(acquireInput(2))

        const restarted = yield* makeWorkspace(state)
        assert.isTrue(Exit.isFailure(yield* Effect.exit(restarted.acquire(acquireInput(1)))))
        const call = (generation: number) =>
          restarted.forward(
            new Request("http://workspace/rpc", {
              method: "POST",
              headers: { [CHAT_GENERATION_HEADER]: String(generation) },
              body: "{}",
            }),
          )
        assert.strictEqual((yield* call(2)).status, 200)
        assert.strictEqual((yield* call(1)).status, 409)
        yield* restarted.destroy(1)
        assert.isTrue(state.container.running)
        yield* restarted.destroy(2)
        assert.isFalse(state.container.running)
      }),
  )
})
