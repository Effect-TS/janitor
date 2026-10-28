import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as HttpRouter from "effect/http/HttpRouter"
import * as UrlParams from "effect/http/UrlParams"
import type { ChatMessage, ChatThread } from "../../../src/Chat/Platform.ts"
import { SlackConfig } from "../../../src/Chat/Slack/Config.ts"
import {
  SlackSessionError,
  SlackSessions,
  SlackWebhookRoutesLayer,
} from "../../../src/Chat/Slack/Ingress.ts"

/**
 * The Slack Events API webhook, from a signed request to what it hands the
 * chat sessions. The Slack Web API and the sessions are fakes.
 */

const SIGNING_SECRET = "signing-secret"
const BOT_USER = "UBOT"
/** The root of the one thread that has a session. */
const SESSION_THREAD = "1700000000.000100"

/** `users.info` answers by user id; anyone else is `user_not_found`. */
const users: Record<string, object> = {
  // A missing flag counts as false.
  "U-member": { id: "U-member", team_id: "T1", name: "ada" },
  "U-multi-guest": { id: "U-multi-guest", team_id: "T1", is_restricted: true },
  "U-single-guest": {
    id: "U-single-guest",
    team_id: "T1",
    is_restricted: true,
    is_ultra_restricted: true,
  },
  "U-connect": { id: "U-connect", team_id: "T2", is_restricted: false },
  "U-stranger": { id: "U-stranger", team_id: "T1", is_stranger: true },
  "U-deleted": { id: "U-deleted", team_id: "T1", deleted: true },
  "U-bot": { id: "U-bot", team_id: "T1", is_bot: true },
  // A guest now, but admitted within the hour.
  "U-cached": { id: "U-cached", team_id: "T1", is_restricted: true },
}

const requestParams = (request: HttpClientRequest.HttpClientRequest): URLSearchParams => {
  const params = new URLSearchParams(new URL(request.url).search)
  for (const [key, value] of Object.entries(UrlParams.toRecord(request.urlParams)))
    params.set(key, Array.isArray(value) ? value[0] : value)
  if (request.body._tag === "Uint8Array") {
    const text = new TextDecoder().decode(request.body.body)
    try {
      for (const [key, value] of Object.entries(JSON.parse(text) as Record<string, unknown>))
        params.set(key, String(value))
    } catch {
      for (const [key, value] of new URLSearchParams(text)) params.set(key, value)
    }
  }
  return params
}

const makeIngress = Effect.fnUntraced(function* (
  options: {
    readonly receive?: (
      thread: ChatThread,
      message: ChatMessage,
    ) => Effect.Effect<void, SlackSessionError>
  } = {},
) {
  const handedOff: Array<{ readonly thread: ChatThread; readonly message: ChatMessage }> = []
  const remembered: Array<string> = []
  /** The `chat.postMessage` calls ingress made itself, by channel and text. */
  const posted: Array<{ readonly channel: string | null; readonly text: string | null }> = []
  const lookups: Array<string> = []

  const slackApi = HttpClient.make((request) =>
    Effect.sync(() => {
      const method = new URL(request.url).pathname.split("/").pop()
      const params = requestParams(request)
      const body = (): object => {
        switch (method) {
          case "auth.test":
            return { ok: true, user_id: BOT_USER, team_id: "T1", bot_id: "B1" }
          case "conversations.info":
            return {
              ok: true,
              channel: {
                id: params.get("channel"),
                is_channel: true,
                is_ext_shared: params.get("channel") === "C-shared",
              },
            }
          case "users.info": {
            const id = params.get("user") ?? ""
            lookups.push(id)
            const user = users[id]
            return user === undefined ? { ok: false, error: "user_not_found" } : { ok: true, user }
          }
          case "chat.postMessage":
            posted.push({ channel: params.get("channel"), text: params.get("text") })
            return { ok: true, ts: "1700000099.000100" }
          default:
            return { ok: false, error: "unknown_method" }
        }
      }
      return HttpClientResponse.fromWeb(request, Response.json(body()))
    }),
  )

  const sessions = SlackSessions.of({
    receive:
      options.receive ??
      ((thread, message) =>
        Effect.sync(() => {
          handedOff.push({ thread, message })
        })),
    exists: (thread) =>
      Effect.succeed(thread._tag === "Slack" && thread.threadTs === SESSION_THREAD),
    cachedAdmission: (_thread, userId) =>
      Effect.succeed(userId === "U-cached" ? Option.some("grace") : Option.none()),
    rememberAdmission: (_thread, userId) =>
      Effect.sync(() => {
        remembered.push(userId)
      }),
  })

  const { handler } = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        SlackWebhookRoutesLayer.pipe(
          Layer.provide([
            Layer.succeed(SlackConfig, {
              signingSecret: Redacted.make(SIGNING_SECRET),
              botToken: Redacted.make("xoxb-test"),
              workspaceId: "T1",
              appId: "A1",
            }),
            Layer.succeed(SlackSessions, sessions),
            Layer.succeed(HttpClient.HttpClient, slackApi),
          ]),
        ),
        { disableLogger: true },
      ),
    ),
    ({ dispose }) => Effect.promise(dispose),
  )

  /** Posts `body`, signed at `timestamp` (now by default) unless `signature` replaces it. */
  const post = Effect.fnUntraced(function* (
    body: string,
    options: { readonly timestamp?: number; readonly signature?: string } = {},
  ) {
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000)
    const signature = options.signature ?? (yield* sign(timestamp, body))
    const response = yield* Effect.promise(() =>
      handler(
        new Request("https://example.com/webhooks/slack", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-slack-request-timestamp": String(timestamp),
            "x-slack-signature": signature,
          },
          body,
        }),
      ),
    )
    return { status: response.status, body: yield* Effect.promise(() => response.text()) }
  })

  /** The message handed off with Slack `ts` `ts`, if any. */
  const handedOffAt = (ts: string) => handedOff.find(({ message }) => message.id === ts)

  return { post, handedOff, handedOffAt, remembered, lookups, posted }
})

