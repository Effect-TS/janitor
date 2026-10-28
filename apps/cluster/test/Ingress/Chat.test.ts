import { assert, layer } from "@effect/vitest"
import * as Prompt from "effect/ai/Prompt"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  type SessionSummary,
  SessionTranscript,
  type SessionTranscriptTurn,
  TranscriptGone,
  type TranscriptMessage,
} from "@janitor/domain/Chat/Session"
import { ChatKillSwitchStore } from "../../src/Chat/KillSwitch.ts"
import { ChatSessionControl } from "../../src/Chat/Session.ts"
import { ChatSessionIndex } from "../../src/Chat/SessionIndex.ts"
import { ChatGroupLayer } from "../../src/Ingress/Chat.ts"
import { makeClient } from "../support/Api.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"

/**
 * The chat sessions API (EFF-3021) over the Postgres session index and kill
 * switch, with the session entities faked. Every test is marked `.fails`
 * until "Chat sessions in the web app" lands (EFF-3021).
 */

interface Committed {
  readonly messages: ReadonlyArray<TranscriptMessage>
  readonly turns: ReadonlyArray<SessionTranscriptTurn>
}

/** What each session's entity answers; one not listed is never asked. */
const transcripts = new Map<string, Option.Option<Committed>>()
/** The sessions sent `Delete`, in order. */
const deleted: Array<string> = []
const control = ChatSessionControl.of({
  transcript: (sessionId) => {
    const found = transcripts.get(sessionId)
    return found === undefined
      ? Effect.die(new Error(`Unexpected transcript read for ${sessionId}`))
      : Effect.succeed(found)
  },
  delete: (sessionId) => Effect.sync(() => deleted.push(sessionId)),
})

const client = Effect.gen(function* () {
  const services = yield* Effect.context<ChatSessionIndex | ChatKillSwitchStore>()
  return yield* makeClient(
    ["chat"],
    ChatGroupLayer,
    services.pipe(Context.add(ChatSessionControl, control)),
  )
})

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 28, 9, minute))

const summary = (threadTs: string, minute: number): SessionSummary => ({
  sessionId: `slack/T1/C1/${threadTs}`,
  thread: { _tag: "Slack", team: "T1", channel: "C1", threadTs },
  startedBy: { id: "U-ada", name: "ada" },
  turns: 2,
  status: "replied",
  lastActivityAt: at(minute),
  usage: { inputTokens: 1200, outputTokens: 300, cacheRead: 800, cacheWrite: 0 },
})

const text = (text: string) => Prompt.makePart("text", { text })

const committed: Committed = {
  messages: [
    {
      id: "1761642000.000100",
      author: { id: "U-ada", name: "ada", class: "admitted" },
      text: "what changed in effect today?",
      mentionsBot: true,
      sentAt: at(1),
      attachments: [],
      gate: { _tag: "Mention" },
    },
    {
      id: "1761642060.000200",
      author: { id: "U-guest", name: "guest", class: "outsider" },
      text: "following",
      mentionsBot: false,
      sentAt: at(2),
      attachments: [],
      gate: { _tag: "Context" },
    },
  ],
  turns: [
    {
      turnId: "turn-1",
      status: "replied",
      errorCategory: null,
      resumes: 1,
      wrappedUp: true,
      model: "openai/gpt-6.1-sol",
      actions: 1,
      usage: { inputTokens: 1200, outputTokens: 300, cacheRead: 800, cacheWrite: 0 },
      queuedAt: at(1),
      startedAt: at(3),
      finishedAt: at(9),
      messages: [
        Prompt.makeMessage("assistant", {
          content: [
            Prompt.makePart("tool-call", {
              id: "call-1",
              name: "execute",
              params: { script: "gh pr list -R Effect-TS/effect" },
              providerExecuted: false,
            }),
          ],
        }),
        Prompt.makeMessage("tool", {
          content: [
            Prompt.makePart("tool-result", {
              id: "call-1",
              name: "execute",
              isFailure: false,
              result: "#6001 Fix Stream.merge",
              providerExecuted: false,
            }),
          ],
        }),
        Prompt.makeMessage("assistant", { content: [text("One pull request merged.")] }),
      ],
    },
  ],
}

