import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as UrlParams from "effect/http/UrlParams"
import { restLayer } from "../../../src/Chat/Discord/Api.ts"
import { DiscordBotConfig } from "../../../src/Chat/Discord/Config.ts"
import * as DiscordPlatform from "../../../src/Chat/Discord/Platform.ts"
import { ChatPlatform, type ChatThread } from "../../../src/Chat/Platform.ts"

/**
 * Discord's `ChatPlatform` over a fake Discord REST API.
 */

const thread: ChatThread = { _tag: "Discord", guild: "100", threadId: "500" }

/** Every message sent to Discord, including multipart upload metadata. */
const posted: Array<{
  readonly content?: string
  readonly message_reference?: { readonly message_id: string; readonly fail_if_not_exists: boolean }
  readonly allowed_mentions: {
    readonly parse: ReadonlyArray<string>
    readonly users?: ReadonlyArray<string>
    readonly replied_user?: boolean
  }
  readonly attachments?: ReadonlyArray<{ readonly id: string; readonly filename: string }>
}> = []

/** The thread's history, newest first, as `GET /channels/{id}/messages` returns it. */
const threadMessages = [
  {
    id: "1001",
    type: 0,
    channel_id: thread.threadId,
    author: { id: "600", username: "ada", global_name: null },
    content: "<@&301> what changed?",
    timestamp: "2026-10-28T12:00:00.000Z",
    mentions: [],
    mention_roles: ["301"],
    attachments: [],
  },
]

/**
 * A thread another member started from a message in channel 400: the thread
 * shares the message's id, and its oldest message is Discord's thread starter
 * (type 21), pointing at the opening message in the parent channel.
 */
const startedThread: ChatThread = { _tag: "Discord", guild: "100", threadId: "700" }

const openingMessage = {
  id: "700",
  type: 0,
  channel_id: "400",
  author: { id: "610", username: "gcanti", global_name: null },
  content: "<@620> is there a reason why StreamSse doesn't call toCodecJson on data?",
  timestamp: "2026-10-30T08:53:00.000Z",
  mentions: [{ id: "620" }],
  mention_roles: [],
  attachments: [],
}

/** Newest first, as `GET /channels/700/messages` returns it. */
const startedThreadMessages = [
  {
    id: "701",
    type: 0,
    channel_id: startedThread.threadId,
    author: { id: "620", username: "tim", global_name: null },
    content: "<@300> can you confirm",
    timestamp: "2026-10-30T09:01:00.000Z",
    mentions: [{ id: "300" }],
    mention_roles: [],
    attachments: [],
  },
  {
    id: "702",
    type: 21,
    channel_id: startedThread.threadId,
    author: { id: "610", username: "gcanti", global_name: null },
    content: "",
    timestamp: "2026-10-30T08:53:00.000Z",
    mentions: [],
    mention_roles: [],
    attachments: [],
    message_reference: { channel_id: "400", guild_id: "100", message_id: "700" },
    referenced_message: openingMessage,
  },
]

/** A plain message, or another type such as a join (7), from ada in a thread. */
const threadMessage = (channelId: string, id: string, type = 0) => ({
  id,
  type,
  channel_id: channelId,
  author: { id: "600", username: "ada", global_name: null },
  content: `message ${id}`,
  timestamp: "2026-10-30T09:00:00.000Z",
  mentions: [],
  mention_roles: [],
  attachments: [],
})

/** The starter of a thread started from message 800 in channel 400. */
const longThreadStarter = {
  ...threadMessage("800", "801", 21),
  content: "",
  message_reference: { channel_id: "400", guild_id: "100", message_id: "800" },
  referenced_message: threadMessage("400", "800"),
}

/**
 * Threads read a page at a time, oldest first: one started from message 800
 * in channel 400, longer than the histories read from it, with a join among
 * its latest messages; and a forum thread, whose post opens it in the thread.
 */
const pagedThreads: Record<string, ReadonlyArray<{ readonly id: string }>> = {
  "800": [
    longThreadStarter,
    ...["802", "803", "804", "805", "806"].map((id) => threadMessage("800", id)),
    threadMessage("800", "807", 7),
    threadMessage("800", "808"),
    threadMessage("800", "809"),
  ],
  "820": ["820", "821", "822"].map((id) => threadMessage("820", id)),
}

