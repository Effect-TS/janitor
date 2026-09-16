import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"

const Timestamp = Schema.String.check(Schema.isPattern(/^\d+\.\d+$/))
export const SessionInput = Schema.Struct({
  workspace: Schema.NonEmptyString,
  channel: Schema.NonEmptyString,
  thread: Timestamp,
  timestamp: Timestamp,
  user: Schema.NonEmptyString,
  text: Schema.String.check(Schema.isMaxLength(40_000)),
  mentioned: Schema.Boolean,
})
export type SessionInput = typeof SessionInput.Type
export const sessionKey = (input: Pick<SessionInput, "workspace" | "channel" | "thread">) =>
  `${input.workspace}/${input.channel}/${input.thread}`

export const Selection = Schema.Struct({
  repositoryId: Schema.NonEmptyString,
  ref: Schema.optionalKey(Schema.NonEmptyString),
})
export type Selection = typeof Selection.Type

const Running = Schema.Union([
  Schema.TaggedStruct("Idle", {}),
  Schema.TaggedStruct("Running", { input: SessionInput }),
])
export const SessionState = Schema.Struct({
  home: SessionInput,
  history: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Selection),
  pending: Schema.Array(SessionInput),
  seen: Schema.Array(Schema.String),
  turn: Running,
})
export type SessionState = typeof SessionState.Type

export interface SessionStore<R = never> {
  readonly load: Effect.Effect<SessionState | undefined, never, R>
  readonly save: (state: SessionState) => Effect.Effect<void, never, R>
  readonly schedule: (at: number) => Effect.Effect<void, never, R>
}

/** Admission and execution are separate so Slack never waits for a model or a container. */
export const makeSession = Effect.fnUntraced(function* <R>(options: {
  readonly store: SessionStore<R>
  readonly run: (
    input: SessionInput,
    state: SessionState,
    select: (repository: Selection) => Effect.Effect<void, never, R>,
  ) => Effect.Effect<{ readonly history: string; readonly text: string }, string, R>
  readonly post: (input: SessionInput, text: string) => Effect.Effect<void, string, R>
}) {
  const lock = yield* Semaphore.make(1)
  const execution = yield* Semaphore.make(1)
  const locked = Semaphore.withPermits(lock, 1)
  const { store } = options
  const mutate = Effect.fnUntraced(function* (update: (state: SessionState) => SessionState) {
    const state = yield* store.load
    if (state !== undefined) yield* store.save(update(state))
  }, locked)

  const receive = Effect.fnUntraced(function* (value: SessionInput) {
    const input = yield* Schema.decodeEffect(SessionInput)(value).pipe(Effect.mapError(String))
    const current = yield* store.load
    if (current === undefined && !input.mentioned) return
    if (current !== undefined && sessionKey(current.home) !== sessionKey(input)) {
      return yield* Effect.fail("Slack thread identity does not match this session")
    }
    const state: SessionState = current ?? {
      home: input,
      history: null,
      repository: null,
      pending: [],
      seen: [],
      turn: { _tag: "Idle" },
    }
    if (state.seen.includes(input.timestamp)) return
    if (state.pending.length >= 32)
      return yield* Effect.fail("This thread's input queue is full; wait for Janitor to finish")
    // Arm before saving. A failed save leaves an empty wake; a successful admission has a wake.
    if (state.turn._tag === "Idle") yield* store.schedule((yield* Clock.currentTimeMillis) + 1)
    yield* store.save({
      ...state,
      pending: [...state.pending, input],
      seen: [...state.seen.slice(-255), input.timestamp],
    })
  }, locked)

  const alarm = Effect.gen(function* () {
    const claim = yield* locked(
      Effect.gen(function* () {
        const state = yield* store.load
        if (state === undefined) return undefined
        if (state.turn._tag === "Running")
          return { _tag: "Interrupted", state, input: state.turn.input } as const
        const [input, ...pending] = state.pending
        if (input === undefined) return undefined
        yield* store.schedule((yield* Clock.currentTimeMillis) + 6 * 60_000)
        const running: SessionState = { ...state, pending, turn: { _tag: "Running", input } }
        yield* store.save(running)
        return { _tag: "Ready", state: running, input } as const
      }),
    )
    if (claim === undefined) return
    const { state, input } = claim
    // A new alarm seeing Running means the previous execution was interrupted.
    const result =
      claim._tag === "Interrupted"
        ? {
            history: state.history,
            text: "My previous turn was interrupted. I haven't retried it. Send another message to continue; the checkout may need to be cloned again.",
          }
        : yield* options
            .run(input, state, (repository) => mutate((current) => ({ ...current, repository })))
            .pipe(
              Effect.timeout("5 minutes"),
              Effect.catchCause((cause) =>
                Effect.logError("Slack session turn failed", cause).pipe(
                  Effect.as({
                    history: state.history,
                    text: "I couldn't finish that turn. Send another message to try again. Repository changes may remain, but I haven't automatically repeated any commands.",
                  }),
                ),
              ),
            )
    // Commit completion before posting. An ambiguous Slack write must not replay model/tool work.
    yield* mutate((current) => ({ ...current, history: result.history, turn: { _tag: "Idle" } }))
    yield* options
      .post(input, result.text)
      .pipe(Effect.catchCause((cause) => Effect.logError("Slack session reply failed", cause)))
    yield* locked(
      Effect.gen(function* () {
        const current = yield* store.load
        if (current !== undefined && current.pending.length > 0)
          yield* store.schedule((yield* Clock.currentTimeMillis) + 1)
      }),
    )
  }).pipe(Semaphore.withPermits(execution, 1))
  return { receive, alarm }
})
