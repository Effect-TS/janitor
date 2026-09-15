import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { RunnerNotices } from "../Agent/RunnerNotices.ts"
import { bearerMatches } from "./Auth.ts"

/** The runner's announcement that a session has new readable events. */
export const RunnerEventNotice = Schema.Struct({
  sessionId: Schema.String,
  generation: Schema.Int,
})

/**
 * Runners call this through their private service binding when a turn emits
 * something a teammate can see. It carries the same service token as the
 * credential authority and only hurries reads that already exist.
 */
export const RunnerEventRoutes = HttpRouter.add(
  "POST",
  "/agent/events",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (!(yield* bearerMatches("REPOSITORY_SERVICE_TOKEN")))
      return HttpServerResponse.empty({ status: 401 })
    const notice = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RunnerEventNotice)),
    )
    const notices = yield* RunnerNotices
    yield* notices.hurry(notice.sessionId)
    return HttpServerResponse.empty({ status: 204 })
  }),
)
