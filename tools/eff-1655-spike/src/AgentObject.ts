import * as Cloudflare from "alchemy/Cloudflare"
import * as Containers from "alchemy/Cloudflare/Containers"
import type { RuntimeContext } from "alchemy/RuntimeContext"
import * as Agent from "clanka/Agent"
import * as AgentExecutor from "clanka/AgentExecutor"
import * as OpenRouterClient from "@effect/ai-openrouter/OpenRouterClient"
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel"
import * as Model from "effect/ai/Model"
import * as Cause from "effect/Cause"
import * as Redacted from "effect/Redacted"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { HttpClientError, TransportError } from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as Socket from "effect/socket/Socket"
import { ExecutorContainer } from "./ExecutorContainer.ts"
import { scriptedModel } from "./FakeModel.ts"

export type Transport = "http" | "ws"

export interface AgentObjectShape {
  /** Container health via the TCP port: proves the port fetch path. */
  readonly health: () => Effect.Effect<unknown>
  /** `ctx.abort()`: the closest local stand-in for an eviction. Never returns normally. */
  readonly abort: () => Effect.Effect<unknown>
  /** A hand-built RPC POST over the raw container port: isolates body/stream handling. */
  readonly rawRpc: (mode: string) => Effect.Effect<unknown>
  /** `capabilities` RPC (unary). */
  readonly capabilities: (transport: Transport) => Effect.Effect<unknown>
  /**
   * N concurrent `execute` streams, each of which delegates (so the server
   * emits `Subagent` and waits for `subagentOutput` on a separate request).
   */
  readonly executeConcurrent: (transport: Transport, n: number) => Effect.Effect<unknown>
  /** A full clanka loop turn with the scripted model. */
  readonly turn: (transport: Transport, scripts: ReadonlyArray<string>) => Effect.Effect<unknown>
  /** A full clanka loop turn with a real OpenRouter model. */
  readonly realTurn: (transport: Transport, model: string, apiKey: string, prompt: string) => Effect.Effect<unknown>
  /**
   * Start a turn whose first script sleeps, then destroy the container while
   * the execute stream is open. Reports what the loop observed.
   */
  readonly turnWithContainerCrash: (transport: Transport) => Effect.Effect<unknown, never, RuntimeContext>
  /** Start a long turn in the background and return immediately (for eviction tests). */
  readonly startBackgroundTurn: (transport: Transport) => Effect.Effect<unknown>
  /** What happened to the background turn (in-memory, lost on eviction). */
  readonly backgroundStatus: () => Effect.Effect<unknown>
  /** Interrupt a running execute stream from the DO side; does the container stop the script? */
  readonly interruptExecute: (transport: Transport) => Effect.Effect<unknown>
}

export class AgentObject extends Cloudflare.DurableObject<AgentObject, AgentObjectShape>()(
  "Eff1655Agent",
) {}

const instanceId = Math.random().toString(36).slice(2, 10)

