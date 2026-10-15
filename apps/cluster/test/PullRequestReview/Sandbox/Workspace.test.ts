import { assert, describe, it } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as HttpEffect from "effect/http/HttpEffect"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as TestClock from "effect/testing/TestClock"
import { GitHubInstallationId } from "@janitor/domain/GitHub/Id"
import { GitHubAppAuth } from "../../../src/GitHub/AppAuth.ts"
import { GitCommandFailed } from "../../../src/PullRequestReview/Sandbox/Checkout.ts"
import { makeContainerApp } from "../../../src/PullRequestReview/Sandbox/ContainerApp.ts"
import type { EgressProps } from "../../../src/PullRequestReview/Sandbox/Egress.ts"
import { makeWorkspace } from "../../../src/PullRequestReview/Sandbox/Workspace.ts"

const BASE = "b".repeat(40)
const HEAD = "a".repeat(40)
const NO_INSTANCE =
  "There is no container instance that can be provided to this Durable Object, try again later"

const acquireInput = {
  runId: "3f9b6c1e-2d4a-4e8b-9c7d-1a2b3c4d5e6f",
  installationId: GitHubInstallationId.make("77"),
  repositoryId: "4242",
  owner: "Effect-TS",
  repo: "effect",
  prNumber: 7,
  baseSha: BASE,
  headSha: HEAD,
  startBudget: "60 seconds",
} as const

type ContainerEvent =
  | { readonly _tag: "start"; readonly enableInternet: boolean | undefined }
  | { readonly _tag: "setInactivityTimeout" }
  | { readonly _tag: "interceptAllOutboundHttp"; readonly token: string }
  | { readonly _tag: "interceptOutboundHttps"; readonly addr: string; readonly token: string }
  | { readonly _tag: "provision" }
  | { readonly _tag: "destroy" }

/** The fake `ctx.exports.GitEgress(...)`: keeps the props so intercepts can be inspected. */
interface FakeEgress {
  readonly props: EgressProps
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

/**
 * workerd's `ctx.container`, as EFF-1847 saw it: `start()` returns at once,
 * and a start with no instance available surfaces as `monitor()` rejecting
 * and `running` turning false. Port 3000 serves the real container app over a
 * scripted git.
 */
class FakeContainer {
  readonly events: Array<ContainerEvent> = []
  readonly gitCalls: Array<ReadonlyArray<string>> = []
  running: boolean
  private unavailableStarts: number
  private failedStart = false
  private readonly handler: (request: Request) => Promise<Response>

  constructor(options: {
    readonly running?: boolean
    readonly unavailableStarts?: number
    readonly git?: (args: ReadonlyArray<string>) => Effect.Effect<string, GitCommandFailed>
  }) {
    this.running = options.running ?? false
    this.unavailableStarts = options.unavailableStarts ?? 0
    const git = options.git ?? (() => Effect.succeed(""))
    const app = HttpEffect.toWebHandler(
      makeContainerApp({
        rpc: Effect.succeed(HttpServerResponse.text("executor")),
        git: (args) =>
          Effect.suspend(() => {
            this.gitCalls.push(args)
            return git(args)
          }),
      }),
    )
    this.handler = (request) => {
      if (new URL(request.url).pathname.startsWith("/provision")) {
        this.events.push({ _tag: "provision" })
      }
      return app(request)
    }
  }

  start(options?: { readonly enableInternet?: boolean }) {
    this.events.push({ _tag: "start", enableInternet: options?.enableInternet })
    if (this.unavailableStarts > 0) {
      this.unavailableStarts--
      this.running = false
      this.failedStart = true
    } else {
      this.running = true
      this.failedStart = false
    }
  }

  monitor(): Promise<void> {
    return this.failedStart ? Promise.reject(new Error(NO_INSTANCE)) : new Promise(() => {})
  }

  async destroy() {
    this.events.push({ _tag: "destroy" })
    this.running = false
  }

  getTcpPort(port: number) {
    return {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        this.running && port === 3000
          ? this.handler(new Request(input, init))
          : Promise.reject(new Error("the container is not listening")),
    }
  }

  async setInactivityTimeout(_durationMs: number | bigint) {
    this.events.push({ _tag: "setInactivityTimeout" })
  }

  async interceptAllOutboundHttp(binding: FakeEgress) {
    this.events.push({ _tag: "interceptAllOutboundHttp", token: binding.props.token })
  }

