import * as Effect from "effect/Effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as Request from "effect/unstable/http/HttpServerRequest"
import * as Response from "effect/unstable/http/HttpServerResponse"
import * as Stream from "effect/Stream"
import { SlackWebhook } from "../Slack/Webhook.ts"

export const SlackSessionRoutes = HttpRouter.add(
  "POST",
  "/api/v1/webhooks/slack",
  Effect.gen(function* () {
    const request = yield* Request.HttpServerRequest
    const webhook = yield* SlackWebhook
    const chunks: Uint8Array[] = []
    let size = 0
    const body = yield* request.stream.pipe(
      Stream.runForEach((chunk) => {
        size += chunk.length
        if (size > 1024 * 1024) return Effect.fail("Too large")
        chunks.push(chunk)
        return Effect.void
      }),
      Effect.result,
    )
    if (body._tag === "Failure")
      return Response.text("Invalid body", { status: size > 1024 * 1024 ? 413 : 400 })
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    const result = yield* webhook.receive({
      body: new TextDecoder().decode(bytes),
      signature: request.headers["x-slack-signature"] ?? "",
      timestamp: request.headers["x-slack-request-timestamp"] ?? "",
    })
    return Response.text(result.body, { status: result.status })
  }).pipe(
    Effect.timeout("2500 millis"),
    Effect.catchCause(() => Effect.succeed(Response.text("Receipt unavailable", { status: 503 }))),
  ),
)
