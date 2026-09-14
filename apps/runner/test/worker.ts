// Test entry: the production runner plus controlled model responses and fault
// injection reachable only through `/__test/` routes. The production entry has
// none of this; the acceptance driver and the runner tests build this file.
import { Effect } from "effect"
import { Session } from "@opencode/schema/session"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { ProtocolError } from "../src/Protocol.ts"
import { errorResponse, jsonResponse, sessionIdOf, type Command } from "../src/Router.ts"
import { SessionRunner, type RunnerEnv } from "../src/SessionRunner.ts"
import { DEFAULT_OPTIONS, SessionController, type RunnerOptions } from "../src/SessionController.ts"
import { authenticate, handle as productionHandle, type WorkerEnv } from "../src/worker.ts"
import {
  RepositoryWorkspace,
  type RepositorySelection,
  type WorkspaceToolInput,
} from "../src/RepositoryWorkspace.ts"

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
    | "repository"
    | "repository-work"
    | "crash"
    | "http-error"
    | "error-stall"
    | "deployment-history"
    | "credential-echo"
  readonly status?: number
  /** Delay before each text answer, so a turn spans supervision checks. */
  readonly delayMs?: number
  /** Answers returned in order; the last repeats. */
  readonly answers?: ReadonlyArray<string>
  readonly tools?: ReadonlyArray<{ name: string; input: unknown }>
  /** Input tokens reported per answer. */
  readonly inputTokens?: number
  /** For `crash`: the model calls (1-based) that abort the object instead of answering. */
  readonly crashes?: number
  /** For `crash`: persist a blocker before aborting so recovery must stay blocked. */
  readonly blockOnCrash?: boolean
}

