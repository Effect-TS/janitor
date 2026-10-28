import type * as Agent from "clanka/Agent"
import type * as AgentOutput from "clanka/AgentOutput"
import type * as AiError from "effect/ai/AiError"
import * as LanguageModel from "effect/ai/LanguageModel"
import type * as Prompt from "effect/ai/Prompt"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import type * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import { RpcClientError } from "effect/rpc/RpcClientError"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"

/**
 * What PR review's and the chat bot's clanka loops share: the commit
 * boundary between a loop's history and the entity that stores it, the
 * handle an entity drives a running loop with, and how a loop's exit reads.
 * Each agent still owns its model, tools, prompts and what a step commits.
 */

/**
 * How a step changed the loop's history: messages added to the end, or the
 * whole history replaced, as compaction does. Either may include the system
 * message, which no entity stores.
 */
export type HistoryChange =
  | { readonly _tag: "Appended"; readonly messages: ReadonlyArray<Prompt.Message> }
  | { readonly _tag: "Replaced"; readonly messages: ReadonlyArray<Prompt.Message> }

/**
 * The commit boundary of one loop. clanka doesn't wait for its history
 * events, so the model calls do: a step the entity hasn't committed never
 * has a next step, and a resume continues from the last committed step.
 */
export interface CommitBoundary {
  /** Commits a change through the entity, then counts it as committed. */
  readonly commit: (change: HistoryChange) => Effect.Effect<void>
  /** The model behind the boundary: each call first waits for the agent's history to be committed. */
  readonly model: (
    agent: Agent.Agent,
  ) => Effect.Effect<LanguageModel.LanguageModel, never, LanguageModel.LanguageModel>
}

export const makeCommitBoundary = (options: {
  /** The history the entity holds at start, without the system message. */
  readonly history: ReadonlyArray<Prompt.Message>
  readonly onStep: (change: HistoryChange) => Effect.Effect<void>
}): CommitBoundary => {
  let committed = options.history
  let commitDone = Deferred.makeUnsafe<void>()

  const commit = (change: HistoryChange) =>
    Effect.suspend(() => options.onStep(change)).pipe(
      Effect.andThen(
        Effect.sync(() => {
          committed =
            change._tag === "Appended" ? [...committed, ...change.messages] : change.messages
          const done = commitDone
          commitDone = Deferred.makeUnsafe<void>()
          Deferred.doneUnsafe(done, Effect.void)
        }),
      ),
    )

  /** Waits until every change to the agent's history is committed. */
  const caughtUp = (agent: Agent.Agent) =>
    Effect.suspend(function wait(): Effect.Effect<void> {
      // Compared by content: a compaction can keep the length, and clanka's
      // events carry copies of its history's messages.
      const current = agent.history.current.content.filter((message) => message.role !== "system")
      return current.length === committed.length &&
        current.every((message, index) => Equal.equals(message, committed[index]))
        ? Effect.void
        : Effect.andThen(Deferred.await(commitDone), Effect.suspend(wait))
    })

  /** clanka only streams, for its steps and compaction alike. */
  const model = (agent: Agent.Agent) =>
    Effect.gen(function* () {
      const ai = yield* LanguageModel.LanguageModel
      // The method is generic over the toolkit; this only adds the wait.
      const streamText = (options: Parameters<typeof ai.streamText>[0]) =>
        Stream.unwrap(Effect.as(caughtUp(agent), ai.streamText(options)))
      return LanguageModel.LanguageModel.of({
        ...ai,
        streamText: streamText as typeof ai.streamText,
      })
    })

  return { commit, model }
}

/** A running loop, as its entity drives it; `End` is how the entity reads its end. */
export interface LoopHandle<End> {
  /** Sends the agent a message between its steps; it lands with the next model call. */
  readonly steer: (message: string) => Effect.Effect<void>
  /** Stops the loop; `result` then ends as interrupted. */
  readonly interrupt: Effect.Effect<void>
  /** Waits for the loop to end. */
  readonly result: Effect.Effect<End>
}

/**
 * Runs `loop` in a fiber of the current scope and hands back its handle.
 * The loop completes `ready` with its agent once it has one, so steers can
 * reach it; `onExit` reads how the loop's fiber ended.
 */
export const startLoop = <E, End>(options: {
  readonly loop: (ready: Deferred.Deferred<Agent.Agent>) => Effect.Effect<void, E>
  readonly onExit: (exit: Exit.Exit<void, E>) => Effect.Effect<End>
  /** What `result` ends with after `interrupt`. */
  readonly interrupted: End
}): Effect.Effect<LoopHandle<End>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<Agent.Agent>()
    const ended = yield* Deferred.make<End>()
    const fiber = yield* Effect.forkScoped(
      Effect.flatMap(Effect.exit(options.loop(ready)), (exit) =>
        Effect.flatMap(options.onExit(exit), (end) => Deferred.succeed(ended, end)),
      ),
    )
    const scope = yield* Effect.scope
    return {
      // Delivered between steps; the entity's timers don't wait for it.
      steer: (message) =>
        Effect.asVoid(
          Effect.forkIn(
            Effect.flatMap(Deferred.await(ready), (agent) => agent.steer(message)),
            scope,
          ),
        ),
      interrupt: Effect.asVoid(
        Effect.andThen(Fiber.interrupt(fiber), Deferred.succeed(ended, options.interrupted)),
      ),
      result: Deferred.await(ended),
    }
  })

/** A defect from the executor's transport: its container or the connection to it is gone. */
export const isSandboxLoss = (cause: Cause.Cause<unknown>) =>
  cause.reasons.some(
    (reason) => Cause.isDieReason(reason) && Schema.is(RpcClientError)(reason.defect),
  )

/** How a loop's fiber ended, as `loopExit` reads its exit. */
export type LoopExit =
  /** The agent finished, with its final summary or reply. */
  | { readonly _tag: "Finished"; readonly summary: string }
  /** The loop ended without the agent finishing. */
  | { readonly _tag: "Incomplete" }
  /** The provider failed, by error category and HTTP status; never with a body. */
  | {
      readonly _tag: "ProviderFailed"
      readonly category: string
      readonly status: number | undefined
    }
  /** The executor's transport or its container went away. */
  | { readonly _tag: "SandboxLost" }
  | { readonly _tag: "Interrupted" }
  /** The loop died on something else, by the defect's kind. */
  | { readonly _tag: "Crashed"; readonly defect: string }

export const loopExit = (
  exit: Exit.Exit<void, AgentOutput.AgentFinished | AgentOutput.RetriesExhausted | AiError.AiError>,
): LoopExit => {
  if (exit._tag === "Success") return { _tag: "Incomplete" }
  const error = Cause.findErrorOption(exit.cause)
  if (Option.isSome(error)) {
    const failure = error.value
    if (failure._tag === "AgentFinished") return { _tag: "Finished", summary: failure.summary }
    const reason = failure._tag === "RetriesExhausted" ? failure.error.reason : failure.reason
    return {
      _tag: "ProviderFailed",
      category: reason._tag,
      status: "http" in reason ? reason.http?.response?.status : undefined,
    }
  }
  if (isSandboxLoss(exit.cause)) return { _tag: "SandboxLost" }
  if (Cause.hasInterruptsOnly(exit.cause)) return { _tag: "Interrupted" }
  const defect = Cause.squash(exit.cause)
  return { _tag: "Crashed", defect: defect instanceof Error ? defect.name : typeof defect }
}
