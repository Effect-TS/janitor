import { Context, Effect, Layer } from "effect"
import { ProtocolError } from "../Protocol.ts"
import { errorResponse, jsonResponse, parseCommand, type Command } from "../Router.ts"

interface Commands {
  readonly execute: (command: Command) => Promise<unknown>
  readonly alarm: Effect.Effect<void, unknown>
  readonly journal: (kind: string, data: Record<string, unknown>) => void
}

/** Owns request decoding, protocol failures and command timing at the native HTTP boundary. */
export class SessionCommands extends Context.Service<
  SessionCommands,
  {
    readonly handle: (request: Request) => Effect.Effect<Response>
    readonly alarm: Effect.Effect<void, unknown>
  }
>()("janitor/runner/SessionCommands") {
  static make(commands: Commands): SessionCommands["Service"] {
    return {
      handle: Effect.fn("SessionCommands.handle")((request) =>
        Effect.gen(function* () {
          const command = yield* Effect.tryPromise({
            try: () => parseCommand(request),
            catch: (cause) => cause,
          })
          const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
          const mutates = command.kind !== "inspect" && command.kind !== "events"
          if (mutates) commands.journal("command-received", { command: command.kind })
          return yield* Effect.tryPromise({
            try: () => commands.execute(command),
            catch: (cause) => cause,
          }).pipe(
            Effect.map(jsonResponse),
            Effect.ensuring(
              Effect.gen(function* () {
                const finished = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
                if (mutates)
                  commands.journal("command-finished", {
                    command: command.kind,
                    durationMs: finished - started,
                  })
              }),
            ),
          )
        }).pipe(
          Effect.catch((cause) =>
            Effect.sync(() => {
              if (!(cause instanceof ProtocolError))
                commands.journal("command-failed", { error: String(cause) })
              return errorResponse(cause)
            }),
          ),
        ),
      ),
      alarm: commands.alarm,
    }
  }
  static layer(commands: Commands) {
    return Layer.sync(this, () => this.make(commands))
  }
}
