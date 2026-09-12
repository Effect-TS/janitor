// Test entry: the production runner plus controlled model responses and fault
// injection reachable only through `/__test/` routes. The production entry has
// none of this; the acceptance driver and the runner tests build this file.
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { ProtocolError } from "../src/Protocol.ts"
import { errorResponse, jsonResponse, sessionIdOf, type Command } from "../src/Router.ts"
import { DEFAULT_OPTIONS, SessionRunner, type RunnerOptions } from "../src/SessionRunner.ts"
import { authenticate, handle as productionHandle, type WorkerEnv } from "../src/worker.ts"

export interface ModelScript {
  /** How the scripted provider answers; see `respond`. */
  readonly mode:
    | "text"
    | "question"
    | "before-first"
    | "midstream"
    | "always-stall"
    | "retry-after"
    | "disconnect"
    | "activity"
    | "shell-policy"
    | "crash"
  /** Delay before each text answer, so a turn spans supervision checks. */
  readonly delayMs?: number
  /** Answers returned in order; the last repeats. */
  readonly answers?: ReadonlyArray<string>
  /** Input tokens reported per answer. */
  readonly inputTokens?: number
  /** For `crash`: the model calls (1-based) that abort the object instead of answering. */
  readonly crashes?: number
  /** For `crash`: persist a blocker before aborting so recovery must stay blocked. */
  readonly blockOnCrash?: boolean
}

export interface TestFaults {
  readonly intervalMs?: number
  readonly modelInactivityMs?: number
  readonly lostReplyOnce?: boolean
  readonly abortAfterAdmission?: boolean
  readonly abortBeforeCreationRecord?: boolean
  readonly inspectionFailures?: number
  readonly idleDelayMs?: number
  readonly blockers?: ReadonlyArray<string>
}

const encoder = new TextEncoder()
const frame = (
  delta: Record<string, unknown>,
  finish: string | null = null,
  usage: unknown = null,
) =>
  "data: " +
  JSON.stringify({ id: "scripted", choices: [{ index: 0, delta, finish_reason: finish }], usage }) +
  "\n\n"
const done = "data: [DONE]\n\n"
const completion = (text: string, inputTokens: number) =>
  frame({ role: "assistant", content: text }) +
  frame({}, "stop", {
    prompt_tokens: inputTokens,
    completion_tokens: 3,
    total_tokens: inputTokens + 3,
  }) +
  done
