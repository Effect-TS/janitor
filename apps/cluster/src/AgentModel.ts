import * as OpenAiClient from "@effect/ai-openai-compat/OpenAiClient"
import * as OpenAiLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Redacted from "effect/Redacted"
import * as Stream from "effect/Stream"
import type { ReasoningEffort } from "./PullRequestReview/Config.ts"
import {
  type TailnetEgressNamespace,
  tailnetFetch,
} from "./PullRequestReview/TailnetEgress/TailnetEgressClient.ts"

/**
 * An agent's model through an OpenAI-compatible chat completions endpoint
 * (EFF-1929), as PR review's and the chat bot's settings describe one.
 */

export type ModelLayer = Layer.Layer<
  LanguageModel.LanguageModel | Model.ProviderName | Model.ModelName
>

/** The endpoint and model one agent's settings name. */
export interface OpenAiCompatibleModel {
  /** The endpoint's base URL. */
  readonly apiUrl: Option.Option<string>
  readonly apiKey: Option.Option<Redacted.Redacted<string>>
  readonly model: string
  readonly reasoningEffort: ReasoningEffort
  /** Request priority processing when enabled for this agent. */
  readonly serviceTier?: "priority"
  /** Reach the endpoint through the tailnet egress container instead of the open internet. */
  readonly viaTailnet: boolean
}

/**
 * The fetch client with each request's `fetch` pinned to the tailnet egress
 * DO, as `WorkspaceClient` pins the executor's. Providing `FetchHttpClient.Fetch`
 * to the layer instead isn't enough: the Worker shares `FetchHttpClient.layer`
 * across its layers, so its client is built once with the global fetch.
 */
const tailnetHttpClient = (egress: TailnetEgressNamespace): Layer.Layer<HttpClient.HttpClient> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(
      HttpClient.HttpClient,
      HttpClient.transform((effect) =>
        Effect.provideService(effect, FetchHttpClient.Fetch, tailnetFetch(egress)),
      ),
    ),
  ).pipe(Layer.provide(FetchHttpClient.layer))

/**
 * The model with its own HTTP client: the executor's is pinned to the
 * sandbox. With `viaTailnet` its requests go through the tailnet egress DO.
 */
export const openAiCompatibleModel = (
  settings: OpenAiCompatibleModel,
  egress: TailnetEgressNamespace,
): ModelLayer =>
  OpenAiLanguageModel.model(settings.model, {
    reasoning_effort: settings.reasoningEffort,
    service_tier: settings.serviceTier,
  }).pipe(
    Layer.provide(
      OpenAiClient.layer({
        apiUrl: Option.getOrUndefined(settings.apiUrl),
        apiKey: Option.getOrUndefined(settings.apiKey),
      }),
    ),
    Layer.provide(settings.viaTailnet ? tailnetHttpClient(egress) : FetchHttpClient.layer),
  )

/**
 * A model for settings that didn't parse: every call dies with `error`,
 * and records show `name` as the model. Nothing else the Worker runs fails.
 */
export const invalidModel = (error: unknown, name: string): ModelLayer =>
  Layer.mergeAll(
    Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: () => Effect.die(error),
        streamText: () => Stream.die(error),
      }),
    ),
    Layer.succeed(Model.ProviderName, "openai"),
    Layer.succeed(Model.ModelName, name),
  )
