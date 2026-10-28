import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import * as AgentExecutor from "clanka/AgentExecutor"
import * as AiError from "effect/ai/AiError"
import * as DecisionModel from "effect/ai/DecisionModel"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import type * as Prompt from "effect/ai/Prompt"
import type * as Response from "effect/ai/Response"
import * as Clock from "effect/Clock"
import * as MessageStorage from "effect/cluster/MessageStorage"
import * as RunnerHealth from "effect/cluster/RunnerHealth"
import * as Runners from "effect/cluster/Runners"
import * as RunnerStorage from "effect/cluster/RunnerStorage"
import * as Sharding from "effect/cluster/Sharding"
import * as ShardingConfig from "effect/cluster/ShardingConfig"
import type * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Reactivity from "effect/reactivity/Reactivity"
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError"
import type * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import type { SessionSummary } from "@janitor/domain/Chat/Session"
import { ChatKillSwitch, type KillSwitchState } from "../../src/Chat/KillSwitch.ts"
import {
  type AuthorClass,
  type ChatAttachment,
  type ChatMessage,
  ChatPlatform,
  ChatPlatformError,
  type ChatThread,
  sessionKey,
} from "../../src/Chat/Platform.ts"
import { ChatSandboxes } from "../../src/Chat/Sandbox/Sandboxes.ts"
import { SandboxBusy } from "../../src/Chat/Sandbox/Pool.ts"
import { ChatSession, ChatSessionLayer } from "../../src/Chat/Session.ts"
import { ChatSessionIndex } from "../../src/Chat/SessionIndex.ts"

/**
 * The chat session entity under test, the way the cluster runs it: an
 * in-memory runner over message storage and Durable Object SQLite that
 * outlive it, so a test can restart the runner as a deploy would. Around it
 * are fakes for what it talks to: the platform, the `CHAT_AI_*` model, the
 * reply gate's decision model, the sandbox pool with its executor, and the
 * kill switch. Nothing waits for the cluster to drain, since a running turn
 * may hold a handler open; tests step the clock until what they expect holds.
 */

export const slackThread: ChatThread = {
  _tag: "Slack",
  team: "T1",
  channel: "C1",
  threadTs: "1700000000.000100",
}
export const discordThread: ChatThread = { _tag: "Discord", guild: "G1", threadId: "900" }

/** Everything messages show the model: their text, the scripts it ran and their results. */
export const seen = (prompt: Prompt.Prompt) =>
  prompt.content
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.map((part) =>
            part.type === "text"
              ? part.text
              : part.type === "tool-call"
                ? JSON.stringify(part.params)
                : part.type === "tool-result"
                  ? JSON.stringify(part.result)
                  : "",
          ),
    )
    .join("\n")

/** What one model call answers. */
export type Answer = () => Stream.Stream<Response.StreamPartEncoded, AiError.AiError>

interface TokenUsage {
  readonly input: number
  readonly output: number
  readonly cacheRead?: number
}

const finish = (reason: "stop" | "tool-calls", usage: TokenUsage | undefined) =>
  usage === undefined
    ? []
    : [
        {
          type: "finish" as const,
          reason,
          usage: {
            inputTokens: { total: usage.input, cacheRead: usage.cacheRead },
            outputTokens: { total: usage.output },
          },
        },
      ]

/** A plain reply: with conversation mode on, it ends the turn. */
export const say =
  (text: string, usage?: TokenUsage): Answer =>
  () =>
    Stream.fromIterable<Response.StreamPartEncoded>([
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: text },
      { type: "text-end", id: "text" },
      ...finish("stop", usage),
    ])

let calls = 0

/** Runs `script` in the sandbox through clanka's `execute` tool. */
export const run =
  (script: string, usage?: TokenUsage): Answer =>
  () =>
    Stream.fromIterable<Response.StreamPartEncoded>([
      { type: "tool-call", id: `call-${++calls}`, name: "execute", params: { script } },
      ...finish("tool-calls", usage),
    ])

/** A provider failure clanka doesn't retry. */
export const quotaExhausted: Answer = () =>
  Stream.fail(
    AiError.make({
      module: "OpenAiLanguageModel",
      method: "streamText",
      reason: new AiError.QuotaExhaustedError({}),
    }),
  )

/**
 * The `CHAT_AI_*` model. Each call is recorded as it arrives, then waits
 * for the test to `answer` it, so a test can act while the model "thinks".
 */
export class FakeModel {
  readonly prompts: Array<Prompt.Prompt> = []
  private readonly answers: Array<Answer> = []
  private answered = Deferred.makeUnsafe<void>()

