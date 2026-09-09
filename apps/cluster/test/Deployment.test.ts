import { assert, describe, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import { deployment, requiredText } from "../src/Deployment.ts"
import { aiCacheTtlConfig } from "../src/Labeling/Classifier.ts"

const config = (values: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(values))
describe("deployment configuration", () => {
  it.effect("defaults the AI cache to 24 hours and validates whole positive seconds", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* aiCacheTtlConfig.pipe(Effect.provide(config({}))), 86400)
      assert.strictEqual(
        yield* aiCacheTtlConfig.pipe(
          Effect.provide(config({ LABELING_AI_CACHE_TTL_SECONDS: "60" })),
        ),
        60,
      )
      for (const value of ["0", "-1", "1.5", "forever", "Infinity", "2147483648"]) {
        assert.strictEqual(
          (yield* Effect.flip(
            aiCacheTtlConfig.pipe(Effect.provide(config({ LABELING_AI_CACHE_TTL_SECONDS: value }))),
          ))._tag,
          "ConfigError",
        )
      }
    }),
  )
  it.effect("requires an identity provider ID rather than the example placeholder", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* requiredText("CLOUDFLARE_ACCESS_GITHUB_IDP_ID").pipe(
          Effect.provide(
            config({ CLOUDFLARE_ACCESS_GITHUB_IDP_ID: "01234567-89ab-cdef-0123-456789abcdef" }),
          ),
        ),
        "01234567-89ab-cdef-0123-456789abcdef",
      )
      assert.strictEqual(
        (yield* Effect.flip(
          requiredText("CLOUDFLARE_ACCESS_GITHUB_IDP_ID").pipe(
            Effect.provide(config({ CLOUDFLARE_ACCESS_GITHUB_IDP_ID: "CHANGE_ME" })),
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
