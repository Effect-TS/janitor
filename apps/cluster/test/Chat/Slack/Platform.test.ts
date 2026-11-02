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

/** The `markdown_text` of every `chat.postMessage` call. */
const postedTexts: Array<string | null> = []
/** While set, Slack refuses file uploads, as without the `files:write` scope. */
let refuseFiles = false

/** Every file uploaded to an upload URL, with its content type. */
const uploads: Array<{ readonly type: string; readonly content: Uint8Array }> = []
/** The parameters of every `files.completeUploadExternal` call. */
const completed: Array<URLSearchParams> = []

/** Answers the other methods. Channel `C-shared` is a Slack Connect channel. */
const answer = (method: string, params: URLSearchParams): Response => {
  switch (method) {
    case "auth.test":
      return Response.json({ ok: true, user_id: "UBOT" })
    case "conversations.info":
      return Response.json({
        ok: true,
        channel: { is_ext_shared: params.get("channel") === "C-shared" },
      })
    case "files.getUploadURLExternal":
      if (refuseFiles) return Response.json({ ok: false, error: "missing_scope" })
      return Response.json({
        ok: true,
        upload_url: `https://files.slack.test/upload/${params.get("filename")}`,
        file_id: `F-${params.get("filename")}`,
      })
    case "files.completeUploadExternal":
      completed.push(params)
      return Response.json({ ok: true })
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
          const url = new URL(request.url)
          if (url.hostname === "files.slack.test") {
            if (request.body._tag === "Uint8Array")
              uploads.push({ type: request.body.contentType, content: request.body.body })
            return HttpClientResponse.fromWeb(request, new Response("OK"))
          }
          const method = url.pathname.replace("/api/", "")
          const params = new URLSearchParams(
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
          )
          return HttpClientResponse.fromWeb(
            request,
            method === "chat.postMessage"
              ? (postedTexts.push(params.get("markdown_text")), respond(++posts))
              : answer(method, params),
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

  const plot = {
    name: "plot.png",
    contentType: "image/png",
    content: new Uint8Array([137, 80, 78, 71, 0, 255]),
  }

  /** The files a `files.completeUploadExternal` call shares, by id and title. */
  const shared = (params: URLSearchParams) =>
    JSON.parse(params.get("files") ?? "[]") as ReadonlyArray<{ id: string; title: string }>

  it.effect("posts a reply with its files as one message in the thread", () =>
    Effect.gen(function* () {
      const platform = yield* ChatPlatform
      posts = 0
      respond = () => Response.json({ ok: true, ts: "1700000001.000100" })
      uploads.length = 0
      completed.length = 0

      yield* platform.postReply(thread, "Here's the **plot**.", { files: [plot] })

      assert.strictEqual(posts, 0)
      assert.deepStrictEqual(uploads, [{ type: "image/png", content: plot.content }])
      assert.lengthOf(completed, 1)
      const [message] = completed
      assert.strictEqual(message!.get("channel_id"), "C1")
      assert.strictEqual(message!.get("thread_ts"), thread.threadTs)
      assert.deepStrictEqual(shared(message!), [{ id: "F-plot.png", title: "plot.png" }])
      // The text goes with the files, as `initial_comment` or as blocks.
      assert.include([...message!.values()].join("\n"), "Here's the **plot**.")
    }).pipe(Effect.provide(services)),
  )

  it.effect("uploads an overflowing reply as reply.md in one message with its files", () =>
    Effect.gen(function* () {
      const platform = yield* ChatPlatform
      posts = 0
      respond = () => Response.json({ ok: true, ts: "1700000001.000100" })
      uploads.length = 0
      completed.length = 0
      const text = "a".repeat(40_000)

      yield* platform.postReply(thread, text, { files: [plot] })

      assert.strictEqual(posts, 0)
      assert.deepStrictEqual(uploads, [
        { type: "text/markdown", content: new TextEncoder().encode(text) },
        { type: "image/png", content: plot.content },
      ])
      assert.lengthOf(completed, 1)
      assert.deepStrictEqual(shared(completed[0]!), [
        { id: "F-reply.md", title: "reply.md" },
        { id: "F-plot.png", title: "plot.png" },
      ])
    }).pipe(Effect.provide(services)),
  )

  it.effect("an overflowing reply whose files are refused goes out as text, naming them", () =>
    Effect.gen(function* () {
      const platform = yield* ChatPlatform
      respond = () => Response.json({ ok: true, ts: "1700000001.000100" })
      postedTexts.length = 0
      completed.length = 0
      refuseFiles = true

      const reply = yield* platform
        .postReply(thread, Array.from({ length: 4 }, () => "a".repeat(11_000)).join("\n"), {
          files: [plot],
        })
        .pipe(Effect.ensuring(Effect.sync(() => (refuseFiles = false))), Effect.forkChild)
      yield* TestClock.adjust("10 seconds")
      yield* Fiber.join(reply)

      assert.lengthOf(completed, 0)
      assert.lengthOf(postedTexts, 4)
      assert.isTrue(postedTexts[3]!.endsWith("(Couldn't attach plot.png.)"))
    }).pipe(Effect.provide(services)),
  )

  it.effect("posts to a channel shared with another organization", () =>
    Effect.gen(function* () {
      const platform = yield* ChatPlatform
      posts = 0
      respond = () => Response.json({ ok: true, ts: "1700000001.000100" })
      const shared: ChatThread = { ...thread, channel: "C-shared" }
      yield* platform.postReply(shared, "hello")
      yield* platform.postStatus(shared, "Starting")
      assert.strictEqual(posts, 2)
    }).pipe(Effect.provide(services)),
  )
})
