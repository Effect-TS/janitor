import * as OpenRouterClient from "@effect/ai-openrouter/OpenRouterClient"
import * as OpenRouterDecisionModel from "@effect/ai-openrouter/OpenRouterDecisionModel"
import * as AiError from "effect/ai/AiError"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import type { ChatMessage } from "./Platform.ts"

/**
 * The reply gate (EFF-2959): whether a thread message that doesn't mention
 * the bot is addressed to it. Jev answers one probability question about the
 * last 20 thread messages, each tagged with its author's class.
 */

/** Thread messages the gate reads, the new one included. */
export const GATE_CONTEXT = 20

/** Characters of each message's text the gate reads. */
const TEXT_CAP = 500

/** A gate call that takes longer fails, and the message starts nothing. */
const GATE_TIMEOUT = "30 seconds"

const decision = Decision.make({
  input: Schema.Json,
  decisions: {
    addressed: Decision.probability({
      instructions:
        "This is a team chat thread with a bot called janitor. Is the newest message addressed to janitor, or does it ask janitor to answer or act?",
      criteria: {
        true: "The newest message is for janitor: it asks janitor something or asks it to do something.",
        false: "The newest message is for other people, or needs no answer from janitor.",
      },
    }),
  },
})

export class ReplyGateError extends Data.TaggedError("ReplyGateError")<{
  readonly cause: unknown
}> {}

const tagged = (message: ChatMessage) => ({
  author: message.author.name,
  class: message.author.class,
  text: message.text.length > TEXT_CAP ? `${message.text.slice(0, TEXT_CAP)}…` : message.text,
})

export class ReplyGate extends Context.Service<
  ReplyGate,
  {
    /**
     * The probability that the last of `thread` is addressed to the bot.
     * `thread` is the thread's latest messages, oldest first.
     */
    readonly decide: (thread: ReadonlyArray<ChatMessage>) => Effect.Effect<number, ReplyGateError>
  }
>()("@janitor/cluster/Chat/Gate/ReplyGate") {
  /** The gate over its own decision model: Jev on OpenRouter in the Worker. */
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const model = yield* DecisionModel.DecisionModel
      return {
        decide: (thread) => {
          const recent = thread.slice(-GATE_CONTEXT)
          return model
            .decide(decision, {
              input: {
                earlier: recent.slice(0, -1).map(tagged),
                newest: tagged(recent.at(-1)!),
              },
            })
            .pipe(
              Effect.timeout(GATE_TIMEOUT),
              Effect.map((response) => response.answers.addressed.probability),
              Effect.mapError((cause) => new ReplyGateError({ cause })),
            )
        },
      }
    }),
  )

  /**
   * The gate's decision model in the Worker: `model` on OpenRouter with
   * labeling's `OPENROUTER_API_KEY`. Without the key every gate call fails,
   * and a message that doesn't mention the bot starts nothing.
   */
  static readonly decisionModel = (options: {
    readonly apiKey: Option.Option<Redacted.Redacted<string>>
    readonly model: string
  }): Layer.Layer<DecisionModel.DecisionModel> =>
    Option.match(options.apiKey, {
      onNone: () =>
        Layer.effect(
          DecisionModel.DecisionModel,
          DecisionModel.make({
            decide: () =>
              Effect.fail(
                AiError.make({
                  module: "ChatGate",
                  method: "decide",
                  reason: new AiError.UnknownError({
                    description: "OPENROUTER_API_KEY is not set",
                  }),
                }),
              ),
          }),
        ),
      onSome: (apiKey) =>
        OpenRouterDecisionModel.layer({ model: options.model }).pipe(
          Layer.provide(OpenRouterClient.layer({ apiKey })),
          Layer.provide(FetchHttpClient.layer),
        ),
    })
}