  async interceptOutboundHttps(addr: string, binding: FakeEgress) {
    this.events.push({ _tag: "interceptOutboundHttps", addr, token: binding.props.token })
  }
}

/** Durable Object storage that outlives the object, as a Map. */
const makeStorage = () => {
  const values = new Map<string, unknown>()
  return {
    values,
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      values.set(key, value)
    },
    delete: async (key: string) => values.delete(key),
  }
}

const makeState = (container: FakeContainer, storage = makeStorage()) => ({
  container,
  storage,
  exports: {
    GitEgress: ({ props }: { readonly props: EgressProps }): FakeEgress => ({
      props,
      fetch: () => Promise.reject(new Error("egress is not exercised here")),
    }),
  },
})

/** A GitHub App that mints `token-1`, `token-2`, ... and records when, and what it revokes. */
const makeAuth = () => {
  const minted: Array<{ readonly token: string; readonly at: number }> = []
  const revoked: Array<string> = []
  const layer = Layer.succeed(GitHubAppAuth, {
    appJwt: Effect.succeed(Redacted.make("jwt")),
    installationToken: () =>
      Effect.gen(function* () {
        const token = `token-${minted.length + 1}`
        minted.push({ token, at: yield* Clock.currentTimeMillis })
        return Redacted.make(token)
      }),
    revokeInstallationToken: (token) =>
      Effect.sync(() => {
        revoked.push(Redacted.value(token))
      }),
    invalidateInstallationToken: () => Effect.void,
  })
  return { minted, revoked, layer }
}

/** Real macrotask turns, so promise-based fakes settle before the clock moves. */
const settle = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0))).pipe(
  Effect.repeat({ times: 4 }),
)

/** Runs `effect` to completion, moving the `TestClock` a second at a time once everything else has settled. */
const elapsing = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect)
    for (let tick = 0; tick < 1000; tick++) {
      yield* settle
      if (fiber.pollUnsafe() !== undefined) break
      yield* TestClock.adjust("1 second")
    }
    return yield* Fiber.join(fiber)
  })

/** A git that answers `rev-parse` with `head` and fails `fetch` while `failFetch` says so. */
const scriptedGit =
  (head: string, failFetch: () => boolean = () => false) =>
  (args: ReadonlyArray<string>): Effect.Effect<string, GitCommandFailed> => {
    if (args[0] === "fetch" && failFetch()) {
      return Effect.fail(
        new GitCommandFailed({ args, exitCode: 128, stderr: "fatal: unable to access" }),
      )
    }
    return Effect.succeed(args[0] === "rev-parse" ? `${head}\n` : "")
  }

const significant = (container: FakeContainer) =>
  container.events.map((event) =>
    event._tag === "start"
      ? `start enableInternet=${event.enableInternet}`
      : event._tag === "interceptAllOutboundHttp"
        ? `interceptAllOutboundHttp ${event.token}`
        : event._tag === "interceptOutboundHttps"
          ? `interceptOutboundHttps ${event.addr} ${event.token}`
          : event._tag,
  )

/** Runs a test with a fresh fake GitHub App provided. */
const withAuth = <A, E>(
  test: (auth: ReturnType<typeof makeAuth>) => Effect.Effect<A, E, GitHubAppAuth>,
) => {
  const auth = makeAuth()
  return test(auth).pipe(Effect.provide(auth.layer))
}

