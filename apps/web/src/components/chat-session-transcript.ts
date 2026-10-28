import { SessionTranscript } from "@janitor/domain/Chat/Session"
import * as Schema from "effect/Schema"
import { defineMessageUnion } from "foldkit/message"
import * as Submodel from "foldkit/submodel"
import type * as Update from "foldkit/update"
import type { ApiClient } from "@/lib/api-client"

/**
 * One chat session's transcript (EFF-3021): the thread's messages with their
 * gate outcomes, and each turn with its steps, tokens and model. Everything
 * in it comes from the thread or the model, so all of it is shown as plain
 * text; nothing is rendered as HTML or Markdown. A stub until "Chat sessions
 * in the web app" builds it.
 */

export const Model = Schema.Struct({
  sessionId: Schema.String,
  active: Schema.Boolean,
  transcript: Schema.NullOr(SessionTranscript),
  /** The session expired or was deleted. */
  expired: Schema.Boolean,
  loading: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  /** Fences responses from an earlier session or activation. */
  generation: Schema.Int,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  Activated: { sessionId: Schema.String, active: Schema.Boolean },
  Loaded: { generation: Schema.Int, transcript: SessionTranscript },
  Expired: { generation: Schema.Int },
  Failed: { generation: Schema.Int, reason: Schema.String },
})
export type Message = typeof Message.Type

export const init = (): Model => ({
  sessionId: "",
  active: false,
  transcript: null,
  expired: false,
  loading: false,
  error: null,
  generation: 0,
})

type Return = Update.Return<Model, Message, ApiClient>

export const update = (model: Model, _message: Message): Return => ({ model })

export const view = Submodel.defineView<Model, Message>((_model, h) => h.div([], []))