  /** Queues answers for the next calls, in order. */
  answer(...answers: ReadonlyArray<Answer>) {
    this.answers.push(...answers)
    const answered = this.answered
    this.answered = Deferred.makeUnsafe<void>()
    Deferred.doneUnsafe(answered, Effect.void)
  }

  /** The prompt of the latest call. */
  get last(): Prompt.Prompt {
    const prompt = this.prompts.at(-1)
    if (prompt === undefined) throw new Error("The model was never called")
    return prompt
  }

  private readonly next: Effect.Effect<Answer> = Effect.suspend(() => {
    const answer = this.answers.shift()
    return answer !== undefined
      ? Effect.succeed(answer)
      : Effect.andThen(Deferred.await(this.answered), this.next)
  })

  get layer() {
    return Layer.mergeAll(
      Layer.effect(
        LanguageModel.LanguageModel,
        LanguageModel.make({
          generateText: () => Effect.die("unexpected generateText call"),
          streamText: ({ prompt }) =>
            Stream.unwrap(
              Effect.suspend(() => {
                this.prompts.push(prompt)
                return Effect.map(this.next, (answer) => answer())
              }),
            ),
        }),
      ),
      Layer.succeed(Model.ProviderName, "test-provider"),
      Layer.succeed(Model.ModelName, "test-model"),
    )
  }
}

/** The reply gate's decision model: every question gets `answer`, and each input is kept. */
export class FakeGate {
  readonly inputs: Array<Schema.Json> = []
  answer: number | "fail" = 0

  get layer() {
    return Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: (options) =>
          Effect.suspend(() => {
            this.inputs.push(options.state)
            const answer = this.answer
            if (answer === "fail")
              return Effect.fail(
                AiError.make({
                  module: "OpenRouterDecisionModel",
                  method: "decide",
                  reason: new AiError.InternalProviderError({ description: "Jev is down" }),
                }),
              )
            return Effect.succeed({
              answers: Object.fromEntries(
                Object.keys(options.decisions).map((key) => [
                  key,
                  { _tag: "Probability" as const, probability: answer },
                ]),
              ),
              usage: { inputTokens: 100, outputTokens: 1 },
            })
          }),
      }),
    )
  }
}

/** What a script finds when its sandbox's container is gone: the executor's transport fails. */
const lostSandbox = new RpcClientError({
  reason: new RpcClientDefect({ message: "fetch failed", cause: null }),
})

/**
 * The sandbox pool. Every acquire succeeds at once with an executor that
 * runs no real command: each script is recorded and answers "ok".
 */
export class FakeSandboxes {
  readonly acquires: Array<string> = []
  readonly releases: Array<string> = []
  readonly scripts: Array<string> = []
  /** Every file written into a sandbox, as attachments are. */
  readonly written: Array<{ readonly path: string; readonly content: Uint8Array }> = []
  /** How many more scripts find their sandbox gone. */
  lose = 0
  /** While set, a script runs until `finishScripts` or `loseScripts`, as a long build would. */
  hang = false
  /** While set, an acquire waits for ever, as when every sandbox is running a turn. */
  holdAcquires = false
  /** While set, the pool refuses an acquire after its queue timeout. */
  busy = false
  private finished = Deferred.makeUnsafe<"ok" | "lost">()

  finishScripts() {
    this.endScripts("ok")
  }

  /** Ends the scripts running now as their container goes away. */
  loseScripts() {
    this.endScripts("lost")
  }

  private endScripts(end: "ok" | "lost") {
    const finished = this.finished
    this.finished = Deferred.makeUnsafe<"ok" | "lost">()
    Deferred.doneUnsafe(finished, Effect.succeed(end))
  }

  private readonly executor = Layer.succeed(
    AgentExecutor.AgentExecutor,
    AgentExecutor.AgentExecutor.of({
      capabilities: Effect.succeed(
        new AgentExecutor.Capabilities({
          toolsDts: "",
          instructions: Option.none(),
          supportsSearch: false,
          environment: new AgentExecutor.ExecutionEnvironment({
            cwd: "/workspace",
            baseline: [],
            seen: [],
          }),
          tools: [],
        }),
      ),
      execute: ({ script }) =>
        Stream.unwrap(
          Effect.suspend(() => {
            this.scripts.push(script)
            if (this.lose > 0) {
              this.lose -= 1
              return Effect.succeed(Stream.die(lostSandbox))
            }
            return Effect.map(
              this.hang ? Deferred.await(this.finished) : Effect.succeed("ok" as const),
              (end) => (end === "ok" ? Stream.make("ok") : Stream.die(lostSandbox)),
            )
          }),
        ),
      executeUnsafe: () => Effect.die("unexpected executeUnsafe call"),
    }),
  )

