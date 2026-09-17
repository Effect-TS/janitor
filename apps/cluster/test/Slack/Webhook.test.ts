import { assert, it } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Fiber from "effect/Fiber"
import * as Redacted from "effect/Redacted"
import { SlackConfig } from "../../src/Slack/Config.ts"
import { makeSlackWebhook, SlackError } from "../../src/Slack/Webhook.ts"

it.effect("verifies signed events and waits for durable admission before acknowledging", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    const entered = yield* Deferred.make<void>()
    const completed = yield* Deferred.make<void>()
    const admitted: string[] = []
    const webhook = yield* makeSlackWebhook(
      Effect.fnUntraced(function* (message) {
        admitted.push(message.ts)
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(gate)
      }),
    )
    const timestamp = String(Math.floor((yield* Clock.currentTimeMillis) / 1000))
    const key = yield* Effect.promise(() =>
      crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("secret"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    )
    const signed = Effect.fnUntraced(function* (event: object, team = "T1") {
      const body = JSON.stringify({
        type: "event_callback",
        team_id: team,
        api_app_id: "A1",
        event_id: "E1",
        event,
      })
      const digest = yield* Effect.promise(() =>
        crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`)),
      )
      return { body, timestamp, signature: `v0=${Encoding.encodeHex(new Uint8Array(digest))}` }
    })
    const event = {
      type: "message",
      channel_type: "group",
      channel: "C1",
      user: "U2",
      ts: "2.1",
      thread_ts: "1.1",
      text: "continue",
    }
    const request = yield* signed(event)
    assert.strictEqual(
      (yield* webhook.receive({ ...request, signature: "v0=invalid" })).status,
      401,
    )
    assert.strictEqual((yield* webhook.receive(yield* signed(event, "OTHER"))).status, 403)
    assert.strictEqual(
      (yield* webhook.receive(yield* signed({ ...event, subtype: "message_changed" }))).status,
      200,
    )
    assert.deepStrictEqual(admitted, [])
    const running = yield* webhook.receive(request).pipe(
      Effect.tap(() => Deferred.succeed(completed, undefined)),
      Effect.forkChild,
    )
    yield* Deferred.await(entered)
    assert.isFalse(yield* Deferred.isDone(completed))
    yield* Deferred.succeed(gate, undefined)
    assert.deepStrictEqual(yield* Fiber.join(running), { status: 200, body: "Accepted" })
    assert.deepStrictEqual(admitted, ["2.1"])
    const failed = yield* makeSlackWebhook(
      () => new SlackError({ message: "Admission unavailable" }),
    )
    assert.strictEqual((yield* failed.receive(request)).status, 503)
  }).pipe(
    Effect.provideService(SlackConfig, {
      workspaceId: "T1",
      appId: "A1",
      botUserId: "BOT",
      signingSecret: Redacted.make("secret"),
      token: Redacted.make("token"),
    }),
  ),
)
