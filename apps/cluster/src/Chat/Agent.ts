import * as OpenAiClient from "@effect/ai-openai-compat/OpenAiClient"
import * as OpenAiLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel"
import * as Agent from "clanka/Agent"
import type * as AgentExecutor from "clanka/AgentExecutor"
import type * as AgentOutput from "clanka/AgentOutput"
import type * as AiError from "effect/ai/AiError"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import * as Prompt from "effect/ai/Prompt"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import type * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as MutableRef from "effect/MutableRef"
import * as Option from "effect/Option"
import * as References from "effect/References"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type { HistoryChange } from "../PullRequestReview/Agent.ts"
import { isSandboxLoss, tailnetHttpClient } from "../PullRequestReview/ReviewAgent.ts"
import type { TailnetEgressNamespace } from "../PullRequestReview/TailnetEgress/TailnetEgressClient.ts"
import { chatModelConfig } from "./Config.ts"

/**
 * The chat bot's agent (EFF-3018): clanka's `Agent.makeWith` in the Worker,
 * with conversation mode on, so a plain reply ends the turn. The session
 * entity owns the turn: its history, deadline, resumes and steering. This
 * module owns the model, the commit boundary and how a loop's exit reads.
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
  /** Commits a history change. The loop waits for it before its next model call. */
  readonly onStep: (history: HistoryChange) => Effect.Effect<void>
  readonly onProgress: (progress: ChatProgress) => Effect.Effect<void>
}

export interface ChatLoop {
  /** Sends the agent a message between its steps; it lands with the next model call. */
  readonly steer: (message: string) => Effect.Effect<void>
  /** Stops the loop; `result` then ends as `Interrupted`. */
  readonly interrupt: Effect.Effect<void>
  readonly result: Effect.Effect<ChatLoopEnd>
}

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
  if (exit._tag === "Success")
    return Effect.as(Effect.logWarning("The chat loop ended without a reply"), {
      _tag: "Failed",
      category: "incomplete",
    })
  const error = Cause.findErrorOption(exit.cause)
  if (Option.isSome(error)) {
    const failure = error.value
    if (failure._tag === "AgentFinished")
      return Effect.succeed({ _tag: "Replied", text: failure.summary })
    const reason = failure._tag === "RetriesExhausted" ? failure.error.reason : failure.reason
    const status = "http" in reason ? reason.http?.response?.status : undefined
    return Effect.as(
      Effect.logWarning("The chat model failed").pipe(
        Effect.annotateLogs({
          errorCategory: reason._tag,
          ...(status === undefined ? {} : { status }),
        }),
      ),
      { _tag: "Failed", category: reason._tag },
    )
  }
  if (isSandboxLoss(exit.cause)) return Effect.succeed({ _tag: "SandboxLost" })
  if (Cause.hasInterruptsOnly(exit.cause)) return Effect.succeed({ _tag: "Interrupted" })
  const defect = Cause.squash(exit.cause)
  const kind = defect instanceof Error ? defect.name : typeof defect
  return Effect.as(
    Effect.logError("The chat loop failed").pipe(Effect.annotateLogs({ defect: kind })),
    { _tag: "Failed", category: "loop_failed" },
  )
}

