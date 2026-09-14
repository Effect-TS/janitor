import { assert, describe, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import {
  agentRunnerConnection,
  deployment,
  requiredSecret,
  requiredText,
} from "../src/Deployment.ts"
import * as Redacted from "effect/Redacted"
import { aiCacheTtlConfig } from "../src/Labeling/Classifier.ts"

const config = (values: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(values))
describe("deployment configuration", () => {
  it.effect(
    "connects production to the stack-owned runner and rejects missing service secrets",
    () =>
      Effect.gen(function* () {
        const values = {
          ALCHEMY_DEV: "false",
          JANITOR_STAGE: "production",
          JANITOR_AGENT_RUNNER_URL: "https://obsolete-runner.example",
          JANITOR_AGENT_RUNNER_TOKEN: "runner-token",
          REPOSITORY_SERVICE_TOKEN: "repository-token",
          JANITOR_MAINTENANCE_TOKEN: "maintenance-token",
        }
        const connection = yield* agentRunnerConnection.pipe(Effect.provide(config(values)))
        assert.strictEqual(connection.url, "https://runner.janitor.effectful.co")
        assert.strictEqual(Redacted.value(connection.token), "runner-token")
        assert.strictEqual(Redacted.value(connection.repositoryToken), "repository-token")
        assert.strictEqual(Redacted.value(connection.maintenanceToken), "maintenance-token")
        for (const key of ["JANITOR_AGENT_RUNNER_TOKEN", "REPOSITORY_SERVICE_TOKEN"]) {
          const missing: Record<string, string> = { ...values }
          delete missing[key]
          assert.strictEqual(
            (yield* Effect.flip(agentRunnerConnection.pipe(Effect.provide(config(missing)))))._tag,
            "ConfigError",
          )
        }
        for (const value of ["", "CHANGE_ME", "with spaces"]) {
          assert.strictEqual(
            (yield* Effect.flip(
              requiredSecret("JANITOR_AGENT_RUNNER_MODEL_API_KEY").pipe(
                Effect.provide(config({ JANITOR_AGENT_RUNNER_MODEL_API_KEY: value })),
              ),
            ))._tag,
            "ConfigError",
          )
        }
      }),
  )
  it.effect("keeps local development optional and permits a local runner connection", () =>
    Effect.gen(function* () {
      const empty = yield* agentRunnerConnection.pipe(
        Effect.provide(config({ ALCHEMY_DEV: "true" })),
      )
      assert.strictEqual(empty.url, "")
      assert.strictEqual(Redacted.value(empty.token), "")
      const local = yield* agentRunnerConnection.pipe(
        Effect.provide(
          config({
            ALCHEMY_DEV: "true",
            JANITOR_AGENT_RUNNER_URL: "http://127.0.0.1:8788",
            JANITOR_AGENT_RUNNER_TOKEN: "local-token",
          }),
        ),
      )
      assert.strictEqual(local.url, "http://127.0.0.1:8788")
      assert.strictEqual(Redacted.value(local.token), "local-token")
    }),
  )
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
      const secretError = yield* Effect.flip(
        requiredSecret("JANITOR_AGENT_RUNNER_MODEL_API_KEY").pipe(
          Effect.provide(config({ JANITOR_AGENT_RUNNER_MODEL_API_KEY: "private-key with-space" })),
        ),
      )
      assert.notInclude(String(secretError), "private-key")
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
