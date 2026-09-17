import type { Sandbox } from "@janitor/alchemy/AI/Sandbox"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import { Repositories } from "./Repositories.ts"
import { runAgentTurn } from "./AgentTurn.ts"
import { Sandbox as SandboxTag } from "@janitor/alchemy/AI/Sandbox"
import type { Selection, SessionInput, SessionState } from "./Session.ts"
import { SlackTransport } from "./Transport.ts"
import { TurnEvents } from "./TurnEvents.ts"
import { makeTurnPresentation } from "./TurnPresentation.ts"

export class SessionRuntime extends Context.Service<
  SessionRuntime,
  {
    readonly run: (
      sandbox: Sandbox["Service"],
      input: SessionInput,
      state: SessionState,
      select: (repository: Selection) => Effect.Effect<void>,
    ) => Effect.Effect<{ readonly history: string; readonly text: string }, string>
    readonly post: (input: SessionInput, text: string) => Effect.Effect<void, string>
  }
>()("Slack/SessionRuntime") {}

export const makeSessionRuntime = Effect.gen(function* () {
  const environment = yield* Effect.context<Repositories | LanguageModel.LanguageModel>()
  const slack = yield* SlackTransport
  return SessionRuntime.of({
    run: Effect.fnUntraced(function* (sandbox, input, state, select) {
      const presentation = yield* makeTurnPresentation(input).pipe(
        Effect.provideService(SlackTransport, slack),
      )
      const heartbeat = yield* Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep("3 seconds")
          yield* presentation.refresh
        }
      }).pipe(Effect.forkScoped)
      return yield* runAgentTurn(input, state, select).pipe(
        Effect.provideService(TurnEvents, presentation),
        Effect.provideService(SandboxTag, sandbox),
        Effect.provide(environment),
        Effect.onExit((exit) =>
          Fiber.interrupt(heartbeat).pipe(
            Effect.andThen(presentation.finish(exit._tag === "Success" ? "Finished" : "Stopped")),
          ),
        ),
      )
    }, Effect.scoped),
    post: Effect.fnUntraced(function* (input, text) {
      // Slack text limit is 40,000; smaller chunks are easier to read and avoid truncation.
      const chunks = text.match(/[\s\S]{1,3500}/gu) ?? ["I couldn't produce an answer."]
      for (const [index, chunk] of chunks.entries()) {
        if (index > 0) yield* Effect.sleep("1 second")
        yield* slack
          .post(input.channel, input.thread, chunk, `chat:${input.timestamp}:${index}`)
          .pipe(Effect.mapError((error) => error.message))
      }
    }),
  })
})
