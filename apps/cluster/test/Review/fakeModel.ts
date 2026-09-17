import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as AiError from "effect/unstable/ai/AiError"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import type * as Prompt from "effect/unstable/ai/Prompt"
import type * as Response from "effect/unstable/ai/Response"

/**
 * A scripted language model: each call takes the next turn of the script
 * and records the prompt it received. A turn is either the parts the model
 * answers with or a provider failure, so tests can drive tool use, the
 * `finish` call, rate limiting and outages without an HTTP provider.
 */

export type Turn =
  | { readonly _tag: "Answer"; readonly text?: string; readonly calls?: ReadonlyArray<Call> }
  | { readonly _tag: "RateLimited"; readonly retryAfterSeconds: number }
  | { readonly _tag: "Unavailable" }
  /** Holds the call until the gate opens, then answers with `then`. */
  | { readonly _tag: "Wait"; readonly until: Deferred.Deferred<void>; readonly then: Turn }

export interface Call {
  readonly name: string
  readonly params: unknown
}

let calls = 0

export class FakeModel {
  readonly turns: Array<Turn> = []
  readonly prompts: Array<Prompt.Prompt> = []
  /** The tool names offered on each call. */
  readonly tools: Array<ReadonlyArray<string>> = []

  /** Queues turns to answer with, in order. */
  script(...turns: ReadonlyArray<Turn>) {
    this.turns.push(...turns)
    return this
  }

  reset() {
    this.turns.length = 0
    this.prompts.length = 0
    this.tools.length = 0
  }

  get layer() {
    const self = this
    return Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: (options) =>
          Effect.gen(function* () {
            self.prompts.push(options.prompt)
            self.tools.push(options.tools.map((tool) => tool.name))
            let turn = self.turns.shift()
            if (turn === undefined)
              return yield* Effect.die(new Error("The fake model has no scripted turn left"))
            while (turn._tag === "Wait") {
              yield* Deferred.await(turn.until)
              turn = turn.then
            }
            if (turn._tag === "RateLimited")
              return yield* new AiError.AiError({
                module: "FakeModel",
                method: "generateText",
                reason: new AiError.RateLimitError({
                  retryAfter: Duration.seconds(turn.retryAfterSeconds),
                }),
              })
            if (turn._tag === "Unavailable")
              return yield* new AiError.AiError({
                module: "FakeModel",
                method: "generateText",
                reason: new AiError.AuthenticationError({ kind: "InvalidKey" }),
              })
            const parts: Array<Response.PartEncoded> = []
            if (turn.text !== undefined) parts.push({ type: "text", text: turn.text })
            for (const call of turn.calls ?? [])
              parts.push({
                type: "tool-call",
                id: `call-${++calls}`,
                name: call.name,
                params: call.params,
              })
            parts.push({
              type: "finish",
              reason: (turn.calls?.length ?? 0) > 0 ? "tool-calls" : "stop",
              usage: { inputTokens: {}, outputTokens: {} },
            })
            return parts
          }),
        streamText: () => Stream.empty,
      }),
    )
  }
}

/** The text of every user message in a prompt, for assertions on what the model saw. */
export const userText = (prompt: Prompt.Prompt): string =>
  prompt.content
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    )
    .join("\n")
