// Service-token authentication for machine routes that sit outside Access.
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"

/**
 * True when the request's bearer token equals the configured secret. The
 * comparison is constant time, and an unset secret matches nothing.
 */
export const bearerMatches = (configKey: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const secret = yield* Config.Redacted(configKey).pipe(Config.withDefault(Redacted.make("")))
    const expected = Redacted.value(secret)
    const supplied = request.headers.authorization ?? ""
    const left = new TextEncoder().encode(supplied)
    const right = new TextEncoder().encode(`Bearer ${expected}`)
    let different = left.length ^ right.length
    for (let i = 0; i < Math.max(left.length, right.length); i++)
      different |= (left[i] ?? 0) ^ (right[i] ?? 0)
    return expected !== "" && !different
  })
