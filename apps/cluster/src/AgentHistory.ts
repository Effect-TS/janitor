import * as Prompt from "effect/ai/Prompt"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * An agent's history messages as Durable Object SQLite rows, one message a
 * row, for PR review's run storage and the chat session's.
 */

const MessageJson = Schema.fromJsonString(Prompt.Message)

/**
 * The longest history row, in UTF-8 bytes: Durable Object SQLite caps a row
 * at 2 MB, and this leaves room for the row's other columns.
 */
export const MAX_MESSAGE_BYTES = 2_000_000 - 4_096

export const OMITTED = "[image omitted, re-read the file if needed]"

const bytes = (text: string) => new TextEncoder().encode(text).length

const omittedText = Prompt.makePart("text", { text: OMITTED })

const omittedResult = (part: Prompt.ToolResultPart) =>
  Prompt.makePart("tool-result", {
    id: part.id,
    name: part.name,
    isFailure: part.isFailure,
    providerExecuted: part.providerExecuted,
    result: OMITTED,
    options: part.options,
  })

/** Files and tool results become the placeholder; the message keeps its role and tool call ids. */
const withoutAttachments = (message: Prompt.Message): Prompt.Message => {
  switch (message.role) {
    case "system":
      return message
    case "user":
      return Prompt.makeMessage("user", {
        content: message.content.map((part) => (part.type === "file" ? omittedText : part)),
        options: message.options,
      })
    case "assistant":
      return Prompt.makeMessage("assistant", {
        content: message.content.map((part) =>
          part.type === "file"
            ? omittedText
            : part.type === "tool-result"
              ? omittedResult(part)
              : part,
        ),
        options: message.options,
      })
    case "tool":
      return Prompt.makeMessage("tool", {
        content: message.content.map((part) =>
          part.type === "tool-result" ? omittedResult(part) : part,
        ),
        options: message.options,
      })
  }
}

/**
 * Every part's content becomes the placeholder, for a message still over the
 * cap. Tool calls keep their ids, so their results still pair up.
 */
const placeholderOnly = (message: Prompt.Message): Prompt.Message => {
  switch (message.role) {
    case "system":
    case "tool":
      return withoutAttachments(message)
    case "user":
      return Prompt.makeMessage("user", { content: [omittedText], options: message.options })
    case "assistant":
      return Prompt.makeMessage("assistant", {
        content: message.content.map((part) => {
          switch (part.type) {
            case "tool-call":
              return Prompt.makePart("tool-call", {
                id: part.id,
                name: part.name,
                params: {},
                providerExecuted: part.providerExecuted,
                options: part.options,
              })
            case "tool-result":
              return omittedResult(part)
            case "tool-approval-request":
              return part
            default:
              return omittedText
          }
        }),
        options: message.options,
      })
  }
}

/**
 * Encodes one history message as a row. A message over the row cap is stored
 * as the placeholder; the live loop keeps the original.
 */
export const encodeMessage = Effect.fnUntraced(function* (message: Prompt.Message) {
  const encode = Schema.encodeEffect(MessageJson)
  const json = yield* encode(message)
  if (bytes(json) <= MAX_MESSAGE_BYTES) return json
  const omitted = yield* encode(withoutAttachments(message))
  if (bytes(omitted) <= MAX_MESSAGE_BYTES) return omitted
  return yield* encode(placeholderOnly(message))
})

/** Decodes a history row. */
export const decodeMessage = Schema.decodeEffect(MessageJson)
