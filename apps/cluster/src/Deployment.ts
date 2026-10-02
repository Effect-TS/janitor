import { ALCHEMY_DEV } from "alchemy"
import { Stage } from "alchemy/Stage"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Redacted from "effect/Redacted"
import { SourceError } from "effect/ConfigProvider"

// Alchemy provides the stage while planning and binds ALCHEMY_STAGE into
// every Worker it deploys, so the runtime reads the same value.
const alchemyStage = Effect.gen(function* () {
  const planned = yield* Effect.serviceOption(Stage)
  return Option.isSome(planned) ? planned.value : yield* Config.String("ALCHEMY_STAGE")
})

export const deployment = Effect.gen(function* () {
  if (yield* ALCHEMY_DEV) return { stage: "local" as const, domain: "localhost", retain: false }
  const stage = yield* alchemyStage
  if (stage !== "production")
    return yield* Effect.fail(
      new Config.ConfigError(
        new SourceError({ message: `Janitor deploys only the production stage, not "${stage}"` }),
      ),
    )
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
