import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster"
import type * as DecisionModel from "effect/ai/DecisionModel"
import type * as LanguageModel from "effect/ai/LanguageModel"
import type * as Model from "effect/ai/Model"
import * as Prompt from "effect/ai/Prompt"
import * as Clock from "effect/Clock"
import * as ClusterSchema from "effect/cluster/ClusterSchema"
import * as DeliverAt from "effect/cluster/DeliverAt"
import * as Entity from "effect/cluster/Entity"
import type * as Sharding from "effect/cluster/Sharding"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as PrimaryKey from "effect/PrimaryKey"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import {
  resumeMessage,
  switchedOffMessage,
  systemPrompt,
  threadMessages,
  wrapUpMessage,
} from "@janitor/domain/Chat/Prompt"
import type { HistoryChange } from "../PullRequestReview/Agent.ts"
import { ChatAgent, ChatAgentLayer, type ChatLoop, type ChatProgress } from "./Agent.ts"
import { chatMulticaWorkspaceId, chatSessionConfig } from "./Config.ts"
import { ReplyGate } from "./Gate.ts"
import { ChatKillSwitch, type KillSwitchState } from "./KillSwitch.ts"
import { ChatMessage, ChatPlatform, ChatThread } from "./Platform.ts"
import { ChatSandboxes } from "./Sandbox/Sandboxes.ts"
import {
  GateOutcome,
  makeSessionStorage,
  type SessionState,
  type StoredMessage,
  TranscriptTurn,
  type TurnState,
  type TurnStatus,
  type TurnUsage,
} from "./SessionStorage.ts"

export { GateOutcome, TranscriptTurn, TurnStatus, TurnUsage } from "./SessionStorage.ts"

/**
 * The chat session entity (EFF-3018): one per chat thread, with the session
 * key as its entity id. It stores the thread's messages, runs the reply gate
 * and runs the thread's turns, one at a time.
 */

/**
 * A thread message from ingress. The session stores it once, keyed by its
 * platform message id, then gates it, steers it into the running turn,
 * starts a turn with it or keeps it as context. The reply comes once that
 * is decided, never after the turn; ingress sends it with `discard`.
 */
export const Receive = Rpc.make("Receive", {
  payload: { thread: ChatThread, message: ChatMessage },
  primaryKey: ({ message }) => `receive/${message.id}`,
})

/**
 * Deletes the session early, from the web app: cancels a running turn,
 * releases the sandbox and deletes the session's storage. A later message
 * starts a new session.
 */
export const Delete = Rpc.make("Delete", { payload: {} })

/**
 * Sent to itself after each message, for when the session expires. One for
 * an earlier message finds a later one and does nothing.
 */
export class ExpirePayload extends Schema.Class<ExpirePayload>("ChatSession/Expire")({
  /** The epoch millis of the message it was sent for. */
  lastMessageAt: Schema.Finite,
  at: Schema.DateTimeUtc,
}) {
  [DeliverAt.symbol](): DateTime.DateTime {
    return this.at
  }
  [PrimaryKey.symbol](): string {
    return `expire/${this.lastMessageAt}`
  }
}
export const Expire = Rpc.make("Expire", { payload: ExpirePayload })

/** What the session's storage holds: nothing once it expired or was deleted. */
export const TranscriptResult = Schema.TaggedUnion({
  Expired: {},
  Available: {
    messages: Schema.Array(Schema.Struct({ ...ChatMessage.fields, gate: GateOutcome })),
    turns: Schema.Array(TranscriptTurn),
  },
})
export type TranscriptResult = typeof TranscriptResult.Type

/** Reads the session's transcript as committed so far. */
export const Transcript = Rpc.make("Transcript", { success: TranscriptResult })

export const ChatSession = Entity.fromRpcGroup(
  "ChatSession",
  RpcGroup.make(Receive, Delete, Expire)
    .annotateRpcs(ClusterSchema.Persisted, true)
    // A read changes nothing, so it isn't stored and replayed like the rest.
    .add(Transcript),
)

/** How often a running turn reads the kill switch, and the status message is edited at most. */
const TICK = Duration.seconds(3)

/** Messages read for the backfill when the bot joins a thread. */
const BACKFILL = 100