  get layer() {
    return Layer.succeed(ChatSandboxes, {
      acquire: ({ sessionId }) =>
        Effect.suspend(() => {
          const fresh = !this.acquires.includes(sessionId)
          this.acquires.push(sessionId)
          if (this.busy) return Effect.fail(new SandboxBusy())
          const sandbox = {
            fresh,
            generation: this.acquires.length,
            executor: this.executor,
            writeFile: (path: string, content: Uint8Array) =>
              Effect.sync(() => {
                this.written.push({ path, content })
              }),
          }
          return this.holdAcquires ? Effect.never : Effect.succeed(sandbox)
        }),
      release: (sessionId) =>
        Effect.sync(() => {
          this.releases.push(sessionId)
        }),
    })
  }
}

/** One status message: its thread, and every text it showed, the latest last. */
export interface FakeStatus {
  readonly thread: ChatThread
  readonly texts: Array<string>
  deleted: boolean
}

/** Slack and Discord. Status messages, replies and downloads are recorded. */
export class FakePlatform {
  readonly statuses: Array<FakeStatus> = []
  readonly statusDeletes: Array<{ readonly thread: ChatThread; readonly messageId: string }> = []
  /** While set, deleting a status fails, as a denied delete does. */
  failStatusDeletes = false
  readonly replies: Array<{ readonly thread: ChatThread; readonly text: string }> = []
  /** Replies still being posted. */
  posting = 0
  /** While set, posting a reply waits for it. */
  holdReplies: Deferred.Deferred<void> | undefined
  /** While set, posting a reply fails, as a denied post does. */
  failReplies = false
  /** The thread's earlier messages, which the backfill reads. */
  threadHistory: ReadonlyArray<ChatMessage> = []
  /** Reads of the thread's history so far. */
  historyReads = 0
  /** While set, reading the thread's history never finishes. */
  holdHistory = false
  /** While set, reading the thread's history fails. */
  failHistory = false
  /** Each attachment's bytes, by attachment id. */
  readonly files = new Map<string, Uint8Array>()
  /** The ids of the attachments downloaded, in order. */
  readonly downloads: Array<string> = []
  /** While set, a download never finishes, as a stalled transfer doesn't. */
  holdDownloads = false
  /** Attachments whose download waits for `releaseDownloads`. */
  private readonly held = new Set<string>()
  private released = Deferred.makeUnsafe<void>()

  /** Holds the download of attachment `id` until `releaseDownloads`, as a slow transfer would. */
  holdDownload(id: string) {
    this.held.add(id)
  }

  releaseDownloads() {
    this.held.clear()
    const released = this.released
    this.released = Deferred.makeUnsafe<void>()
    Deferred.doneUnsafe(released, Effect.void)
  }

  /** The latest text of each status message in `thread`, in order. */
  statusTexts(thread: ChatThread) {
    return this.statuses
      .filter((status) => !status.deleted)
      .filter((status) => sessionKey(status.thread) === sessionKey(thread))
      .map((status) => status.texts.at(-1)!)
  }

  readonly deleteStatus = (thread: ChatThread, messageId: string) =>
    Effect.suspend(() => {
      this.statusDeletes.push({ thread, messageId })
      if (this.failStatusDeletes)
        return Effect.fail(new ChatPlatformError({ message: "missing_permissions" }))
      this.statuses[Number(messageId)]!.deleted = true
      return Effect.void
    })

  get layer() {
    // The tests introduce this operation before the production platform contract does.
    const platform: Context.Service.Shape<typeof ChatPlatform> &
      Pick<FakePlatform, "deleteStatus"> = {
      deleteStatus: this.deleteStatus,
      postStatus: (thread, text) =>
        Effect.sync(() =>
          String(this.statuses.push({ thread, texts: [text], deleted: false }) - 1),
        ),
      editStatus: (_thread, messageId, text) =>
        Effect.sync(() => {
          this.statuses[Number(messageId)]!.texts.push(text)
        }),
      postReply: (thread, text) =>
        Effect.gen({ self: this }, function* () {
          this.posting += 1
          if (this.holdReplies !== undefined) yield* Deferred.await(this.holdReplies)
          this.posting -= 1
          if (this.failReplies)
            return yield* new ChatPlatformError({ message: "channel_not_found" })
          this.replies.push({ thread, text })
          return yield* DateTime.now
        }),
      uploadFile: () => Effect.die("unexpected file upload"),
      download: (_thread, attachment, maxBytes) =>
        Effect.suspend(() => {
          this.downloads.push(attachment.id)
          if (this.holdDownloads) return Effect.never
          return Effect.andThen(
            this.held.has(attachment.id) ? Deferred.await(this.released) : Effect.void,
            Effect.suspend(() => {
              const content = this.files.get(attachment.id) ?? new Uint8Array()
              return content.length > maxBytes
                ? Effect.fail(new ChatPlatformError({ message: "file_too_large" }))
                : Effect.succeed(content)
            }),
          )
        }),
      history: () =>
        Effect.suspend(() => {
          this.historyReads += 1
          if (this.holdHistory) return Effect.never
          return this.failHistory
            ? Effect.fail(new ChatPlatformError({ message: "ratelimited" }))
            : Effect.succeed(this.threadHistory)
        }),
    }
    return Layer.succeed(ChatPlatform, platform)
  }
}

