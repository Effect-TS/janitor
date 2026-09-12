import { Effect, Layer, Stream } from "effect"
import { OpenCode, AbsolutePath, Location, Tool } from "@opencode/sdk/effect"
import { LanguageModel, LLMClient } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { ServerWorkerd } from "@opencode/server/workerd"
import { WorkspaceDriver } from "@opencode/core/workspace/driver"
import { Shell } from "@opencode/core/shell"
import { execDefaults } from "@opencode/core/environment/exec-defaults"
import { makeFixtureSpawner } from "./fixture-spawner.mjs"
import { readFile } from "node:fs/promises"
import { Database } from "@opencode/core/database/database"
import { sqliteLayer } from "@opencode/core/database/sqlite.workerd"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"

// OpenCode owns unprefixed tables and ignores underscore-prefixed embedder
// tables during bootstrap. Keep Janitor data under _janitor_* names.
export const initializeSDKDatabase = (storage) =>
  Effect.runPromise(
    Effect.scoped(
      Database.Service.pipe(
        Effect.asVoid,
        Effect.provide(AppNodeBuilder.build(Database.configuredClient(sqliteLayer({ storage })))),
      ),
    ),
  )

export const removeSDKSession = (storage, sessionID) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const options = { storage, models: { fetch: false }, config: { content: "{}" } }
        const sdk = yield* OpenCode.create(ServerWorkerd.serverOptions(options), {
          overrides: ServerWorkerd.replacements(options),
        })
        yield* sdk.sessions.remove({ sessionID })
      }),
    ),
  )

export const probeSDKSession = (storage, rpc, admitCommand, checkpointCapture) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = makeFixtureSpawner(rpc)
      const files = execDefaults(spawner)
      const calls = { create: 0, connect: 0, model: 0, rejected: 0, captures: 0 }
      const model = LanguageModel.make({ id: "probe", provider: "test", route: OpenAIChat.route })
      const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()))
      yield* llm.serve((request) => {
        if (!request.tools.some((t) => t.name === "shell"))
          throw new Error("native shell tool absent")
        calls.model++
        if (calls.model === 1)
          return Stream.fromIterable(
            TestLLM.tool("background-attempt", "shell", {
              command: "touch sdk-forbidden",
              background: true,
            }),
          )
        if (calls.model === 2)
          return Stream.fromIterable(
            TestLLM.tool("foreground-command", "shell", {
              command: "printf 'SDK native shell result\\n' > sdk-result.md; printf sdk-complete",
              workdir: "/workspace/fixture",
              timeout: 5000,
            }),
          )
        return TestLLM.textWithUsage("fixture complete", "answer", 7)
      })
      const driver = WorkspaceDriver.make({
        create: ({ workspaceID }) =>
          Effect.sync(() => {
            calls.create++
            return { binding: { workspaceID, sandbox: "fixture" } }
          }),
        connect: ({ workspaceID, binding }) =>
          Effect.sync(() => {
            if (binding.workspaceID !== workspaceID) throw new Error("workspace binding mismatch")
            calls.connect++
            return { spawner }
          }),
        suspendForIdle: () => Effect.die(new Error("idle lifecycle is tested separately")),
        destroy: () => Effect.die(new Error("fixture provider cleanup belongs to controller")),
      })
      const options = {
        storage,
        models: { fetch: false },
        config: { content: JSON.stringify({ experimental: { portable_shell_scanner: true } }) },
      }
      const shellCapture = Shell.node.mapLayer((layer) =>
        Layer.effect(
          Shell.Service,
          Effect.gen(function* () {
            const native = yield* Shell.Service
            return {
              ...native,
              create: (input, before) =>
                Effect.tryPromise(() =>
                  admitCommand({ command: input.command, cwd: input.cwd }),
                ).pipe(Effect.andThen(native.create(input, before))),
              result: (started) =>
                native.result(started).pipe(
                  Effect.flatMap((result) =>
                    Effect.gen(function* () {
                      if (!result.capture) return result
                      const path = `/workspace/fixture/tool-capture-${started.id}.out`
                      const bytes = yield* Effect.tryPromise(() => readFile(started.file))
                      yield* files.write(path, bytes)
                      yield* Effect.tryPromise(checkpointCapture)
                      calls.captures++
                      return {
                        ...result,
                        info: { ...result.info, file: path },
                        capture: {
                          ...result.capture,
                          output: result.capture.output.replaceAll(started.file, path),
                        },
                      }
                    }),
                  ),
                ),
            }
          }),
        ).pipe(Layer.provide(layer)),
      )
      const sdk = yield* OpenCode.create(
        { ...ServerWorkerd.serverOptions(options), workspaceProviders: { fixture: driver } },
        {
          overrides: [
            ...ServerWorkerd.replacements(options),
            Shell.node.replace(shellCapture),
            llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
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
      yield* sdk.plugin({
        id: "janitor-foreground-fixture",
        effect: (ctx) =>
          ctx.tool.hook("execute.before", (event) => {
            if (event.tool === "shell" && event.input?.background === true) {
              calls.rejected++
              return Effect.fail(
                new Tool.Error({
                  message: "Foreground-only session: background execution is unavailable",
                }),
              )
            }
            return Effect.void
          }),
      })
      const workspaceID = yield* sdk.workspace.create({ provider: "fixture" })
      yield* sdk.workspace.provision({ workspaceID })
      yield* sdk.workspace.provision({ workspaceID })
      const session = yield* sdk.sessions.create({
        title: "Disposable remote execution verification",
        location: Location.Ref.make({
          directory: AbsolutePath.make("/workspace/fixture"),
          workspaceID,
        }),
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      })
      yield* sdk.sessions.prompt({
        sessionID: session.id,
        text: "Run the deterministic fixture.",
        delivery: "queue",
        resume: true,
      })
      yield* sdk.sessions.wait({ sessionID: session.id })
      const file = yield* files.read("/workspace/fixture/sdk-result.md")
      if (new TextDecoder().decode(file.bytes) !== "SDK native shell result\n")
        throw new Error("SDK command output missing")
      const entries = yield* files.list("/workspace/fixture")
      if (
        entries.some((e) => e.name === "sdk-forbidden") ||
        calls.rejected !== 1 ||
        calls.captures !== 1 ||
        calls.create !== 1
      )
        throw new Error(JSON.stringify(calls))
      const events = Array.from(
        yield* sdk.sessions.log({ sessionID: session.id, follow: false }).pipe(Stream.runCollect),
      )
      return {
        sessionID: session.id,
        workspaceID,
        calls,
        durableEventCount: events.length,
        actualSDKSession: true,
        actualNativeShellTool: true,
        durableAdmissionBeforeCommand: true,
        checkpointBeforeNativeToolResult: true,
        fakeModel: true,
        unattendedLifecycleTested: false,
      }
    }),
  ).pipe(Effect.timeout("90 seconds"))
