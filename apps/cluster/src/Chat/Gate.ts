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
 * the bot needs the bot to answer or act. Jev answers one probability
 * question about the last 20 thread messages, each tagged with its author's
 * class, and two signals read off the thread's structure (EFF-3137): whether
 * the newest message comes straight after janitor's reply to its author, and
 * how many people have spoken.
 */

/** Thread messages the gate reads, the new one included. */
export const GATE_CONTEXT = 20

/** The gate passes a message at this probability or above. */
export const GATE_PASS = 0.5

/** Characters of each message's text the gate reads. */
const TEXT_CAP = 500

/** A gate call that takes longer fails, and the message starts nothing. */
const GATE_TIMEOUT = "30 seconds"

const decision = Decision.make({
  input: Schema.Json,
  decisions: {
    addressed: Decision.probability({
      instructions:
        "This is a team chat thread with a bot called janitor. Does the newest message need janitor to answer or act? followsBotReplyTo means the newest message comes straight after janitor's reply to its author. humansInThread is how many people have spoken in the thread.",
      criteria: {
        true: "The newest message asks janitor something, tells it to do something, or answers a question janitor asked, including approving what janitor proposed.",
        false:
          "The newest message is for other people, or needs nothing from janitor: it only acknowledges janitor (thanks, good bot) or turns down what janitor proposed (no thanks, leave it as is).",
      },
    }),
  },
})

/** The structural signals the gate passes to Jev next to the transcript. */
export interface GateSignals {
  /** The newest message comes straight after janitor's reply to its author. */
  readonly followsBotReplyTo: boolean
  /** How many admitted people have spoken in the window. */
  readonly humansInThread: number
}

/**
 * Reads the signals off the gate's window, `thread` oldest first with the
 * message being gated last. Janitor's replies carry `answers`; a backfilled
 * copy of one doesn't, and reads as nobody's reply.
 */
export const gateSignals = (thread: ReadonlyArray<ChatMessage>): GateSignals => {
  const newest = thread.at(-1)
  const previous = thread.at(-2)
  return {
    followsBotReplyTo:
      newest !== undefined &&
      previous !== undefined &&
      previous.author.class === "bot" &&
      previous.answers !== undefined &&
      previous.answers === newest.author.id,
    humansInThread: new Set(
      thread.filter((message) => message.author.class === "admitted").map((m) => m.author.id),
    ).size,
  }
}

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
                ...gateSignals(recent),
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
