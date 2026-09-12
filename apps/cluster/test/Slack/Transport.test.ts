import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { SlackConfig } from "../../src/Slack/Config.ts"
import { SlackFetch, SlackTransport } from "../../src/Slack/Transport.ts"

const requests: Request[] = []
let response = () =>
  Response.json({ ok: true, messages: [], response_metadata: { next_cursor: "next" } })
const services = SlackTransport.layer.pipe(
  Layer.provide(
    Layer.succeed(SlackConfig, {
      workspaceId: "T1",
      appId: "A1",
      botUserId: "U1",
      signingSecret: Redacted.make("secret"),
      token: Redacted.make("token"),
      accountUrl: "https://janitor.test/account",
    }),
  ),
  Layer.provide(
    Layer.succeed(SlackFetch, async (input, init) => {
      requests.push(new Request(input, init))
      return response()
    }),
  ),
)
layer(services)("Slack HTTP transport", (it) => {
  it.effect("pages only the selected thread through its exact boundary", () =>
    Effect.gen(function* () {
      const page = yield* (yield* SlackTransport).replies(
        "C1",
        "123.000000000000001",
        "opaque",
        "124.000000000000002",
      )
      assert.strictEqual(page.cursor, "next")
      const request = requests.at(-1)!
      assert.strictEqual(request.method, "GET")
      const url = new URL(request.url)
      assert.strictEqual(url.searchParams.get("ts"), "123.000000000000001")
      assert.strictEqual(url.searchParams.get("latest"), "124.000000000000002")
      assert.strictEqual(url.searchParams.get("include_all_metadata"), "true")
      assert.strictEqual(url.searchParams.get("cursor"), "opaque")
    }),
  )
  it.effect(
    "honors Retry-After and distinguishes an ambiguous write from an explicit refusal",
    () =>
      Effect.gen(function* () {
        const transport = yield* SlackTransport
        response = () => new Response("", { status: 429, headers: { "retry-after": "47" } })
        const throttled = yield* transport.post("C1", "1.1", "text", "marker").pipe(Effect.flip)
        assert.strictEqual(throttled.disposition, "retry")
        assert.strictEqual(throttled.retryAfter, 47)
        response = () => new Response("", { status: 502 })
        assert.strictEqual(
          (yield* transport.post("C1", "1.1", "text", "marker").pipe(Effect.flip)).disposition,
          "uncertain",
        )
        response = () => Response.json({ ok: false, error: "not_in_channel" })
        assert.strictEqual(
          (yield* transport.post("C1", "1.1", "text", "marker").pipe(Effect.flip)).disposition,
          "denied",
        )
      }),
  )
})