/** The gate passes a message at this probability or above. */
const GATE_PASS = 0.5

const isStop = (text: string) => /^\s*stop[\s.!]*$/i.test(text)

const switchedOff = (state: KillSwitchState, thread: ChatThread) =>
  state.global || (thread._tag === "Slack" ? state.slack : state.discord)

const addUsage = (a: TurnUsage | null, b: TurnUsage | null): TurnUsage | null =>
  a === null
    ? b
    : b === null
      ? a
      : {
          inputTokens: a.inputTokens + b.inputTokens,
          outputTokens: a.outputTokens + b.outputTokens,
          cacheRead: a.cacheRead + b.cacheRead,
          cacheWrite: a.cacheWrite + b.cacheWrite,
        }

const elapsed = (millis: number) => {
  const seconds = Math.max(0, Math.floor(millis / 1000))
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
}

const actionCount = (actions: number) => `${actions} action${actions === 1 ? "" : "s"}`

/** The text of a user message, as clanka stores a steer or a prompt. */
const userText = (message: Prompt.Message) =>
  message.role !== "user"
    ? undefined
    : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")

/** Messages as the model sees them, each prefixed with its author. */
const render = (messages: ReadonlyArray<StoredMessage>) =>
  threadMessages(
    messages.map(({ message }) => ({
      author: message.author.name,
      kind: message.author.class,
      text: message.text,
    })),
  )

/** What a turn ended with. */
interface TurnEnd {
  readonly status: Exclude<TurnStatus, "running">
  readonly errorCategory?: string | undefined
}

/** A text the turn sent the model, and the messages it carries, until it lands in the history. */
interface InFlight {
  readonly text: string
  readonly ids: ReadonlyArray<string>
}

/** The turn this entity is running. */
interface Running {
  readonly turnId: string
  readonly thread: ChatThread
  fiber: Fiber.Fiber<void> | undefined
  /** The loop, once it started; steers go to it. */
  loop: ChatLoop | undefined
  /** Set once the loop replied: a message now waits for the next turn. */
  ending: boolean
  /** Set by a stop, so the turn's own end leaves finishing it to the stop. */
  stopping: boolean
  readonly inFlight: Array<InFlight>
  /** What the status message shows while the turn runs. */
  view: string
}

/**
 * The session entity's handlers, over its own Durable Object SQLite. A
 * running turn holds keep-alive, so a restart rebuilds the entity and the
 * turn resumes. Messages are handled one at a time; a turn runs in its own
 * fiber, so `Receive` replies once the message is decided.
 */
