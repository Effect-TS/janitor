import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import { BotAppError, ChatCredentials, type BotApp } from "../../../src/Chat/Egress/BotApp.ts"
import { makeEgressContext } from "../../../src/Chat/Egress/Client.ts"
import { handleChatEgress } from "../../../src/Chat/Egress/Egress.ts"
import { makeChatWorkspace } from "../../../src/Chat/Sandbox/Workspace.ts"
import { makeState } from "../Sandbox/support.ts"

const GITHUB = "https://api.github.com/repos/Effect-TS/effect/pulls"
const MULTICA = "https://api.multica.ai/api/issues"
const FAR = Date.UTC(2100, 0, 1)

const acquireInput = {
  sessionId: "slack/T1/C1/1700000000.000100",
  fresh: true,
  generation: 1,
  multicaWorkspaceId: "workspace",
  startBudget: 60_000,
  warmFor: 1_800_000,
}

/**
 * A chat workspace with the bot's credentials, and a way to send a container
 * request through the egress its last acquire registered, as the `ChatEgress`
 * entrypoint does. Each send answers the `Authorization` that reached
 * upstream, or `null`.
 */
const setup = (app: BotApp) =>
  Effect.gen(function* () {
    const state = makeState()
    const workspace = yield* makeChatWorkspace(state).pipe(
      Effect.provide(Layer.succeed(ChatCredentials, { app, multicaToken: "mul_janitor" })),
    )
    const send = (url: string) =>
      Effect.gen(function* () {
        const props = state.egress.at(-1)!
        const context = makeEgressContext(props, {
          fetch: (input, init) =>
            Effect.runPromise(workspace.egressControl(new Request(input, init))),
        })
        let authorization: string | null = null
        yield* handleChatEgress(new Request(url), {
          ...context,
          upstream: (request) =>
            Effect.sync(() => {
              authorization = request.headers.get("authorization")
              return new Response("upstream")
            }),
        })
        return authorization
      })
    return { workspace, send }
  })

describe("chat egress credential lifecycle", () => {
  it.effect(
    "a sandbox left running after its turn reaches GitHub and Multica with no credential",
    () =>
      Effect.gen(function* () {
        const { workspace, send } = yield* setup({
          mint: (org) =>
            Effect.succeed(
              org === "Effect-TS"
                ? { read: "ghs_read", write: "ghs_write", expiresAt: FAR }
                : undefined,
            ),
          revoke: () => Effect.void,
        })
        yield* workspace.acquire(acquireInput)
        const during = [yield* send(GITHUB), yield* send(MULTICA)]
        yield* workspace.release(acquireInput.generation)
        const after = [yield* send(GITHUB), yield* send(MULTICA)]

        assert.deepStrictEqual(
          { during, after },
          { during: ["Bearer ghs_read", "Bearer mul_janitor"], after: [null, null] },
        )
      }),
  )

  it.effect("a token minted after its turn ended is never handed out, and is revoked", () =>
    Effect.gen(function* () {
      const reminting = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const revoked: Array<string> = []
      let mints = 0
      const { workspace, send } = yield* setup({
        mint: (org) =>
          Effect.gen(function* () {
            if (org !== "Effect-TS") return undefined
            mints++
            // The first pair, minted at acquire, is already expired, so the next use mints again.
            if (mints === 1) return { read: "ghs_read_1", write: "ghs_write_1", expiresAt: 0 }
            yield* Deferred.succeed(reminting, undefined)
            yield* Deferred.await(gate)
            return { read: "ghs_read_2", write: "ghs_write_2", expiresAt: FAR }
          }),
        revoke: (token) =>
          Effect.sync(() => {
            revoked.push(token)
          }),
      })
      yield* workspace.acquire(acquireInput)

      const request = yield* Effect.forkChild(send(GITHUB))
      yield* Deferred.await(reminting)
      // The release goes first: it finishes now, or waits on the mint if the two are serialized.
      const release = yield* Effect.forkChild(workspace.release(acquireInput.generation))
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)))
      yield* Deferred.succeed(gate, undefined)
      const authorization = yield* Fiber.join(request)
      yield* Fiber.join(release)

      assert.deepStrictEqual(
        {
          authorization,
          lateTokensRevoked: ["ghs_read_2", "ghs_write_2"].every((token) =>
            revoked.includes(token),
          ),
        },
        { authorization: null, lateTokensRevoked: true },
      )
    }),
  )

  it.effect.fails(
    "a remint that fails after its turn ended hands out no token, not even the one still valid",
    () =>
      Effect.gen(function* () {
        const reminting = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        let mints = 0
        const { workspace, send } = yield* setup({
          mint: (org) =>
            Effect.gen(function* () {
              if (org !== "Effect-TS") return undefined
              mints++
              // Valid for five more minutes: inside the remint margin, so the next use mints again.
              if (mints === 1) {
                return { read: "ghs_read_1", write: "ghs_write_1", expiresAt: 5 * 60_000 }
              }
              yield* Deferred.succeed(reminting, undefined)
              yield* Deferred.await(gate)
              return yield* new BotAppError({ reason: "GitHub is down" })
            }),
          revoke: () => Effect.void,
        })
        yield* workspace.acquire(acquireInput)

        const request = yield* Effect.forkChild(send(GITHUB))
        yield* Deferred.await(reminting)
        // The release goes first: it finishes now, or waits on the mint if the two are serialized.
        const release = yield* Effect.forkChild(workspace.release(acquireInput.generation))
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)))
        yield* Deferred.succeed(gate, undefined)
        const authorization = yield* Fiber.join(request)
        yield* Fiber.join(release)

        assert.strictEqual(authorization, null)
      }),
  )
})
