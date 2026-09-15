import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { SlackInteractivity } from "../Slack/Interactivity.ts"
import { SlackWebhook } from "../Slack/Webhook.ts"

const receiveWith = (
  receive: (request: {
    readonly body: string
    readonly signature: string
    readonly timestamp: string
    readonly retry?: string
  }) => Effect.Effect<{ readonly status: number; readonly body: string }>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const parts: Uint8Array[] = []
    let size = 0
    const read = yield* request.stream.pipe(
      Stream.runForEach((part) => {
        size += part.byteLength
        if (size > 1024 * 1024) return Effect.fail("too-large")
        parts.push(part)
        return Effect.void
      }),
      Effect.result,
    )
    if (read._tag === "Failure")
      return HttpServerResponse.text("Invalid body", { status: size > 1024 * 1024 ? 413 : 400 })
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const part of parts) {
      bytes.set(part, offset)
      offset += part.byteLength
    }
    const result = yield* receive({
      body: new TextDecoder().decode(bytes),
      signature: request.headers["x-slack-signature"] ?? "",
      timestamp: request.headers["x-slack-request-timestamp"] ?? "",
      ...(request.headers["x-slack-retry-num"] === undefined
        ? {}
        : { retry: request.headers["x-slack-retry-num"] }),
    })
    return HttpServerResponse.text(result.body, { status: result.status })
  }).pipe(
    Effect.timeout("2500 millis"),
    Effect.catchCause(() =>
      Effect.succeed(HttpServerResponse.text("Receipt unavailable", { status: 503 })),
    ),
  )

const events = HttpRouter.add(
  "POST",
  "/api/v1/webhooks/slack",
  Effect.flatMap(SlackWebhook, (webhook) => receiveWith(webhook.receive)),
)

/** Retry/Skip clicks arrive here; Slack waits at most three seconds for the acknowledgement. */
const interactivity = HttpRouter.add(
  "POST",
  "/api/v1/webhooks/slack/interactivity",
  Effect.flatMap(SlackInteractivity, (service) => receiveWith(service.receive)),
)

export const SlackWebhookRoutes = Layer.mergeAll(events, interactivity)
