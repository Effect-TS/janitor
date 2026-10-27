import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeChatWorkspace, type ChatWorkspaceState } from "../../../src/Chat/Sandbox/Workspace.ts"
import type {
  Fetcher,
  WorkspaceContainer,
} from "../../../src/PullRequestReview/Sandbox/Container.ts"

/** workerd's `ctx.container`, with a container that answers `/health` and `/provision` at once. */
class FakeContainer implements WorkspaceContainer {
  running = false
  start() {
    this.running = true
  }
  monitor() {
    return new Promise<void>(() => {})
  }
  destroy() {
    this.running = false
    return Promise.resolve()
  }
  getTcpPort(): Fetcher {
    return {
      fetch: (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        return Promise.resolve(
          new Response(null, { status: url.pathname === "/provision" ? 204 : 200 }),
        )
      },
    }
  }
  setInactivityTimeout() {
    return Promise.resolve()
  }
  interceptAllOutboundHttp() {
    return Promise.resolve()
  }
  interceptOutboundHttps() {
    return Promise.resolve()
  }
}

const makeState = (): ChatWorkspaceState & { readonly container: FakeContainer } => {
  const stored = new Map<string, unknown>()
  return {
    container: new FakeContainer(),
    storage: {
      get: <T>(key: string) => Promise.resolve(stored.get(key) as T | undefined),
      put: (key, value) => {
        stored.set(key, value)
        return Promise.resolve()
      },
    },
    exports: { GitEgress: () => ({ fetch: () => Promise.resolve(new Response(null)) }) },
  }
}

const acquireInput = (generation: number) => ({
  sessionId: "slack/T1/C1/1700000000.000100",
  fresh: false,
  generation,
  multicaWorkspaceId: "workspace",
  startBudget: 60_000,
  warmFor: 1_800_000,
})

describe("chat workspace", () => {
  it.effect(
    "a destroy from an older grant leaves a newer grant's container running, even after a restart",
    () =>
      Effect.gen(function* () {
        const state = makeState()
        const workspace = yield* makeChatWorkspace(state)
        yield* workspace.acquire(acquireInput(1))
        yield* workspace.acquire(acquireInput(2))

        const restarted = yield* makeChatWorkspace(state)
        yield* restarted.destroy(1)
        assert.isTrue(state.container.running)
        yield* restarted.destroy(2)
        assert.isFalse(state.container.running)
      }),
  )
})