const ChatSessionEntityLayer = ChatSession.toLayer(
  Effect.gen(function* () {
    const { entityId } = yield* Entity.CurrentAddress
    const sql = yield* CloudflareCluster.DurableObjectSqlClient.orDie
    const storage = makeSessionStorage(sql, entityId)
    const platform = yield* ChatPlatform
    const sandboxes = yield* ChatSandboxes
    const killSwitch = yield* ChatKillSwitch
    const agent = yield* ChatAgent
    const gate = yield* ReplyGate
    const self = (yield* ChatSession.client)(entityId)
    const entityScope = yield* Scope.Scope
    const cluster = yield* Effect.context<Entity.CurrentAddress | Sharding.Sharding>()

    /** Messages are handled one at a time, in arrival order. */
    const inbox = yield* Semaphore.make(1)
    /** Starting and finishing turns, and steering, one at a time. */
    const transitions = yield* Semaphore.make(1)

    let current: Running | undefined
    let keptAlive = false
    /** Set once the session's tables are dropped; `Receive` makes them again. */
    let dropped = !(yield* storage.exists.pipe(Effect.orDie))

    const withLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.annotateLogs(effect, { sessionId: entityId })

    const keepAlive = (enabled: boolean) =>
      Effect.suspend(() => {
        if (keptAlive === enabled) return Effect.void
        keptAlive = enabled
        return Entity.keepAlive(enabled).pipe(Effect.provideContext(cluster))
      })

    const transcriptLink = (origin: Option.Option<string>) =>
      Option.match(origin, {
        onNone: () => "",
        onSome: (origin) => ` · ${origin}/chat/sessions/${encodeURIComponent(entityId)}`,
      })

    /** The status message's last text: how the turn ended. */
    const finalStatus = (turn: TurnState, now: number) => {
      const summary = `${elapsed(now - (turn.startedAt ?? turn.createdAt))} · ${actionCount(turn.actions)}`
      switch (turn.status) {
        case "replied":
          return `Done · ${summary}`
        case "stopped":
          return `Stopped · ${summary}`
        case "deadline":
          return `Stopped at the time limit · ${summary}`
        case "failed":
          return turn.errorCategory === "busy"
            ? "Every sandbox is busy right now. Try again in a while."
            : `Failed (${turn.errorCategory ?? "unknown"}) · ${summary}`
        case "running":
          return `Working · ${summary}`
      }
    }

    const editStatus = (thread: ChatThread, messageId: string | null, text: string) =>
      messageId === null
        ? Effect.void
        : platform
            .editStatus(thread, messageId, text)
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Couldn't edit a chat status message").pipe(
                  Effect.annotateLogs({ reason: error.message }),
                ),
              ),
            )

    /**
     * Ends `running` as `end`, once, then starts the next turn if a message
     * is waiting for one. Run with `transitions` held.
     */
    const finish = (running: Running, end: TurnEnd) =>
      Effect.gen(function* () {
        if (current !== running) return
        current = undefined
        const now = yield* Clock.currentTimeMillis
        const saved = yield* storage.updateTurn(running.turnId, (turn) =>
          turn.status === "running"
            ? {
                ...turn,
                status: end.status,
                errorCategory: end.errorCategory ?? null,
                finishedAt: now,
              }
            : undefined,
        )
        if (Option.isSome(saved)) {
          const turn = saved.value
          yield* editStatus(running.thread, turn.statusMessageId, finalStatus(turn, now))
          yield* Effect.logInfo(`Chat turn ${end.status}`).pipe(
            Effect.annotateLogs({
              turnId: running.turnId,
              actions: turn.actions,
              resumes: Math.max(0, turn.acquires - 1),
              ...(turn.errorCategory === null ? {} : { errorCategory: turn.errorCategory }),
            }),
          )
        }
        // A stopped turn's waiting messages stay as context.
        if (end.status === "stopped") yield* storage.clearWanted
        if ((yield* storage.hasWanted) && !switchedOff(yield* killSwitch.get, running.thread))
          return yield* startTurn(running.thread)
        yield* keepAlive(false)
      })

    /** Steers every message the model hasn't seen into the running loop, if one wants a turn. */
    const steerPending = (running: Running) =>
      Effect.gen(function* () {
        if (running.loop === undefined || running.ending || running.stopping) return
        const inFlight = new Set(running.inFlight.flatMap((sent) => sent.ids))
        const pending = (yield* storage.undelivered).filter(
          ({ message }) => !inFlight.has(message.id),
        )
        if (!pending.some((stored) => stored.wantsTurn)) return
        const text = render(pending)
        running.inFlight.push({ text, ids: pending.map(({ message }) => message.id) })
        yield* running.loop.steer(text)
      })

    /** Starts a turn for the messages waiting. Run with `transitions` held. */
    const startTurn = (thread: ChatThread) =>
      Effect.gen(function* () {
        const turnId = crypto.randomUUID()
        yield* storage.saveTurn({
          turnId,
          status: "running",
          errorCategory: null,
          resumes: 0,
          wrappedUp: false,
          model: agent.model,
          actions: 0,
          usage: null,
          createdAt: yield* Clock.currentTimeMillis,
          startedAt: null,
          acquires: 0,
          statusMessageId: null,
          finishedAt: null,
        })
        yield* resumeTurn(turnId, thread)
      })

    /** Runs a saved turn in its own fiber: a new one, or a running one after a restart. */
    const resumeTurn = (turnId: string, thread: ChatThread) =>
      Effect.gen(function* () {
        yield* keepAlive(true)
        const running: Running = {
          turnId,
          thread,
          fiber: undefined,
          loop: undefined,
          ending: false,
          stopping: false,
          inFlight: [],
          view: "Starting",
        }
        current = running
        running.fiber = yield* Effect.forkIn(
          withLogs(runTurn(running)).pipe(Effect.annotateLogs({ turnId })),
          entityScope,
        )
      })

    /** Stops the running turn, whatever it is doing, and edits its status to "Stopped". */
    const stopTurn = Effect.gen(function* () {
      const running = yield* Semaphore.withPermits(
        transitions,
        1,
      )(
        Effect.sync(() => {
          if (current !== undefined) current.stopping = true
          return current
        }),
      )
      if (running === undefined) return
      if (running.fiber !== undefined) yield* Fiber.interrupt(running.fiber)
      yield* Semaphore.withPermits(transitions, 1)(finish(running, { status: "stopped" }))
    })

    /** Ends the turn from its own fiber, unless a stop is finishing it. */
    const end = (running: Running, outcome: TurnEnd) =>
      Semaphore.withPermits(
        transitions,
        1,
      )(Effect.suspend(() => (running.stopping ? Effect.void : finish(running, outcome))))

    /** Commits a step of the loop's history, and marks what it delivered. */
    const commitStep = (running: Running, change: HistoryChange) =>
      Effect.gen(function* () {
        yield* storage.commitHistory(change)
        const texts = new Set(change.messages.flatMap((message) => userText(message) ?? []))
        const landed = running.inFlight.filter((sent) => texts.has(sent.text))
        if (landed.length === 0) return
        yield* storage.markDelivered(landed.flatMap((sent) => sent.ids))
        for (const sent of landed) running.inFlight.splice(running.inFlight.indexOf(sent), 1)
      }).pipe(Effect.orDie)

    /**
     * One acquire of a sandbox and one loop in it. Ends with the loop's end,
     * or with how the turn ended before a loop could start.
     */
    const attempt = (running: Running, turn: TurnState) =>
      Effect.gen(function* () {
        const config = yield* Effect.orDie(chatSessionConfig)
        const resumed = turn.acquires > 1
        const queued = (ahead: number) =>
          Effect.sync(() => {
            running.view = `Waiting for a sandbox (${ahead} ahead)`
          })
        const acquired = yield* Effect.acquireRelease(
          sandboxes
            .acquire({
              sessionId: entityId,
              turnId: turn.turnId,
              startBudget: config.deadline,
              onQueued: queued,
            })
            .pipe(Effect.result),
          (result) =>
            result._tag === "Success"
              ? sandboxes.release(entityId, result.success.generation)
              : Effect.void,
        )
        if (acquired._tag === "Failure") {
          const error = acquired.failure
          yield* Effect.logWarning("Couldn't get a chat sandbox").pipe(
            Effect.annotateLogs({ reason: error._tag }),
          )
          return {
            status: "failed",
            errorCategory: error._tag === "SandboxBusy" ? "busy" : "sandbox_unavailable",
          } satisfies TurnEnd
        }
        const now = yield* Clock.currentTimeMillis
        const started = yield* storage.updateTurn(turn.turnId, (state) =>
          state.status !== "running" || state.startedAt !== null
            ? undefined
            : { ...state, startedAt: now },
        )
        const startedAt = Option.match(started, {
          onNone: () => turn.startedAt ?? now,
          onSome: (state) => state.startedAt!,
        })
        const deadline = startedAt + Duration.toMillis(config.deadline)
        const wrapUpAt = startedAt + Duration.toMillis(config.wrapUpAfter)
        if (now >= deadline) return { status: "deadline" } satisfies TurnEnd

        const multicaWorkspaceId = yield* Effect.orDie(chatMulticaWorkspaceId)
        const history = yield* storage.history(resumed)
        const pending = yield* storage.undelivered
        const prompt = [
          ...(resumed ? [resumeMessage] : []),
          ...(pending.length === 0 ? [] : [render(pending)]),
        ].join("\n\n")
        // Nothing for a new turn to answer: every message it was for has been seen.
        if (prompt === "") return { status: "replied" } satisfies TurnEnd
        running.inFlight.length = 0
        running.inFlight.push({ text: prompt, ids: pending.map(({ message }) => message.id) })
        const base = { actions: turn.actions, usage: turn.usage }
        const loop = yield* agent.start({
          instructions: systemPrompt({
            audience: running.thread._tag === "Slack" ? "slack" : "discord",
            multicaWorkspaceId,
          }),
          executor: acquired.success.executor,
          history,
          prompt,
          onStep: (change) => commitStep(running, change),
          onProgress: (progress: ChatProgress) =>
            Effect.gen(function* () {
              const actions = base.actions + progress.actions
              running.view = `Working · ${actionCount(actions)}${progress.note === null ? "" : ` · ${progress.note}`}`
              yield* storage.updateTurn(turn.turnId, (state) => ({
                ...state,
                actions,
                usage: addUsage(base.usage, progress.usage),
              }))
            }).pipe(Effect.orDie),
        })
        yield* Semaphore.withPermits(
          transitions,
          1,
        )(
          Effect.suspend(() => {
            running.loop = loop
            return steerPending(running)
          }),
        )
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            running.loop = undefined
          }),
        )

        const wrapUp = Effect.gen(function* () {
          yield* loop.steer(wrapUpMessage)
          yield* storage.updateTurn(turn.turnId, (state) => ({ ...state, wrappedUp: true }))
          yield* Effect.logInfo("Chat turn told to wrap up")
        })
        // A resume past wrap-up time goes straight to wrap-up.
        if (now >= wrapUpAt) yield* wrapUp
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            if (now < wrapUpAt) {
              yield* Effect.sleep(Duration.millis(wrapUpAt - now))
              yield* wrapUp
            }
            yield* Effect.sleep(Duration.millis(deadline - (yield* Clock.currentTimeMillis)))
            yield* Effect.logInfo("Chat turn hit its deadline")
            yield* loop.interrupt
          }),
        )
        const result = yield* loop.result
        switch (result._tag) {
          case "Replied": {
            running.ending = true
            yield* platform
              .postReply(running.thread, result.text)
              .pipe(
                Effect.catch((error) =>
                  Effect.logError("Couldn't post a chat reply").pipe(
                    Effect.annotateLogs({ reason: error.message }),
                  ),
                ),
              )
            return { status: "replied" } satisfies TurnEnd
          }
          case "Interrupted":
            return { status: "deadline" } satisfies TurnEnd
          case "Failed":
            return { status: "failed", errorCategory: result.category } satisfies TurnEnd
          case "SandboxLost":
            return "SandboxLost" as const
        }
      }).pipe(Effect.orDie, Effect.scoped)

    /** Edits the status message every tick while the view changes, and stops the turn if switched off. */
    const watch = (running: Running, turn: TurnState) =>
      Effect.gen(function* () {
        const config = yield* Effect.orDie(chatSessionConfig)
        const link = transcriptLink(config.publicOrigin)
        let shown = ""
        while (true) {
          yield* Effect.sleep(TICK)
          if (switchedOff(yield* killSwitch.get, running.thread)) {
            yield* Effect.logInfo("Chat kill switch is on; stopping the turn")
            // Not from this fiber: stopping the turn interrupts it.
            yield* Effect.forkIn(withLogs(stopTurn), entityScope)
            return
          }
          const loaded = yield* storage.loadTurn(turn.turnId).pipe(Effect.orDie)
          const since = Option.match(loaded, {
            onNone: () => turn.createdAt,
            onSome: (state) => state.startedAt ?? state.createdAt,
          })
          const text = `${running.view} · ${elapsed((yield* Clock.currentTimeMillis) - since)}${link}`
          if (text !== shown) {
            shown = text
            yield* editStatus(running.thread, turn.statusMessageId, text)
          }
        }
      })

    /** A turn from its start, or its resume, to its end. */
    const runTurn = (running: Running): Effect.Effect<void> =>
      Effect.gen(function* () {
        const config = yield* Effect.orDie(chatSessionConfig)
        let loaded = yield* storage.loadTurn(running.turnId)
        if (Option.isNone(loaded) || loaded.value.status !== "running") return
        if (loaded.value.statusMessageId === null) {
          const posted = yield* platform.postStatus(running.thread, "Starting").pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Couldn't post a chat status message").pipe(
                Effect.annotateLogs({ reason: error.message }),
              ),
            ),
            Effect.option,
          )
          loaded = yield* storage.updateTurn(running.turnId, (state) => ({
            ...state,
            statusMessageId: Option.getOrNull(posted),
          }))
        }
        const watcher = yield* Effect.forkChild(watch(running, Option.getOrThrow(loaded)))
        let outcome: TurnEnd | undefined
        while (outcome === undefined) {
          // Every acquire after the first is a resume; past the allowed resumes the turn fails.
          const counted = yield* storage.updateTurn(running.turnId, (state) =>
            state.status === "running" && state.acquires <= config.maxResumes
              ? { ...state, acquires: state.acquires + 1, resumes: state.acquires }
              : undefined,
          )
          if (Option.isNone(counted)) {
            outcome = { status: "failed", errorCategory: "resume_limit" }
            break
          }
          if (counted.value.acquires > 1)
            yield* Effect.logInfo("Chat turn resuming").pipe(
              Effect.annotateLogs({ resumeCount: counted.value.acquires - 1 }),
            )
          const ended = yield* attempt(running, counted.value)
          if (ended === "SandboxLost")
            yield* Effect.logWarning("Chat sandbox lost; resuming in a new one")
          else outcome = ended
        }
        // Before the last edit, so the status message ends on how the turn ended.
        yield* Fiber.interrupt(watcher)
        yield* end(running, outcome)
      }).pipe(Effect.orDie)

    /** Gates one stored message, then steers it, starts a turn with it or keeps it as context. */
    const handle = (thread: ChatThread, message: ChatMessage) =>
      Effect.gen(function* () {
        if (message.author.class !== "admitted")
          return yield* storage.setGate(message.id, { _tag: "Context" })
        const session = yield* storage.loadSession
        if (switchedOff(yield* killSwitch.get, thread)) {
          yield* storage.setGate(message.id, { _tag: "SwitchedOff" })
          yield* stopTurn
          if (Option.isSome(session) && !session.value.switchedOffNotified) {
            yield* storage.saveSession({ ...session.value, switchedOffNotified: true })
            yield* platform
              .postReply(thread, switchedOffMessage)
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Couldn't say the chat bot is switched off").pipe(
                    Effect.annotateLogs({ reason: error.message }),
                  ),
                ),
              )
          }
          return
        }
        if (Option.isSome(session) && session.value.switchedOffNotified)
          yield* storage.saveSession({ ...session.value, switchedOffNotified: false })
        // Trusted code: no model ever sees a "stop".
        if (isStop(message.text)) {
          yield* storage.setGate(message.id, { _tag: "Stop" }, { delivered: true })
          yield* Effect.logInfo("Chat turn stop requested")
          return yield* stopTurn
        }
        let outcome: GateOutcome
        if (message.mentionsBot) outcome = { _tag: "Mention" }
        else {
          const decided = yield* gate.decide(yield* storage.recent(20)).pipe(Effect.result)
          if (decided._tag === "Failure") {
            yield* Effect.logWarning("Chat reply gate failed; starting nothing")
            outcome = { _tag: "Failed" }
          } else {
            const probability = decided.success
            outcome =
              probability >= GATE_PASS
                ? { _tag: "Passed", probability }
                : { _tag: "Rejected", probability }
            yield* Effect.logInfo("Chat reply gate decided").pipe(
              Effect.annotateLogs({ probability, passed: outcome._tag === "Passed" }),
            )
          }
        }
        const wantsTurn = outcome._tag === "Mention" || outcome._tag === "Passed"
        yield* storage.setGate(message.id, outcome, { wantsTurn })
        if (!wantsTurn) return
        yield* Semaphore.withPermits(
          transitions,
          1,
        )(Effect.suspend(() => (current === undefined ? startTurn(thread) : steerPending(current))))
      })

    /** Backfills a thread the bot just joined: its earlier messages, as context. */
    const backfill = (thread: ChatThread, joinedWith: string) =>
      platform.history(thread, BACKFILL).pipe(
        Effect.flatMap((messages) =>
          Effect.forEach(
            messages.filter((message) => message.id !== joinedWith),
            (message) => storage.addMessage(message, { _tag: "Context" }),
            { discard: true },
          ),
        ),
        Effect.catchTag("ChatPlatformError", (error) =>
          Effect.logWarning("Couldn't backfill a chat thread").pipe(
            Effect.annotateLogs({ reason: error.message }),
          ),
        ),
      )

    /** Ends the session: stops its turn and deletes its storage. */
    const drop = Effect.gen(function* () {
      yield* stopTurn
      yield* storage.drop
      dropped = true
      yield* keepAlive(false)
    })

    // A rebuilt entity picks up where it was: a running turn resumes, and a
    // message stored but not yet gated is gated now.
    if (!dropped) {
      const turns = yield* storage.turns.pipe(Effect.orDie)
      const session = yield* storage.loadSession.pipe(Effect.orDie)
      const running = turns.find((turn) => turn.status === "running")
      if (Option.isSome(session)) {
        const thread = session.value.thread
        if (running !== undefined)
          yield* Semaphore.withPermits(
            transitions,
            1,
          )(resumeTurn(running.turnId, thread)).pipe(withLogs)
        yield* Effect.forkIn(
          Semaphore.withPermits(
            inbox,
            1,
          )(
            Effect.flatMap(storage.ungated, (messages) =>
              Effect.forEach(messages, ({ message }) => handle(thread, message), {
                discard: true,
              }),
            ),
          ).pipe(withLogs, Effect.orDie),
          entityScope,
        )
      }
    }

    return ChatSession.of({
      Receive: ({ payload: { thread, message } }) =>
        Semaphore.withPermits(
          inbox,
          1,
        )(
          Effect.gen(function* () {
            yield* storage.ensureTables
            dropped = false
            const now = yield* Clock.currentTimeMillis
            const session = yield* storage.loadSession
            const state: SessionState = Option.isSome(session)
              ? { ...session.value, lastMessageAt: now }
              : { thread, lastMessageAt: now, switchedOffNotified: false }
            if (Option.isNone(session)) {
              yield* storage.saveSession(state)
              yield* backfill(thread, message.id)
            }
            if (!(yield* storage.addMessage(message, null))) return
            yield* storage.saveSession(state)
            const config = yield* Effect.orDie(chatSessionConfig)
            yield* self.Expire(
              new ExpirePayload({
                lastMessageAt: now,
                at: DateTime.makeUnsafe(now + Duration.toMillis(config.retention)),
              }),
              { discard: true },
            )
            yield* handle(thread, message)
          }),
        ).pipe(withLogs, Effect.orDie),

      Delete: () =>
        Semaphore.withPermits(
          inbox,
          1,
        )(
          Effect.gen(function* () {
            if (dropped) return
            yield* drop
            yield* Effect.logInfo("Deleted the chat session")
          }),
        ).pipe(withLogs, Effect.orDie),

      Expire: ({ payload }) =>
        Semaphore.withPermits(
          inbox,
          1,
        )(
          Effect.gen(function* () {
            if (dropped) return
            const session = yield* storage.loadSession
            // A later message moved the expiry on.
            if (Option.isNone(session) || session.value.lastMessageAt !== payload.lastMessageAt)
              return
            yield* drop
            yield* Effect.logInfo("Chat session expired")
          }),
        ).pipe(withLogs, Effect.orDie),

      Transcript: () =>
        Effect.gen(function* () {
          if (dropped) return { _tag: "Expired" } as const
          const { messages, turns } = yield* storage.transcript
          if (messages.length === 0 && turns.length === 0) return { _tag: "Expired" } as const
          return {
            _tag: "Available",
            messages: messages.map(({ message, gate }) => ({ ...message, gate: gate! })),
            turns: turns.map((turn): TranscriptTurn => ({
              turnId: turn.turnId,
              status: turn.status,
              errorCategory: turn.errorCategory,
              resumes: turn.resumes,
              wrappedUp: turn.wrappedUp,
              model: turn.model,
              actions: turn.actions,
              usage: turn.usage,
            })),
          } as const
        }).pipe(withLogs, Effect.orDie),
    })
  }),
  { concurrency: "unbounded" },
)

/**
 * The session entity with its agent and reply gate. The turn's agent is
 * clanka on the `CHAT_AI_*` model, and the reply gate is Jev through its own
 * `DecisionModel`.
 */
export const ChatSessionLayer: Layer.Layer<
  never,
  never,
  | ChatPlatform
  | ChatSandboxes
  | ChatKillSwitch
  | LanguageModel.LanguageModel
  | Model.ProviderName
  | Model.ModelName
  | DecisionModel.DecisionModel
  | Sharding.Sharding
> = ChatSessionEntityLayer.pipe(Layer.provide([ChatAgentLayer, ReplyGate.layer]))
