import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { SlackConfig } from "../../src/Slack/Config.ts"
import { SlackFetch, SlackTransport } from "../../src/Slack/Transport.ts"

let response = () => Response.json({ ok: true, ts: "123.456" })
const services = SlackTransport.layer.pipe(
  Layer.provide(
    Layer.succeed(SlackConfig, {
      workspaceId: "T1",
      appId: "A1",
      botUserId: "U1",
      signingSecret: Redacted.make("secret"),
      token: Redacted.make("token"),
    }),
  ),
  Layer.provide(Layer.succeed(SlackFetch, async () => response())),
)
layer(services)("Slack HTTP transport", (it) => {
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