describe("PR review sandbox workspace", () => {
  it.effect(
    "starts without internet, holds the container, intercepts egress, then checks out the recorded head",
    () =>
      withAuth(() =>
        Effect.gen(function* () {
          const container = new FakeContainer({ git: scriptedGit(HEAD) })
          const workspace = yield* makeWorkspace(makeState(container))
          yield* elapsing(workspace.acquire(acquireInput))

          assert.deepStrictEqual(significant(container), [
            "start enableInternet=false",
            "setInactivityTimeout",
            "interceptAllOutboundHttp token-1",
            "interceptOutboundHttps * token-1",
            "provision",
          ])
          assert.deepStrictEqual(container.gitCalls, [
            ["init", "--quiet"],
            ["remote", "add", "origin", "https://github.com/Effect-TS/effect.git"],
            [
              "fetch",
              "--quiet",
              "--depth=1",
              "--no-tags",
              "origin",
              "+refs/pull/7/head:refs/pull/7/head",
              BASE,
            ],
            ["rev-parse", "refs/pull/7/head"],
            ["checkout", "--quiet", "--detach", HEAD],
          ])
        }),
      ),
  )

  it.effect("fails with a typed error when the fetched head is not the recorded one", () =>
    withAuth(() =>
      Effect.gen(function* () {
        const container = new FakeContainer({ git: scriptedGit("c".repeat(40)) })
        const workspace = yield* makeWorkspace(makeState(container))
        const error = yield* elapsing(Effect.flip(workspace.acquire(acquireInput)))
        assert.strictEqual(error._tag, "HeadShaMismatch")
        assert.notInclude(
          container.gitCalls.map((args) => args[0]),
          "checkout",
        )
      }),
    ),
  )

  it.effect(
    "retries the checkout after 5 s, 15 s and 30 s with a fresh token each time, then fails typed",
    () =>
      withAuth((auth) =>
        Effect.gen(function* () {
          const container = new FakeContainer({ git: scriptedGit(HEAD, () => true) })
          const workspace = yield* makeWorkspace(makeState(container))
          const error = yield* elapsing(Effect.flip(workspace.acquire(acquireInput)))

          assert.strictEqual(error._tag, "CheckoutFailed")
          assert.deepStrictEqual(
            auth.minted.slice(1).map((mint, index) => mint.at - auth.minted[index]!.at),
            [5_000, 15_000, 30_000],
          )
          assert.deepStrictEqual(
            significant(container).filter((event) => event.startsWith("intercept")),
            ["token-1", "token-2", "token-3", "token-4"].flatMap((token) => [
              `interceptAllOutboundHttp ${token}`,
              `interceptOutboundHttps * ${token}`,
            ]),
          )
        }),
      ),
  )

  it.effect(
    "retries a start with no container instance within the budget, and gives up after it",
    () =>
      withAuth(() =>
        Effect.gen(function* () {
          const recovers = new FakeContainer({ unavailableStarts: 2, git: scriptedGit(HEAD) })
          yield* elapsing(
            Effect.flatMap(makeWorkspace(makeState(recovers)), (workspace) =>
              workspace.acquire(acquireInput),
            ),
          )
          assert.strictEqual(
            significant(recovers).filter((event) => event.startsWith("start")).length,
            3,
          )
          assert.include(significant(recovers), "provision")

          const exhausted = new FakeContainer({ unavailableStarts: Infinity })
          const error = yield* elapsing(
            Effect.flatMap(makeWorkspace(makeState(exhausted)), (workspace) =>
              Effect.flip(workspace.acquire({ ...acquireInput, startBudget: "10 seconds" })),
            ),
          )
          assert.strictEqual(error._tag, "ContainerUnavailable")
          assert.notInclude(significant(exhausted), "provision")
        }),
      ),
  )

  it.effect("sets the inactivity timeout again when constructed over a running container", () =>
    withAuth(() =>
      Effect.gen(function* () {
        const running = new FakeContainer({ running: true })
        yield* makeWorkspace(makeState(running))
        assert.deepStrictEqual(significant(running), ["setInactivityTimeout"])

        const stopped = new FakeContainer({})
        yield* makeWorkspace(makeState(stopped))
        assert.deepStrictEqual(significant(stopped), [])
      }),
    ),
  )

  it.effect(
    "release destroys the container, revokes the token, and refuses a later acquire after eviction",
    () =>
      withAuth((auth) =>
        Effect.gen(function* () {
          const storage = makeStorage()
          const container = new FakeContainer({ git: scriptedGit(HEAD) })
          const workspace = yield* makeWorkspace(makeState(container, storage))
          yield* elapsing(workspace.acquire(acquireInput))
          yield* workspace.release

          assert.strictEqual(container.events.at(-1)?._tag, "destroy")
          assert.isFalse(container.running)
          assert.deepStrictEqual(auth.revoked, ["token-1"])

          const evicted = yield* makeWorkspace(makeState(new FakeContainer({}), storage))
          const error = yield* elapsing(Effect.flip(evicted.acquire(acquireInput)))
          assert.strictEqual(error._tag, "WorkspaceReleased")
          assert.notInclude(JSON.stringify([...storage.values]), "token-")
        }),
      ),
  )
})
