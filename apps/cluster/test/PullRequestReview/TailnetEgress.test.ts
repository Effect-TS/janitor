import { assert, describe, it } from "@effect/vitest"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { ReviewModelLayer } from "../../src/PullRequestReview/ReviewAgent.ts"
import {
  EGRESS_PORT,
  makeTailnetEgress,
} from "../../src/PullRequestReview/TailnetEgress/TailnetEgress.ts"
import {
  TAILNET_EGRESS_NAME,
  type TailnetEgressNamespace,
} from "../../src/PullRequestReview/TailnetEgress/TailnetEgressClient.ts"

const NO_INSTANCE =
  "There is no container instance that can be provided to this Durable Object, try again later"
const NOT_ATTACHED = "There is no container application assigned to this Durable Object namespace"

/**
 * workerd's `ctx.container`, as the workspace tests model it: `start()`
 * returns at once, and a failed start surfaces as `monitor()` rejecting and
 * `running` turning false. Once started, port 8080 answers `/healthz` and
 * hands every other request to `upstream`.
 */
class FakeContainer {
  readonly starts: Array<{ readonly enableInternet: boolean | undefined }> = []
  readonly forwarded: Array<Request> = []
  inactivityTimeouts = 0
  running = false
  private failedStart = false
  private failedStartsLeft: number

  constructor(
    private readonly options: {
      /** Starts that fail with `startFailure` before one succeeds. */
      readonly failedStarts?: number
      readonly startFailure?: string
      /** A started container that never answers `/healthz`. */
      readonly neverHealthy?: boolean
      readonly upstream?: (request: Request) => Response
    } = {},
  ) {
    this.failedStartsLeft = options.failedStarts ?? 0
  }

  start(options?: { readonly enableInternet?: boolean }) {
    this.starts.push({ enableInternet: options?.enableInternet })
    this.failedStart = this.failedStartsLeft > 0
    if (this.failedStart) this.failedStartsLeft--
    this.running = !this.failedStart
  }

  monitor(): Promise<void> {
    return this.failedStart
      ? Promise.reject(new Error(this.options.startFailure ?? NO_INSTANCE))
      : new Promise(() => {})
  }

  async destroy() {
    this.running = false
  }

  getTcpPort(port: number) {
    return {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        if (!this.running || port !== EGRESS_PORT) throw new Error("not listening")
        if (new URL(request.url).pathname === "/healthz") {
          if (this.options.neverHealthy) throw new Error("not listening")
          return new Response(null, { status: 204 })
        }
        this.forwarded.push(request)
        return (this.options.upstream ?? (() => new Response("upstream")))(request)
      },
    }
  }

  async setInactivityTimeout(_durationMs: number | bigint) {
    this.inactivityTimeouts++
  }
}

const request = () =>
  new Request("https://proxy.example.ts.net/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer proxy-key", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6.1-sol" }),
  })

