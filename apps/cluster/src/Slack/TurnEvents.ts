import * as Context from "effect/Context"
import * as Effect from "effect/Effect"

/** Execution observations, adapted from Alchemy AI.Events. Presentation owns Slack writes. */
export type TurnEvent =
  | { readonly type: "commentary"; readonly text: string }
  | { readonly type: "tool-call"; readonly id: string; readonly name: string }
  | { readonly type: "tool-result"; readonly id: string }

export const TurnEvents = Context.Reference<{
  readonly emit: (event: TurnEvent) => Effect.Effect<void>
}>("Slack/TurnEvents", { defaultValue: () => ({ emit: () => Effect.void }) })
