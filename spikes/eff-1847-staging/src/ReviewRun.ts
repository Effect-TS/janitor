import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster"
import * as OpenRouterClient from "@effect/ai-openrouter/OpenRouterClient"
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel"
import * as Agent from "clanka/Agent"
import * as AgentExecutor from "clanka/AgentExecutor"
import * as Model from "effect/ai/Model"
import * as Prompt from "effect/ai/Prompt"
import * as Cause from "effect/Cause"
import * as ClusterSchema from "effect/cluster/ClusterSchema"
import * as Entity from "effect/cluster/Entity"
import * as EntityResource from "effect/cluster/EntityResource"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import { HttpClientError, TransportError } from "effect/http/HttpClientError"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import * as MutableRef from "effect/MutableRef"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Socket from "effect/socket/Socket"
import * as Stream from "effect/Stream"

/**
 * The run entity from the EFF-1651 design, cut down to what the smoke test
 * needs: an `EntityResource` holding the clanka loop (keep-alive while a run
 * is active), history rows in the entity's own DO SQLite committed at each
 * step, resume from those rows after a restart, a persisted `Publish` with a
 * `publish_steps` journal, and `Cancel`.
 */

export const Transport = Schema.Literals(["http", "ws"])
export type Transport = typeof Transport.Type

export const ReviewRun = Entity.make("ReviewRun", [
  Rpc.make("Start", {
    payload: {
      runId: Schema.String,
      minutes: Schema.Number,
      model: Schema.String,
      sleepSeconds: Schema.Number,
      transport: Transport,
    },
    success: Schema.Unknown,
    primaryKey: ({ runId }) => `start/${runId}`,
  }).annotate(ClusterSchema.Persisted, true),
  Rpc.make("Cancel", {
    payload: { runId: Schema.String, reason: Schema.String },
    success: Schema.Unknown,
    primaryKey: ({ runId, reason }) => `cancel/${runId}/${reason}`,
  }).annotate(ClusterSchema.Persisted, true),
  Rpc.make("Publish", {
    payload: { runId: Schema.String, steps: Schema.Number, stepSeconds: Schema.Number },
    success: Schema.Unknown,
    primaryKey: ({ runId }) => `publish/${runId}`,
  }).annotate(ClusterSchema.Persisted, true),
  Rpc.make("Status", { success: Schema.Unknown }),
  Rpc.make("Probe", {
    payload: { kind: Schema.String, transport: Transport, n: Schema.Number },
    success: Schema.Unknown,
  }),
])

/** The raw Durable Object namespace of the workspace objects (`env.Eff1847Workspace`). */
export class WorkspaceNamespace extends Context.Service<WorkspaceNamespace, DurableObjectNamespace>()(
  "eff1847/WorkspaceNamespace",
) {}

/** The alchemy-typed workspace stubs (`provision`, `release`, `status`). */
export class WorkspaceStubs extends Context.Service<
  WorkspaceStubs,
  { readonly getByName: (name: string) => { readonly provision: (acquire: number) => Effect.Effect<unknown, any>; readonly release: () => Effect.Effect<unknown, any>; readonly status: () => Effect.Effect<unknown, any> } }
>()("eff1847/WorkspaceStubs") {}

export class OpenRouterKey extends Context.Service<OpenRouterKey, Redacted.Redacted<string>>()("eff1847/OpenRouterKey") {}
export class DeployMarker extends Context.Service<DeployMarker, string>()("eff1847/DeployMarker") {}

/** One process-wide id per isolate, one per handler build: tells restarts apart. */
const isolateId = Math.random().toString(36).slice(2, 10)

const SYSTEM = [
  "You are a smoke-test agent inside a scratch workspace. The workspace holds a file named AGENTS.md.",
  "Every time you receive a message, do exactly this in ONE script:",
  "1. call `bash` with the command `sleep SLEEP; date -u; cat counter.txt 2>/dev/null; echo $((1 + $(cat counter.txt 2>/dev/null || echo 0))) > counter.txt` (replace SLEEP with the number the user gives you),",
  "2. then call `taskComplete` with a one-line summary containing the date the command printed.",
  "Never ask questions, never explore, never do anything else.",
].join("\n")

