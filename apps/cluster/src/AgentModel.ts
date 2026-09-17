import * as OpenAiClient from "@effect/ai-openai-compat/OpenAiClient"
import * as OpenAiLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import type * as LanguageModel from "effect/unstable/ai/LanguageModel"

/**
 * The deployment's agent model: the OpenRouter chat configuration agent
 * sessions and issue review share, independent of the labeling model. It is
 * absent until the API key is configured; each consumer chooses its own
 * completion budget.
 */
export const agentModel: Effect.Effect<
  Option.Option<
    (options: { readonly maxCompletionTokens: number }) => Layer.Layer<LanguageModel.LanguageModel>
  >,
  Config.ConfigError
> = Effect.gen(function* () {
  const key = yield* Config.Redacted("JANITOR_AGENT_RUNNER_MODEL_API_KEY").pipe(
    Config.withDefault(Redacted.make("")),
  )
  const model = yield* Config.String("JANITOR_CHAT_MODEL").pipe(
    Config.withDefault("z-ai/glm-5.3-flash"),
  )
  if (Redacted.value(key) === "") return Option.none()
  return Option.some(({ maxCompletionTokens }: { readonly maxCompletionTokens: number }) =>
    OpenAiLanguageModel.layer({
      model,
      config: { max_completion_tokens: maxCompletionTokens },
    }).pipe(
      Layer.provide(OpenAiClient.layer({ apiKey: key, apiUrl: "https://openrouter.ai/api/v1" })),
      Layer.provide(FetchHttpClient.layer),
    ),
  )
})
