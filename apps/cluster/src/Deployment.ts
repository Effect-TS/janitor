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

/** Production's runner is stack-owned; only local development accepts an external URL. */
export const agentRunnerConnection = Effect.gen(function* () {
  const target = yield* deployment
  return {
    url:
      target.stage === "local"
        ? yield* Config.String("JANITOR_AGENT_RUNNER_URL").pipe(
            Config.withDefault("http://localhost:8790"),
          )
        : `https://runner.${target.domain}`,
    token: yield* target.stage === "local"
      ? Config.Redacted("JANITOR_AGENT_RUNNER_TOKEN").pipe(
          Config.withDefault(Redacted.make("janitor-local-runner")),
        )
      : requiredSecret("JANITOR_AGENT_RUNNER_TOKEN"),
    repositoryToken: yield* target.stage === "local"
      ? Config.Redacted("REPOSITORY_SERVICE_TOKEN").pipe(
          Config.withDefault(Redacted.make("janitor-local-repository")),
        )
      : requiredSecret("REPOSITORY_SERVICE_TOKEN"),
  }
})