const encodeTranscript = Schema.encodeSync(Schema.toCodecJson(SessionTranscript))

const Services = Layer.mergeAll(ChatSessionIndex.layer, ChatKillSwitchStore.layer).pipe(
  Layer.provideMerge(MigratedPostgresLayer),
)

layer(Services, { timeout: "2 minutes" })("ChatGroup", (it) => {
  it.effect.fails("lists the sessions, latest activity first", () =>
    Effect.gen(function* () {
      const api = yield* client
      const index = yield* ChatSessionIndex
      const older = summary("1761640000.000100", 5)
      const newer = summary("1761640000.000200", 20)
      const waiting: SessionSummary = {
        sessionId: "discord/G1/900",
        thread: { _tag: "Discord", guild: "G1", threadId: "900" },
        startedBy: { id: "77", name: "grace" },
        turns: 0,
        status: null,
        lastActivityAt: at(10),
        usage: null,
      }
      for (const session of [older, newer, waiting]) yield* index.save(session)
      // A later save replaces the session's row.
      const running: SessionSummary = {
        ...older,
        turns: 3,
        status: "running",
        lastActivityAt: at(30),
      }
      yield* index.save(running)

      const ids = new Set([older.sessionId, newer.sessionId, waiting.sessionId])
      const { sessions } = yield* api.chat.listSessions()
      assert.deepStrictEqual(
        sessions.filter((session) => ids.has(session.sessionId)),
        [running, newer, waiting],
      )
    }),
  )

  it.effect.fails("serves a session's transcript, which Download JSON saves as it is", () =>
    Effect.gen(function* () {
      const api = yield* client
      const session = summary("1761641000.000100", 9)
      yield* (yield* ChatSessionIndex).save(session)
      transcripts.set(session.sessionId, Option.some(committed))

      const body = yield* api.chat.getTranscript({ params: { sessionId: session.sessionId } })
      assert.deepStrictEqual(encodeTranscript(body), encodeTranscript({ session, ...committed }))
    }),
  )

  it.effect.fails("a session that expired, was deleted or never existed is gone", () =>
    Effect.gen(function* () {
      const api = yield* client
      const expired = summary("1761641000.000200", 9)
      yield* (yield* ChatSessionIndex).save(expired)
      // Its row is still listed, but its entity's storage is already gone.
      transcripts.set(expired.sessionId, Option.none())
      // Not in the index, so its entity is never asked.
      const unknown = "slack/T1/C1/1761641000.000300"

      for (const sessionId of [expired.sessionId, unknown])
        assert.deepStrictEqual(
          yield* api.chat.getTranscript({ params: { sessionId } }).pipe(Effect.flip),
          new TranscriptGone({ sessionId }),
        )
    }),
  )

  it.effect.fails("deleting a session sends its entity Delete", () =>
    Effect.gen(function* () {
      const api = yield* client
      const session = summary("1761642000.000100", 9)
      yield* (yield* ChatSessionIndex).save(session)
      deleted.length = 0

      yield* api.chat.deleteSession({ params: { sessionId: session.sessionId } })
      assert.deepStrictEqual(deleted, [session.sessionId])
    }),
  )

  it.effect.fails("the kill switch is off until someone turns it on, and stays as set", () =>
    Effect.gen(function* () {
      const api = yield* client
      const off = { global: false, slack: false, discord: false }
      assert.deepStrictEqual(yield* api.chat.getKillSwitch(), off)

      const slackOff = { global: false, slack: true, discord: false }
      assert.deepStrictEqual(yield* api.chat.setKillSwitch({ payload: slackOff }), slackOff)
      // Stored, not held by the handler: another client reads it back.
      assert.deepStrictEqual(yield* (yield* client).chat.getKillSwitch(), slackOff)

      const everywhere = { global: true, slack: false, discord: false }
      yield* api.chat.setKillSwitch({ payload: everywhere })
      assert.deepStrictEqual(yield* api.chat.getKillSwitch(), everywhere)
    }),
  )
})