const toolCall = (name: string, args: unknown) =>
  frame({
    role: "assistant",
    tool_calls: [
      {
        index: 0,
        id: `call_${name}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  }) +
  frame({}, "tool_calls") +
  done

export class TestSessionRunner extends SessionRunner {
  private meta<T>(key: string, fallback: T): T {
    const row = this.ctx.storage.sql
      .exec("SELECT value FROM _janitor_meta WHERE key = ?", key)
      .toArray()[0]
    return row === undefined ? fallback : (JSON.parse(row.value as string) as T)
  }
  private put(key: string, value: unknown) {
    this.ctx.storage.sql.exec(
      "INSERT INTO _janitor_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    )
  }
  private get faults(): TestFaults {
    return this.meta<TestFaults>("testFaults", {})
  }
  private setFaults(update: Partial<TestFaults>) {
    this.put("testFaults", { ...this.faults, ...update })
  }
  private get script(): ModelScript {
    return this.meta<ModelScript>("testModel", { mode: "text" })
  }

  protected override options(): RunnerOptions {
    const faults = this.faults
    return {
      intervalMs: faults.intervalMs ?? DEFAULT_OPTIONS.intervalMs,
      modelInactivityMs: faults.modelInactivityMs ?? DEFAULT_OPTIONS.modelInactivityMs,
    }
  }

  protected override async afterAdmission(): Promise<void> {
    if (this.faults.abortAfterAdmission) {
      this.setFaults({ abortAfterAdmission: false })
      await this.ctx.storage.sync()
      this.ctx.abort("test: crash after durable admission")
    }
  }

  protected override async beforeCreationRecord(): Promise<void> {
    if (this.faults.abortBeforeCreationRecord) {
      this.setFaults({ abortBeforeCreationRecord: false })
      await this.ctx.storage.sync()
      this.ctx.abort("test: crash after native creation before the durable mapping")
    }
  }

  protected override async beforeIdleDecision(): Promise<void> {
    const delay = this.faults.idleDelayMs
    if (delay !== undefined && delay > 0) {
      this.store.journal("idle-inspection")
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  protected override guardReason(): string | null {
    const blockers = this.faults.blockers
    if (blockers !== undefined && blockers.length > 0) return blockers[0]!
    return super.guardReason()
  }

  protected override async ensureHost() {
    const failures = this.faults.inspectionFailures ?? 0
    if (failures > 0) {
      this.setFaults({ inspectionFailures: failures - 1 })
      throw new Error("test: injected inspection failure")
    }
    return super.ensureHost()
  }

  protected override transport(): HttpClient.HttpClient {
    return HttpClient.make((request) =>
      Effect.suspend(() => {
        const call = this.meta<number>("modelCalls", 0) + 1
        this.put("modelCalls", call)
        const script = this.script
        const body = request.body
        const summary =
          body._tag === "Uint8Array"
            ? (() => {
                const parsed = JSON.parse(new TextDecoder().decode(body.body)) as {
                  messages?: ReadonlyArray<{ role: string; content: unknown }>
                  tools?: ReadonlyArray<{ function?: { name?: string } }>
                }
                return {
                  messages: (parsed.messages ?? []).filter((message) => message.role !== "system")
                    .length,
                  tools: (parsed.tools ?? []).map((tool) => tool.function?.name ?? "?"),
                }
              })()
            : { messages: -1, tools: [] as string[] }
        this.store.journal("model-call", {
          call,
          mode: script.mode,
          incarnation: this.incarnation,
          ...summary,
        })
        const respond = (
          content: BodyInit,
          init: ResponseInit = { status: 200, headers: { "content-type": "text/event-stream" } },
        ) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(content, init)))
        const answers = script.answers ?? ["scripted answer"]
        const answer = answers[Math.min(call, answers.length) - 1]!
        const inputTokens = script.inputTokens ?? 7
        const stalled = (partial: boolean) =>
          respond(
            new ReadableStream<Uint8Array>({
              pull: (controller) => {
                if (partial && !this.meta<boolean>(`partial-${call}`, false)) {
                  this.put(`partial-${call}`, true)
                  controller.enqueue(
                    encoder.encode(frame({ role: "assistant", content: "partial" })),
                  )
                  return
                }
                return new Promise(() => {})
              },
              cancel: () => {
                this.store.journal("model-stream-cancelled", { call })
              },
            }),
          )
        switch (script.mode) {
          case "crash": {
            if ((script.crashes ?? 0) >= call) {
              setTimeout(async () => {
                if (script.blockOnCrash) {
                  this.setFaults({
                    blockers: ["uncertain external operation awaiting reconciliation"],
                  })
                  this.store.journal("blocker-persisted")
                  await this.ctx.storage.sync()
                }
                this.ctx.abort("test: process interruption during a model call")
              }, 30)
              return Effect.never
            }
            break
          }
          case "before-first":
            if (call === 1) return Effect.never
            break
          case "midstream":
            if (call === 1) return stalled(true)
            break
          case "always-stall":
            return stalled(true)
          case "retry-after":
            if (call === 1) return respond("busy", { status: 503, headers: { "retry-after": "1" } })
            break
          case "disconnect":
            if (call === 1)
              return respond(
                new ReadableStream<Uint8Array>({
                  pull: (controller) => {
                    if (!this.meta<boolean>(`partial-${call}`, false)) {
                      this.put(`partial-${call}`, true)
                      controller.enqueue(
                        encoder.encode(frame({ role: "assistant", content: "partial" })),
                      )
                      return
                    }
                    controller.error(new Error("test: socket reset"))
                  },
                }),
              )
            break
          case "activity": {
            const gap = Math.floor(this.options().modelInactivityMs / 3)
            let chunks = 0
            return respond(
              new ReadableStream<Uint8Array>({
                pull: async (controller) => {
                  await new Promise((resolve) => setTimeout(resolve, gap))
                  chunks++
                  if (chunks <= 6) controller.enqueue(encoder.encode(frame({ content: "chunk " })))
                  else {
                    controller.enqueue(encoder.encode(frame({}, "stop") + done))
                    controller.close()
                  }
                },
              }),
            )
          }
          case "question":
            if (call === 1)
              return respond(completion("Which approach do you prefer, A or B?", inputTokens))
            break
          case "shell-policy": {
            // Only policy rejections: valid commands need the repository execution plane.
            const inputs = [
              { command: "true", timeout: 0 },
              { command: "true", background: true },
            ]
            if (call <= inputs.length) return respond(toolCall("shell", inputs[call - 1]))
            break
          }
          case "text":
            break
        }
        const delay = script.delayMs ?? 0
        const reply = () => {
          this.store.journal("model-response", { call, incarnation: this.incarnation })
          return respond(completion(answer, inputTokens))
        }
        return delay > 0 ? Effect.sleep(delay).pipe(Effect.flatMap(reply)) : reply()
      }),
    )
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith("/__test/")) return this.testRoute(request, url)
    const response = await super.fetch(request)
    if (
      response.ok &&
      request.method === "POST" &&
      url.pathname.endsWith("/inputs") &&
      this.faults.lostReplyOnce
    ) {
      this.setFaults({ lostReplyOnce: false })
      this.store.journal("reply-lost")
      return new Response("test: admission reply lost", { status: 503 })
    }
    return response
  }

  private async testRoute(request: Request, url: URL): Promise<Response> {
    const rest = url.pathname.replace(/^\/__test\/sessions\/[^/]+/, "")
    try {
      if (rest === "/model" && request.method === "POST") {
        this.put("testModel", await request.json())
        return jsonResponse({ ok: true })
      }
      if (rest === "/faults" && request.method === "POST") {
        this.setFaults((await request.json()) as Partial<TestFaults>)
        return jsonResponse({ ok: true })
      }
      if (rest === "/state" && request.method === "GET") {
        const session = this.store.session
        const row =
          session === undefined ? undefined : this.store.nativeSession(session.nativeSessionId)
        return jsonResponse({
          incarnation: this.incarnation,
          modelCalls: this.meta<number>("modelCalls", 0),
          supervision: this.store.supervision,
          alarm: await this.ctx.storage.getAlarm(),
          faults: this.faults,
          native: row ?? null,
          journal: this.store.journalEntries,
          compatibility: this.store.compatibility ?? null,
        })
      }
      if (rest === "/compatibility" && request.method === "POST") {
        this.put("compatibility", await request.json())
        return jsonResponse({ ok: true })
      }
      throw new ProtocolError(
        "invalid_request",
        `Unknown test route ${request.method} ${url.pathname}`,
      )
    } catch (error) {
      return errorResponse(error)
    }
  }
}

export { TestSessionRunner as SessionRunner }

export default {
  fetch: async (request: Request, env: WorkerEnv) => {
    const url = new URL(request.url)
    if (!url.pathname.startsWith("/__test/")) return productionHandle(request, env)
    try {
      authenticate(request, env)
      const sessionId = sessionIdOf(new URL(url.pathname.replace(/^\/__test/, "/v1"), url.origin))
      if (sessionId === null)
        throw new ProtocolError("invalid_request", `Unknown test route ${url.pathname}`)
      return env.SESSIONS.get(env.SESSIONS.idFromName(sessionId)).fetch(request)
    } catch (error) {
      return errorResponse(error)
    }
  },
} satisfies ExportedHandler<WorkerEnv>

// Referenced so the production command union stays in the test bundle's type graph.
export type { Command }
