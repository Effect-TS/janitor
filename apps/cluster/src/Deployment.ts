import { ALCHEMY_DEV } from "alchemy"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Redacted from "effect/Redacted"
import { SourceError } from "effect/ConfigProvider"

export const deployment = Effect.gen(function* () {
  if (yield* ALCHEMY_DEV) return { stage: "local" as const, domain: "localhost", retain: false }
  const stage = yield* Config.schema(Schema.Literal("production"), "JANITOR_STAGE")
  return { stage, domain: "janitor.effectful.co", retain: true }
})

export const requiredText = (name: string) =>
  Config.schema(Schema.String.check(Schema.isPattern(/^(?!CHANGE_ME$)\S+$/)), name)

export const requiredSecret = (name: string) =>
  Config.Redacted(name).pipe(
    Config.mapEffect((secret) =>
      /^(?!CHANGE_ME$)\S+$/.test(Redacted.value(secret))
        ? Effect.succeed(secret)
        : Effect.fail(
            new Config.ConfigError(
              new SourceError({
                message: `${name} requires a nonempty secret, not the example placeholder`,
              }),
            ),
          ),
    ),
  )
