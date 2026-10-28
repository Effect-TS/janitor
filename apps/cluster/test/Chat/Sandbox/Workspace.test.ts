import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import { ChatCredentials } from "../../../src/Chat/Egress/BotApp.ts"
import {
  CHAT_GENERATION_HEADER,
  makeChatWorkspace,
  type ChatWorkspaceState,
} from "../../../src/Chat/Sandbox/Workspace.ts"
import { ChatSkills } from "../../../src/Chat/Sandbox/Skills.ts"
import { makeState } from "./support.ts"

/** A workspace without the bot's credentials: its egress hands out no token. */
const makeWorkspace = (state: ChatWorkspaceState) =>
  makeChatWorkspace(state).pipe(
    Effect.provide(Layer.mergeAll(ChatCredentials.disabled, ChatSkills.bundled)),
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
