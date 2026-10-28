import * as Cause from "effect/Cause"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import type * as HttpServerRequest from "effect/http/HttpServerRequest"

export class BodyTooLargeError extends Data.TaggedError("BodyTooLargeError")<{
  readonly maxBytes: number
}> {}

/**
 * Reads a webhook's raw body, failing as soon as more than `maxBytes` arrive
 * without reading the rest.
 */
export const readBodyBounded = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
  maxBytes: number,
) {
  const chunks: Array<Uint8Array> = []

  let total = 0
  yield* request.stream.pipe(
    Stream.runForEach(
      Effect.fnUntraced(function* (chunk) {
        total += chunk.byteLength

        if (total > maxBytes) {
          return yield* new BodyTooLargeError({ maxBytes })
        }

        chunks.push(chunk)
      }),
    ),
  )

  const body = new Uint8Array(total)

  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  return body
})

/** A failure's tag, which code defines; a defect or interruption gets a fixed category. */
export const failureCategory = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.findErrorOption(cause)
  if (failure._tag === "None") return Cause.hasInterruptsOnly(cause) ? "interrupted" : "defect"
  const error = failure.value
  return typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string"
    ? error._tag
    : "unknown"
}