const make = Effect.gen(function* () {
  const model = yield* Effect.context<
    LanguageModel.LanguageModel | Model.ProviderName | Model.ModelName
  >()
  const subagentModel = yield* Effect.serviceOption(Agent.SubagentModel)

  const start = Effect.fnUntraced(function* (options: ChatTurnStart) {
    const ready = yield* Deferred.make<Agent.Agent>()
    const ended = yield* Deferred.make<ChatLoopEnd>()

    /** The history the session holds, and a signal for each commit. */
    let committed: ReadonlyArray<Prompt.Message> = options.history
    let commitDone = Deferred.makeUnsafe<void>()

    const commit = (history: HistoryChange) =>
      Effect.andThen(
        options.onStep(history),
        Effect.sync(() => {
          committed =
            history._tag === "Appended" ? [...committed, ...history.messages] : history.messages
          const done = commitDone
          commitDone = Deferred.makeUnsafe<void>()
          Deferred.doneUnsafe(done, Effect.void)
        }),
      )

    /**
     * Waits until every change to the loop's history is committed, so a step
     * the session hasn't committed never has a next step (as `ReviewAgent`).
     */
    const caughtUp = (agent: Agent.Agent) =>
      Effect.suspend(function wait(): Effect.Effect<void> {
        const current = agent.history.current.content.filter((message) => message.role !== "system")
        return current.length === committed.length &&
          current.every((message, index) => Equal.equals(message, committed[index]))
          ? Effect.void
          : Effect.andThen(Deferred.await(commitDone), Effect.suspend(wait))
      })

    const committedModel = (agent: Agent.Agent) =>
      Effect.gen(function* () {
        const ai = yield* LanguageModel.LanguageModel
        const streamText = (options: Parameters<typeof ai.streamText>[0]) =>
          Stream.unwrap(Effect.as(caughtUp(agent), ai.streamText(options)))
        return LanguageModel.LanguageModel.of({
          ...ai,
          streamText: streamText as typeof ai.streamText,
        })
      })

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
          return commit({ _tag: "Appended", messages: part.messages })
        case "HistoryReplaced":
          return commit({ _tag: "Replaced", messages: part.messages })
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

    const loop = Effect.gen(function* () {
      const agent = yield* Agent.makeWith({ instructions: Option.some(options.instructions) })
      if (options.history.length > 0)
        MutableRef.set(agent.history, Prompt.fromMessages(options.history))
      yield* Deferred.succeed(ready, agent)
      const output = yield* agent
        .send({ prompt: options.prompt })
        .pipe(Effect.provideServiceEffect(LanguageModel.LanguageModel, committedModel(agent)))
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
    )

    const fiber = yield* Effect.forkScoped(
      Effect.flatMap(Effect.exit(loop), (exit) =>
        Effect.flatMap(loopEnd(exit), (end) => Deferred.succeed(ended, end)),
      ),
    )
    const scope = yield* Effect.scope

    return {
      // Delivered between steps; the session's timers don't wait for it.
      steer: (message: string) =>
        Effect.asVoid(
          Effect.forkIn(
            Effect.flatMap(Deferred.await(ready), (agent) => agent.steer(message)),
            scope,
          ),
        ),
      interrupt: Effect.andThen(
        Fiber.interrupt(fiber),
        Deferred.succeed(ended, { _tag: "Interrupted" }),
      ).pipe(Effect.asVoid),
      result: Deferred.await(ended),
    } satisfies ChatLoop
  })

  return ChatAgent.of({ model: yield* Model.ModelName, start })
})

/** The chat agent on clanka, over the model it is given. */
export const ChatAgentLayer: Layer.Layer<
  ChatAgent,
  never,
  LanguageModel.LanguageModel | Model.ProviderName | Model.ModelName
> = Layer.effect(ChatAgent, make)

const openAiModel = (
  config: Effect.Success<typeof chatModelConfig>,
  model: string,
  egress: TailnetEgressNamespace,
) =>
  OpenAiLanguageModel.model(model, { reasoning_effort: config.reasoningEffort }).pipe(
    Layer.provide(
      OpenAiClient.layer({
        apiUrl: Option.getOrUndefined(config.apiUrl),
        apiKey: Option.getOrUndefined(config.apiKey),
      }),
    ),
    Layer.provide(config.viaTailnet ? tailnetHttpClient(egress) : FetchHttpClient.layer),
  )

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
        const invalid = Layer.mergeAll(
          Layer.effect(
            LanguageModel.LanguageModel,
            LanguageModel.make({
              generateText: () => Effect.die(error),
              streamText: () => Stream.die(error),
            }),
          ),
          Layer.succeed(Model.ProviderName, "openai"),
          Layer.succeed(Model.ModelName, "invalid chat settings"),
        )
        return Layer.merge(invalid, Agent.layerSubagentModel(invalid))
      },
      onSuccess: (config) =>
        Layer.merge(
          openAiModel(config, config.model, egress),
          Agent.layerSubagentModel(
            openAiModel(
              config,
              Option.getOrElse(config.subagentModel, () => config.model),
              egress,
            ),
          ),
        ),
    }),
  )
