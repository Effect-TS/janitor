import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
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
    readonly replied_user?: boolean
  }
  readonly attachments?: ReadonlyArray<{ readonly id: string; readonly filename: string }>
}> = []

const services = DiscordPlatform.layer.pipe(
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
          if (request.method === "POST" && path === `/channels/${thread.threadId}/messages`) {
            const body = request.body
            let json: string
            if (body._tag === "Uint8Array") {
              json = new TextDecoder().decode(body.body)
            } else if (body._tag === "FormData") {
              const payload = body.formData.get("payload_json")
              assert.isNotNull(payload)
              json =
                typeof payload === "string" ? payload : yield* Effect.promise(() => payload!.text())
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
          return HttpClientResponse.fromWeb(request, Response.json({ id: "1" }))
        }),
      ),
    ),
  ]),
)

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
  for (const { name, replyTo, reference } of [
    { name: "the thread starter", replyTo: "500", reference: undefined },
    {
      name: "a later message",
      replyTo: "501",
      reference: { message_id: "501", fail_if_not_exists: false },
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
      }).pipe(Effect.provide(services)),
    )
  }
})
