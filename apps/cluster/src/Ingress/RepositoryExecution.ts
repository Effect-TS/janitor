import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { RepositoryAccess, RepositoryRequest } from "../Agent/RepositoryAccess.ts"
import { bearerMatches } from "./Auth.ts"

// Service authentication is independent of browser Access. Production runners
// call this route through their private REPOSITORY_AUTHORITY service binding.
export const RepositoryExecutionRoutes = HttpRouter.add(
  "POST",
  "/agent/repository",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (!(yield* bearerMatches("REPOSITORY_SERVICE_TOKEN")))
      return HttpServerResponse.empty({ status: 401 })
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
      // The concrete fence travels with the refusal so the runner can report it.
      Effect.catch((error) =>
        HttpServerResponse.schemaJson(Schema.Struct({ message: Schema.String }))(
          { message: error.message },
          { status: 423 },
        ),
      ),
    )
  }),
)