/** `GET /channels/{id}/messages` over a paged thread: `limit` messages before or after an id, newest first. */
const page = (messages: ReadonlyArray<{ readonly id: string }>, params: URLSearchParams) => {
  const limit = Number(params.get("limit") ?? 50)
  const before = params.get("before")
  const after = params.get("after")
  const selected =
    after !== null
      ? messages.filter(({ id }) => BigInt(id) > BigInt(after)).slice(0, limit)
      : messages.filter(({ id }) => before === null || BigInt(id) < BigInt(before)).slice(-limit)
  return [...selected].reverse()
}

/** Discord's answers to the reads the platform makes, by path. */
const respond = (
  path: string,
  params: URLSearchParams,
  options: { readonly rolesRefused?: boolean },
): Response => {
  const paged = /^\/channels\/(\d+)\/messages$/.exec(path)?.[1]
  if (paged !== undefined && paged in pagedThreads)
    return Response.json(page(pagedThreads[paged]!, params))
  if (path === "/users/@me") return Response.json({ id: "300", username: "janitor", bot: true })
  if (path === "/guilds/100/roles" && options.rolesRefused === true)
    return Response.json({ message: "Missing Access", code: 50001 }, { status: 403 })
  if (path === "/guilds/100/roles")
    return Response.json([
      { id: "200", name: "Core", managed: false },
      { id: "301", name: "Janitor", managed: true, tags: { bot_id: "300" } },
    ])
  if (path === `/channels/${thread.threadId}/messages`) return Response.json(threadMessages)
  if (path === "/guilds/100/members/600") return Response.json({ nick: null, roles: ["200"] })
  if (path === `/channels/${startedThread.threadId}/messages`)
    return Response.json(startedThreadMessages)
  if (path === "/channels/400/messages/700") return Response.json(openingMessage)
  if (path === "/guilds/100/members/610") return Response.json({ nick: null, roles: [] })
  if (path === "/guilds/100/members/620") return Response.json({ nick: null, roles: ["200"] })
  return Response.json({ id: "1" })
}

const makeServices = (options: { readonly rolesRefused?: boolean } = {}) =>
  DiscordPlatform.layer.pipe(
    Layer.provide(restLayer(Redacted.make("bot-token"))),
    Layer.provide([
      DiscordBotConfig.layerFrom({
        botToken: Redacted.make("bot-token"),
        guildId: "100",
        roleId: "200",
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            const path = new URL(request.url).pathname.replace(/^\/api\/v10/, "")
            const params = new URLSearchParams(UrlParams.toString(request.urlParams))
            if (request.method === "POST" && path === `/channels/${thread.threadId}/messages`) {
              const body = request.body
              let json: string
              if (body._tag === "Uint8Array") {
                json = new TextDecoder().decode(body.body)
              } else if (body._tag === "FormData") {
                const payload = body.formData.get("payload_json")
                assert.isNotNull(payload)
                json =
                  typeof payload === "string"
                    ? payload
                    : yield* Effect.promise(() => payload!.text())
              } else {
                throw new Error(`Unexpected Discord request body: ${body._tag}`)
              }
              posted.push(JSON.parse(json))
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  id: String(900 + posted.length),
                  channel_id: thread.threadId,
                  timestamp: "2026-10-28T12:00:00.000Z",
                }),
              )
            }
            return HttpClientResponse.fromWeb(request, respond(path, params, options))
          }),
        ),
      ),
    ]),
  )

const services = makeServices()

const isFence = (line: string) => line.trimStart().startsWith("```")

