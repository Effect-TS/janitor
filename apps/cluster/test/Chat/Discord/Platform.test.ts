import { assert, describe, it } from "@effect/vitest"
import * as DiscordConfig from "dfx/DiscordConfig"
import { DiscordRESTLive } from "dfx/DiscordREST"
import { MemoryRateLimitStoreLive } from "dfx/RateLimit"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as DiscordPlatform from "../../../src/Chat/Discord/Platform.ts"
import { ChatPlatform, type ChatThread } from "../../../src/Chat/Platform.ts"

/**
 * Discord's `ChatPlatform` over a fake Discord REST API.
 *
 * Expected failures until the platform is implemented (EFF-3020).
 */

const thread: ChatThread = { _tag: "Discord", guild: "100", threadId: "500" }

/** The `content` of every message posted to the thread, in order. */
const posted: Array<string> = []

const services = DiscordPlatform.layer.pipe(
  Layer.provide(DiscordRESTLive),
  Layer.provide([
    DiscordConfig.layer({ token: Redacted.make("bot-token") }),
    MemoryRateLimitStoreLive,
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname.replace(/^\/api\/v10/, "")
          if (
            request.method === "POST" &&
            path === `/channels/${thread.threadId}/messages` &&
            request.body._tag === "Uint8Array"
          ) {
            const body = JSON.parse(new TextDecoder().decode(request.body.body)) as {
              readonly content: string
            }
            posted.push(body.content)
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
  it.effect.fails("posts a long reply in 2,000-character chunks with balanced code fences", () =>
    Effect.gen(function* () {
      const platform = yield* ChatPlatform
      posted.length = 0
      // A code block that a 2,000-character split has to cut.
      const code = Array.from({ length: 120 }, (_, index) => `const value${index} = ${index}`)
      const text = ["Here is the change:", "", "```ts", ...code, "```", "", "Done."].join("\n")
      assert.isAbove(text.length, 2000)

      yield* platform.postReply(thread, text)

      assert.isAbove(posted.length, 1)
      for (const chunk of posted) {
        assert.isAtMost(chunk.length, 2000)
        assert.strictEqual(chunk.split("\n").filter(isFence).length % 2, 0, chunk)
      }
      // Nothing but the fences added at the splits.
      assert.deepStrictEqual(
        posted
          .flatMap((chunk) => chunk.split("\n"))
          .filter((line) => !isFence(line) && line !== ""),
        text.split("\n").filter((line) => !isFence(line) && line !== ""),
      )
    }).pipe(Effect.provide(services)),
  )
})