/** The sessions page's index, in memory. */
const memoryIndex = () => {
  const rows = new Map<string, SessionSummary>()
  return Layer.succeed(ChatSessionIndex, {
    save: (summary) => Effect.sync(() => void rows.set(summary.sessionId, summary)),
    remove: (sessionId) => Effect.sync(() => void rows.delete(sessionId)),
    get: (sessionId) => Effect.sync(() => Option.fromNullishOr(rows.get(sessionId))),
    list: Effect.sync(() => [...rows.values()]),
  })
}

/** One runner with the session entity on it, over the Durable Object's SQLite file. */
const makeRunner = (options: {
  readonly filename: string
  readonly storage: Context.Context<MessageStorage.MemoryDriver>
  readonly services: Layer.Layer<
    | ChatPlatform
    | ChatSandboxes
    | ChatKillSwitch
    | ChatSessionIndex
    | LanguageModel.LanguageModel
    | Model.ProviderName
    | Model.ModelName
    | DecisionModel.DecisionModel
  >
}) => {
  const Cluster = Sharding.layer.pipe(
    Layer.provideMerge(Runners.layerNoop),
    Layer.provideMerge(
      Layer.effect(
        MessageStorage.MessageStorage,
        Effect.map(MessageStorage.MemoryDriver, (driver) => driver.storage),
      ),
    ),
    Layer.provide([RunnerStorage.layerMemory, RunnerHealth.layerNoop]),
    Layer.provide(ShardingConfig.layer()),
    Layer.provideMerge(Layer.succeedContext(options.storage)),
  )
  const DurableObjectStorage = Layer.effect(
    CloudflareCluster.DurableObjectSqlClient,
    SqliteClient.make({ filename: options.filename }),
  ).pipe(Layer.provide(Reactivity.layer))
  return ChatSessionLayer.pipe(
    Layer.provideMerge(options.services),
    Layer.provideMerge(DurableObjectStorage),
    Layer.provideMerge(Cluster),
  )
}

/** Lets the event loop run, so file I/O can land; the test clock stays put. */
const yieldToIo = TestClock.withLive(Effect.sleep(Duration.millis(1)))

let messages = 0