describe("Discord platform", () => {
  it.effect("posts a long reply in 2,000-character chunks with balanced code fences", () =>
    Effect.gen(function* () {
      const platform = yield* ChatPlatform
      posted.length = 0
      // A code block that a 2,000-character split has to cut.
      const code = Array.from({ length: 120 }, (_, index) => `const value${index} = ${index}`)
      const text = ["Here is the change:", "", "```ts", ...code, "```", "", "Done."].join("\n")

      yield* platform.postReply(thread, text)

      for (const { content: chunk = "" } of posted) {
        assert.isAtMost(chunk.length, 2000)
        assert.strictEqual(chunk.split("\n").filter(isFence).length % 2, 0, chunk)
      }
      // Nothing but the fences added at the splits.
      assert.deepStrictEqual(
        posted
          .flatMap(({ content = "" }) => content.split("\n"))
          .filter((line) => !isFence(line) && line !== ""),
        text.split("\n").filter((line) => !isFence(line) && line !== ""),
      )
    }).pipe(Effect.provide(services)),
  )

  // Exercise postReply through the same Discord HTTP boundary for both delivery modes.
  // Without a reference, only a mention in the content pings the author.
  for (const { name, replyTo, reference, mentioned } of [
    {
      name: "the thread starter",
      replyTo: { messageId: "500", authorId: "600" },
      reference: undefined,
      mentioned: true,
    },
    {
      name: "a later message",
      replyTo: { messageId: "501", authorId: "600" },
      reference: { message_id: "501", fail_if_not_exists: false },
      mentioned: false,
    },
  ]) {
    it.effect(`chunked replies to ${name} use only a resolvable reply preview`, () =>
      Effect.gen(function* () {
        const platform = yield* ChatPlatform
        posted.length = 0

        yield* platform.postReply(thread, "a".repeat(2500), { replyTo })

        assert.lengthOf(posted, 2)
        for (const message of posted) {
          assert.deepStrictEqual(message.allowed_mentions, { parse: ["users"], replied_user: true })
        }
        assert.deepStrictEqual(
          posted.map((message) => message.message_reference),
          [reference, undefined],
        )
        assert.strictEqual(posted[0]!.content!.startsWith("<@600>"), mentioned)
        assert.notInclude(posted[1]!.content, "<@600>")
      }).pipe(Effect.provide(services)),
    )

    it.effect(`reply.md uploads answering ${name} use only a resolvable reply preview`, () =>
      Effect.gen(function* () {
        const platform = yield* ChatPlatform
        posted.length = 0

        yield* platform.postReply(thread, "a".repeat(11000), { replyTo })

        assert.lengthOf(posted, 1)
        assert.deepStrictEqual(posted[0]!.attachments, [{ id: "0", filename: "reply.md" }])
        assert.deepStrictEqual(posted[0]!.message_reference, reference)
        if (mentioned) {
          assert.strictEqual(posted[0]!.content, "<@600>")
          assert.deepStrictEqual(posted[0]!.allowed_mentions, { parse: [], users: ["600"] })
        } else {
          assert.isUndefined(posted[0]!.content)
        }
      }).pipe(Effect.provide(services)),
    )
  }

  it.effect("reads a managed bot role mention in the history as a bot mention", () =>
    Effect.gen(function* () {
      const platform = yield* ChatPlatform
      const history = yield* platform.history(thread, 10)

      assert.deepStrictEqual(
        history.map(({ id, text, mentionsBot }) => ({ id, text, mentionsBot })),
        [{ id: "1001", text: "what changed?", mentionsBot: true }],
      )
    }).pipe(Effect.provide(services)),
  )

  it.effect("reads the history when Discord refuses to list the roles", () =>
    Effect.gen(function* () {
      const platform = yield* ChatPlatform
      const history = yield* platform.history(thread, 10)

      assert.deepStrictEqual(
        history.map(({ id, text, mentionsBot }) => ({ id, text, mentionsBot })),
        [{ id: "1001", text: "<@&301> what changed?", mentionsBot: false }],
      )
    }).pipe(Effect.provide(makeServices({ rolesRefused: true }))),
  )

  it.effect("reads the opening message of a thread started from a message", () =>
    Effect.gen(function* () {
      const platform = yield* ChatPlatform
      const history = yield* platform.history(startedThread, 10)

      assert.deepStrictEqual(
        history.map(({ id, author, text }) => ({ id, author: author.name, text })),
        [
          {
            id: "700",
            author: "gcanti",
            text: "<@620> is there a reason why StreamSse doesn't call toCodecJson on data?",
          },
          { id: "701", author: "tim", text: "can you confirm" },
        ],
      )
    }).pipe(Effect.provide(services)),
  )

  it.effect("reads the opening message of a thread longer than the history", () =>
    Effect.gen(function* () {
      const platform = yield* ChatPlatform
      // The join on the first page leaves it a message short of the limit.
      const history = yield* platform.history({ _tag: "Discord", guild: "100", threadId: "800" }, 3)

      assert.deepStrictEqual(
        history.map(({ id }) => id),
        ["800", "806", "808", "809"],
      )
    }).pipe(Effect.provide(services)),
  )

  it.effect("reads a forum thread's opening post once when the history reaches it", () =>
    Effect.gen(function* () {
      const platform = yield* ChatPlatform
      const history = yield* platform.history({ _tag: "Discord", guild: "100", threadId: "820" }, 3)

      assert.deepStrictEqual(
        history.map(({ id }) => id),
        ["820", "821", "822"],
      )
    }).pipe(Effect.provide(services)),
  )
})
