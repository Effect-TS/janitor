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

/**
 * The thread's replies, which `conversations.replies` pages two at a time: 31
 * pages. Reply 59 is a `/me` action, which janitor doesn't read.
 */
const replies = Array.from({ length: 61 }, (_, index) => ({
  ts: `17000${String(index).padStart(5, "0")}.000100`,
  user: "U1",
  text: `reply ${index}`,
  ...(index === 59 ? { subtype: "me_message" } : {}),
}))

/**
 * What reached the thread, in order: each `chat.postMessage`'s Markdown,
 * and `files:<ids>` for each `chat.update` that attaches files.
 */
const sent: Array<string> = []
/** The parameters of every `chat.postMessage` call. */
const postParams: Array<URLSearchParams> = []
/**
 * Where Slack refuses a reply's files, if anywhere: staging them, as without
 * the `files:write` scope, completing the upload, or attaching them to the
 * posted message.
 */
let refuseFiles: "staging" | "completing" | "attaching" | undefined

/** Every file uploaded to an upload URL, with its content type. */
const uploads: Array<{ readonly type: string; readonly content: Uint8Array }> = []
/** The parameters of every `files.completeUploadExternal` call. */
const completed: Array<URLSearchParams> = []
/** The `ts` of every message deleted. */
const deleted: Array<string> = []

/** The Markdown of a post or an update: its `markdown` block. */
const markdownOf = (params: URLSearchParams): string =>
  (JSON.parse(params.get("blocks") ?? "[]") as ReadonlyArray<{ type: string; text?: string }>)
    .filter((block) => block.type === "markdown")
    .map((block) => block.text ?? "")
    .join("")

/** Answers the other methods. Channel `C-shared` is a Slack Connect channel. */
const answer = (method: string, params: URLSearchParams): Response => {
  switch (method) {
    case "auth.test":
      return Response.json({ ok: true, user_id: "UBOT" })
    case "conversations.info":
      return Response.json({
        ok: true,
        channel: { id: params.get("channel"), is_ext_shared: params.get("channel") === "C-shared" },
      })
    case "files.getUploadURLExternal":
      if (refuseFiles === "staging") return Response.json({ ok: false, error: "missing_scope" })
      return Response.json({
        ok: true,
        upload_url: `https://files.slack.test/upload/${params.get("filename")}`,
        file_id: `F-${params.get("filename")}`,
      })
    case "files.completeUploadExternal":
      completed.push(params)
      if (refuseFiles === "completing") return Response.json({ ok: false, error: "missing_scope" })
      return Response.json({ ok: true })
    case "chat.update":
      if (params.get("file_ids") !== null) {
        sent.push(`files:${params.get("file_ids")}`)
        if (refuseFiles === "attaching")
          return Response.json({ ok: false, error: "not_in_channel" })
      }
      return Response.json({ ok: true })
    case "chat.delete":
      deleted.push(params.get("ts") ?? "")
      return Response.json({ ok: true })
    case "users.info":
      return Response.json({
        ok: true,
        user: { id: params.get("user"), team_id: "T1", name: "ada" },
      })
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

const services = SlackPlatform.layerFrom({
  signingSecret: Redacted.make("secret"),
  botToken: Redacted.make("xoxb-test"),
  workspaceId: "T1",
  appId: "A1",
}).pipe(
  Layer.provide(
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
          if (method === "chat.postMessage") {
            sent.push(markdownOf(params))
            postParams.push(params)
            return HttpClientResponse.fromWeb(request, respond(++posts))
          }
          return HttpClientResponse.fromWeb(request, answer(method, params))
        }),
      ),
    ),
  ),
)

/** Clears what the fake recorded, with every post answered. */
const reset = Effect.sync(() => {
  posts = 0
  respond = (post) => Response.json({ ok: true, ts: `1700000001.00010${post}` })
  sent.length = 0
  postParams.length = 0
  uploads.length = 0
  completed.length = 0
  deleted.length = 0
  refuseFiles = undefined
})

