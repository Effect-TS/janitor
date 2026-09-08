import { assert, describe, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import { deployment, requiredText } from "../src/Deployment.ts"

const config = (values: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(values))
describe("deployment configuration", () => {
  it.effect("requires an identity provider ID rather than the example placeholder", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* requiredText("ACCESS_GITHUB_IDP_ID").pipe(
          Effect.provide(config({ ACCESS_GITHUB_IDP_ID: "01234567-89ab-cdef-0123-456789abcdef" })),
        ),
        "01234567-89ab-cdef-0123-456789abcdef",
      )
      assert.strictEqual(
        (yield* Effect.flip(
          requiredText("ACCESS_GITHUB_IDP_ID").pipe(
            Effect.provide(config({ ACCESS_GITHUB_IDP_ID: "CHANGE_ME" })),
          ),
        ))._tag,
        "ConfigError",
      )
    }),
  )
  it.effect("allows only production remotely and preserves local development", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* deployment.pipe(
          Effect.provide(config({ ALCHEMY_DEV: "false", JANITOR_STAGE: "production" })),
        ),
        { stage: "production", domain: "janitor.effectful.co", retain: true },
      )
      assert.strictEqual(
        (yield* Effect.flip(
          deployment.pipe(
            Effect.provide(config({ ALCHEMY_DEV: "false", JANITOR_STAGE: "staging" })),
          ),
        ))._tag,
        "ConfigError",
      )
      assert.strictEqual(
        (yield* deployment.pipe(Effect.provide(config({ ALCHEMY_DEV: "true" })))).stage,
        "local",
      )
      assert.strictEqual(
        (yield* Effect.flip(
          deployment.pipe(Effect.provide(config({ JANITOR_STAGE: "cluster-spike" }))),
        ))._tag,
        "ConfigError",
      )
    }),
  )
})
