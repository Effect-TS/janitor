import { JanitorApi } from "@janitor/domain/Api"
import { TranscriptGone } from "@janitor/domain/Chat/Session"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { chatSessionRetention } from "../Chat/Config.ts"
import { ChatKillSwitchStore } from "../Chat/KillSwitch.ts"
import { ChatSessionControl } from "../Chat/Session.ts"
import { ChatSessionIndex } from "../Chat/SessionIndex.ts"

/**
 * The chat sessions page, a session's transcript and delete, and the kill
 * switch (EFF-3021). While the chat bot is off, a session can't be read or
 * deleted. Infrastructure failures die: the index, the kill switch and a
 * session entity that can't be reached. A transcript is never logged.
 */
export const ChatGroupLayer = HttpApiBuilder.group(JanitorApi, "chat", (handlers) =>
  handlers
    .handle("listSessions", () =>
      Effect.gen(function* () {
        const index = yield* ChatSessionIndex
        // A row whose session has expired is pruned here, should the session
        // have failed to remove it.
        const retention = yield* chatSessionRetention
        yield* index.removeBefore(DateTime.subtractDuration(yield* DateTime.now, retention))
        return { sessions: yield* index.list }
      }).pipe(Effect.orDie),
    )
    .handle("getTranscript", ({ params }) =>
      Effect.gen(function* () {
        const { sessionId } = params
        // Listed first, so an id no session has never wakes an entity.
        const session = yield* ChatSessionIndex.use((index) => index.get(sessionId)).pipe(
          Effect.orDie,
        )
        if (Option.isNone(session)) return yield* new TranscriptGone({ sessionId })
        const committed = yield* ChatSessionControl.use((control) => control.transcript(sessionId))
        if (Option.isNone(committed)) return yield* new TranscriptGone({ sessionId })
        return { session: session.value, ...committed.value }
      }),
    )
    .handle("deleteSession", ({ params }) =>
      Effect.gen(function* () {
        const { sessionId } = params
        yield* ChatSessionControl.use((control) => control.delete(sessionId))
        // The session removes its row too; this one fails the request if the
        // row stays, so the page never shows a deleted session as kept.
        yield* ChatSessionIndex.use((index) => index.remove(sessionId)).pipe(Effect.orDie)
        yield* Effect.logInfo("Chat session deleted from the web app")
      }).pipe(Effect.annotateLogs({ sessionId: params.sessionId })),
    )
    .handle("getKillSwitch", () => ChatKillSwitchStore.use((store) => store.get).pipe(Effect.orDie))
    .handle("setKillSwitch", ({ payload }) =>
      Effect.gen(function* () {
        const store = yield* ChatKillSwitchStore
        yield* store.set(payload)
        yield* Effect.logInfo("Chat kill switch set").pipe(
          Effect.annotateLogs({ switch: payload.switch, on: payload.on }),
        )
        return yield* store.get
      }).pipe(Effect.orDie),
    ),
)
