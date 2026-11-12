import { assert, describe, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import { chatModelConfig } from "../../src/Chat/Config.ts"

describe("Chat model configuration", () => {
  it.effect("defaults to gpt-6-astra with medium reasoning effort", () =>
    Effect.gen(function* () {
      const config = yield* chatModelConfig.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      )
      assert.deepInclude(config, {
        model: "openai/gpt-6-astra",
        reasoningEffort: "medium",
      })
    }),
  )
})
