// Constructs the pinned OpenCode Workerd host for one session Durable Object
// and runs turns through it.
//
// The host is the SDK's embedded runtime with the Workerd profile: Durable
// Object SQLite for the database, Janitor's model execution and model
// resolution, and the sandbox-backed tools in place of every native tool.
// The native suspended-session recovery sweep is replaced with an inert one:
// the coordinator decides when an interrupted turn runs again, and a restart
// never restarts the model on its own.
import { Effect, Layer, ManagedRuntime, Schema, Semaphore, type Scope } from "effect"
import { HttpClient } from "effect/unstable/http"
import { AbsolutePath, Location, OpenCode, Session, type Tool } from "@opencode/sdk/effect"
import { LLMClient, RequestExecutor } from "@opencode/ai/route"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { ServerWorkerd } from "@opencode/server/workerd"
import { WorkspaceDriver } from "@opencode/core/workspace/driver"
import { makeMemoryDriver } from "@opencode/core/environment/index"
import { resolverLayer, type ModelConfigurations, type SecretReader } from "./ModelConfiguration.ts"
import { redactModelEvents } from "./ModelCredentials.ts"
import type { RunnerStorage } from "./Storage.ts"
import {
  HostError,
  type TurnHost,
  type TurnOutcome,
  type TurnRequest,
} from "./services/TurnHost.ts"

/** The workspace provider name registered with the native host. */
export const WORKSPACE_PROVIDER = "janitor"

/** Guidance attached to every session's native instructions. */
const CONVERSATION_GUIDANCE =
  "You collaborate with a team through a chat thread. Ask questions in ordinary replies and end your turn when you need a teammate's answer; the next message in the thread continues the conversation. Begin every turn with one short sentence saying what you are about to do, then do it. Each message you write is delivered to the thread as it lands, and your final message ends the turn; keep intermediate commentary short. Run commands in the foreground with a finite timeout; background processes are stopped when the turn ends."

export interface HostDependencies {
  readonly storage: DurableObjectStorage
  readonly store: RunnerStorage
  readonly configurations: ModelConfigurations
  /** The session's persisted model configuration id. */
  readonly selection: () => string | undefined
  readonly secrets: SecretReader
  /** Model transport with the inactivity deadline already applied. */
  readonly httpClient: HttpClient.HttpClient
  readonly tools: () => ReadonlyArray<Tool.Info>
  readonly session: () =>
    | {
        readonly nativeSessionId: string
        readonly title: string
        readonly repositoryId: string | null
      }
    | undefined
  readonly journal: (kind: string, data?: unknown) => void
}

export interface Host {
  readonly sdk: <A, E>(
    f: (sdk: OpenCode.Interface) => Effect.Effect<A, E, Scope.Scope>,
  ) => Promise<A>
  readonly dispose: () => Promise<void>
}

const InertRestart = Layer.succeed(SessionRestart.Service, { resumeSuspendedSessions: Effect.void })

export const createHost = (deps: HostDependencies): Promise<Host> => {
  const executor = RequestExecutor.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, deps.httpClient)),
  )
  const client = Layer.effect(
    LLMClient.Service,
    Effect.gen(function* () {
      const native = yield* LLMClient.Service
      return {
        ...native,
        stream: (request, options) => {
          const record = deps.configurations.records.find(
            (record) => record.id === deps.selection(),
          )
          return redactModelEvents(
            native.stream(request, options),
            record && deps.secrets(record.secretBinding),
          )
        },
      } satisfies typeof native
    }),
  ).pipe(Layer.provide(LLMClient.layer.pipe(Layer.provide(executor))))
  // Files and processes live in the sandbox; the native workspace only needs an identity.
  const driver = WorkspaceDriver.make({
    create: ({ workspaceID }) => Effect.succeed({ binding: { workspaceID } }),
    connect: () => Effect.succeed(makeMemoryDriver()),
    suspendForIdle: () => Effect.void,
    destroy: () => Effect.void,
  })
  const options = {
    storage: deps.storage,
    models: { fetch: false },
    config: { content: JSON.stringify({ experimental: { portable_shell_scanner: true } }) },
  }
  const runtime = ManagedRuntime.make(
    Layer.effect(
      OpenCode.Service,
      Effect.gen(function* () {
        const sdk = yield* OpenCode.create(
          {
            ...ServerWorkerd.serverOptions(options),
            workspaceProviders: { [WORKSPACE_PROVIDER]: driver },
          },
          {
            overrides: [
              ...ServerWorkerd.replacements(options),
              SessionRestart.node.replace(InertRestart),
              llmClient.replace(client),
              SessionRunnerModel.node.replace(
                resolverLayer(deps.configurations, deps.selection, deps.secrets),
              ),
            ],
          },
        )
        yield* sdk.plugin({
          id: "janitor-sandbox-tools",
          effect: (context) =>
            Effect.gen(function* () {
              const gate = yield* Semaphore.make(1)
              yield* context.tool.transform((editor) => {
                for (const tool of editor.list()) editor.remove(tool.id)
                for (const tool of deps.tools())
                  editor.add({
                    ...tool,
                    execute: (input, execution) =>
                      tool.execute(input, execution).pipe(gate.withPermits(1)),
                  })
              })
            }),
        })
        return sdk
      }),
    ),
  )
  const run = <A, E>(effect: Effect.Effect<A, E, OpenCode.Service>) => runtime.runPromise(effect)
  return run(Effect.map(OpenCode.Service, () => undefined)).then(() => ({
    sdk: (f) => run(Effect.flatMap(OpenCode.Service, (sdk) => Effect.scoped(f(sdk)))),
    dispose: () => runtime.dispose(),
  }))
}

