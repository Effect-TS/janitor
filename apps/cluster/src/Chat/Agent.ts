import * as Agent from "clanka/Agent"
import type * as AgentExecutor from "clanka/AgentExecutor"
import type * as AgentOutput from "clanka/AgentOutput"
import type * as AiError from "effect/ai/AiError"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import * as Prompt from "effect/ai/Prompt"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as MutableRef from "effect/MutableRef"
import * as Option from "effect/Option"
import * as References from "effect/References"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import {
  type HistoryChange,
  type LoopHandle,
  loopExit,
  makeCommitBoundary,
  startLoop,
} from "../AgentLoop.ts"
import { invalidModel, openAiCompatibleModel } from "../AgentModel.ts"
import type { TailnetEgressNamespace } from "../PullRequestReview/TailnetEgress/TailnetEgressClient.ts"
import { chatModelConfig } from "./Config.ts"

/**
 * The chat bot's agent (EFF-3018): clanka's `Agent.makeWith` in the Worker,
 * with conversation mode on, so a plain reply ends the turn. The session
 * entity owns the turn: its history, deadline, resumes and steering. This
 * module owns the model, what a loop reports as it runs and how its exit
 * reads; the commit boundary is PR review's (`AgentLoop`).
 */

/** Model calls retried in a row before the turn ends with a provider failure. */
const MAX_RETRIES = 3

/** A turn's cumulative token usage, sub-agents included. */
export interface ChatUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** What a running loop has done so far, for the status message and the turn's record. */
export interface ChatProgress {
  /** Scripts started, sub-agents' included. */
  readonly actions: number
  /** Null until the model reports any. */
  readonly usage: ChatUsage | null
  /** The first line of the model's latest text, if it wrote any. */
  readonly note: string | null
}

/**
 * How a loop ended. `SandboxLost` means the executor's transport or its
 * container went away: the turn re-acquires a sandbox and resumes.
 */
export type ChatLoopEnd =
  | { readonly _tag: "Replied"; readonly text: string }
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "Failed"; readonly category: string }
  | { readonly _tag: "SandboxLost" }

export interface ChatTurnStart {
  readonly instructions: string
  readonly executor: Layer.Layer<AgentExecutor.AgentExecutor>
  /** The session's history so far, without the system message. */
  readonly history: ReadonlyArray<Prompt.Message>
  readonly prompt: string
  /** Images sent with the prompt, as image input. */
  readonly images: ReadonlyArray<ChatImage>
  /** Commits a history change. The loop waits for it before its next model call. */
  readonly onStep: (history: HistoryChange) => Effect.Effect<void>
  readonly onProgress: (progress: ChatProgress) => Effect.Effect<void>
}

/** An attached image the model sees with the prompt. */
export interface ChatImage {
  readonly name: string
  readonly mediaType: string
  readonly data: Uint8Array
}

/** The prompt as one user message: its text, then its images. */
const promptWith = (text: string, images: ReadonlyArray<ChatImage>): Prompt.RawInput =>
  images.length === 0
    ? text
    : Prompt.fromMessages([
        Prompt.makeMessage("user", {
          content: [
            Prompt.makePart("text", { text }),
            ...images.map((image) =>
              Prompt.makePart("file", {
                mediaType: image.mediaType,
                fileName: image.name,
                data: image.data,
              }),
            ),
          ],
        }),
      ])

export type ChatLoop = LoopHandle<ChatLoopEnd>

export class ChatAgent extends Context.Service<
  ChatAgent,
  {
    /** The model's name, as each turn records it. */
    readonly model: string
    /** Starts a loop that runs until it ends or `scope` closes. */
    readonly start: (options: ChatTurnStart) => Effect.Effect<ChatLoop, never, Scope.Scope>
  }
>()("@janitor/cluster/Chat/Agent/ChatAgent") {}

const NOTE_CAP = 120

/** The first line of the last text an assistant message holds. */
const noteOf = (messages: ReadonlyArray<Prompt.Message>): string | null => {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue
    for (const part of [...message.content].reverse()) {
      if (part.type !== "text") continue
      const line = part.text.trim().split("\n")[0]?.trim() ?? ""
      if (line !== "") return line.length > NOTE_CAP ? `${line.slice(0, NOTE_CAP)}…` : line
    }
  }
  return null
}

const sumUsage = (usages: ReadonlyArray<AgentOutput.Usage>): ChatUsage | null =>
  usages.length === 0
    ? null
    : {
        inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
        outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
        cacheRead: usages.reduce((sum, usage) => sum + usage.cacheRead, 0),
        cacheWrite: usages.reduce((sum, usage) => sum + usage.cacheWrite, 0),
      }

