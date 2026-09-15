// The Slack shape of an interrupted turn: the message text and the Retry/Skip
// buttons that carry the exact input and attempt they apply to.
import * as Schema from "effect/Schema"

export const INTERRUPTION_ACTION_PREFIX = "janitor_turn"

/** What a Retry or Skip button carries; the runner deduplicates on the click identity. */
export const InterruptionActions = Schema.Struct({
  sessionId: Schema.String,
  generation: Schema.Int,
  inputId: Schema.String,
  attempt: Schema.Int,
})
export type InterruptionActions = typeof InterruptionActions.Type

export const ButtonValue = Schema.fromJsonString(InterruptionActions)

export const interruptionBlocks = (text: string, actions: InterruptionActions) => {
  const value = JSON.stringify(actions)
  return [
    { type: "section", text: { type: "plain_text", text, emoji: false } },
    {
      type: "actions",
      block_id: `${INTERRUPTION_ACTION_PREFIX}:${actions.inputId}:${actions.attempt}`,
      elements: [
        {
          type: "button",
          action_id: `${INTERRUPTION_ACTION_PREFIX}_retry`,
          text: { type: "plain_text", text: "Retry", emoji: false },
          style: "primary",
          value,
        },
        {
          type: "button",
          action_id: `${INTERRUPTION_ACTION_PREFIX}_skip`,
          text: { type: "plain_text", text: "Skip", emoji: false },
          value,
        },
      ],
    },
  ]
}