export default AgentObject.make(
  Effect.gen(function* () {
    const container = yield* ExecutorContainer
    const state = yield* Cloudflare.DurableObjectState

    return Effect.gen(function* () {
      // NOTE: the Scope alchemy hands to this constructor closes as soon as
      // the shape is built (observed: "scope closing: success" right after
      // construction), so fibers forked into it are interrupted immediately.
      // Long-running turns need a scope the object owns itself.
      const doScope = yield* Scope.make()
      // Distinguishes DO *instances*: a reset/eviction constructs a new one.
      const objectInstance = Math.random().toString(36).slice(2, 10)
      console.log(`[AgentObject] constructing object instance ${objectInstance} for ${state.id.toString()}`)
      yield* Effect.addFinalizer((exit) =>
        Effect.sync(() => console.log(`[AgentObject] construction scope of ${objectInstance} closing: ${Exit.isSuccess(exit) ? "success" : Cause.pretty(exit.cause).slice(0, 200)}`)),
      )
      const port = yield* container.getTcpPort(3000)

      // Make sure the container is up and port 3000 answers before any RPC
      // (alchemy's wrapped `port.fetch` blocks on readiness and restarts a
      // stopped container).
      yield* port.fetch(HttpClientRequest.get("http://container/health")).pipe(
        Effect.tapCause((cause) => Effect.logWarning("readiness probe failed", cause)),
        Effect.ignore,
      )

      // The raw workerd container port (`ctx.container.getTcpPort`). alchemy's
      // wrapper converts an Effect HttpClientRequest into a streamed web
      // Request, and the POST body arrived empty at the container (observed:
      // "Received empty HTTP response from RPC server"). An HttpClient built
      // directly on the raw fetcher carries the body correctly.
      //
      // NOTE: an earlier version overrode the `FetchHttpClient.Fetch`
      // reference instead; that reference leaked into the model layer built
      // in the same fiber, so OpenRouter requests were sent to the container
      // port. `HttpClient.make` keeps the two clients fully separate.
      const rawPort = state.container!.getTcpPort(3000)
      const portHttpClient = HttpClient.make((request, url, signal, fiber) =>
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
          console.log(`[portClient] ${request.method} ${url.toString()} body=${body._tag}`)
          const response = yield* Effect.tryPromise({
            try: () => rawPort.fetch(url.toString().replace(/^https:/, "http:"), init as any) as Promise<Response>,
            catch: (cause) =>
              new HttpClientError({
                reason: new TransportError({ request, cause, description: "container port fetch failed" }),
              }),
          })
          console.log(`[portClient] -> ${response.status} content-length=${response.headers.get("content-length")} transfer-encoding=${response.headers.get("transfer-encoding")}`)
          return HttpClientResponse.fromWeb(request, response)
        }),
      )

      // --- HTTP streaming transport.
      const HttpProtocol = RpcClient.layerProtocolHttp({ url: "http://container/rpc" }).pipe(
        Layer.provide([RpcSerialization.layerNdjson, Layer.succeed(HttpClient.HttpClient, portHttpClient)]),
      )

      // --- WebSocket transport: upgrade through the raw container port, wrap
      // the Cloudflare WebSocket as an Effect Socket.
      const openSocket = Effect.gen(function* () {
        const raw = yield* Effect.tryPromise({
          try: () =>
            rawPort.fetch("http://container/ws", {
              headers: { Upgrade: "websocket", Connection: "Upgrade" },
            }) as Promise<Response & { webSocket?: WebSocket | null }>,
          catch: (cause) =>
            new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) }),
        })
        const webSocket = raw.webSocket
        if (!webSocket) {
          return yield* Effect.fail(
            new Socket.SocketError({
              reason: new Socket.SocketOpenError({
                kind: "Unknown",
                cause: new Error(`no webSocket on upgrade response (status ${raw.status})`),
              }),
            }),
          )
        }
        ;(webSocket as any).accept()
        yield* Effect.addFinalizer(() => Effect.sync(() => webSocket.close()))
        return webSocket as unknown as Socket.WebSocketLike
      })
      const WsSocket = Layer.effect(Socket.Socket, Socket.fromWebSocket(openSocket))
      const WsProtocol = RpcClient.layerProtocolSocket().pipe(
        Layer.provide([RpcSerialization.layerNdjson, WsSocket]),
      )

      const executorLayer = (transport: Transport) =>
        AgentExecutor.layerRpc.pipe(Layer.provide(transport === "http" ? HttpProtocol : WsProtocol))

      const withExecutor = <A, E>(
        transport: Transport,
        use: Effect.Effect<A, E, AgentExecutor.AgentExecutor | Scope.Scope>,
      ) => Effect.scoped(use.pipe(Effect.provide(executorLayer(transport))))

      // Subagents (the `delegate` tool) get the same model as the parent; the
      // scripted model answers every delegate call with its last script.

      const realModelLayer = (model: string, apiKey: string) =>
        Layer.mergeAll(
          OpenRouterLanguageModel.layer({ model }).pipe(
            Layer.provide(OpenRouterClient.layer({ apiKey: Redacted.make(apiKey) })),
            Layer.provide(FetchHttpClient.layer),
          ),
          Layer.succeed(Model.ProviderName, "openrouter"),
          Layer.succeed(Model.ModelName, model),
        )

      const runTurn = (
        transport: Transport,
        scripts: ReadonlyArray<string>,
        onEvent?: (event: string) => Effect.Effect<void>,
      ) => runTurnWith(transport, Layer.unwrap(scriptedModel(scripts)), "run the spike", onEvent)

      const runTurnWith = (
        transport: Transport,
        modelLayer: Layer.Layer<any, never, never>,
        prompt: string,
        onEvent?: (event: string) => Effect.Effect<void>,
      ) =>
        Effect.gen(function* () {
          const events: Array<string> = []
          const started = Date.now()
          const agent = yield* Agent.make
          const outcome = yield* agent.send({ prompt }).pipe(
            Effect.flatMap((stream) =>
              stream.pipe(
                Stream.runForEach((part) => {
                  const line = `${part._tag}${summarize(part)}`
                  events.push(line)
                  return onEvent ? onEvent(line) : Effect.void
                }),
                Effect.as({ _tag: "ended-without-finish" as const }),
                Effect.catchTag("AgentFinished", (finished) =>
                  Effect.succeed({ _tag: "finished" as const, summary: finished.summary }),
                ),
              ),
            ),
            Effect.exit,
          )
          return {
            instanceId,
            objectInstance,
            transport,
            elapsedMs: Date.now() - started,
            outcome: Exit.isSuccess(outcome) ? outcome.value : { _tag: "failed", cause: Cause.pretty(outcome.cause) },
            events,
          }
        }).pipe(
          Effect.provide(modelLayer),
          Effect.provide(Agent.layerSubagentModel(modelLayer)),
          Effect.provide(Agent.ConversationMode.layer(false)),
          (effect) => withExecutor(transport, effect),
        )

      // Background turn bookkeeping (in memory only, by design).
      let background: { fiber?: Fiber.Fiber<unknown, unknown>; events: Array<string>; result?: unknown; startedAt: number } | undefined

      return {
        health: () =>
          Effect.gen(function* () {
            const response = yield* port.fetch(HttpClientRequest.get("http://container/health"))
            const body = yield* response.json
            return { instanceId, objectInstance, doId: state.id.toString(), container: body }
          }).pipe(Effect.catchCause((cause) => Effect.succeed({ instanceId, error: Cause.pretty(cause) }))),

        abort: () =>
          Effect.sync(() => {
            console.log(`[AgentObject] aborting object instance ${objectInstance}`)
            try {
              ;(state.raw as any).abort("spike: simulated eviction")
            } catch (error) {
              return { objectInstance, abortThrew: String(error) }
            }
            return { objectInstance, abortReturned: true }
          }),

        rawRpc: (mode) =>
          Effect.gen(function* () {
            const text =
              JSON.stringify({ _tag: "Request", id: "1", tag: "capabilities", payload: null, headers: [], traceId: "0", spanId: "0", sampled: false }) + "\n"
            const bytes = new TextEncoder().encode(text)
            const body: BodyInit =
              mode === "bytes"
                ? bytes
                : mode === "stream"
                  ? new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close() } })
                  : text
            const init: RequestInit & { duplex?: string } = {
              method: "POST",
              headers: { "content-type": "application/ndjson" },
              body,
            }
            if (mode === "stream") init.duplex = "half"
            const response = yield* Effect.promise(() => rawPort.fetch("http://container/rpc", init as any) as Promise<Response>)
            const out = yield* Effect.promise(() => response.text())
            return { instanceId, mode, status: response.status, headers: Object.fromEntries(response.headers as any), bodyLength: out.length, body: out.slice(0, 160) }
          }).pipe(Effect.catchCause((cause) => Effect.succeed({ instanceId, error: Cause.pretty(cause) }))),

        capabilities: (transport) =>
          withExecutor(
            transport,
            Effect.gen(function* () {
              const executor = yield* AgentExecutor.AgentExecutor
              const caps = yield* executor.capabilities
              return { instanceId, transport, toolsDtsBytes: caps.toolsDts.length, agentsMd: Option.getOrNull(caps.agentsMd), skills: caps.skills.length }
            }),
          ).pipe(Effect.catchCause((cause) => Effect.succeed({ instanceId, transport, error: Cause.pretty(cause) }))),

        executeConcurrent: (transport, n) =>
          withExecutor(
            transport,
            Effect.gen(function* () {
              const executor = yield* AgentExecutor.AgentExecutor
              const started = Date.now()
              const results = yield* Effect.forEach(
                Array.from({ length: n }, (_, i) => i),
                (i) =>
                  Effect.gen(function* () {
                    const subagentPrompts: Array<string> = []
                    const text = yield* executor
                      .execute({
                        script: [
                          `console.log("stream ${i} start pid", process === undefined ? "sandbox-has-no-process" : "has-process")`,
                          `const reply = await delegate("hello from stream ${i}")`,
                          `console.log("stream ${i} delegate ->", reply)`,
                          `await sleep(${100 * (n - i)})`,
                          `console.log(await bash({ command: "echo stream ${i} ran in $(hostname) at $(pwd)" }))`,
                        ].join("\n"),
                        onTaskComplete: () => Effect.void,
                        onSubagent: (prompt) =>
                          Effect.sync(() => {
                            subagentPrompts.push(prompt)
                            return `subagent answer for stream ${i}`
                          }),
                        onImage: () => Effect.void,
                      })
                      .pipe(Stream.mkString)
                    return { stream: i, subagentPrompts, output: text }
                  }),
                { concurrency: "unbounded" },
              )
              return { instanceId, transport, elapsedMs: Date.now() - started, results }
            }),
          ).pipe(Effect.catchCause((cause) => Effect.succeed({ instanceId, transport, error: Cause.pretty(cause) }))),

        turn: (transport, scripts) => runTurn(transport, scripts),

        realTurn: (transport, model, apiKey, prompt) =>
          runTurnWith(transport, realModelLayer(model, apiKey), prompt),

        turnWithContainerCrash: (transport) =>
          Effect.gen(function* () {
            const timeline: Array<string> = []
            const log = (line: string) => Effect.sync(() => { timeline.push(`${Date.now()}: ${line}`) })
            const turn = yield* runTurn(
              transport,
              [
                'console.log("about to sleep in the container"); await sleep(4000); console.log("woke up (should not print if the container died)")',
                'await taskComplete("finished after sleep (unexpected)")',
              ],
              log,
            ).pipe(Effect.forkIn(doScope))
            yield* Effect.sleep("1500 millis")
            yield* log("destroying container")
            yield* container.destroy().pipe(Effect.catchCause((c) => log(`destroy failed: ${Cause.pretty(c)}`)))
            yield* log("destroy returned")
            const result = yield* Fiber.join(turn).pipe(Effect.timeout("30 seconds"), Effect.exit)
            yield* log("turn settled")
            const healthAfter = yield* port.fetch(HttpClientRequest.get("http://container/health")).pipe(
              Effect.flatMap((r) => r.json),
              Effect.catchCause((cause) => Effect.succeed({ error: Cause.pretty(cause).slice(0, 300) })),
            )
            yield* log("health after settled")
            return {
              objectInstance,
              timeline,
              result: Exit.isSuccess(result) ? result.value : { _tag: "failed", cause: Cause.pretty(result.cause).slice(0, 600) },
              healthAfter,
            }
          }),

        startBackgroundTurn: (transport) =>
          Effect.gen(function* () {
            background = { events: [], startedAt: Date.now() }
            const bg = background
            const fiber = yield* runTurn(
              transport,
              [
                'console.log("background step 1"); await sleep(20000); console.log("background step 1 done")',
                'await taskComplete("background turn finished")',
              ],
              (line) => Effect.sync(() => { bg.events.push(line) }),
            ).pipe(
              Effect.tap((result) => Effect.sync(() => { bg.result = result })),
              Effect.forkIn(doScope),
            )
            bg.fiber = fiber
            return { instanceId, objectInstance, started: true }
          }),

        backgroundStatus: () =>
          Effect.sync(() => ({
            instanceId,
            objectInstance,
            known: background !== undefined,
            events: background?.events ?? [],
            result: background?.result ?? null,
            ageMs: background ? Date.now() - background.startedAt : null,
          })),

        interruptExecute: (transport) =>
          withExecutor(
            transport,
            Effect.gen(function* () {
              const executor = yield* AgentExecutor.AgentExecutor
              const marker = `interrupt-${Date.now()}`
              const chunks: Array<string> = []
              const fiber = yield* executor
                .execute({
                  script: `console.log("start ${marker}"); await bash({ command: "sleep 2; echo ${marker} > /workspace/${marker}; echo wrote" }); console.log("end ${marker}")`,
                  onTaskComplete: () => Effect.void,
                  onSubagent: () => Effect.succeed(""),
                  onImage: () => Effect.void,
                })
                .pipe(Stream.runForEach((c) => Effect.sync(() => { chunks.push(c) })), Effect.forkScoped)
              yield* Effect.sleep("500 millis")
              yield* Fiber.interrupt(fiber)
              yield* Effect.sleep("3 seconds")
              // Did the script keep running after the client went away?
              const after = yield* executor
                .execute({
                  script: `console.log(await bash({ command: "ls /workspace | grep interrupt- || echo no-marker-files" }))`,
                  onTaskComplete: () => Effect.void,
                  onSubagent: () => Effect.succeed(""),
                  onImage: () => Effect.void,
                })
                .pipe(Stream.mkString)
              return { instanceId, transport, chunksBeforeInterrupt: chunks, markerFilesAfter: after.trim(), marker }
            }),
          ).pipe(Effect.catchCause((cause) => Effect.succeed({ instanceId, transport, error: Cause.pretty(cause) }))),
      } satisfies AgentObjectShape
    })
  }).pipe(Effect.provide(Containers.layer(ExecutorContainer, { enableInternet: false }))),
)

const summarize = (part: any): string => {
  switch (part._tag) {
    case "ScriptOutput":
      return ` ${JSON.stringify(String(part.output).slice(0, 300))}`
    case "ScriptDelta":
      return ` ${JSON.stringify(String(part.delta).slice(0, 120))}`
    case "SubagentStart":
      return ` ${JSON.stringify(String(part.prompt ?? "").slice(0, 80))}`
    case "SubagentComplete":
      return ` ${JSON.stringify(String(part.summary ?? "").slice(0, 80))}`
    case "ErrorRetry":
      return ` ${JSON.stringify(String(part.error?.message ?? part.error).slice(0, 200))}`
    case "Usage":
      return ` ${JSON.stringify({ input: part.inputTokens ?? part.usage?.inputTokens, output: part.outputTokens ?? part.usage?.outputTokens })}`
    default:
      return ""
  }
}
