import { JanitorApi } from "@janitor/domain/Api"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"

const notYet = Effect.die("Chat sessions in the web app are not built yet (EFF-3021)")

/**
 * The chat sessions page, a session's transcript and delete, and the kill
 * switch (EFF-3021). Every endpoint dies until "Chat sessions in the web
 * app" builds them.
 */
export const ChatGroupLayer = HttpApiBuilder.group(JanitorApi, "chat", (handlers) =>
  handlers
    .handle("listSessions", () => notYet)
    .handle("getTranscript", () => notYet)
    .handle("deleteSession", () => notYet)
    .handle("getKillSwitch", () => notYet)
    .handle("setKillSwitch", () => notYet),
)
