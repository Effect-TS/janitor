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
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as PrimaryKey from "effect/PrimaryKey"
import * as Queue from "effect/Queue"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"
import * as Schedule from "effect/Schedule"
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
import {
  ChatUnavailable,
  SessionTranscriptTurn,
  TranscriptMessage,
} from "@janitor/domain/Chat/Session"
import type { HistoryChange } from "../AgentLoop.ts"
import { ChatAgent, ChatAgentLayer, type ChatImage, type ChatLoop } from "./Agent.ts"
import { chatMulticaWorkspaceId, chatSessionConfig } from "./Config.ts"
import { GATE_CONTEXT, ReplyGate } from "./Gate.ts"
import { ChatKillSwitch, type KillSwitchState } from "./KillSwitch.ts"
import { ChatMessage, ChatPlatform, ChatPlatformError, ChatThread, sessionKey } from "./Platform.ts"
import { type ChatSandbox, ChatSandboxes } from "./Sandbox/Sandboxes.ts"
import { ChatSessionIndex } from "./SessionIndex.ts"
import {
  GateOutcome,
  makeSessionStorage,
  type SessionState,
  type StoredMessage,
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
 * Stops the running turn from the web app, as "stop" does. The session and
 * its history stay.
 */
export const Cancel = Rpc.make("Cancel", { payload: {} })

/**
 * Remembers a Slack user as admitted for an hour, with their name, for
 * ingress's admission check. Denials are never remembered.
 */
export const RememberAdmission = Rpc.make("RememberAdmission", {
  payload: { userId: Schema.String, name: Schema.String },
})

/** The user's name, when their admission is remembered and less than an hour old. */
export const CachedAdmission = Rpc.make("CachedAdmission", {
  payload: { userId: Schema.String },
  success: Schema.NullOr(Schema.String),
})

/**
 * Whether the thread has a session, for ingress: a reply that doesn't
 * mention the bot reaches only a thread that has one.
 */
export const Exists = Rpc.make("Exists", { success: Schema.Boolean })

/**
 * Sent to itself after each message, for when the session expires. One for
 * an earlier message finds a later one and does nothing. One that couldn't
 * end the session sends itself again for later.
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
    return `expire/${this.lastMessageAt}/${DateTime.toEpochMillis(this.at)}`
  }
}
export const Expire = Rpc.make("Expire", { payload: ExpirePayload })

/** What the session's storage holds: nothing once it expired or was deleted. */
export const TranscriptResult = Schema.TaggedUnion({
  Expired: {},
  Available: {
    messages: Schema.Array(TranscriptMessage),
    turns: Schema.Array(SessionTranscriptTurn),
  },
})
export type TranscriptResult = typeof TranscriptResult.Type

/** Reads the session's transcript as committed so far. */
export const Transcript = Rpc.make("Transcript", { success: TranscriptResult })

/** What the web app's API asks of the session entities (EFF-3021). */
export class ChatSessionControl extends Context.Service<
  ChatSessionControl,
  {
    /** The session's transcript as committed so far; none once its storage is gone. */
    readonly transcript: (sessionId: string) => Effect.Effect<
      Option.Option<{
        readonly messages: ReadonlyArray<TranscriptMessage>
        readonly turns: ReadonlyArray<SessionTranscriptTurn>
      }>,
      ChatUnavailable
    >
    /** Sends the session `Delete`: it cancels the turn, releases the sandbox and deletes the history. */
    readonly delete: (sessionId: string) => Effect.Effect<void, ChatUnavailable>
  }
>()("@janitor/cluster/Chat/Session/ChatSessionControl") {
  /** The session entities, through the cluster's client. An entity that can't be reached dies. */
  static readonly layer: Layer.Layer<ChatSessionControl, never, Sharding.Sharding> = Layer.effect(
    this,
    Effect.gen(function* () {
      const client = yield* ChatSession.client
      return {
        transcript: (sessionId) =>
          client(sessionId)
            .Transcript()
            .pipe(
              Effect.orDie,
              Effect.map((result) =>
                result._tag === "Expired"
                  ? Option.none()
                  : Option.some({ messages: result.messages, turns: result.turns }),
              ),
            ),
        delete: (sessionId) => client(sessionId).Delete({}).pipe(Effect.orDie),
      }
    }),
  )

  /**
   * No session entities: the chat bot is off. The sessions it kept are still
   * in their storage, so they can't be read or deleted until it is back on.
   */
  static readonly unavailable = Layer.succeed(this, {
    transcript: () => Effect.fail(new ChatUnavailable()),
    delete: () => Effect.fail(new ChatUnavailable()),
  })
}

export const ChatSession = Entity.fromRpcGroup(
  "ChatSession",
  RpcGroup.make(Receive, Delete, Cancel, RememberAdmission, Expire)
    .annotateRpcs(ClusterSchema.Persisted, true)
    // Reads change nothing, so they aren't stored and replayed like the rest.
    .add(Transcript, CachedAdmission, Exists),
)

/** How often a running turn reads the kill switch, and the status message is edited at most. */
const TICK = Duration.seconds(3)

/** How often a running turn's tokens reach the sessions page at most. */
const INDEX_PROGRESS = Duration.seconds(30)

/** How long an expiry that couldn't end the session waits to try again. */
const EXPIRE_RETRY = Duration.hours(1)

/** Messages read for the backfill when the bot joins a thread. */
const BACKFILL = 100

/** The gate passes a message at this probability or above. */
const GATE_PASS = 0.5

/** Attachments up to this size are written into the turn's folder; bigger ones are never fetched. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/** Each turn's attachments go in a folder of its own under here. */
const ATTACHMENTS_DIRECTORY = "/workspace/attachments"

/** An attachment's name as one safe path segment. */
const safeName = (name: string) => name.replace(/[/\\]/g, "_").replace(/^\.+/, "_") || "file"

/** The longest a steered message's attachment may take to fetch and write. */
const STEERED_TRANSFER_TIMEOUT = Duration.minutes(2)

/** How long a remembered admission counts. */
const ADMISSION_TTL = Duration.hours(1)

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

/** What a turn ended with. */
interface TurnEnd {
  readonly status: Exclude<TurnStatus, "running">
  readonly errorCategory?: string | undefined
}

/** A text the turn sent the model, and the messages it carries, until it lands in the history. */
export interface InFlight {
  readonly text: string
  readonly ids: ReadonlyArray<string>
}

/**
 * The in-flight texts that `appended` user messages land: each message
 * lands at most one, the oldest with its text. Two steers with the same
 * text need two messages before both count as delivered.
 */
export const landedInputs = (
  inFlight: ReadonlyArray<InFlight>,
  appended: ReadonlyArray<Prompt.Message>,
): ReadonlyArray<InFlight> => {
  const landed: Array<InFlight> = []
  for (const message of appended) {
    const text = userText(message)
    const sent = inFlight.find(
      (candidate) => candidate.text === text && !landed.includes(candidate),
    )
    if (sent !== undefined) landed.push(sent)
  }
  return landed
}

/** The turn this entity is running. */
interface Running {
  readonly turnId: string
  readonly thread: ChatThread
  fiber: Fiber.Fiber<void> | undefined
  /**
   * Steers waiting for their attachments, in arrival order, once the loop
   * started. One worker in the loop's scope takes them, so a stop or the
   * deadline ends it too.
   */
  steers: Queue.Queue<ReadonlyArray<StoredMessage>> | undefined
  /** Messages queued to steer, so no later steer takes them again. */
  readonly preparing: Set<string>
  /**
   * The messages waiting for a turn when this one was created. However the
   * turn ends, they stop waiting: a deadline or a busy pool doesn't start
   * the same work again. Messages that arrive later and miss it still do.
   */
  readonly claimed: ReadonlyArray<string>
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
    const index = yield* ChatSessionIndex
    const agent = yield* ChatAgent
    const gate = yield* ReplyGate
    const self = (yield* ChatSession.client)(entityId)
    const entityScope = yield* Scope.Scope
    const cluster = yield* Effect.context<Entity.CurrentAddress | Sharding.Sharding>()

    /** Messages are handled one at a time, in arrival order. */
    const inbox = yield* Semaphore.make(1)
    /** A visible reply is recorded before a follow-up can read the gate context. */
    const replyContext = yield* Semaphore.make(1)
    /** Starting and finishing turns, and steering, one at a time. */
    const transitions = yield* Semaphore.make(1)
    /** The session's index row is saved and removed one at a time, so a save never outlives a drop. */
    const indexing = yield* Semaphore.make(1)

    let current: Running | undefined
    let keptAlive = false
    /** Set once the session's tables are dropped; `Receive` makes them again. */
    let dropped = !(yield* storage.exists.pipe(Effect.orDie))

    const withLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.annotateLogs(effect, { sessionId: entityId })

    /**
     * Saves the session's row in the sessions page's index, as it stands now.
     * The index only serves the page, so a failure is logged and the session
     * goes on.
     */
    const saveIndex = Semaphore.withPermits(
      indexing,
      1,
    )(
      Effect.gen(function* () {
        if (dropped) return
        const session = yield* storage.loadSession
        const starter = yield* storage.starter
        if (Option.isNone(session) || Option.isNone(starter)) return
        const turns = yield* storage.turns
        yield* index.save({
          sessionId: entityId,
          thread: session.value.thread,
          startedBy: { id: starter.value.id, name: starter.value.name },
          turns: turns.length,
          status: turns.at(-1)?.status ?? null,
          lastActivityAt: DateTime.makeUnsafe(
            Math.max(
              session.value.lastMessageAt,
              ...turns.map((turn) => turn.finishedAt ?? turn.startedAt ?? turn.createdAt),
            ),
          ),
          usage: turns.reduce<TurnUsage | null>((total, turn) => addUsage(total, turn.usage), null),
        })
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Couldn't save the chat session's index row", cause),
      ),
    )

    let indexedProgressAt = 0
    let trailingProgress = false
    /**
     * A running turn's actions and tokens, saved to the index at most every
     * `INDEX_PROGRESS`. Progress inside that window is saved once it ends,
     * so the last update is never left out.
     */
    const saveProgress = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const wait = indexedProgressAt + Duration.toMillis(INDEX_PROGRESS) - now
      if (wait <= 0) {
        indexedProgressAt = now
        return yield* saveIndex
      }
      if (trailingProgress) return
      trailingProgress = true
      yield* Effect.forkIn(
        Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(wait))
          trailingProgress = false
          indexedProgressAt = yield* Clock.currentTimeMillis
          yield* saveIndex
        }),
        entityScope,
      )
    })

    const keepAlive = (enabled: boolean) =>
      Effect.suspend(() => {
        if (keptAlive === enabled) return Effect.void
        keptAlive = enabled
        return Entity.keepAlive(enabled).pipe(Effect.provideContext(cluster))
      })

    /** Sends the session its expiry for the message at `lastMessageAt`, due `after` from now. */
    const scheduleExpiry = (lastMessageAt: number, after: Duration.Duration) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        self.Expire(
          new ExpirePayload({
            lastMessageAt,
            at: DateTime.makeUnsafe(now + Duration.toMillis(after)),
          }),
          { discard: true },
        ),
      )

    // The key's slashes stay path separators: redirects decode an encoded
    // `%2F` and break the link.
    const transcriptPath = entityId.split("/").map(encodeURIComponent).join("/")
    const transcriptLink = (origin: Option.Option<string>) =>
      Option.match(origin, {
        onNone: () => "",
        onSome: (origin) => ` · ${origin}/chat/sessions/${transcriptPath}`,
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
        // A stopped turn's waiting messages stay as context, in the same
        // transaction, so a restart never starts work someone stopped.
        const saved = yield* storage.endTurn(
          running.turnId,
          (turn) =>
            turn.status === "running"
              ? {
                  ...turn,
                  status: end.status,
                  errorCategory: end.errorCategory ?? null,
                  finishedAt: now,
                }
              : undefined,
          { clearWanted: end.status === "stopped", settled: running.claimed },
        )
        if (Option.isSome(saved)) {
          const turn = saved.value
          const final = editStatus(running.thread, turn.statusMessageId, finalStatus(turn, now))
          // A reply speaks for itself, so its status goes; any other end
          // keeps it, as the turn's only output.
          if (turn.status === "replied" && turn.statusMessageId !== null)
            yield* platform
              .deleteStatus(running.thread, turn.statusMessageId)
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Couldn't delete a chat status message").pipe(
                    Effect.annotateLogs({ reason: error.message }),
                    Effect.andThen(final),
                  ),
                ),
              )
          else yield* final
          yield* Effect.logInfo(`Chat turn ${end.status}`).pipe(
            Effect.annotateLogs({
              turnId: running.turnId,
              actions: turn.actions,
              resumes: Math.max(0, turn.acquires - 1),
              ...(turn.errorCategory === null ? {} : { errorCategory: turn.errorCategory }),
            }),
          )
        }
        if ((yield* storage.hasWanted) && !switchedOff(yield* killSwitch.get, running.thread))
          yield* startTurn(running.thread)
        else yield* keepAlive(false)
        yield* saveIndex
      })

    /** Steers every message the model hasn't seen into the running loop, if one wants a turn. */
    const steerPending = (running: Running) =>
      Effect.gen(function* () {
        const { steers } = running
        if (steers === undefined || running.ending || running.stopping) return
        const taken = new Set([
          ...running.inFlight.flatMap((sent) => sent.ids),
          ...running.preparing,
        ])
        const pending = (yield* storage.undelivered).filter(({ message }) => !taken.has(message.id))
        if (!pending.some((stored) => stored.wantsTurn)) return
        for (const { message } of pending) running.preparing.add(message.id)
        // Attachments can take a while, so the loop's steer worker fetches them,
        // not the session's locks: a stop doesn't wait for them.
        Queue.offerUnsafe(steers, pending)
      })

    /**
     * Steers queued messages into `loop`, one batch at a time in arrival
     * order, each once its attachments are in the sandbox.
     */
    const steerWorker = (
      running: Running,
      loop: ChatLoop,
      sandbox: ChatSandbox,
      steers: Queue.Queue<ReadonlyArray<StoredMessage>>,
    ) =>
      Effect.forever(
        Effect.gen(function* () {
          const pending = yield* Queue.take(steers)
          const ids = pending.map(({ message }) => message.id)
          yield* Effect.gen(function* () {
            const { text } = yield* prepare(running, sandbox, pending, { steered: true })
            running.inFlight.push({ text, ids })
            yield* loop.steer(text)
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                for (const id of ids) running.preparing.delete(id)
              }),
            ),
          )
        }),
      )

    /**
     * Thread messages as the model sees them, each prefixed with its author.
     * Admitted users' attachments are written into the turn's folder first,
     * one folder per message, up to 20 MB each, and each message says where
     * its files are. Images come back for image input; a steer is text only,
     * so a steered image's note says to open it with `readFile`, which shows
     * it to the model.
     */
    const prepare = (
      running: Running,
      sandbox: ChatSandbox,
      pending: ReadonlyArray<StoredMessage>,
      options: { readonly steered: boolean } = { steered: false },
    ) =>
      Effect.gen(function* () {
        const images: Array<ChatImage> = []
        const messages = []
        for (const { message } of pending) {
          const folder = `${ATTACHMENTS_DIRECTORY}/${running.turnId}/${safeName(message.id)}`
          const used = new Set<string>()
          const notes: Array<string> = []
          if (message.author.class === "admitted")
            for (const attachment of message.attachments) {
              if (attachment.size > MAX_ATTACHMENT_BYTES) {
                notes.push(`[${attachment.name}: not fetched, it is over 20 MB]`)
                continue
              }
              let name = safeName(attachment.name)
              for (let copy = 2; used.has(name); copy++)
                name = `${copy}-${safeName(attachment.name)}`
              used.add(name)
              const path = `${folder}/${name}`
              const transfer = platform
                .download(running.thread, attachment, MAX_ATTACHMENT_BYTES)
                .pipe(
                  // Whatever size the platform reported.
                  Effect.filterOrFail(
                    (content) => content.length <= MAX_ATTACHMENT_BYTES,
                    () => new ChatPlatformError({ message: "over the attachment limit" }),
                  ),
                  Effect.flatMap((content) => Effect.as(sandbox.writeFile(path, content), content)),
                )
              // A steer's transfer is capped, so one stalled file doesn't hold
              // every later steer until the deadline.
              const saved = yield* (
                options.steered
                  ? Effect.timeoutOrElse(transfer, {
                      duration: STEERED_TRANSFER_TIMEOUT,
                      orElse: () =>
                        Effect.fail(new ChatPlatformError({ message: "the transfer timed out" })),
                    })
                  : transfer
              ).pipe(Effect.result)
              if (saved._tag === "Failure") {
                yield* Effect.logWarning("Couldn't save a chat attachment in the sandbox").pipe(
                  Effect.annotateLogs({ reason: saved.failure._tag }),
                )
                notes.push(`[${attachment.name}: couldn't be fetched]`)
                continue
              }
              const image = attachment.mediaType.startsWith("image/")
              notes.push(
                image && options.steered
                  ? `[attached: ${path}, an image: open it with readFile to see it]`
                  : `[attached: ${path}]`,
              )
              if (image) images.push({ name, mediaType: attachment.mediaType, data: saved.success })
            }
          messages.push({
            author: message.author.name,
            kind: message.author.class,
            text: [message.text, ...notes].join("\n"),
          })
        }
        return { text: threadMessages(messages), images }
      })

    /** Starts a turn for the messages waiting. Run with `transitions` held. */
    const startTurn = (thread: ChatThread) =>
      Effect.gen(function* () {
        const turnId = crypto.randomUUID()
        const claimed = (yield* storage.undelivered)
          .filter((stored) => stored.wantsTurn)
          .map(({ message }) => message.id)
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
          claimed,
        })
        yield* resumeTurn(turnId, thread, claimed)
      })

    /** Runs a saved turn in its own fiber: a new one, or a running one after a restart. */
    const resumeTurn = (turnId: string, thread: ChatThread, claimed: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        yield* keepAlive(true)
        const running: Running = {
          turnId,
          thread,
          fiber: undefined,
          steers: undefined,
          preparing: new Set(),
          claimed,
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

    /**
     * Commits a step of the loop's history with the thread messages it
     * delivered, in one transaction. Each user message the step appended
     * lands at most one text sent to the model, the oldest with its text.
     */
    const commitStep = (running: Running, change: HistoryChange) =>
      Effect.gen(function* () {
        // A compaction's replacement re-sends old messages; only appends land anything.
        const landed =
          change._tag === "Appended" ? landedInputs(running.inFlight, change.messages) : []
        yield* storage.commitStep(
          running.turnId,
          change,
          landed.flatMap((sent) => sent.ids),
        )
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
        // A resume waits for its sandbox no longer than the turn's deadline. The
        // first acquire's wait in the queue doesn't count against the turn.
        const remaining =
          turn.startedAt === null
            ? undefined
            : turn.startedAt + Duration.toMillis(config.deadline) - (yield* Clock.currentTimeMillis)
        if (remaining !== undefined && remaining <= 0)
          return { status: "deadline" } satisfies TurnEnd
        const budget = remaining === undefined ? undefined : Duration.millis(remaining)
        const acquiring = sandboxes.acquire({
          sessionId: entityId,
          turnId: turn.turnId,
          startBudget: budget ?? config.deadline,
          onQueued: queued,
        })
        // None once the deadline passes while waiting.
        const granted = yield* Effect.acquireRelease(
          // Interruptible, so a stop or a shutdown doesn't wait out the queue.
          Effect.interruptible(
            budget === undefined
              ? Effect.asSome(acquiring)
              : Effect.timeoutOption(acquiring, budget),
          ).pipe(Effect.result),
          (result) =>
            result._tag === "Success" && Option.isSome(result.success)
              ? sandboxes.release(entityId, result.success.value.generation)
              : Effect.void,
        )
        if (granted._tag === "Failure") {
          const error = granted.failure
          yield* Effect.logWarning("Couldn't get a chat sandbox").pipe(
            Effect.annotateLogs({ reason: error._tag }),
          )
          return {
            status: "failed",
            errorCategory: error._tag === "SandboxBusy" ? "busy" : "sandbox_unavailable",
          } satisfies TurnEnd
        }
        if (Option.isNone(granted.success)) return { status: "deadline" } satisfies TurnEnd
        const sandbox = granted.success.value
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
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            running.steers = undefined
          }),
        )
        // Fetching attachments counts against the turn's deadline.
        const preparing = yield* prepare(running, sandbox, pending).pipe(
          Effect.timeoutOption(Duration.millis(deadline - now)),
        )
        if (Option.isNone(preparing)) return { status: "deadline" } satisfies TurnEnd
        const prepared = preparing.value
        const prompt = [
          ...(resumed ? [resumeMessage] : []),
          ...(pending.length === 0 ? [] : [prepared.text]),
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
          executor: sandbox.executor,
          history,
          prompt,
          images: prepared.images,
          onStep: (change) => commitStep(running, change),
          onProgress: (progress) =>
            Effect.gen(function* () {
              const actions = base.actions + progress.actions
              running.view = `Working · ${actionCount(actions)}${progress.note === null ? "" : ` · ${progress.note}`}`
              yield* storage.updateTurn(turn.turnId, (state) => ({
                ...state,
                actions,
                usage: addUsage(base.usage, progress.usage),
              }))
              yield* saveProgress
            }).pipe(Effect.orDie),
        })
        yield* Semaphore.withPermits(
          transitions,
          1,
        )(
          Effect.gen(function* () {
            const steers = yield* Queue.unbounded<ReadonlyArray<StoredMessage>>()
            yield* Effect.forkScoped(steerWorker(running, loop, sandbox, steers))
            running.steers = steers
            yield* steerPending(running)
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
            return yield* Semaphore.withPermits(
              replyContext,
              1,
            )(
              Effect.gen(function* () {
                const answered = running.claimed.at(-1)
                const message =
                  answered === undefined ? Option.none() : yield* storage.message(answered)
                const replyTo = Option.isSome(message)
                  ? { messageId: message.value.id, authorId: message.value.author.id }
                  : undefined
                // Never retried here: the transport retries what is safe to retry.
                const posted = yield* platform
                  .postReply(running.thread, result.text, { replyTo })
                  .pipe(Effect.result)
                if (posted._tag === "Failure") {
                  yield* Effect.logError("Couldn't post a chat reply").pipe(
                    Effect.annotateLogs({ reason: posted.failure.message }),
                  )
                  return { status: "failed", errorCategory: "reply_failed" } satisfies TurnEnd
                }
                yield* storage.addReply(running.turnId, result.text, posted.success)
                return { status: "replied" } satisfies TurnEnd
              }),
            )
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
            yield* Effect.forkIn(
              withLogs(
                Effect.andThen(
                  stopTurn,
                  Semaphore.withPermits(inbox, 1)(announceSwitchedOff(running.thread)),
                ),
              ),
              entityScope,
            )
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

    /** Tells the thread once that the bot is switched off. Run with `inbox` held. */
    const announceSwitchedOff = (thread: ChatThread) =>
      Effect.gen(function* () {
        const session = yield* storage.loadSession
        if (Option.isNone(session) || session.value.switchedOffNotified) return
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
          return yield* announceSwitchedOff(thread)
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
          const recent = yield* Semaphore.withPermits(
            replyContext,
            1,
          )(storage.recent(GATE_CONTEXT, message))
          const decided = yield* gate
            // A posted reply can share the incoming message's timestamp. The
            // message being gated must still be the newest one in the input.
            .decide([...recent.filter((earlier) => earlier.id !== message.id), message])
            .pipe(Effect.result)
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

    /**
     * Backfills a thread the bot just joined: its earlier messages, as
     * context. Succeeds with whether the thread's history was read.
     */
    const backfill = (thread: ChatThread, joinedWith: string) =>
      platform.history(thread, BACKFILL).pipe(
        Effect.flatMap((messages) =>
          Effect.forEach(
            messages.filter((message) => message.id !== joinedWith),
            (message) => storage.addMessage(message, { _tag: "Context" }),
            { discard: true },
          ),
        ),
        Effect.as(true),
        Effect.catchTag("ChatPlatformError", (error) =>
          Effect.logWarning("Couldn't backfill a chat thread").pipe(
            Effect.annotateLogs({ reason: error.message }),
            Effect.as(false),
          ),
        ),
      )

    /** Ends the session: stops its turn and deletes its storage. */
    const drop = Effect.gen(function* () {
      yield* stopTurn
      // The index row goes first and the storage only once it's gone, under
      // `indexing` so no save comes between. A failure leaves both, so the
      // page never lists a session whose transcript is gone, and a replay
      // after a crash runs the same steps again.
      yield* Semaphore.withPermits(
        indexing,
        1,
      )(
        Effect.gen(function* () {
          yield* index
            .remove(entityId)
            .pipe(Effect.retry({ times: 4, schedule: Schedule.exponential("1 second") }))
          yield* storage.drop
          dropped = true
        }),
      )
      yield* keepAlive(false)
    })

    // A rebuilt entity picks up where it was: a running turn resumes, and a
    // message stored but not yet gated is gated now.
    if (!dropped) {
      yield* storage.ensureTables.pipe(Effect.orDie)
      const turns = yield* storage.turns.pipe(Effect.orDie)
      const session = yield* storage.loadSession.pipe(Effect.orDie)
      const running = turns.find((turn) => turn.status === "running")
      if (Option.isSome(session)) {
        const thread = session.value.thread
        if (running !== undefined)
          yield* Semaphore.withPermits(
            transitions,
            1,
          )(resumeTurn(running.turnId, thread, running.claimed)).pipe(withLogs, Effect.orDie)
        yield* Effect.forkIn(
          Semaphore.withPermits(
            inbox,
            1,
          )(
            Effect.gen(function* () {
              const ungated = yield* storage.ungated
              yield* Effect.forEach(ungated, ({ message }) => handle(thread, message), {
                discard: true,
              })
              // Gated as wanting a turn, but stopped before the turn was saved.
              yield* Semaphore.withPermits(
                transitions,
                1,
              )(
                Effect.gen(function* () {
                  if (current !== undefined || !(yield* storage.hasWanted)) return
                  if (switchedOff(yield* killSwitch.get, thread)) return
                  yield* startTurn(thread)
                }),
              )
            }),
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
            let state: SessionState = Option.isSome(session)
              ? { ...session.value, lastMessageAt: now }
              : { thread, lastMessageAt: now, switchedOffNotified: false }
            // The session row is saved only once the backfill is done: a
            // restart during it replays this message, which backfills again.
            // A failed backfill is retried with the next message.
            if (Option.isNone(session) || state.backfillPending === true) {
              const { backfillPending: _, ...rest } = state
              state = (yield* backfill(thread, message.id))
                ? rest
                : { ...rest, backfillPending: true }
              yield* storage.saveSession(state)
            }
            if (!(yield* storage.addMessage(message, null))) return
            yield* storage.saveSession(state)
            const config = yield* Effect.orDie(chatSessionConfig)
            yield* scheduleExpiry(now, config.retention)
            yield* handle(thread, message)
            yield* saveIndex
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

      Cancel: () =>
        Semaphore.withPermits(
          inbox,
          1,
        )(
          Effect.gen(function* () {
            if (dropped) return
            yield* Effect.logInfo("Chat turn cancelled from the web app")
            yield* stopTurn
          }),
        ).pipe(withLogs, Effect.orDie),

      RememberAdmission: ({ payload }) =>
        Effect.gen(function* () {
          yield* storage.ensureTables
          yield* storage.rememberAdmission(
            payload.userId,
            payload.name,
            yield* Clock.currentTimeMillis,
          )
        }).pipe(withLogs, Effect.orDie),

      CachedAdmission: ({ payload }) =>
        Effect.gen(function* () {
          const admission = yield* storage.admission(payload.userId)
          const now = yield* Clock.currentTimeMillis
          return Option.match(admission, {
            onNone: () => null,
            onSome: ({ at, name }) => (now - at < Duration.toMillis(ADMISSION_TTL) ? name : null),
          })
        }).pipe(withLogs, Effect.orDie),

      Exists: () =>
        Effect.suspend(() => (dropped ? Effect.succeed(false) : storage.exists)).pipe(
          withLogs,
          Effect.orDie,
        ),

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
            yield* drop.pipe(
              Effect.andThen(Effect.logInfo("Chat session expired")),
              Effect.catch((error) =>
                Effect.logWarning(
                  "Couldn't end the expired chat session; trying again later",
                  error,
                ).pipe(Effect.andThen(scheduleExpiry(payload.lastMessageAt, EXPIRE_RETRY))),
              ),
            )
          }),
        ).pipe(withLogs, Effect.orDie),

      Transcript: () =>
        Effect.gen(function* () {
          if (dropped) return { _tag: "Expired" } as const
          const { messages, turns, history } = yield* storage.transcript
          if (messages.length === 0 && turns.length === 0) return { _tag: "Expired" } as const
          return {
            _tag: "Available",
            messages: messages.map(({ message, gate }) => ({ ...message, gate: gate! })),
            turns: turns.map((turn) => ({
              turnId: turn.turnId,
              status: turn.status,
              errorCategory: turn.errorCategory,
              resumes: turn.resumes,
              wrappedUp: turn.wrappedUp,
              model: turn.model,
              actions: turn.actions,
              usage: turn.usage,
              queuedAt: DateTime.makeUnsafe(turn.createdAt),
              startedAt: turn.startedAt === null ? null : DateTime.makeUnsafe(turn.startedAt),
              finishedAt: turn.finishedAt === null ? null : DateTime.makeUnsafe(turn.finishedAt),
              messages: history.get(turn.turnId) ?? [],
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
  | ChatSessionIndex
  | LanguageModel.LanguageModel
  | Model.ProviderName
  | Model.ModelName
  | DecisionModel.DecisionModel
  | Sharding.Sharding
> = ChatSessionEntityLayer.pipe(Layer.provide([ChatAgentLayer, ReplyGate.layer]))

/**
 * Calls a thread's session entity through the cluster's client, for the
 * platform ingresses. `provide` is the cluster handle's: ingress is built
 * before any request brings `Sharding`. Every failure becomes `onError`'s.
 */
export const sessionClient =
  <E2>(
    provide: <A, E>(effect: Effect.Effect<A, E, Sharding.Sharding>) => Effect.Effect<A, E>,
    onError: (error: unknown) => E2,
  ) =>
  <A, E>(
    thread: ChatThread,
    call: (
      client: ReturnType<Effect.Success<typeof ChatSession.client>>,
    ) => Effect.Effect<A, E, Sharding.Sharding>,
  ): Effect.Effect<A, E2> =>
    provide(Effect.flatMap(ChatSession.client, (client) => call(client(sessionKey(thread))))).pipe(
      Effect.mapError(onError),
    )