export interface TestFaults {
  readonly abortAfterWorkspaceCommit?: boolean
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

class TestSessionController extends SessionController {
  protected override makeRepository(selected: RepositorySelection) {
    const runner = this
    return new (class extends RepositoryWorkspace {
      override async tool(id: string, name: string, input: WorkspaceToolInput) {
        const result = await super.tool(id, name, input)
        if (runner.faults.abortAfterWorkspaceCommit) {
          runner.setFaults({ abortAfterWorkspaceCommit: false })
          await runner.ctx.storage.sync()
          runner.ctx.abort("test: SQLite edit committed before native result")
        }
        return result
      }
    })(this.ctx.storage, this.env, selected)
  }
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
    if (this.env.JANITOR_TEST_LIVE_MODEL === "true") return super.transport()
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
                  model?: string
                  max_tokens?: number
                  max_completion_tokens?: number
                  messages?: ReadonlyArray<{ role: string; content: unknown }>
                  tools?: ReadonlyArray<{ function?: { name?: string } }>
                }
                return {
                  model: parsed.model,
                  maxTokens: parsed.max_completion_tokens ?? parsed.max_tokens,
                  toolResults: (parsed.messages ?? []).filter((message) => message.role === "tool")
                    .length,
                  compaction: JSON.stringify(parsed.messages).includes(
                    "Return only the structured summary",
                  ),
                  retainedTool:
                    JSON.stringify(parsed.messages).includes("[Assistant tool call]: read") ||
                    JSON.stringify(parsed.messages).includes("call_deployment_"),
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
          credentialMatches:
            request.headers.authorization === `Bearer ${this.env.JANITOR_TEST_EXPECTED_AUTH}`,
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
          case "credential-echo": {
            if (call === 1) {
              const secret = request.headers.authorization!.slice(7)
              const split = Math.floor(secret.length / 2)
              return respond(
                frame({
                  role: "assistant",
                  content: secret.slice(0, split),
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_echo",
                      type: "function",
                      function: {
                        name: "write",
                        arguments: '{"path":"echo.txt","content":"' + secret.slice(0, split),
                      },
                    },
                  ],
                }) +
                  frame({
                    content: secret.slice(split),
                    tool_calls: [{ index: 0, function: { arguments: secret.slice(split) + '"}' } }],
                  }) +
                  frame({}, "tool_calls") +
                  done,
              )
            }
            if (call === 2) return respond(toolCall("read", { path: "echo.txt" }))
            break
          }
          case "error-stall":
            if (call === 1)
              return respond(new ReadableStream({ pull: () => new Promise(() => {}) }), {
                status: 503,
              })
            break
          case "deployment-history": {
            if ("compaction" in summary && summary.compaction)
              return respond(
                completion(
                  "## Objective\nValidate deployment.\n## Work state\nRead both files.\n## Next move\nContinue with retained history.",
                  13,
                ),
              )
            if (call === 1) return respond(completion("Earlier work noted.", 7))
            if (call === 2) {
              const start = [0, 1].map((index) => ({
                index,
                id: `call_deployment_${index}`,
                type: "function",
                function: { name: "read", arguments: '{"path":' },
              }))
              const end = [0, 1].map((index) => ({
                index,
                function: {
                  arguments: JSON.stringify(index === 0 ? "README.md" : "NOTES.md") + "}",
                },
              }))
              return respond(
                frame({ role: "assistant", tool_calls: start }) +
                  frame({ tool_calls: end }) +
                  frame({}, "tool_calls", {
                    prompt_tokens: 120000,
                    completion_tokens: 3,
                    total_tokens: 120003,
                  }) +
                  done,
              )
            }
            return respond(completion("Continue after tool results.", 17))
          }
          case "http-error":
            return respond(
              JSON.stringify({
                error: {
                  message: `Provider rejected credential ${request.headers.authorization}`,
                  type: script.status === 404 ? "model_not_found" : "invalid_api_key",
                },
              }),
              { status: script.status ?? 401, headers: { "content-type": "application/json" } },
            )
          case "repository-work": {
            const tool = script.tools?.[call - this.meta<number>("testToolBase", 0) - 1]
            if (tool) return respond(toolCall(tool.name, tool.input))
            break
          }
          case "repository": {
            if (
              summary.tools.some(
                (tool) =>
                  !["read", "glob", "grep", "write", "edit", "shell", "publish"].includes(tool),
              )
            )
              throw new Error(`Unexpected repository tools: ${summary.tools}`)
            if (call === 1) return respond(toolCall("read", { path: "README.md" }))
            if (call === 2) return respond(toolCall("grep", { pattern: "repository", path: "." }))
            break
          }
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
      if (rest === "/compact" && request.method === "POST") {
        const host = await this.ensureHost()
        await host.sdk((sdk) =>
          sdk.sessions.compact({ sessionID: Session.ID.make(this.store.session!.nativeSessionId) }),
        )
        return jsonResponse({ ok: true })
      }
      if (rest === "/model" && request.method === "POST") {
        // Model a Workerd process environment populated from runner-only bindings.
        process.env.JANITOR_TEST_RUNNER_SECRET = "runner-only-secret"
        this.put("testModel", await request.json())
        this.put("testToolBase", this.meta<number>("modelCalls", 0))
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
          maintenance: this.store.maintenance,
          blockers: this.store.blockers,
          checkpoint: this.ctx.storage.sql
            .exec(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_janitor_checkpoint'",
            )
            .toArray().length
            ? (this.ctx.storage.sql
                .exec("SELECT key, sha256, manifest FROM _janitor_checkpoint WHERE id = 1")
                .toArray()[0] ?? null)
            : null,
        })
      }
      if (rest === "/compatibility" && request.method === "POST") {
        this.put("compatibility", await request.json())
        return jsonResponse({ ok: true })
      }
      if (rest === "/legacy-workspace" && request.method === "POST") {
        await this.disposeHost()
        const body = (await request.json()) as {
          archive: string
          sha256: string
          uncertain?: boolean
        }
        const key = "legacy-fixture"
        await this.env.WORKSPACE_CHECKPOINTS!.put(key, body.archive)
        this.ctx.storage.sql.exec(
          "DELETE FROM _janitor_workspace_file; DELETE FROM _janitor_sql_workspace",
        )
        this.ctx.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS _janitor_checkpoint (id INTEGER PRIMARY KEY, key TEXT NOT NULL, sha256 TEXT NOT NULL, manifest TEXT)",
        )
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO _janitor_checkpoint VALUES (1, ?, ?, NULL)",
          key,
          body.sha256,
        )
        if (body.uncertain) {
          this.ctx.storage.sql.exec(
            "CREATE TABLE IF NOT EXISTS _janitor_tool_operation (id TEXT PRIMARY KEY, state TEXT)",
          )
          this.ctx.storage.sql.exec(
            "INSERT INTO _janitor_tool_operation VALUES ('legacy-unknown','admitted')",
          )
        }
        return jsonResponse({ ok: true })
      }
      if (rest === "/checkpoint-manifest" && request.method === "POST") {
        // Rewrites the committed pointer's manifest; a null body removes it.
        const manifest = await request.json()
        this.ctx.storage.sql.exec(
          "UPDATE _janitor_checkpoint SET manifest = ? WHERE id = 1",
          manifest === null ? null : JSON.stringify(manifest),
        )
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

class TestSessionRunner extends SessionRunner {
  protected override makeController(ctx: DurableObjectState, env: RunnerEnv) {
    return new TestSessionController(ctx, env)
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
