// The model side of a turn as the coordinator sees it: run one accepted input
// to a terminal outcome, deliver notes about restored workspaces or skipped
// requests, and cancel queued work. The OpenCode host implements this; tests
// script outcomes.
import { Context, Data, Layer } from "effect"
import type * as Effect from "effect/Effect"
import type { InputAttribution } from "../Protocol.ts"

export class HostError extends Data.TaggedError("HostError")<{
  readonly message: string
}> {}

export interface TurnRequest {
  readonly inputId: string
  readonly attempt: number
  readonly text: string
  readonly attribution: InputAttribution
  /** Context the model must see before the input: restored workspace, skipped requests. */
  readonly notes: ReadonlyArray<string>
  /** Inputs whose queued native messages must be cancelled before this turn runs. */
  readonly cancel: ReadonlyArray<string>
  /** Called as each assistant text block lands, in order; synchronous so it can be recorded durably. */
  readonly message: (ordinal: number, text: string) => void
}

export type TurnOutcome =
  | { readonly type: "completed"; readonly text: string }
  | { readonly type: "interrupted"; readonly reason: string }
  | { readonly type: "failed"; readonly reason: string }

export class TurnHost extends Context.Service<
  TurnHost,
  {
    /**
     * Runs the input to a terminal outcome. Interrupting the effect stops the
     * model turn and the sandbox processes it started; the outcome then reports
     * the interruption.
     */
    readonly run: (turn: TurnRequest) => Effect.Effect<TurnOutcome, HostError>
    /** Releases the native runtime; the next run constructs a fresh one. */
    readonly dispose: Effect.Effect<void>
  }
>()("janitor/runner/TurnHost") {
  static layer(service: TurnHost["Service"]) {
    return Layer.succeed(this, service)
  }
}

export class TurnScheduler extends Context.Service<
  TurnScheduler,
  {
    /** Arranges for the coordinator to drive its queue after the delay. */
    readonly wake: (delayMs: number) => Effect.Effect<void>
  }
>()("janitor/runner/TurnScheduler") {
  static layer(service: TurnScheduler["Service"]) {
    return Layer.succeed(this, service)
  }
}
