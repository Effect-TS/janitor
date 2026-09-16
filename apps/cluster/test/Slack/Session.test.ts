import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { expect, test } from "vite-plus/test"
import {
  makeSession,
  type SessionInput,
  type SessionState,
  type SessionStore,
} from "../../src/Slack/Session.ts"

const input: SessionInput = {
  workspace: "T1",
  channel: "C1",
  thread: "1.0",
  timestamp: "1.0",
  user: "U1",
  text: "Help me investigate",
  mentioned: true,
}

const memory = () => {
  let state: SessionState | undefined
  const alarms: number[] = []
  const store: SessionStore = {
    load: Effect.sync(() => state),
    save: (value) =>
      Effect.sync(() => {
        state = value
      }),
    schedule: (at) =>
      Effect.sync(() => {
        alarms.push(at)
      }),
  }
  return { store, alarms, state: () => state }
}

test("only mentions create sessions and duplicate deliveries run once", async () => {
  const storage = memory()
  const replies: string[] = []
  let turns = 0
  await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* makeSession({
        store: storage.store,
        run: () =>
          Effect.sync(() => {
            turns += 1
            return { history: "history", text: "Which repository?" }
          }),
        post: (_input, text) =>
          Effect.sync(() => {
            replies.push(text)
          }),
      })
      yield* session.receive({ ...input, mentioned: false })
      expect(storage.state()).toBeUndefined()
      yield* session.receive(input)
      yield* session.receive(input)
      expect(turns).toBe(0)
      yield* session.alarm
      yield* session.alarm
      expect(turns).toBe(1)
      expect(replies).toEqual(["Which repository?"])
    }),
  )
})

test("inputs arriving during a turn retain ordering and persisted conversation", async () => {
  const storage = memory()
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const turns: string[] = []
      const session = yield* makeSession({
        store: storage.store,
        run: Effect.fnUntraced(function* (message, state, select) {
          turns.push(message.timestamp)
          if (message.timestamp === "1.0") {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            yield* select({ repositoryId: "42" })
          } else {
            expect(state.history).toBe("first")
            expect(state.repository).toEqual({ repositoryId: "42" })
          }
          return { history: message.timestamp === "1.0" ? "first" : "second", text: "Reply" }
        }),
        post: () => Effect.void,
      })
      yield* session.receive(input)
      const running = yield* Effect.forkChild(session.alarm)
      yield* Deferred.await(entered)
      yield* session.receive({ ...input, timestamp: "2.0", mentioned: false })
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
      yield* session.alarm
      expect(turns).toEqual(["1.0", "2.0"])
      expect(storage.state()?.pending).toEqual([])
      expect(storage.state()?.history).toBe("second")
    }),
  )
})

test("interrupted execution is reported after eviction without replaying tools", async () => {
  const storage = memory()
  const replies: string[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.store.save({
        home: input,
        history: "previous",
        repository: null,
        pending: [],
        seen: [input.timestamp],
        turn: { _tag: "Running", input },
      })
      const session = yield* makeSession({
        store: storage.store,
        run: () => Effect.die("Must not replay"),
        post: (_input, text) =>
          Effect.sync(() => {
            replies.push(text)
          }),
      })
      yield* session.alarm
      expect(replies[0]).toContain("interrupted")
      expect(storage.state()?.history).toBe("previous")
      expect(storage.state()?.turn._tag).toBe("Idle")
    }),
  )
})
