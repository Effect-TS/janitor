import * as Schema from "effect/Schema"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import { KillSwitchState, SessionList, SessionTranscript, TranscriptGone } from "../Chat/Session.ts"

const params = { sessionId: Schema.String }

/** The chat sessions page, a session's transcript and delete, and the kill switch (EFF-3021). */
export class ChatGroup extends HttpApiGroup.make("chat")
  .add(HttpApiEndpoint.get("listSessions", "/chat/sessions", { success: SessionList }))
  .add(
    HttpApiEndpoint.get("getTranscript", "/chat/sessions/:sessionId/transcript", {
      params,
      success: SessionTranscript,
      error: TranscriptGone,
    }),
  )
  .add(HttpApiEndpoint.delete("deleteSession", "/chat/sessions/:sessionId", { params }))
  .add(HttpApiEndpoint.get("getKillSwitch", "/chat/kill-switch", { success: KillSwitchState }))
  .add(
    HttpApiEndpoint.put("setKillSwitch", "/chat/kill-switch", {
      payload: KillSwitchState,
      success: KillSwitchState,
    }),
  ) {}
