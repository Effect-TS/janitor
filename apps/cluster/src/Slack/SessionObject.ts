import { Sandbox } from "@janitor/alchemy/AI/Sandbox"
import {
  layerContainer,
  layerContainerSession,
} from "@janitor/alchemy/Cloudflare/AI/SandboxContainer"
import * as Cloudflare from "alchemy/Cloudflare"
import { ALCHEMY_PHASE } from "alchemy/Phase"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { makeSession, SessionState, type SessionInput } from "./Session.ts"
import { SessionRuntime } from "./SessionRuntime.ts"

export interface SessionObjectShape {
  readonly receive: (input: SessionInput) => Effect.Effect<void, string>
  readonly alarm: () => Effect.Effect<void>
}
export class SlackSession extends Cloudflare.DurableObject<SlackSession, SessionObjectShape>()(
  "SlackSession",
) {}

export const SessionObjectLive = SlackSession.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState
    const runtime = yield* SessionRuntime
    // Container attachment must be discovered while Alchemy plans this namespace.
    // Runtime construction stays lazy so conversation alone does not start a guest.
    if ((yield* ALCHEMY_PHASE) === "plan") {
      yield* Sandbox.pipe(Effect.provide(layerContainer({ enableInternet: true })))
    }
    const sandbox = yield* Sandbox.pipe(
      Effect.provide(layerContainerSession({ enableInternet: true })),
    )
    return Effect.gen(function* () {
      const session = yield* makeSession({
        store: {
          load: Effect.promise(() => state.raw.storage.get<unknown>("session")).pipe(
            Effect.flatMap((value) =>
              value === undefined
                ? Effect.succeed(undefined)
                : Schema.decodeUnknownEffect(SessionState)(value),
            ),
            Effect.orDie,
          ),
          save: (value) => Effect.promise(() => state.raw.storage.put("session", value)),
          schedule: (at) => Effect.promise(() => state.raw.storage.setAlarm(at)),
        },
        run: (input, current, select) => runtime.run(sandbox, input, current, select),
        post: runtime.post,
      })
      return {
        receive: session.receive,
        alarm: () =>
          session.alarm.pipe(
            Effect.catchCause((cause) => Effect.logError("Slack session alarm failed", cause)),
          ),
      }
    })
  }),
)