describe("tailnet egress", () => {
  it.live("starts the container with internet access and forwards requests as they are", () =>
    Effect.gen(function* () {
      const container = new FakeContainer()
      const egress = yield* makeTailnetEgress(container)

      const response = yield* egress.forward(request())

      assert.strictEqual(yield* Effect.promise(() => response.text()), "upstream")
      assert.deepStrictEqual(container.starts, [{ enableInternet: true }])
      assert.strictEqual(container.inactivityTimeouts, 1)
      const [forwarded] = container.forwarded
      assert.strictEqual(forwarded?.url, "https://proxy.example.ts.net/v1/chat/completions")
      assert.strictEqual(forwarded?.headers.get("authorization"), "Bearer proxy-key")
      assert.strictEqual(
        yield* Effect.promise(() => forwarded!.text()),
        JSON.stringify({ model: "gpt-6.1-sol" }),
      )
    }),
  )

  it.live("passes a streamed response through without reading it", () =>
    Effect.gen(function* () {
      const chunks = ["data: one\n\n", "data: two\n\n", "data: [DONE]\n\n"]
      const container = new FakeContainer({
        upstream: () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
                controller.close()
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      })
      const egress = yield* makeTailnetEgress(container)

      const response = yield* egress.forward(request())

      assert.strictEqual(response.headers.get("content-type"), "text/event-stream")
      assert.strictEqual(yield* Effect.promise(() => response.text()), chunks.join(""))
    }),
  )

  it.live("starts the container once for concurrent requests, then reuses it", () =>
    Effect.gen(function* () {
      const container = new FakeContainer()
      const egress = yield* makeTailnetEgress(container)

      yield* Effect.all([egress.forward(request()), egress.forward(request())], {
        concurrency: "unbounded",
      })
      yield* egress.forward(request())

      assert.strictEqual(container.starts.length, 1)
      assert.strictEqual(container.forwarded.length, 3)
    }),
  )

  it.live("starts a new container after the last one stopped", () =>
    Effect.gen(function* () {
      const container = new FakeContainer()
      const egress = yield* makeTailnetEgress(container)

      yield* egress.forward(request())
      container.running = false
      yield* egress.forward(request())

      assert.strictEqual(container.starts.length, 2)
    }),
  )

  it.live("retries a start with no container instance yet", () =>
    Effect.gen(function* () {
      const container = new FakeContainer({ failedStarts: 1 })
      const egress = yield* makeTailnetEgress(container)

      const response = yield* egress.forward(request())

      assert.strictEqual(response.status, 200)
      assert.strictEqual(container.starts.length, 2)
    }),
  )

  it.live("answers 503 with a fixed reason when the container can't start", () =>
    Effect.gen(function* () {
      const notAttached = new FakeContainer({ failedStarts: 1, startFailure: NOT_ATTACHED })
      const response = yield* (yield* makeTailnetEgress(notAttached)).forward(request())
      assert.strictEqual(response.status, 503)
      assert.strictEqual(
        yield* Effect.promise(() => response.text()),
        "the tailnet egress is unavailable: no container application assigned\n",
      )
      // Not attached is not retried.
      assert.strictEqual(notAttached.starts.length, 1)

      const silent = new FakeContainer({ neverHealthy: true })
      const timedOut = yield* (yield* makeTailnetEgress(silent, {
        startBudget: Duration.millis(600),
      })).forward(request())
      assert.strictEqual(timedOut.status, 503)
      assert.strictEqual(
        yield* Effect.promise(() => timedOut.text()),
        "the tailnet egress is unavailable: timed out\n",
      )
      assert.strictEqual(silent.forwarded.length, 0)
    }),
  )
})

describe("the review model's transport", () => {
  const completion = {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "gpt-6.1-sol",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }

  /** Generates once through `ReviewModelLayer`, recording what reached the egress DO and the global fetch. */
  const generate = (values: Record<string, string>) =>
    Effect.gen(function* () {
      const viaEgress: Array<{ readonly name: string; readonly request: Request }> = []
      const viaGlobal: Array<Request> = []
      const namespace: TailnetEgressNamespace = {
        getByName: (name) => ({
          fetch: async (input, init) => {
            viaEgress.push({ name, request: new Request(input, init) })
            return Response.json(completion)
          },
        }),
      }
      const globalFetch = globalThis.fetch
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          globalThis.fetch = async (input, init) => {
            viaGlobal.push(new Request(input, init))
            return Response.json(completion)
          }
        }),
        () =>
          Effect.sync(() => {
            globalThis.fetch = globalFetch
          }),
      )
      const response = yield* LanguageModel.generateText({ prompt: "Say ok" }).pipe(
        Effect.provide(
          ReviewModelLayer(namespace).pipe(
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values))),
          ),
        ),
      )
      return { text: response.text, viaEgress, viaGlobal }
    }).pipe(Effect.scoped)

  const endpoint = {
    PR_REVIEW_AI_API_URL: "https://proxy.example.ts.net/v1",
    PR_REVIEW_AI_API_KEY: "proxy-key",
    PR_REVIEW_AI_MODEL: "gpt-6.1-sol",
  }

  it.effect("goes through the tailnet egress with PR_REVIEW_AI_VIA_TAILNET", () =>
    Effect.gen(function* () {
      const result = yield* generate({ ...endpoint, PR_REVIEW_AI_VIA_TAILNET: "true" })

      assert.strictEqual(result.text, "ok")
      assert.strictEqual(result.viaGlobal.length, 0)
      const [call] = result.viaEgress
      assert.strictEqual(call?.name, TAILNET_EGRESS_NAME)
      assert.strictEqual(call?.request.url, "https://proxy.example.ts.net/v1/chat/completions")
      assert.strictEqual(call?.request.headers.get("authorization"), "Bearer proxy-key")
    }),
  )

  it.effect("uses the open internet without it", () =>
    Effect.gen(function* () {
      const result = yield* generate(endpoint)

      assert.strictEqual(result.text, "ok")
      assert.strictEqual(result.viaEgress.length, 0)
      assert.strictEqual(
        result.viaGlobal[0]?.url,
        "https://proxy.example.ts.net/v1/chat/completions",
      )
    }),
  )
})
