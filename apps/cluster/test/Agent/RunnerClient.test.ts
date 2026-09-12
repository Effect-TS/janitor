import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { RunnerClient, RunnerClientError } from "../../src/Agent/RunnerClient.ts"
import { RUNNER_PROTOCOL_HEADER } from "../../src/Agent/RunnerProtocol.ts"

interface Recorded {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string
}

const withResponder = (
  responder: (recorded: Recorded) => Response,
  run: (recorded: Array<Recorded>) => Effect.Effect<void, unknown, RunnerClient>,
) =>
  Effect.gen(function* () {
    const recorded: Array<Recorded> = []
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""
        const entry = {
          method: request.method,
          url: request.url,
          headers: { ...request.headers },
          body,
        }
        recorded.push(entry)
        return HttpClientResponse.fromWeb(request, responder(entry))
      }),
    )
    yield* run(recorded).pipe(
      Effect.provide(
        RunnerClient.layer({
          baseUrl: "http://runner.test/",
          token: Redacted.make("secret-token"),
        }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
      ),
    )
  })

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("RunnerClient", () => {
  it.effect("sends the protocol version and service token with every command", () =>
    withResponder(
      (recorded) =>
        recorded.method === "PUT"
          ? json(200, {
              sessionId: "s1",
              generation: 1,
              nativeSessionId: "ses_1",
              modelConfigurationId: "default",
              created: true,
            })
          : json(200, {
              sessionId: "s1",
              after: 0,
              events: [],
              next: 0,
              synced: null,
              usage: null,
              execution: "idle",
              reason: null,
            }),
      (recorded) =>
        Effect.gen(function* () {
          const runner = yield* RunnerClient
          const created = yield* runner.createSession("s1", { generation: 1, title: "t" })
          assert.isTrue(created.created)
          const events = yield* runner.readEvents("s1", 0)
          assert.deepStrictEqual(events.events, [])
          assert.strictEqual(recorded[0]?.url, "http://runner.test/v1/sessions/s1")
          assert.strictEqual(recorded[0]?.headers[RUNNER_PROTOCOL_HEADER], "1")
          assert.strictEqual(recorded[0]?.headers.authorization, "Bearer secret-token")
          assert.deepStrictEqual(JSON.parse(recorded[0]!.body), { generation: 1, title: "t" })
          assert.strictEqual(
            recorded[1]?.url,
            "http://runner.test/v1/sessions/s1/events?after=0&limit=200",
          )
        }),
    ),
  )

  it.effect("classifies protocol error bodies and treats everything else as transport", () =>
    withResponder(
      (recorded) => {
        if (recorded.url.endsWith("/inputs"))
          return json(423, { code: "blocked", message: "held", reason: "maintenance" })
        if (recorded.method === "DELETE")
          return json(409, { code: "stale_generation", message: "old" })
        if (recorded.method === "GET") return new Response("<html>", { status: 502 })
        return json(426, { code: "incompatible_protocol", message: "v9" })
      },
      () =>
        Effect.gen(function* () {
          const runner = yield* RunnerClient
          const blocked = yield* runner
            .admitInput("s1", {
              generation: 1,
              inputId: "msg_1",
              text: "x",
              attribution: { source: "driver" },
            })
            .pipe(Effect.flip)
          assert.instanceOf(blocked, RunnerClientError)
          assert.strictEqual(blocked.code, "blocked")
          assert.strictEqual(blocked.reason, "maintenance")
          assert.isFalse(blocked.retryable)
          const stale = yield* runner.cleanup("s1", 1).pipe(Effect.flip)
          assert.strictEqual(stale.code, "stale_generation")
          const transport = yield* runner.inspect("s1").pipe(Effect.flip)
          assert.strictEqual(transport.code, "transport")
          assert.isTrue(transport.retryable)
          assert.strictEqual(transport.status, 502)
          const protocol = yield* runner
            .createSession("s1", { generation: 1, title: "t" })
            .pipe(Effect.flip)
          assert.strictEqual(protocol.code, "incompatible_protocol")
        }),
    ),
  )

  it.effect("reports an unreachable runner as retryable transport failure", () =>
    Effect.gen(function* () {
      const client = HttpClient.make(() => Effect.die(new Error("connection refused")))
      const error = yield* RunnerClient.pipe(
        Effect.flatMap((runner) => runner.inspect("s1")),
        Effect.provide(
          RunnerClient.layer({ baseUrl: "http://runner.test", token: Redacted.make("t") }).pipe(
            Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
          ),
        ),
        Effect.sandbox,
        Effect.flip,
      )
      assert.isTrue(String(error).includes("connection refused"))
    }),
  )
})
