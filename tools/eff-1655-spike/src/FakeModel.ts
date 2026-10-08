import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"

/**
 * A scripted LanguageModel so the loop runs deterministically without model
 * credentials. Each call emits one `execute` tool call; the step index is the
 * number of tool results already in the prompt.
 */
export const scriptedModel = (scripts: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const languageModel = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: (options) => {
        // A delegate (subagent) prompt carries the "You have been asked" preamble;
        // answer it by completing immediately so the parent's script continues.
        const isSubagent = options.prompt.content.some(
          (m) => m.role === "user" && JSON.stringify(m.content).includes("You have been asked using the"),
        )
        const step = options.prompt.content.filter((m) => m.role === "tool").length
        const script = isSubagent ? 'await taskComplete("subagent reporting in")' : scripts[Math.min(step, scripts.length - 1)]!
        return Stream.fromIterable([
          { type: "tool-call" as const, id: `call-${step}`, name: "execute", params: { script } },
        ] as any)
      },
    })
    return Layer.mergeAll(
      Layer.succeed(LanguageModel.LanguageModel, languageModel),
      Layer.succeed(Model.ProviderName, "spike"),
      Layer.succeed(Model.ModelName, "scripted"),
    )
  })
