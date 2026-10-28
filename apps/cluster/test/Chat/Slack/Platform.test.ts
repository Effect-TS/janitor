import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as TestClock from "effect/testing/TestClock"
import { ChatPlatform, type ChatThread } from "../../../src/Chat/Platform.ts"
import { SlackConfig } from "../../../src/Chat/Slack/Config.ts"
import * as SlackPlatform from "../../../src/Chat/Slack/Platform.ts"

/**
 * Slack's `ChatPlatform` over a fake Slack Web API.
 */

const thread: ChatThread = {
  _tag: "Slack",
  team: "T1",
  channel: "C1",
  threadTs: "1700000000.000100",
}

/** How `chat.postMessage` answers its nth call, from 1. */
let respond = (_post: number): Response => Response.json({ ok: true, ts: "1700000001.000100" })
let posts = 0

const services = SlackPlatform.layer.pipe(
  Layer.provide([
    Layer.succeed(SlackConfig, {
      signingSecret: Redacted.make("secret"),
      botToken: Redacted.make("xoxb-test"),
      workspaceId: "T1",
      appId: "A1",
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() =>
          HttpClientResponse.fromWeb(
            request,
            new URL(request.url).pathname === "/api/chat.postMessage"
              ? respond(++posts)
              : Response.json({ ok: true }),
          ),
        ),
      ),
    ),
  ]),
)

describe("Slack platform", () => {
  it.effect(
    "retries a rate-limited post after Retry-After, and never an uncertain or refused one",
    () =>
      Effect.gen(function* () {
        const platform = yield* ChatPlatform

        posts = 0
        respond = (post) =>
          post === 1
            ? new Response("", { status: 429, headers: { "retry-after": "47" } })
            : Response.json({ ok: true, ts: "1700000001.000100" })
        const throttled = yield* platform.postReply(thread, "hello").pipe(Effect.forkChild)
        yield* TestClock.adjust("46 seconds")
        assert.strictEqual(posts, 1)
        yield* TestClock.adjust("1 second")
        yield* Fiber.join(throttled)
        assert.strictEqual(posts, 2)

        for (const response of [
          () => new Response("", { status: 502 }),
          () => Response.json({ ok: false, error: "not_in_channel" }),
        ]) {
          posts = 0
          respond = response
          const failing = yield* platform.postReply(thread, "hello").pipe(Effect.forkChild)
          yield* TestClock.adjust("10 minutes")
          assert.isTrue(Exit.isFailure(yield* Fiber.await(failing)))
          assert.strictEqual(posts, 1)
        }
      }).pipe(Effect.provide(services)),
  )
})
