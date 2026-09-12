import { Shell } from "@opencode/core/shell"
import { httpModel } from "./http-model.mjs"
import { DurableObject } from "cloudflare:workers"
import { Effect, ManagedRuntime, Stream, Layer, Schema } from "effect"
import { OpenCode, AbsolutePath, Location, Tool } from "@opencode/sdk/effect"
import { LanguageModel, LLMClient, Auth } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionExecution } from "@opencode/core/session/execution"
import { ServerWorkerd } from "@opencode/server/workerd"
import { WorkspaceDriver } from "@opencode/core/workspace/driver"
import { makeMemoryDriver } from "@opencode/core/environment/index"

export class Runner extends DurableObject {
  runtime
  native
  creating
  incarnation = crypto.randomUUID()
  constructor(ctx, env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS _janitor_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    )
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS _janitor_trace (seq INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER, kind TEXT, data TEXT)",
    )
    this.trace("constructor", { incarnation: this.incarnation })
  }
  read(key, fallback = null) {
    const r = [...this.sql.exec("SELECT value FROM _janitor_meta WHERE key=?", key)][0]
    return r ? JSON.parse(r.value) : fallback
  }
  put(key, value) {
    this.sql.exec(
      "INSERT INTO _janitor_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    )
  }
  trace(kind, data = {}) {
    this.sql.exec(
      "INSERT INTO _janitor_trace(time,kind,data) VALUES(?,?,?)",
      Date.now(),
      kind,
      JSON.stringify(data),
    )
  }
  run(e) {
    return this.runtime.runPromise(e)
  }
  init() {
    if (this.runtime) return this.runtime
    const self = this
    const execution = SessionExecution.node.mapLayer((layer) =>
      Layer.effect(
        SessionExecution.Service,
        Effect.gen(function* () {
          const native = yield* SessionExecution.Service
          self.native = native
          return native
        }),
      ).pipe(Layer.provide(layer)),
    )
    const shell = Shell.node.mapLayer((layer) =>
      Layer.effect(
        Shell.Service,
        Effect.gen(function* () {
          const native = yield* Shell.Service
          return {
            ...native,
            create: (input, before) => {
              if (!self.read("config", {}).guardShell) return native.create(input, before)
              self.trace("shell-boundary", { timeout: input.timeout, command: input.command })
              return Effect.fail(
                new Tool.Error({
                  message: "fixture captured native shell invocation before spawn",
                }),
              )
            },
          }
        }),
      ).pipe(Layer.provide(layer)),
    )
    this.runtime = ManagedRuntime.make(
      Layer.effect(
        OpenCode.Service,
        Effect.gen(function* () {
          const model = self.read("config", {}).httpMode
            ? OpenAIChat.route
                .with({
                  endpoint: { baseURL: "https://fixture.test/v1/" },
                  auth: Auth.bearer("fake"),
                })
                .model({ id: "probe" })
            : LanguageModel.make({ id: "probe", provider: "test", route: OpenAIChat.route })
          const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()))
          yield* llm.serve((request) => {
            const call = self.read("modelCalls", 0) + 1
            self.put("modelCalls", call)
            self.trace("model-start", {
              call,
              messages: request.messages,
              tools: request.tools.map((t) => t.name),
              incarnation: self.incarnation,
            })
            const config = self.read("config", {})
            // Deliberate process death preserves native claims; the next invocation must be an alarm.
            if ((config.crashes ?? 0) >= call) {
              setTimeout(async () => {
                if (config.blockOnCrash) {
                  self.put("blocked", true)
                  self.trace("block-persisted")
                  await self.ctx.storage.sync()
                }
                self.ctx.abort("fixture process interruption")
              }, 30)
              return Stream.fromEffect(Effect.never)
            }
            if (config.guardShell && call <= 4) {
              const input =
                call === 1
                  ? { command: "fixture", timeout: 0 }
                  : call === 2
                    ? { command: "fixture" }
                    : call === 3
                      ? { command: "fixture", timeout: 300000 }
                      : { command: "fixture", background: true }
              return Stream.fromIterable(TestLLM.tool("guard-" + call, "shell", input))
            }
            const delay = config.delayMs ?? 0
            return Stream.fromEffect(Effect.sleep(delay)).pipe(
              Stream.flatMap(() => {
                self.trace("model-response", { call, incarnation: self.incarnation })
                return Stream.fromIterable(
                  TestLLM.textWithUsage(
                    config.plainQuestion && call === 1
                      ? "Which approach do you prefer, A or B?"
                      : "fixture answer " + call,
                    "answer",
                    7,
                  ),
                )
              }),
            )
          })
          const driver = WorkspaceDriver.make({
            create: ({ workspaceID }) => Effect.succeed({ binding: { workspaceID } }),
            connect: () => Effect.succeed(makeMemoryDriver()),
            suspendForIdle: () => Effect.void,
            destroy: () => Effect.void,
          })
          const options = {
            storage: self.ctx.storage,
            models: { fetch: false },
            config: { content: "{}" },
          }
          const sdk = yield* OpenCode.create(
            { ...ServerWorkerd.serverOptions(options), workspaceProviders: { fake: driver } },
            {
              overrides: [
                ...ServerWorkerd.replacements(options),
                SessionExecution.node.replace(execution),
                Shell.node.replace(shell),
                llmClient.replace(
                  self.read("config", {}).httpMode
                    ? httpModel(self)
                    : Layer.succeed(LLMClient.Service, llm),
                ),
                SessionRunnerModel.node.replace(
                  Layer.mock(SessionRunnerModel.Service, {
                    resolve: () =>
                      Effect.succeed(
                        SessionRunnerModel.resolved(model, {
                          capabilities: { tools: true, input: ["text"], output: ["text"] },
                          cost: [],
                          limit: { context: 100000, output: 1000 },
                        }),
                      ),
                  }),
                ),
              ],
            },
          )
          if (self.read("config", {}).plainQuestion)
            yield* sdk.plugin({
              id: "plain-questions",
              effect: (ctx) => ctx.tool.transform((editor) => editor.remove("question")),
            })
          yield* sdk.plugin({
            id: "foreground-deadline",
            effect: (ctx) =>
              ctx.tool.hook("execute.before", (event) => {
                if (event.tool !== "shell") return Effect.void
                const input = event.input
                if (
                  input?.background === true ||
                  (input?.timeout !== undefined &&
                    (!Number.isFinite(input.timeout) || input.timeout <= 0))
                ) {
                  self.trace("shell-rejected", { input })
                  return Effect.fail(
                    new Tool.Error({
                      message: "Foreground commands require a finite positive timeout",
                    }),
                  )
                }
                return Effect.void
              }),
          })
          yield* sdk.plugin({
            id: "quiet-fixture",
            effect: (ctx) =>
              ctx.tool.transform((editor) =>
                editor.add({
                  name: "fixture_pause",
                  description: "Quiet finite tool for lifecycle test",
                  input: Schema.Struct({}),
                  options: { codemode: false },
                  execute: () =>
                    Effect.gen(function* () {
                      self.trace("tool-start")
                      yield* Effect.sleep(800)
                      self.trace("tool-end")
                      return "quiet tool complete"
                    }),
                }),
              ),
          })
          return sdk
        }),
      ),
    )
    return this.runtime
  }
  sdk(effect) {
    this.init()
    return this.run(Effect.flatMap(OpenCode.Service, effect))
  }
  async arm() {
    const due = Date.now() + (this.read("config", {}).intervalMs ?? 30000)
    this.put("obligation", true)
    const existing = await this.ctx.storage.getAlarm()
    if (existing === null || existing > due) await this.ctx.storage.setAlarm(due)
    this.trace("armed", { due })
  }
  row() {
    const id = this.read("session")
    return id
      ? [
          ...this.sql.exec(
            "SELECT id,time_suspended,resume_attempts,time_idle,idle_outcome FROM session_v2 WHERE id=?",
            id,
          ),
        ][0]
      : null
  }
  pending() {
    const id = this.read("session")
    return id
      ? [...this.sql.exec("SELECT COUNT(*) AS n FROM session_inbox WHERE session_id=?", id)][0].n
      : 0
  }
  async create(config) {
    if (this.read("session")) return this.read("session")
    if (this.creating) return this.creating
    this.put("config", config)
    if (!this.read("intendedSession"))
      this.put("intendedSession", "ses_" + crypto.randomUUID().replaceAll("-", ""))
    this.creating = (async () => {
      const intended = this.read("intendedSession")
      const id = await this.sdk((sdk) =>
        Effect.gen(function* () {
          const workspaceID = yield* sdk.workspace.create({ provider: "fake" })
          const session = yield* sdk.sessions.create({
            permissions: [{ action: "*", resource: "*", effect: "allow" }],
            id: intended,
            title: "lifecycle-fixture",
            location: Location.Ref.make({ directory: AbsolutePath.make("/probe"), workspaceID }),
          })
          return session.id
        }),
      )
      if (config.abortCreate && !this.read("createAborted")) {
        this.put("createAborted", true)
        this.ctx.abort("created before mapping reply")
      }
      this.put("session", id)
      this.trace("created", { id })
      return id
    })()
    return this.creating
  }
  async alarm() {
    this.trace("alarm-start", { incarnation: this.incarnation })
    if (!this.read("obligation") || this.read("disconnected")) {
      this.trace("alarm-noop")
      return
    }
    await this.arm()
    if (this.read("blocked")) {
      this.trace("blocked")
      this.put("obligation", false)
      await this.ctx.storage.deleteAlarm()
      return
    }
    const revision = this.read("revision", 0)
    try {
      if (this.read("config", {}).inspectionHang && !this.read("hungOnce")) {
        this.put("hungOnce", true)
        await this.run(Effect.never.pipe(Effect.timeout(200)))
      }
      if (this.read("inspectionFailures", 0) > 0) {
        this.put("inspectionFailures", this.read("inspectionFailures") - 1)
        throw new Error("injected inspection failure")
      }
      await this.sdk((sdk) => sdk.health.get())
      const id = this.read("session")
      const active = id ? await this.run(this.native.isActive(id)) : false
      const row = this.row()
      const pending = this.pending()
      this.trace("inspected", { active, row, pending, revision })
      if (!active && pending && !row?.time_suspended && row?.idle_outcome !== "failed")
        await this.run(this.native.wake(id))
      else if (
        !active &&
        (!pending || row?.idle_outcome === "failed") &&
        !row?.time_suspended &&
        revision === this.read("revision", 0)
      ) {
        if (this.read("config", {}).idleDelayMs) {
          this.trace("idle-inspection")
          await new Promise((r) => setTimeout(r, this.read("config").idleDelayMs))
        }
        if (revision !== this.read("revision", 0)) {
          this.trace("idle-raced")
          return
        }
        this.put("obligation", false)
        await this.ctx.storage.deleteAlarm()
        this.trace("idle")
      }
      // Event projection is a read after execution, never a trigger to run an agent.
      if (id)
        this.put(
          "events",
          await this.sdk((sdk) =>
            sdk.sessions
              .log({ sessionID: id, follow: false })
              .pipe(Stream.runCollect, Effect.map(Array.from)),
          ),
        )
      this.put("row", this.row())
    } catch (error) {
      this.trace("inspection-error", { error: String(error) })
    }
    this.trace("alarm-end")
  }
  async fetch(request) {
    const path = new URL(request.url).pathname
    // This route never initializes the SDK, rearms alarms, or touches native execution.
    if (path === "/evidence")
      return Response.json({
        session: this.read("session"),
        row: this.read("row"),
        modelCalls: this.read("modelCalls", 0),
        obligation: this.read("obligation"),
        alarm: await this.ctx.storage.getAlarm(),
        events: this.read("events", []),
        trace: [...this.sql.exec("SELECT * FROM _janitor_trace")].map((r) => ({
          ...r,
          data: JSON.parse(r.data),
        })),
      })
    if (path === "/cleanup") {
      this.put("disconnected", true)
      this.put("obligation", false)
      await this.ctx.storage.deleteAlarm()
      await this.runtime?.dispose()
      this.runtime = undefined
      await this.ctx.storage.deleteAll()
      return Response.json({ cleaned: true })
    }
    const body = await request.json()
    if (path === "/projection") {
      const events = this.read("events", []).filter((e) => e.durable)
      try {
        this.ctx.storage.transactionSync(() => {
          const cursor = this.read("cursor", 0)
          for (const e of events.filter((e) => e.durable.seq > cursor)) {
            const ids = this.read("projected", [])
            ids.push(e.durable.seq)
            this.put("projected", ids)
            if (body.fail) throw new Error("injected projection crash")
            this.put("cursor", e.durable.seq)
          }
        })
      } catch (error) {
        return Response.json({
          rolledBack: true,
          cursor: this.read("cursor", 0),
          projected: this.read("projected", []),
        })
      }
      return Response.json({
        cursor: this.read("cursor", 0),
        projected: this.read("projected", []),
      })
    }
    if (path === "/create") {
      const session = await this.create(body)
      if (body.lostReply) return new Response("lost creation reply", { status: 503 })
      return Response.json({ session })
    }
    if (path === "/admit") {
      if (this.read("disconnected")) return new Response("disconnected", { status: 409 })
      const sessionID = this.read("session")
      if (!sessionID) throw new Error("create first")
      this.put("revision", this.read("revision", 0) + 1)
      await this.arm()
      this.trace("admission-before", { id: body.id })
      const admitted = await this.sdk((sdk) =>
        sdk.sessions.prompt({
          sessionID,
          id: body.id,
          text: body.text,
          delivery: "queue",
          resume: !body.skipWake,
        }),
      )
      this.trace("admission-after", { id: admitted.id })
      if (body.abortAfter) this.ctx.abort("after saved admission")
      if (body.lostReply) return new Response("injected lost admission reply", { status: 503 })
      return Response.json(admitted)
    }
    if (path === "/block") {
      this.put("blocked", true)
      return Response.json({ blocked: true })
    }
    if (path === "/inspection-failures") {
      this.put("inspectionFailures", body.count)
      return Response.json({ configured: true })
    }
    if (path === "/disconnect") {
      this.put("disconnected", true)
      this.put("obligation", false)
      await this.ctx.storage.deleteAlarm()
      await this.runtime?.dispose()
      return Response.json({ disconnected: true })
    }
    return new Response("unknown", { status: 404 })
  }
}
export default {
  fetch(request, env) {
    if (request.headers.get("authorization") !== `Bearer ${env.FIXTURE_TOKEN}`)
      return new Response("unauthorized", { status: 401 })
    const name = request.headers.get("x-fixture-instance")
    if (!name || !/^[a-z0-9-]{1,70}$/.test(name))
      return new Response("bad fixture identity", { status: 400 })
    return env.RUNNER.get(env.RUNNER.idFromName(name)).fetch(request)
  },
}
