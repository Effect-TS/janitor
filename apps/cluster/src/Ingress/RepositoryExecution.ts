import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { RepositoryAccess, RepositoryRequest } from "../Agent/RepositoryAccess.ts"

// Service authentication is independent of browser Access. Production runners
// call this route through their private REPOSITORY_AUTHORITY service binding.
export const RepositoryExecutionRoutes = HttpRouter.add(
  "POST",
  "/agent/repository",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const secret = yield* Config.Redacted("REPOSITORY_SERVICE_TOKEN").pipe(
      Config.withDefault(Redacted.make("")),
    )
    const expected = Redacted.value(secret)
    const supplied = request.headers.authorization ?? ""
    const left = new TextEncoder().encode(supplied)
    const right = new TextEncoder().encode(`Bearer ${expected}`)
    let different = left.length ^ right.length
    for (let i = 0; i < Math.max(left.length, right.length); i++)
      different |= (left[i] ?? 0) ^ (right[i] ?? 0)
    if (!expected || different) return HttpServerResponse.empty({ status: 401 })
    const input = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RepositoryRequest)),
    )
    const access = yield* RepositoryAccess
    return yield* access.authorize(input).pipe(
      Effect.map((result) =>
        HttpServerResponse.jsonUnsafe(
          { ...result, ...(result.token ? { token: Redacted.value(result.token) } : {}) },
          { headers: { "cache-control": "no-store" } },
        ),
      ),
      Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 423 }))),
    )
  }),
)