/** Builds the harness for one test, with its own Durable Object storage. */
export const makeSessionHarness = Effect.gen(function* () {
  const platform = new FakePlatform()
  const model = new FakeModel()
  const gate = new FakeGate()
  const sandboxes = new FakeSandboxes()
  const killSwitch: { -readonly [K in keyof KillSwitchState]: KillSwitchState[K] } = {
    global: false,
    slack: false,
    discord: false,
  }

  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "janitor-chat-session-" })
  const filename = path.join(directory, "durable-object.sqlite")
  const storage = yield* Layer.build(MessageStorage.MemoryDriver.layer)

  const Runner = makeRunner({
    filename,
    storage,
    services: Layer.mergeAll(
      platform.layer,
      sandboxes.layer,
      Layer.succeed(ChatKillSwitch, { get: Effect.sync(() => ({ ...killSwitch })) }),
      memoryIndex(),
      model.layer,
      gate.layer,
    ),
  })

  let scope = yield* Scope.make()
  let runner = yield* Layer.buildWithScope(Runner, scope)
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))

  const use = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => Effect.provideContext(effect, runner))

  const client = (thread: ChatThread) =>
    use(Effect.map(ChatSession.client, (make) => make(sessionKey(thread))))

  /** Runs `effect` to completion while moving the clock in small steps. */
  const stepping = <A, E>(effect: Effect.Effect<A, E>, what: string) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(effect)
      for (let step = 0; fiber.pollUnsafe() === undefined; step++) {
        if (step === 2_000) return yield* Effect.die(new Error(`Timed out waiting for ${what}`))
        yield* yieldToIo
        yield* TestClock.adjust(Duration.millis(100))
      }
      return yield* Fiber.join(fiber)
    })

  /** Delivers `message` as ingress does and waits for the session to acknowledge it. */
  const deliver = (thread: ChatThread, message: ChatMessage) =>
    Effect.flatMap(client(thread), (session) =>
      stepping(use(session.Receive({ thread, message })), "Receive"),
    )

  return {
    platform,
    model,
    gate,
    sandboxes,
    killSwitch,

    /** A new message in `thread`, sent now by `author` (an admitted "Ada" by default). */
    message: (
      text: string,
      options: {
        readonly author?: string
        readonly class?: AuthorClass
        readonly mention?: boolean
        readonly attachments?: ReadonlyArray<ChatAttachment>
      } = {},
    ) =>
      Effect.map(Clock.currentTimeMillis, (now): ChatMessage => {
        const name = options.author ?? "Ada"
        return {
          id: `${1_700_000_100 + ++messages}.000100`,
          author: { id: `U-${name}`, name, class: options.class ?? "admitted" },
          text,
          mentionsBot: options.mention ?? false,
          sentAt: DateTime.makeUnsafe(now),
          attachments: options.attachments ?? [],
        }
      }),

    deliver,

    /** Delivers `message` as Slack ingress does: done once it is stored, before the session decides it. */
    store: (thread: ChatThread, message: ChatMessage) =>
      Effect.flatMap(client(thread), (session) =>
        stepping(use(session.Receive({ thread, message }, { discard: true })), "Receive stored"),
      ),

    /** Delivers `message` twice at once, as a Slack retry racing the first delivery does. */
    deliverTwiceAtOnce: (thread: ChatThread, message: ChatMessage) =>
      Effect.flatMap(client(thread), (session) =>
        stepping(
          Effect.all(
            [use(session.Receive({ thread, message })), use(session.Receive({ thread, message }))],
            { concurrency: "unbounded" },
          ),
          "both deliveries",
        ),
      ),

    /** Deletes the session, as the web app does. */
    remove: (thread: ChatThread) =>
      Effect.flatMap(client(thread), (session) => stepping(use(session.Delete({})), "Delete")),

    /** Stops the running turn, as the web app does. */
    cancel: (thread: ChatThread) =>
      Effect.flatMap(client(thread), (session) => stepping(use(session.Cancel({})), "Cancel")),

    /** Remembers `userId` as admitted, as Slack ingress does after `users.info`. */
    admit: (thread: ChatThread, userId: string) =>
      Effect.flatMap(client(thread), (session) =>
        stepping(use(session.RememberAdmission({ userId, name: userId })), "RememberAdmission"),
      ),

    /** Whether the session remembers `userId` as admitted. */
    admitted: (thread: ChatThread, userId: string) =>
      Effect.flatMap(client(thread), (session) =>
        use(Effect.orDie(session.CachedAdmission({ userId }))).pipe(
          Effect.map((name) => name !== null),
        ),
      ),

    transcript: (thread: ChatThread) =>
      Effect.flatMap(client(thread), (session) => use(Effect.orDie(session.Transcript()))),

    /** Moves the clock in small steps until `done` holds. */
    until: (done: Effect.Effect<boolean>, what: string) =>
      stepping(
        Effect.gen(function* () {
          while (!(yield* done)) yield* Effect.sleep(Duration.millis(100))
        }),
        what,
      ),

    /** Moves the clock by `duration` in steps of at most `step`. */
    wait: (duration: Duration.Input, step: Duration.Input = "5 seconds") =>
      Effect.gen(function* () {
        const total = Duration.toMillis(Duration.fromInputUnsafe(duration))
        const each = Duration.toMillis(Duration.fromInputUnsafe(step))
        for (let elapsed = 0; elapsed < total; elapsed += each) {
          yield* TestClock.adjust(Duration.millis(Math.min(each, total - elapsed)))
          yield* yieldToIo
        }
      }),

    /** Stops the runner, as a deploy or an eviction does, and starts a new one over the same storage. */
    restart: Effect.gen(function* () {
      yield* stepping(Scope.close(scope, Exit.void), "the runner to stop")
      scope = yield* Scope.make()
      runner = yield* Layer.buildWithScope(Runner, scope)
    }),

    /** The tables in the session's Durable Object storage. */
    tables: use(
      Effect.gen(function* () {
        const sql = yield* CloudflareCluster.DurableObjectSqlClient
        const rows = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
        return rows.map((row) => row.name)
      }).pipe(Effect.orDie),
    ),
  }
})

export type SessionHarness = Effect.Success<typeof makeSessionHarness>
