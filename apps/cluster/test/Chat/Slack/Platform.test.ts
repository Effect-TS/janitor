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

/** The thread's replies, which `conversations.replies` pages two at a time: 31 pages. */
const replies = Array.from({ length: 61 }, (_, index) => ({
  ts: `17000${String(index).padStart(5, "0")}.000100`,
  user: "U1",
  text: `reply ${index}`,
}))

/** Answers the other methods: `auth.test`, `users.info` and `conversations.replies`. */
const answer = (method: string, params: URLSearchParams): Response => {
  switch (method) {
    case "auth.test":
      return Response.json({ ok: true, user_id: "UBOT" })
    case "users.info":
      return Response.json({ ok: true, user: { team_id: "T1", name: "ada" } })
    case "conversations.replies": {
      const start = Number(params.get("cursor") ?? 0)
      const next = start + 2 < replies.length ? String(start + 2) : ""
      return Response.json({
        ok: true,
        messages: replies.slice(start, start + 2),
        response_metadata: { next_cursor: next },
      })
    }
    default:
      return Response.json({ ok: true })
  }
}

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
        Effect.sync(() => {
          const method = new URL(request.url).pathname.replace("/api/", "")
          const params = new URLSearchParams(
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
          )
          return HttpClientResponse.fromWeb(
            request,
            method === "chat.postMessage" ? respond(++posts) : answer(method, params),
          )
        }),
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

  it.effect("the backfill reads the thread to its last page and keeps the latest messages", () =>
    Effect.gen(function* () {
      const platform = yield* ChatPlatform
      const messages = yield* platform.history(thread, 3)
      assert.deepStrictEqual(
        messages.map((message) => message.text),
        ["reply 58", "reply 59", "reply 60"],
      )
    }).pipe(Effect.provide(services)),
  )
})