/** Runs a reply to the end, moving the clock past the adapter's pacing. */
const settle = <A, E, R>(reply: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(reply)
    yield* TestClock.adjust("1 minute")
    return yield* Fiber.join(fiber)
  })

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

  it.effect(
    "the backfill reads the thread to its last page and keeps the latest new messages",
    () =>
      Effect.gen(function* () {
        const platform = yield* ChatPlatform
        const messages = yield* platform.history(thread, 3)
        assert.deepStrictEqual(
          messages.map((message) => message.text),
          ["reply 57", "reply 58", "reply 60"],
        )
      }).pipe(Effect.provide(services)),
  )

  const plot = {
    name: "plot.png",
    contentType: "image/png",
    content: new Uint8Array([137, 80, 78, 71, 0, 255]),
  }

  /** The files a `files.completeUploadExternal` call completes, by id and title. */
  const staged = (params: URLSearchParams) =>
    JSON.parse(params.get("files") ?? "[]") as ReadonlyArray<{ id: string; title: string }>

  it.effect("posts a reply with its files as one message in the thread, without unfurls", () =>
    Effect.gen(function* () {
      const platform = yield* ChatPlatform
      yield* reset
      const text = "Here's the **plot**, from [run 7](https://ci.test/runs(7))."

      const reply = yield* settle(platform.postReply(thread, text, { files: [plot] }))

      assert.strictEqual(reply.text, text)
      assert.deepStrictEqual(uploads, [{ type: "image/png", content: plot.content }])
      assert.lengthOf(completed, 1)
      // Completed with no channel: nothing shows until the message is posted.
      assert.isNull(completed[0]!.get("channel_id"))
      assert.deepStrictEqual(staged(completed[0]!), [{ id: "F-plot.png", title: "plot.png" }])
      assert.deepStrictEqual(sent, [text, `files:${JSON.stringify(["F-plot.png"])}`])
      const [message] = postParams
      assert.strictEqual(message!.get("channel"), "C1")
      assert.strictEqual(message!.get("thread_ts"), thread.threadTs)
      assert.strictEqual(message!.get("unfurl_links"), "false")
      assert.strictEqual(message!.get("unfurl_media"), "false")
    }).pipe(Effect.provide(services)),
  )

  for (const refused of ["staging", "completing", "attaching"] as const) {
    it.effect(`a reply whose files are refused ${refused} goes out as text, naming them`, () =>
      Effect.gen(function* () {
        const platform = yield* ChatPlatform
        yield* reset
        refuseFiles = refused
        const text = `${"a".repeat(11_990)}\n\n${"b".repeat(100)}`

        const reply = yield* settle(platform.postReply(thread, text, { files: [plot] }))

        const note = "(Couldn't attach plot.png.)"
        assert.strictEqual(reply.text, `${text}\n\n${note}`)
        // The first part never carries the files; a message the files
        // couldn't be attached to is deleted before the text goes again.
        assert.deepStrictEqual(sent, [
          `${"a".repeat(11_990)}\n\n`,
          ...(refused === "attaching"
            ? ["b".repeat(100), `files:${JSON.stringify(["F-plot.png"])}`]
            : []),
          `${"b".repeat(100)}\n\n${note}`,
        ])
        assert.deepStrictEqual(deleted, refused === "attaching" ? ["1700000001.000102"] : [])
      }).pipe(Effect.provide(services)),
    )
  }

  it.effect(
    "posts the first three parts of a long reply and the rest as reply.md, with its files",
    () =>
      Effect.gen(function* () {
        const platform = yield* ChatPlatform
        yield* reset
        const paragraph = `${"a".repeat(11_000)}\n\n`
        const text = paragraph.repeat(4)

        const reply = yield* settle(platform.postReply(thread, text, { files: [plot] }))

        assert.strictEqual(reply.text, text)
        assert.deepStrictEqual(sent.slice(0, 3), [paragraph, paragraph, paragraph])
        assert.deepStrictEqual(uploads, [
          { type: "text/markdown", content: new TextEncoder().encode(paragraph) },
          { type: "image/png", content: plot.content },
        ])
        assert.deepStrictEqual(staged(completed[0]!), [
          { id: "F-reply.md", title: "reply.md" },
          { id: "F-plot.png", title: "plot.png" },
        ])
      }).pipe(Effect.provide(services)),
  )

  it.effect("posts to a channel shared with another organization", () =>
    Effect.gen(function* () {
      const platform = yield* ChatPlatform
      yield* reset
      const shared: ChatThread = { ...thread, channel: "C-shared" }
      yield* settle(platform.postReply(shared, "hello"))
      yield* platform.postStatus(shared, "Starting")
      assert.strictEqual(posts, 2)
    }).pipe(Effect.provide(services)),
  )

  it.effect("posts the overflow of a long reply whose files are refused as text, naming them", () =>
    Effect.gen(function* () {
      const platform = yield* ChatPlatform
      yield* reset
      refuseFiles = "staging"
      const paragraph = `${"a".repeat(11_000)}\n\n`
      const text = paragraph.repeat(4)

      const reply = yield* settle(platform.postReply(thread, text, { files: [plot] })).pipe(
        Effect.ensuring(Effect.sync(() => (refuseFiles = undefined))),
      )

      const note = "(Couldn't attach plot.png.)"
      assert.strictEqual(reply.text, `${text}\n\n${note}`)
      assert.deepStrictEqual(sent, [
        paragraph,
        paragraph,
        paragraph,
        `${"a".repeat(11_000)}\n\n${note}`,
      ])
    }).pipe(Effect.provide(services)),
  )
})
