import { assert, describe, it } from "@effect/vitest"
import type * as Discord from "dfx/types"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { restLayer } from "../../../src/Chat/Discord/Api.ts"
import { DiscordBotConfig } from "../../../src/Chat/Discord/Config.ts"
import * as DiscordIngress from "../../../src/Chat/Discord/Ingress.ts"
import type { ChatMessage, ChatThread } from "../../../src/Chat/Platform.ts"

/**
 * The gateway's ingress, from a `MESSAGE_CREATE` to what it hands the chat
 * sessions. Discord's REST API and the sessions are fakes.
 */

const GUILD = "100"
const ROLE = "200"
const BOT_USER = "300"
const BOT_ROLE = "301"
const CHANNEL = "400"
/** A thread under `CHANNEL` that has a session. */
const SESSION_THREAD = "500"

/** `GET /channels/{id}`: `CHANNEL` is a text channel, `SESSION_THREAD` a public thread. */
const channels: Record<string, object> = {
  [CHANNEL]: { id: CHANNEL, type: 0, guild_id: GUILD },
  [SESSION_THREAD]: { id: SESSION_THREAD, type: 11, guild_id: GUILD, parent_id: CHANNEL },
}

const makeIngress = (options: { readonly rolesRefused?: boolean } = {}) => {
  const handedOff: Array<{ readonly thread: ChatThread; readonly message: ChatMessage }> = []
  /** The threads ingress started, by the channel and message they started from. */
  const threadsStarted: Array<{
    readonly channel: string
    readonly message: string
    readonly body: Record<string, unknown>
  }> = []
  const seen = new Set<string>()

  const discordApi = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname.replace(/^\/api\/v10/, "")
      const body =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, unknown>)
          : {}
      const respond = (): Response => {
        if (path === "/users/@me")
          return Response.json({ id: BOT_USER, username: "janitor", bot: true })
        if (path === `/guilds/${GUILD}/roles` && options.rolesRefused === true)
          return Response.json({ message: "Missing Access", code: 50001 }, { status: 403 })
        if (path === `/guilds/${GUILD}/roles`)
          return Response.json([
            { id: ROLE, name: "Core", managed: false },
            { id: BOT_ROLE, name: "Janitor", managed: true, tags: { bot_id: BOT_USER } },
          ])
        const thread = /^\/channels\/(\d+)\/messages\/(\d+)\/threads$/.exec(path)
        if (thread !== null && request.method === "POST") {
          threadsStarted.push({ channel: thread[1]!, message: thread[2]!, body })
          // A thread started from a message takes the message's id.
          return Response.json({ id: thread[2], type: 11, guild_id: GUILD, parent_id: thread[1] })
        }
        const channel = /^\/channels\/(\d+)$/.exec(path)
        if (channel !== null && channels[channel[1]!] !== undefined)
          return Response.json(channels[channel[1]!])
        return Response.json({ message: "Unknown", code: 10003 }, { status: 404 })
      }
      return HttpClientResponse.fromWeb(request, respond())
    }),
  )

  const services = Layer.mergeAll(
    DiscordBotConfig.layerFrom({
      botToken: Redacted.make("bot-token"),
      guildId: GUILD,
      roleId: ROLE,
    }),
    Layer.succeed(DiscordIngress.DiscordSessions, {
      receive: (thread, message) =>
        Effect.sync(() => {
          handedOff.push({ thread, message })
        }),
      exists: (thread) =>
        Effect.succeed(thread._tag === "Discord" && thread.threadId === SESSION_THREAD),
    }),
    // One store across every instance, as the Durable Object's storage is.
    Layer.succeed(DiscordIngress.SeenMessages, {
      has: (messageId) => Effect.sync(() => seen.has(messageId)),
      add: (messageId) =>
        Effect.sync(() => {
          seen.add(messageId)
        }),
    }),
    restLayer(Redacted.make("bot-token")).pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, discordApi)),
    ),
  )

  /**
   * A fresh instance of the ingress, as a rebuilt Durable Object builds,
   * over the same sessions and storage.
   */
  const instance = Effect.gen(function* () {
    return (yield* DiscordIngress.DiscordIngress).handle
  }).pipe(Effect.provide(DiscordIngress.layer.pipe(Layer.provide(services))))

  /** The message handed off with id `id`, if any. */
  const handedOffAt = (id: string) => handedOff.find(({ message }) => message.id === id)

  return { instance, handedOff, handedOffAt, threadsStarted }
}

const user = (id: string, username: string, fields: { readonly bot?: boolean } = {}) => ({
  id,
  username,
  global_name: null,
  discriminator: "0",
  avatar: null,
  public_flags: 0,
  flags: 0,
  primary_guild: null,
  ...fields,
})

const member = (roles: ReadonlyArray<string>) => ({
  roles,
  avatar: null,
  banner: null,
  communication_disabled_until: null,
  flags: 0,
  joined_at: "2026-01-01T00:00:00.000Z",
  nick: null,
  pending: false,
  premium_since: null,
  mute: false,
  deaf: false,
})

/** A `MESSAGE_CREATE` from a member with the role, in the session's thread. */
const message = (
  id: string,
  fields: Partial<Discord.GatewayMessageCreateDispatchData> = {},
): Discord.GatewayMessageCreateDispatchData => ({
  id,
  type: 0,
  channel_id: SESSION_THREAD,
  guild_id: GUILD,
  author: user("600", "ada"),
  member: member([ROLE]),
  content: "hello",
  timestamp: "2026-10-28T12:00:00.000Z",
  edited_timestamp: null,
  tts: false,
  mention_everyone: false,
  mentions: [],
  mention_roles: [],
  attachments: [],
  embeds: [],
  pinned: false,
  flags: 0,
  components: [],
  ...fields,
})

