import { assert, describe, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Providers } from "alchemy/Cloudflare"
import { collection } from "alchemy/Provider"
import { declare } from "../../src/Ingress/Access.ts"

const config = (values: Record<string, string>) =>
  Layer.merge(
    ConfigProvider.layer(ConfigProvider.fromUnknown(values)),
    Layer.effect(Providers, collection([])),
  )

describe("Access provisioning", () => {
  it.effect("does not require deployment credentials during Worker initialization", () =>
    Effect.gen(function* () {
      const result = yield* declare({
        dev: false,
        domain: "janitor.effectful.co",
        stage: "production",
      }).pipe(Effect.provide(config({ ALCHEMY_PHASE: "runtime" })))
      assert.strictEqual(result, undefined)
    }),
  )

  it.effect("still requires the identity provider when planning a deployment", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        declare({ dev: false, domain: "janitor.effectful.co", stage: "production" }).pipe(
          Effect.provide(config({ ALCHEMY_PHASE: "plan" })),
        ),
      )
      assert.strictEqual(error._tag, "ConfigError")
    }),
  )
})
