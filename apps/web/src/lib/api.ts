import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage"

const FALLBACK_REASON = "The request failed. Please retry."

/**
 * A JSON write to the API. Error responses carry `{ message }`, which becomes
 * the failure's message so pages can show it as is.
 */
export const request = (method: "POST" | "PUT" | "DELETE" | "PATCH", url: string, body: unknown) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const req = yield* HttpClientRequest.make(method)(url).pipe(HttpClientRequest.bodyJson(body))
    const response = yield* client.execute(req)
    if (response.status >= 400) {
      const data = yield* HttpIncomingMessage.schemaBodyJson(
        Schema.Struct({ message: Schema.String }),
      )(response).pipe(Effect.orElseSucceed(() => ({ message: FALLBACK_REASON })))
      return yield* Effect.fail(new Error(data.message))
    }
    return response
  })

/**
 * A read that came back with an error status. The `{ message }` body becomes
 * the failure's message; anything else shows the caller's fallback.
 */
export const readFailure = (
  response: HttpIncomingMessage.HttpIncomingMessage<unknown>,
  fallback: string,
): Effect.Effect<never, Error> =>
  HttpIncomingMessage.schemaBodyJson(Schema.Struct({ message: Schema.String }))(response).pipe(
    Effect.orElseSucceed(() => ({ message: fallback })),
    Effect.flatMap((data) => Effect.fail(new Error(data.message))),
  )

/** The message a failed request should show. */
export const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : FALLBACK_REASON
