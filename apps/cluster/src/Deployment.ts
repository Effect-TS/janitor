import { ALCHEMY_DEV } from "alchemy"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export const deployment = Effect.gen(function* () {
  if (yield* ALCHEMY_DEV) return { stage: "local" as const, domain: "localhost", retain: false }
  const stage = yield* Config.schema(Schema.Literal("production"), "JANITOR_STAGE")
  return { stage, domain: "janitor.effectful.co", retain: true }
})

export const requiredText = (name: string) =>
  Config.schema(Schema.String.check(Schema.isPattern(/^(?!CHANGE_ME$)\S+$/)), name)