/** How a loop's exit ends it. Provider failures are logged by category and HTTP status only. */
const loopEnd = (
  exit: Exit.Exit<void, AgentOutput.AgentFinished | AgentOutput.RetriesExhausted | AiError.AiError>,
): Effect.Effect<ChatLoopEnd> => {
  const end = loopExit(exit)
  switch (end._tag) {
    case "Finished":
      return Effect.succeed({ _tag: "Replied", text: end.summary })
    case "Incomplete":
      return Effect.as(Effect.logWarning("The chat loop ended without a reply"), {
        _tag: "Failed",
        category: "incomplete",
      })
    case "ProviderFailed":
      return Effect.as(
        Effect.logWarning("The chat model failed").pipe(
          Effect.annotateLogs({
            errorCategory: end.category,
            ...(end.status === undefined ? {} : { status: end.status }),
          }),
        ),
        { _tag: "Failed", category: end.category },
      )
    case "SandboxLost":
    case "Interrupted":
      return Effect.succeed(end)
    case "Crashed":
      return Effect.as(
        Effect.logError("The chat loop failed").pipe(Effect.annotateLogs({ defect: end.defect })),
        { _tag: "Failed", category: "loop_failed" },
      )
  }
}

const make = Effect.gen(function* () {
  const model = yield* Effect.context<
    LanguageModel.LanguageModel | Model.ProviderName | Model.ModelName
  >()
  const subagentModel = yield* Effect.serviceOption(Agent.SubagentModel)

  const start = Effect.fnUntraced(function* (options: ChatTurnStart) {
    const boundary = makeCommitBoundary({ history: options.history, onStep: options.onStep })

    let actions = 0
    let note: string | null = null
    /** Each agent's latest cumulative usage: the root's under -1, sub-agents' by id. */
    const usage = new Map<number, AgentOutput.Usage>()
    const progress = Effect.suspend(() =>
      options.onProgress({ actions, usage: sumUsage([...usage.values()]), note }),
    )

    const onPart = (part: AgentOutput.Output): Effect.Effect<void> => {
      switch (part._tag) {
        case "HistoryAppended":
          note = noteOf(part.messages) ?? note
          return boundary.commit({ _tag: "Appended", messages: part.messages })
        case "HistoryReplaced":
          return boundary.commit({ _tag: "Replaced", messages: part.messages })
        case "ScriptStart":
          actions += 1
          return progress
        case "Usage":
          usage.set(-1, part)
          return progress
        case "SubagentPart":
          if (part.part._tag === "ScriptStart") actions += 1
          else if (part.part._tag === "Usage") usage.set(part.id, part.part)
          else return Effect.void
          return progress
        default:
          return Effect.void
      }
    }

    return yield* startLoop({
      loop: (ready) =>
        Effect.gen(function* () {
          const agent = yield* Agent.makeWith({ instructions: Option.some(options.instructions) })
          if (options.history.length > 0)
            MutableRef.set(agent.history, Prompt.fromMessages(options.history))
          yield* Deferred.succeed(ready, agent)
          const output = yield* agent
            .send({ prompt: promptWith(options.prompt, options.images) })
            .pipe(Effect.provideServiceEffect(LanguageModel.LanguageModel, boundary.model(agent)))
          yield* Stream.runForEach(output, onPart)
        }).pipe(
          Effect.scoped,
          Effect.provide(options.executor),
          Effect.provideContext(model),
          Option.isSome(subagentModel)
            ? Effect.provideService(Agent.SubagentModel, subagentModel.value)
            : (effect) => effect,
          Effect.provideService(Agent.ConversationMode, true),
          Effect.provideService(Agent.MaxRetries, MAX_RETRIES),
          // clanka's compaction warning logs the raw provider error, body included.
          Effect.provideService(References.MinimumLogLevel, "Error"),
        ),
      onExit: loopEnd,
      interrupted: { _tag: "Interrupted" },
    })
  })

  return ChatAgent.of({ model: yield* Model.ModelName, start })
})

/** The chat agent on clanka, over the model it is given. */
export const ChatAgentLayer: Layer.Layer<
  ChatAgent,
  never,
  LanguageModel.LanguageModel | Model.ProviderName | Model.ModelName
> = Layer.effect(ChatAgent, make)

/**
 * The `CHAT_AI_*` model through an OpenAI-compatible endpoint, as PR review's
 * `ReviewModelLayer`, with sub-agents on `CHAT_AI_SUBAGENT_MODEL` when it is
 * set. Invalid chat settings fail the model's calls.
 */
export const ChatModelLayer = (
  egress: TailnetEgressNamespace,
): Layer.Layer<
  LanguageModel.LanguageModel | Model.ProviderName | Model.ModelName | Agent.SubagentModel
> =>
  Layer.unwrap(
    Effect.match(chatModelConfig, {
      onFailure: (error) => {
        const invalid = invalidModel(error, "invalid chat settings")
        return Layer.merge(invalid, Agent.layerSubagentModel(invalid))
      },
      onSuccess: (config) => {
        const settings = { ...config, serviceTier: "priority" as const }
        return Layer.merge(
          openAiCompatibleModel(settings, egress),
          Agent.layerSubagentModel(
            openAiCompatibleModel(
              { ...settings, model: Option.getOrElse(config.subagentModel, () => config.model) },
              egress,
            ),
          ),
        )
      },
    }),
  )