const sign = (timestamp: number, body: string) =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SIGNING_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    const digest = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`v0:${timestamp}:${body}`),
    )
    return `v0=${Hex.encode(new Uint8Array(digest))}`
  })

const eventCallback = (event: object, envelope: object = {}) =>
  JSON.stringify({
    token: "unused",
    team_id: "T1",
    api_app_id: "A1",
    type: "event_callback",
    event_id: "Ev1",
    event_time: 1700000000,
    authorizations: [{ team_id: "T1", user_id: BOT_USER, is_bot: true }],
    event,
    ...envelope,
  })

/** A `message.channels` event from the member, outside any thread. */
const message = (ts: string, fields: object = {}) => ({
  type: "message",
  channel: "C1",
  channel_type: "channel",
  user: "U-member",
  text: "hello",
  ts,
  event_ts: ts,
  ...fields,
})

/** An `app_mention` event from the member, outside any thread. */
const mention = (ts: string, fields: object = {}) => ({
  type: "app_mention",
  channel: "C1",
  user: "U-member",
  text: `<@${BOT_USER}> hello`,
  ts,
  event_ts: ts,
  ...fields,
})

describe("Slack ingress", () => {
  it.effect("checks the signature, its timestamp and the envelope", () =>
    Effect.gen(function* () {
      const ingress = yield* makeIngress()
      const now = Math.floor(Date.now() / 1000)

      assert.deepStrictEqual(
        yield* ingress.post(
          JSON.stringify({ token: "unused", type: "url_verification", challenge: "challenge-1" }),
        ),
        { status: 200, body: "challenge-1" },
      )

      const event = eventCallback(mention("1700000001.000100"))
      const signature = yield* sign(now, event)
      assert.strictEqual(
        (yield* ingress.post(event.replace("hello", "goodbye"), { timestamp: now, signature }))
          .status,
        401,
      )
      assert.strictEqual((yield* ingress.post(event, { timestamp: now - 301 })).status, 401)
      assert.strictEqual(
        (yield* ingress.post(eventCallback(mention("1700000001.000100"), { team_id: "T2" })))
          .status,
        403,
      )
      assert.strictEqual(
        (yield* ingress.post(eventCallback(mention("1700000001.000100"), { api_app_id: "A2" })))
          .status,
        403,
      )
      assert.deepStrictEqual(ingress.handedOff, [])
    }),
  )

  it.effect("answers only once the message is with its session, and 503 when it can't be", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const answered = yield* Deferred.make<void>()
      const received: Array<{ readonly thread: ChatThread; readonly message: ChatMessage }> = []
      const waiting = yield* makeIngress({
        receive: (thread, message) =>
          Effect.gen(function* () {
            received.push({ thread, message })
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }),
      })
      const answer = yield* waiting.post(eventCallback(mention("1700000001.000100"))).pipe(
        Effect.tap(() => Deferred.succeed(answered, undefined)),
        Effect.forkChild,
      )
      yield* Deferred.await(entered)
      assert.isFalse(yield* Deferred.isDone(answered))
      yield* Deferred.succeed(release, undefined)
      assert.strictEqual((yield* Fiber.join(answer)).status, 200)
      assert.lengthOf(received, 1)
      assert.deepStrictEqual(received[0]!.thread, {
        _tag: "Slack",
        team: "T1",
        channel: "C1",
        threadTs: "1700000001.000100",
      })
      assert.isTrue(received[0]!.message.mentionsBot)

      const failing = yield* makeIngress({
        receive: () => Effect.fail(new SlackSessionError({ message: "unavailable" })),
      })
      assert.strictEqual(
        (yield* failing.post(eventCallback(mention("1700000002.000100")))).status,
        503,
      )

      const stuck = yield* makeIngress({ receive: () => Effect.never })
      assert.strictEqual(
        (yield* stuck.post(eventCallback(mention("1700000003.000100")))).status,
        503,
      )
    }),
  )

  it.effect("passes on only mentions, and replies in a thread with a session", () =>
    Effect.gen(function* () {
      const ingress = yield* makeIngress()
      const dropped = [
        message("1700000010.000100", { subtype: "message_changed" }),
        message("1700000012.000100", { thread_ts: SESSION_THREAD, bot_id: "B2" }),
        message("1700000013.000100", { thread_ts: SESSION_THREAD, app_id: "A2" }),
        message("1700000014.000100", {
          thread_ts: SESSION_THREAD,
          edited: { user: "U-member", ts: "1700000015.000100" },
        }),
        mention("1700000016.000100", { user: BOT_USER }),
        // Channel chatter, and a reply in a thread without a session.
        message("1700000017.000100"),
        message("1700000018.000100", { thread_ts: "1700000000.000999" }),
      ]
      for (const event of dropped)
        assert.strictEqual((yield* ingress.post(eventCallback(event))).status, 200)
      assert.deepStrictEqual(ingress.handedOff, [])

      // In a public channel too: the private-channel-only rule is gone.
      yield* ingress.post(
        eventCallback(message("1700000020.000100", { text: `<@${BOT_USER}> look` })),
      )
      yield* ingress.post(
        eventCallback(message("1700000021.000100", { thread_ts: SESSION_THREAD })),
      )
      // A message with files, and a thread reply also sent to the channel.
      for (const [ts, subtype] of [
        ["1700000022.000100", "file_share"],
        ["1700000023.000100", "thread_broadcast"],
      ])
        yield* ingress.post(eventCallback(message(ts, { thread_ts: SESSION_THREAD, subtype })))
      assert.isDefined(ingress.handedOffAt("1700000022.000100"), "file_share")
      assert.isDefined(ingress.handedOffAt("1700000023.000100"), "thread_broadcast")
      assert.isTrue(ingress.handedOffAt("1700000020.000100")?.message.mentionsBot)
      const reply = ingress.handedOffAt("1700000021.000100")
      assert.isFalse(reply?.message.mentionsBot)
      assert.deepStrictEqual(reply?.thread, {
        _tag: "Slack",
        team: "T1",
        channel: "C1",
        threadTs: SESSION_THREAD,
      })
    }),
  )

  it.effect("admits full members of the workspace only, and remembers admissions", () =>
    Effect.gen(function* () {
      const ingress = yield* makeIngress()
      const cases = [
        ["U-member", "admitted"],
        ["U-multi-guest", "outsider"],
        ["U-single-guest", "outsider"],
        ["U-connect", "outsider"],
        ["U-stranger", "outsider"],
        ["U-deleted", "outsider"],
        ["U-bot", "bot"],
        ["U-unknown", "outsider"],
        ["U-cached", "admitted"],
      ] as const
      let index = 0
      for (const [user, expected] of cases) {
        const ts = `17000001${String(index++).padStart(2, "0")}.000100`
        yield* ingress.post(eventCallback(message(ts, { thread_ts: SESSION_THREAD, user })))
        assert.strictEqual(ingress.handedOffAt(ts)?.message.author.class, expected, user)
      }
      assert.notInclude(ingress.lookups, "U-cached")
      assert.strictEqual(ingress.handedOffAt("1700000108.000100")?.message.author.name, "grace")
      assert.deepStrictEqual(
        ingress.remembered.filter((user) => user !== "U-cached"),
        ["U-member"],
      )
    }),
  )

  it.effect("answers a direct message and a Slack Connect channel without a session", () =>
    Effect.gen(function* () {
      const ingress = yield* makeIngress()
      yield* ingress.post(
        eventCallback(message("1700000030.000100", { channel: "D1", channel_type: "im" })),
      )
      // A mention starts nothing in a shared channel, and a channel shared after
      // its session started no longer reaches it.
      yield* ingress.post(eventCallback(mention("1700000031.000100", { channel: "C-shared" })))
      yield* ingress.post(
        eventCallback(
          message("1700000032.000100", { channel: "C-shared", thread_ts: SESSION_THREAD }),
        ),
      )
      assert.deepStrictEqual(ingress.handedOff, [])
      assert.deepStrictEqual(
        ingress.posted.map(({ channel }) => channel),
        ["D1", "C-shared"],
      )
    }),
  )
})
