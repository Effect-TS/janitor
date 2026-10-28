import { JanitorApi } from "@janitor/domain/Api"
import { TranscriptGone } from "@janitor/domain/Chat/Session"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
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
      ChatSessionIndex.use((index) => index.list).pipe(
        Effect.map((sessions) => ({ sessions })),
        Effect.orDie,
      ),
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
      // The session removes its own index row as it deletes, in order with
      // its messages, so a session a later message starts keeps its row.
      ChatSessionControl.use((control) => control.delete(params.sessionId)).pipe(
        Effect.andThen(Effect.logInfo("Chat session deleted from the web app")),
        Effect.annotateLogs({ sessionId: params.sessionId }),
      ),
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
