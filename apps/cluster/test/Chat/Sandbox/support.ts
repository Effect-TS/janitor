import type { ChatEgressProps } from "../../../src/Chat/Egress/Session.ts"
import type { ChatWorkspaceState } from "../../../src/Chat/Sandbox/Workspace.ts"
import type {
  Fetcher,
  WorkspaceContainer,
} from "../../../src/PullRequestReview/Sandbox/Container.ts"

/** workerd's `ctx.container`, with a container that answers `/health` and `/provision` at once. */
export class FakeContainer implements WorkspaceContainer {
  running = false
  /** The path of every request the container got. */
  readonly requests: Array<string> = []
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
        this.requests.push(url.pathname)
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

/**
 * A workspace object's `ctx`: the fake container, in-memory storage, and an
 * egress entrypoint that records the props each acquire registers it with.
 */
export const makeState = (): ChatWorkspaceState & {
  readonly container: FakeContainer
  readonly egress: Array<ChatEgressProps>
} => {
  const stored = new Map<string, unknown>()
  const egress: Array<ChatEgressProps> = []
  return {
    egress,
    container: new FakeContainer(),
    storage: {
      get: <T>(key: string) => Promise.resolve(stored.get(key) as T | undefined),
      put: (key, value) => {
        stored.set(key, value)
        return Promise.resolve()
      },
    },
    exports: {
      ChatEgress: ({ props }) => {
        egress.push(props)
        return { fetch: () => Promise.resolve(new Response(null)) }
      },
    },
  }
}