const OutcomeEvent = Schema.Struct({
  reason: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) })),
  text: Schema.optionalKey(Schema.String),
})
const decodeOutcome = Schema.decodeUnknownOption(OutcomeEvent)

const INTERRUPT_SETTLEMENT_MS = 20_000
const START_GRACE_MS = 15_000
/** How long one wait for idleness runs before text blocks are checked. */
const TEXT_POLL_MS = 500

type NativeEvent = { readonly seq: number; readonly type: string; readonly data: unknown }

/** The assistant text blocks that have landed, in order; empty blocks are skipped. */
const textBlocks = (events: ReadonlyArray<NativeEvent>): ReadonlyArray<string> => {
  const blocks: string[] = []
  for (const event of events) {
    if (event.type !== "session.text.ended") continue
    const fields = decodeOutcome(event.data)
    const text = fields._tag === "Some" ? fields.value.text : undefined
    if (text !== undefined && text.trim() !== "") blocks.push(text)
  }
  return blocks
}

/**
 * Owns one native runtime per object incarnation and runs turns through it.
 * Construction is deferred to the first turn and every pre-host guard belongs
 * to the caller.
 */
export const makeTurnHost = (deps: HostDependencies): TurnHost["Service"] => {
  let host: Host | undefined
  let starting: Promise<Host> | undefined
  const ensure = (): Promise<Host> => {
    if (host) return Promise.resolve(host)
    return (starting ??= createHost(deps)
      .then(async (created) => {
        await ensureNativeSession(created)
        host = created
        deps.journal("host-created")
        return created
      })
      .finally(() => {
        starting = undefined
      }))
  }
  const ensureNativeSession = async (created: Host) => {
    const session = deps.session()
    if (session === undefined) throw new HostError({ message: "The session has not been created" })
    if (deps.store.nativeCreated) return
    const nativeId = Session.ID.make(session.nativeSessionId)
    await created.sdk((sdk) =>
      Effect.gen(function* () {
        const found = yield* sdk.sessions.get({ sessionID: nativeId }).pipe(
          Effect.map(() => true),
          Effect.catch(() => Effect.succeed(false)),
        )
        if (found) return
        const workspaceID = yield* sdk.workspace.create({ provider: WORKSPACE_PROVIDER })
        yield* sdk.sessions.create({
          id: nativeId,
          title: session.title,
          permissions: [
            { action: "*", resource: "*", effect: "deny" },
            ...deps
              .tools()
              .map((tool) => ({ action: tool.name, resource: "*", effect: "allow" as const })),
          ],
          location: Location.Ref.make({
            directory: AbsolutePath.make("/workspace/repository"),
            workspaceID,
          }),
        })
        yield* sdk.sessions.instructions.entry.put({
          sessionID: nativeId,
          key: "janitor-conversation",
          value: CONVERSATION_GUIDANCE,
        })
      }),
    )
    deps.store.nativeCreated = true
  }
  const hostError = (cause: unknown) =>
    cause instanceof HostError
      ? cause
      : new HostError({ message: cause instanceof Error ? cause.message : String(cause) })

  const outcomeAfter = (events: ReadonlyArray<NativeEvent>): TurnOutcome | undefined => {
    let text: string | undefined
    let terminal: TurnOutcome | undefined
    for (const event of events) {
      const fields = decodeOutcome(event.data)
      const data = fields._tag === "Some" ? fields.value : {}
      switch (event.type) {
        case "session.text.ended":
          if (data.text !== undefined && data.text.trim() !== "") text = data.text
          break
        case "session.execution.succeeded":
          terminal = { type: "completed", text: text ?? "" }
          break
        case "session.execution.interrupted":
          terminal = {
            type: "interrupted",
            reason:
              data.reason === "inactivity" ? "the model was inactive" : "the turn was interrupted",
          }
          break
        case "session.execution.failed":
          terminal = { type: "failed", reason: data.error?.message ?? "the model execution failed" }
          break
        default:
          break
      }
    }
    if (terminal?.type === "completed") return { type: "completed", text: text ?? "" }
    return terminal
  }

  const run = (turn: TurnRequest) =>
    Effect.gen(function* () {
      const session = deps.session()
      if (session === undefined)
        return yield* Effect.fail(new HostError({ message: "The session has not been created" }))
      const created = yield* Effect.tryPromise({ try: ensure, catch: hostError })
      const nativeId = Session.ID.make(session.nativeSessionId)
      const watermark = deps.store.nativeEventWatermark(session.nativeSessionId)
      const messageId = turn.attempt === 1 ? turn.inputId : `${turn.inputId}-a${turn.attempt}`
      yield* Effect.tryPromise({
        try: () =>
          created.sdk((sdk) =>
            Effect.gen(function* () {
              const inbox = yield* sdk.sessions.inbox.list({ sessionID: nativeId })
              for (const entry of inbox)
                if (
                  turn.cancel.some(
                    (inputId) => entry.id === inputId || entry.id.startsWith(`${inputId}-a`),
                  )
                )
                  yield* sdk.sessions.inbox
                    .cancel({ sessionID: nativeId, inboxID: entry.id })
                    .pipe(Effect.ignore)
              for (const note of turn.notes)
                yield* sdk.sessions.synthetic({
                  sessionID: nativeId,
                  text: note,
                  delivery: "queue",
                  resume: false,
                })
              // A queued message from an earlier attempt is replaced so the wake is ours.
              for (const entry of inbox)
                if (entry.id === turn.inputId || entry.id.startsWith(`${turn.inputId}-a`))
                  yield* sdk.sessions.inbox
                    .cancel({ sessionID: nativeId, inboxID: entry.id })
                    .pipe(Effect.ignore)
              yield* sdk.sessions.prompt({
                sessionID: nativeId,
                id: messageId as Parameters<typeof sdk.sessions.prompt>[0]["id"],
                text: turn.text,
                metadata: { janitor: turn.attribution },
                delivery: "queue",
                resume: true,
              })
            }),
          ),
        catch: hostError,
      })
      // Wait for the terminal event of this turn; a wake that has not yet started
      // execution reports idle, so the wait is repeated until an outcome exists.
      // The wait is bounded so text blocks are observed while the model works,
      // not only once the session is idle.
      const startedAt = Date.now()
      let delivered = 0
      for (;;) {
        yield* Effect.tryPromise({
          try: () =>
            created.sdk((sdk) =>
              sdk.sessions.wait({ sessionID: nativeId }).pipe(
                Effect.timeoutOrElse({
                  duration: `${TEXT_POLL_MS} millis`,
                  orElse: () => Effect.void,
                }),
              ),
            ),
          catch: hostError,
        })
        const events = deps.store.nativeEvents(session.nativeSessionId, watermark)
        const blocks = textBlocks(events)
        for (; delivered < blocks.length; delivered++) turn.message(delivered, blocks[delivered]!)
        const outcome = outcomeAfter(events)
        if (outcome !== undefined) return outcome
        const started = events.some((event) => event.type === "session.execution.started")
        if (!started && Date.now() - startedAt > START_GRACE_MS)
          return { type: "failed", reason: "The model turn did not start" } satisfies TurnOutcome
        yield* Effect.sleep("250 millis")
      }
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.promise(async () => {
          const session = deps.session()
          if (!host || session === undefined) return
          const nativeId = Session.ID.make(session.nativeSessionId)
          await host
            .sdk((sdk) =>
              sdk.sessions.interrupt({ sessionID: nativeId }).pipe(
                Effect.andThen(sdk.sessions.wait({ sessionID: nativeId })),
                Effect.timeoutOrElse({
                  duration: `${INTERRUPT_SETTLEMENT_MS} millis`,
                  orElse: () => Effect.void,
                }),
                Effect.ignore,
              ),
            )
            .catch(() => undefined)
        }),
      ),
      Effect.withSpan("TurnHost.run"),
    )

  const dispose = Effect.promise(async () => {
    await starting?.catch(() => undefined)
    const current = host
    host = undefined
    if (current) {
      await current.dispose()
      deps.journal("host-disposed")
    }
  })

  return { run, dispose }
}