/** A mention of the bot from a member with the role, in `channel`. */
const mention = (id: string, channel: string) =>
  message(id, {
    channel_id: channel,
    content: `<@${BOT_USER}> hello`,
    mentions: [user(BOT_USER, "janitor", { bot: true })],
  })

describe("Discord ingress", () => {
  it.effect("admits authors with the role, and refuses other guilds and no member", () =>
    Effect.gen(function* () {
      const ingress = makeIngress()
      const handle = yield* ingress.instance
      // A webhook's message, say.
      const { member: _member, ...withoutMember } = message("1005")
      yield* handle(message("1001"))
      yield* handle(message("1002", { member: member(["201"]) }))
      yield* handle(
        message("1003", { author: user("700", "other-bot", { bot: true }), member: member([]) }),
      )
      yield* handle(message("1004", { guild_id: "101" }))
      yield* handle(withoutMember)

      assert.deepStrictEqual(
        ingress.handedOff.map(({ message }) => [message.id, message.author.class]),
        [
          ["1001", "admitted"],
          ["1002", "outsider"],
          ["1003", "bot"],
        ],
      )
    }),
  )

  it.effect("drops a message a RESUME replays to a rebuilt instance", () =>
    Effect.gen(function* () {
      const ingress = makeIngress()
      const before = yield* ingress.instance
      yield* before(message("1101"))
      // The object was evicted before the shard stored the sequence, so the
      // RESUME replays 1101 along with what arrived while the socket was dark.
      const after = yield* ingress.instance
      yield* after(message("1101"))
      yield* after(message("1102"))
      assert.deepStrictEqual(
        ingress.handedOff.map(({ message }) => message.id),
        ["1101", "1102"],
      )
    }),
  )

  it.effect("starts a thread from a managed bot role mention and strips it from the message", () =>
    Effect.gen(function* () {
      const ingress = makeIngress()
      const handle = yield* ingress.instance
      yield* handle(
        message("1251", {
          channel_id: CHANNEL,
          content: `<@&${BOT_ROLE}> hello`,
          mention_roles: [BOT_ROLE],
        }),
      )

      assert.deepStrictEqual(
        ingress.handedOff.map(({ thread, message }) => ({
          thread,
          mentionsBot: message.mentionsBot,
          text: message.text,
        })),
        [
          {
            thread: { _tag: "Discord", guild: GUILD, threadId: "1251" },
            mentionsBot: true,
            text: "hello",
          },
        ],
      )
    }),
  )

  it.effect(
    "hands on a session thread's message that mentions a role when roles can't be read",
    () =>
      Effect.gen(function* () {
        const ingress = makeIngress({ rolesRefused: true })
        const handle = yield* ingress.instance
        yield* handle(message("1261", { content: `<@&${ROLE}> hello`, mention_roles: [ROLE] }))

        assert.deepStrictEqual(
          ingress.handedOff.map(({ thread, message }) => [thread, message.id]),
          [[{ _tag: "Discord", guild: GUILD, threadId: SESSION_THREAD }, "1261"]],
        )
      }),
  )

  it.effect("keeps the bot role's mention syntax that doesn't mention the role", () =>
    Effect.gen(function* () {
      const ingress = makeIngress()
      const handle = yield* ingress.instance
      // Discord doesn't parse a mention in inline code.
      const content = `<@&${ROLE}> the bot's role is \`<@&${BOT_ROLE}>\``
      yield* handle(message("1271", { content, mention_roles: [ROLE] }))

      assert.deepStrictEqual(
        ingress.handedOff.map(({ message }) => [message.text, message.mentionsBot]),
        [[content, false]],
      )
    }),
  )

  it.effect("counts a reply to the bot's message as a mention, ping or not", () =>
    Effect.gen(function* () {
      const ingress = makeIngress()
      const handle = yield* ingress.instance
      yield* handle(
        message("1281", {
          type: 19,
          referenced_message: message("1280", { author: user(BOT_USER, "janitor", { bot: true }) }),
        }),
      )
      yield* handle(message("1283", { type: 19, referenced_message: message("1282") }))

      assert.deepStrictEqual(
        ingress.handedOff.map(({ message }) => [message.id, message.mentionsBot]),
        [
          ["1281", true],
          ["1283", false],
        ],
      )
    }),
  )

  it.effect("starts a thread from a channel mention, and uses an existing one", () =>
    Effect.gen(function* () {
      const ingress = makeIngress()
      const handle = yield* ingress.instance
      yield* handle(mention("1201", CHANNEL))
      yield* handle(mention("1202", SESSION_THREAD))

      assert.deepStrictEqual(
        ingress.threadsStarted.map(({ channel, message, body }) => ({
          channel,
          message,
          autoArchive: body["auto_archive_duration"],
        })),
        [{ channel: CHANNEL, message: "1201", autoArchive: 1440 }],
      )
      assert.deepStrictEqual(ingress.handedOffAt("1201")?.thread, {
        _tag: "Discord",
        guild: GUILD,
        threadId: "1201",
      })
      assert.deepStrictEqual(ingress.handedOffAt("1202")?.thread, {
        _tag: "Discord",
        guild: GUILD,
        threadId: SESSION_THREAD,
      })
    }),
  )
})