export const makeReviewRunLayer = Effect.gen(function* () {
  const namespace = yield* WorkspaceNamespace
  const stubs = yield* WorkspaceStubs
  const apiKey = yield* OpenRouterKey
  const deployMarker = yield* DeployMarker

  const build = Effect.gen(function* () {
    const sql = yield* CloudflareCluster.DurableObjectSqlClient
    const address = yield* Entity.CurrentAddress
    const runId = address.entityId
    const buildId = Math.random().toString(36).slice(2, 10)
    const builtAt = Date.now()
    console.log(`[ReviewRun ${runId}] handler build ${buildId} (isolate ${isolateId}, deploy ${deployMarker})`)

    yield* sql`CREATE TABLE IF NOT EXISTS run (id TEXT PRIMARY KEY, status TEXT NOT NULL, model TEXT NOT NULL, sleep_seconds INTEGER NOT NULL, transport TEXT NOT NULL, started_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL, finished_at INTEGER, turns INTEGER NOT NULL DEFAULT 0, acquires INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, result TEXT)`
    yield* sql`CREATE TABLE IF NOT EXISTS history (seq INTEGER PRIMARY KEY, message TEXT NOT NULL)`
    yield* sql`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, build TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL)`
    yield* sql`CREATE TABLE IF NOT EXISTS publish_steps (step INTEGER PRIMARY KEY, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL, build TEXT NOT NULL)`
    yield* sql`CREATE TABLE IF NOT EXISTS publish (id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, first_started_at INTEGER, finished_at INTEGER)`

    const event = (kind: string, detail: unknown) =>
      Effect.gen(function* () {
        const text = typeof detail === "string" ? detail : JSON.stringify(detail)
        console.log(`[ReviewRun ${runId}] ${kind} ${text.slice(0, 300)}`)
        yield* sql`INSERT INTO events (at, build, kind, detail) VALUES (${Date.now()}, ${buildId}, ${kind}, ${text.slice(0, 4000)})`
      }).pipe(Effect.orDie)

    interface RunRow {
      readonly id: string
      readonly status: string
      readonly model: string
      readonly sleep_seconds: number
      readonly transport: Transport
      readonly started_at: number
      readonly deadline_at: number
      readonly finished_at: number | null
      readonly turns: number
      readonly acquires: number
      readonly input_tokens: number
      readonly output_tokens: number
      readonly result: string | null
    }
    const readRun = sql<RunRow>`SELECT * FROM run WHERE id = ${runId}`.pipe(
      Effect.map((rows) => rows[0]),
      Effect.orDie,
    )

    // ---- executor transport: entity -> workspace DO fetch -> executor port.
    const stub = namespace.getByName(runId)
    const workspaceHttpClient = HttpClient.make((request, url, signal, fiber) =>
      Effect.gen(function* () {
        const body = request.body
        const init: RequestInit & { duplex?: string } = {
          method: request.method,
          headers: request.headers as Record<string, string>,
          signal,
        }
        switch (body._tag) {
          case "Empty":
            break
          case "Uint8Array":
          case "Raw":
            init.body = body.body as BodyInit
            break
          case "FormData":
            init.body = body.formData
            break
          case "Stream":
            init.body = Stream.toReadableStreamWith(body.stream, fiber.context)
            init.duplex = "half"
            break
        }
        const response = yield* Effect.tryPromise({
          try: () => stub.fetch(url.toString().replace(/^https:/, "http:"), init as any) as Promise<Response>,
          catch: (cause) => new HttpClientError({ reason: new TransportError({ request, cause, description: "workspace DO fetch failed" }) }),
        })
        return HttpClientResponse.fromWeb(request, response)
      }),
    )
    const HttpProtocol = RpcClient.layerProtocolHttp({ url: "http://workspace/rpc" }).pipe(
      Layer.provide([RpcSerialization.layerNdjson, Layer.succeed(HttpClient.HttpClient, workspaceHttpClient)]),
    )
    const openSocket = Effect.gen(function* () {
      const raw = yield* Effect.tryPromise({
        try: () => stub.fetch("http://workspace/ws", { headers: { Upgrade: "websocket", Connection: "Upgrade" } }) as Promise<Response & { webSocket?: WebSocket | null }>,
        catch: (cause) => new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) }),
      })
      const webSocket = raw.webSocket
      if (!webSocket) {
        return yield* Effect.fail(
          new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause: new Error(`no webSocket on upgrade response (status ${raw.status})`) }) }),
        )
      }
      ;(webSocket as any).accept()
      yield* Effect.addFinalizer(() => Effect.sync(() => webSocket.close()))
      return webSocket as unknown as Socket.WebSocketLike
    })
    const WsProtocol = RpcClient.layerProtocolSocket().pipe(
      Layer.provide([RpcSerialization.layerNdjson, Layer.effect(Socket.Socket, Socket.fromWebSocket(openSocket))]),
    )
    const executorLayer = (transport: Transport) =>
      AgentExecutor.layerRpc.pipe(Layer.provide(transport === "http" ? HttpProtocol : WsProtocol))

    const modelLayer = (model: string) =>
      Layer.mergeAll(
        OpenRouterLanguageModel.layer({ model }).pipe(
          Layer.provide(OpenRouterClient.layer({ apiKey })),
          Layer.provide(FetchHttpClient.layer),
        ),
        Layer.succeed(Model.ProviderName, "openrouter"),
        Layer.succeed(Model.ModelName, model),
      )

    // ---- history rows
    const readHistory = sql<{ readonly seq: number; readonly message: string }>`SELECT seq, message FROM history ORDER BY seq`.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(Prompt.Message)(JSON.parse(row.message))),
      ),
      Effect.orDie,
    )
    let savedCount = 0
    const saveHistory = (agent: Agent.Agent, turns: number) =>
      Effect.gen(function* () {
        const messages = MutableRef.get(agent.history).content
        if (messages.length === savedCount) return { inserted: 0, replaced: false }
        const replaced = messages.length < savedCount
        const from = replaced ? 0 : savedCount
        const encoded = yield* Effect.forEach(messages.slice(from), (m) => Schema.encodeEffect(Prompt.Message)(m))
        yield* sql.withTransaction(
          Effect.gen(function* () {
            if (replaced) yield* sql`DELETE FROM history`
            for (let i = 0; i < encoded.length; i++) {
              yield* sql`INSERT INTO history (seq, message) VALUES (${from + i + 1}, ${JSON.stringify(encoded[i])})`
            }
            yield* sql`UPDATE run SET turns = ${turns} WHERE id = ${runId}`
          }),
        )
        savedCount = messages.length
        return { inserted: encoded.length, replaced }
      }).pipe(Effect.orDie)

    // ---- the loop, forked into the resource's CloseScope.
    let loop: { fiber: Fiber.Fiber<unknown, unknown>; startedAt: number; acquire: number; lastPart?: string; lastPartAt?: number; parts: number } | undefined

    const runLoop = (run: RunRow, acquire: number) =>
      Effect.gen(function* () {
        const agent = yield* Agent.make
        const restored = yield* readHistory
        // A snapshot taken mid-step may end on an assistant tool call with
        // no tool result; drop it so the resumed prompt is well formed.
        const trimmed = [...restored]
        while (trimmed.length > 0 && trimmed[trimmed.length - 1]!.role === "assistant") trimmed.pop()
        MutableRef.set(agent.history, Prompt.fromMessages(trimmed))
        savedCount = trimmed.length
        if (trimmed.length !== restored.length) yield* saveHistory(agent, run.turns)
        yield* event("LoopStart", { acquire, restoredMessages: restored.length, usedMessages: trimmed.length, turnsDone: run.turns })

        let turns = run.turns
        let resumed = acquire > 1
        let inputTokens = run.input_tokens
        let outputTokens = run.output_tokens
        while (Date.now() < run.deadline_at) {
          const turn = turns + 1
          const prompt = turn === 1
            ? `Begin. SLEEP is ${run.sleep_seconds}. This is step ${turn}.`
            : resumed
              ? `The sandbox was reset and this run was resumed; continue as if nothing happened. SLEEP is ${run.sleep_seconds}. This is step ${turn}.`
              : `Next. SLEEP is ${run.sleep_seconds}. This is step ${turn}.`
          resumed = false
          const turnStarted = Date.now()
          const outcome = yield* agent.send({ prompt, system: SYSTEM }).pipe(
            Effect.flatMap((stream) =>
              stream.pipe(
                Stream.runForEach((part) =>
                  Effect.gen(function* () {
                    if (loop) {
                      loop.parts++
                      loop.lastPart = part._tag
                      loop.lastPartAt = Date.now()
                    }
                    switch (part._tag) {
                      case "Usage": {
                        inputTokens += part.inputTokens
                        outputTokens += part.outputTokens
                        yield* sql`UPDATE run SET input_tokens = ${inputTokens}, output_tokens = ${outputTokens} WHERE id = ${runId}`.pipe(Effect.orDie)
                        const saved = yield* saveHistory(agent, turns)
                        if (saved.inserted > 0) yield* event("HistorySaved", { turn, ...saved, total: savedCount })
                        return
                      }
                      case "ScriptOutput":
                        return yield* event("ScriptOutput", part.output.slice(0, 200))
                      case "ErrorRetry":
                        return yield* event("ErrorRetry", String(part.error))
                      case "CompactionEnded":
                        return yield* event("CompactionEnded", part)
                      default:
                        return
                    }
                  }),
                ),
                Effect.as({ _tag: "ended" as const }),
                Effect.catchTag("AgentFinished", (finished) => Effect.succeed({ _tag: "finished" as const, summary: finished.summary })),
              ),
            ),
          )
          turns = turn
          const saved = yield* saveHistory(agent, turns)
          yield* event("TurnDone", { turn, elapsedMs: Date.now() - turnStarted, outcome, historyRows: savedCount, saved })
        }
        yield* sql`UPDATE run SET status = 'finished', finished_at = ${Date.now()}, result = ${`finished after ${turns} turns`} WHERE id = ${runId}`.pipe(Effect.orDie)
        yield* event("LoopFinished", { turns })
      }).pipe(
        Effect.provide(modelLayer(run.model)),
        Effect.provide(Agent.layerSubagentModel(modelLayer(run.model))),
        Effect.provide(Agent.ConversationMode.layer(false)),
        Effect.scoped,
        Effect.provide(executorLayer(run.transport)),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? event("LoopInterrupted", { acquire })
            : Effect.gen(function* () {
                yield* sql`UPDATE run SET status = 'failed', finished_at = ${Date.now()}, result = ${Cause.pretty(cause).slice(0, 2000)} WHERE id = ${runId}`.pipe(Effect.orDie)
                yield* event("LoopFailed", Cause.pretty(cause).slice(0, 1500))
              }),
        ),
      )

    const resource = yield* EntityResource.make({
      acquire: Effect.gen(function* () {
        const closeScope = yield* EntityResource.CloseScope
        const run = yield* readRun
        if (run === undefined || run.status !== "active") {
          return yield* Effect.die(new Error(`acquire without an active run (${run?.status})`))
        }
        const acquire = run.acquires + 1
        yield* sql`UPDATE run SET acquires = ${acquire} WHERE id = ${runId}`.pipe(Effect.orDie)
        const started = Date.now()
        const provisioned = yield* stubs.getByName(runId).provision(acquire).pipe(Effect.orDie)
        yield* event("Acquired", { acquire, build: buildId, provisionMs: Date.now() - started, provisioned })
        const fiber = yield* runLoop({ ...run, acquires: acquire }, acquire).pipe(Effect.forkIn(closeScope))
        loop = { fiber, startedAt: Date.now(), acquire, parts: 0 }
        yield* Scope.addFinalizer(closeScope, Effect.suspend(() => stubs.getByName(runId).release().pipe(Effect.ignore, Effect.andThen(event("Released", { acquire })))))
        return { acquire }
      }),
    })

    // A restart rebuilds the entity; the build sees the active run and
    // re-acquires straight away (design item 10).
    const existing = yield* readRun
    if (existing !== undefined && existing.status === "active") {
      yield* event("BuildSawActiveRun", { build: buildId, acquires: existing.acquires, turns: existing.turns })
      yield* Effect.scoped(resource.get)
    }

    const probe = (transport: Transport, kind: string, n: number) =>
      Effect.gen(function* () {
        // Probes run against a fresh workspace unless a run holds one.
        if (loop === undefined || loop.fiber.pollUnsafe() !== undefined) {
          yield* stubs.getByName(runId).provision(0).pipe(Effect.orDie)
        }
        const executor = yield* AgentExecutor.AgentExecutor
        const started = Date.now()
        switch (kind) {
          case "caps": {
            const caps = yield* executor.capabilities
            return { toolsDtsBytes: caps.toolsDts.length, agentsMd: Option.getOrNull(caps.agentsMd), skills: caps.skills.length, elapsedMs: Date.now() - started }
          }
          case "concurrent": {
            const results = yield* Effect.forEach(
              Array.from({ length: n }, (_, i) => i),
              (i) =>
                Effect.gen(function* () {
                  const subagentPrompts: Array<string> = []
                  const s = Date.now()
                  const text = yield* executor
                    .execute({
                      script: [
                        `console.log("stream ${i} start")`,
                        `const reply = await delegate("hello from stream ${i}")`,
                        `console.log("stream ${i} delegate ->", reply)`,
                        `await sleep(${200 * (n - i)})`,
                        `console.log(await bash({ command: "echo stream ${i} ran in $(hostname) at $(pwd)" }))`,
                      ].join("\n"),
                      onTaskComplete: () => Effect.void,
                      onSubagent: (prompt) => Effect.sync(() => { subagentPrompts.push(prompt); return `subagent answer for stream ${i}` }),
                      onImage: () => Effect.void,
                    })
                    .pipe(Stream.mkString)
                  return { stream: i, elapsedMs: Date.now() - s, subagentPrompts, output: text }
                }),
              { concurrency: "unbounded" },
            )
            return { elapsedMs: Date.now() - started, results }
          }
          case "interrupt": {
            const marker = `interrupt-${Date.now()}`
            const chunks: Array<string> = []
            const fiber = yield* executor
              .execute({
                script: `console.log("start ${marker}"); await bash({ command: "sleep 2; echo ${marker} > ${marker}; echo wrote" }); console.log("end ${marker}")`,
                onTaskComplete: () => Effect.void,
                onSubagent: () => Effect.succeed(""),
                onImage: () => Effect.void,
              })
              .pipe(Stream.runForEach((c) => Effect.sync(() => { chunks.push(c) })), Effect.forkScoped)
            yield* Effect.sleep("500 millis")
            const interruptedAt = Date.now()
            yield* Fiber.interrupt(fiber)
            yield* Effect.sleep("3 seconds")
            const after = yield* executor
              .execute({
                script: `console.log(await bash({ command: "ls | grep interrupt- || echo no-marker-files" }))`,
                onTaskComplete: () => Effect.void,
                onSubagent: () => Effect.succeed(""),
                onImage: () => Effect.void,
              })
              .pipe(Stream.mkString)
            return { marker, chunksBeforeInterrupt: chunks, interruptAfterMs: interruptedAt - started, markerFilesAfter: after.trim(), elapsedMs: Date.now() - started }
          }
          default:
            return { error: `unknown probe ${kind}` }
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(executorLayer(transport)),
        Effect.map((result) => ({ transport, kind, ...result })),
        Effect.catchCause((cause) => Effect.succeed({ transport, kind, error: Cause.pretty(cause).slice(0, 2000) })),
      )

    return ReviewRun.of({
      Start: ({ payload }) =>
        Effect.gen(function* () {
          const now = Date.now()
          const existing = yield* readRun
          if (existing === undefined) {
            yield* sql`INSERT INTO run (id, status, model, sleep_seconds, transport, started_at, deadline_at) VALUES (${runId}, 'active', ${payload.model}, ${payload.sleepSeconds}, ${payload.transport}, ${now}, ${now + payload.minutes * 60_000})`.pipe(Effect.orDie)
            yield* event("Started", payload)
          }
          const acquired = yield* Effect.scoped(resource.get)
          return { runId, build: buildId, isolate: isolateId, acquired, startMs: Date.now() - now }
        }),

      Cancel: ({ payload }) =>
        Effect.gen(function* () {
          const started = Date.now()
          yield* sql`UPDATE run SET status = 'cancelled', finished_at = ${started}, result = ${`cancelled: ${payload.reason}`} WHERE id = ${runId} AND status = 'active'`.pipe(Effect.orDie)
          yield* event("Cancel", payload)
          yield* resource.close
          const fiberExit = loop ? yield* Fiber.await(loop.fiber).pipe(Effect.timeout("10 seconds"), Effect.option) : undefined
          return { runId, build: buildId, closeMs: Date.now() - started, loopExit: fiberExit?._tag === "Some" ? (Exit.isSuccess(fiberExit.value) ? "success" : Cause.pretty(fiberExit.value.cause).slice(0, 200)) : "no loop fiber / timeout" }
        }),

      Publish: ({ payload }) =>
        Effect.gen(function* () {
          const started = Date.now()
          yield* sql`INSERT INTO publish (id, attempts, first_started_at) VALUES (${runId}, 1, ${started}) ON CONFLICT(id) DO UPDATE SET attempts = attempts + 1`.pipe(Effect.orDie)
          const existing = yield* sql<{ readonly step: number }>`SELECT step FROM publish_steps`.pipe(Effect.orDie)
          const done = new Set(existing.map((r) => r.step))
          yield* event("PublishStart", { steps: payload.steps, alreadyDone: [...done], build: buildId })
          yield* resource.close
          for (let step = 1; step <= payload.steps; step++) {
            if (done.has(step)) {
              yield* event("PublishStepSkipped", { step })
              continue
            }
            const stepStarted = Date.now()
            // The "GitHub write": outside any transaction.
            yield* Effect.sleep(`${payload.stepSeconds} seconds`)
            yield* sql.withTransaction(
              sql`INSERT INTO publish_steps (step, started_at, finished_at, build) VALUES (${step}, ${stepStarted}, ${Date.now()}, ${buildId})`,
            ).pipe(Effect.orDie)
            yield* event("PublishStepDone", { step, build: buildId })
          }
          yield* sql`UPDATE publish SET finished_at = ${Date.now()} WHERE id = ${runId}`.pipe(Effect.orDie)
          yield* event("PublishDone", { elapsedMs: Date.now() - started, build: buildId })
          return { runId, build: buildId }
        }),

      Status: () =>
        Effect.gen(function* () {
          const run = yield* readRun
          const historyRows = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM history`.pipe(Effect.map((r) => r[0]?.n ?? 0), Effect.orDie)
          const events = yield* sql<{ readonly at: number; readonly build: string; readonly kind: string; readonly detail: string }>`SELECT at, build, kind, detail FROM events ORDER BY id DESC LIMIT 400`.pipe(Effect.orDie)
          const steps = yield* sql<{ readonly step: number; readonly started_at: number; readonly finished_at: number; readonly build: string }>`SELECT * FROM publish_steps ORDER BY step`.pipe(Effect.orDie)
          const publish = yield* sql`SELECT * FROM publish WHERE id = ${runId}`.pipe(Effect.map((r) => r[0] ?? null), Effect.orDie)
          const entityState = yield* sql`SELECT * FROM cluster_entity_state`.pipe(Effect.orDie, Effect.catch(() => Effect.succeed([])))
          const loopRunning = loop ? loop.fiber.pollUnsafe() === undefined : false
          const mailbox = yield* sql<{ readonly n: number; readonly processed: number }>`SELECT COUNT(*) AS n, SUM(CASE WHEN processed THEN 1 ELSE 0 END) AS processed FROM cluster_messages`.pipe(Effect.map((r) => r[0] ?? null), Effect.orDie, Effect.catch(() => Effect.succeed(null)))
          return {
            now: Date.now(),
            runId,
            deploy: deployMarker,
            isolate: isolateId,
            build: buildId,
            builtAt,
            buildAgeMs: Date.now() - builtAt,
            run: run ?? null,
            historyRows,
            loop: loop ? { acquire: loop.acquire, startedAt: loop.startedAt, running: loopRunning, parts: loop.parts, lastPart: loop.lastPart ?? null, lastPartAt: loop.lastPartAt ?? null } : null,
            publish,
            publishSteps: steps,
            entityState,
            mailbox,
            events: [...events].reverse(),
          }
        }).pipe(Effect.orDie),

      Probe: ({ payload }) => probe(payload.transport, payload.kind, payload.n),
    })
  })

  return CloudflareCluster.toLayer(ReviewRun, build.pipe(Effect.orDie))
})
