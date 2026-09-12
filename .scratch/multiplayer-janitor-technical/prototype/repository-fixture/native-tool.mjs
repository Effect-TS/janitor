import { Effect, Layer } from "effect"
import { ShellTool } from "@opencode/core/tool/plugin/shell"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { Session } from "@opencode/core/session"
import { Shell } from "@opencode/core/shell"
import { ShellSelect } from "@opencode/core/shell/select"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { FileAccess } from "@opencode/core/file-access"
import { Permission } from "@opencode/core/permission"
import { readFile } from "node:fs/promises"

// Fixture wrapper preserves native execution and result shape. Authentication
// and approval services below allow only the generated fixture environment.
export const probeNativeTool = (shell, files, spawner, cwd) =>
  Effect.gen(function* () {
    let definition
    let captureCount = 0
    const stored = new Map()
    const jobs = yield* Job.make.pipe(
      Effect.provideService(KV.Service, {
        set: (key, value) => Effect.sync(() => stored.set(key, value)),
        get: (key) => Effect.succeed(stored.get(key)),
        remove: (key) => Effect.sync(() => stored.delete(key)),
        list: () => Effect.succeed([]),
      }),
    )
    const adaptedShell = {
      ...shell,
      result: (started) =>
        shell.result(started).pipe(
          Effect.flatMap((result) =>
            Effect.gen(function* () {
              if (!result.capture) return result
              const path = `${cwd}/tool-capture-${started.id}.out`
              const bytes = yield* Effect.tryPromise(() => readFile(started.file))
              yield* files.write(path, bytes)
              captureCount++
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
    const ctx = {
      tool: {
        transform: (update) =>
          Effect.sync(() =>
            update({
              add: (tool) => {
                definition = tool
              },
            }),
          ),
      },
      session: { hook: () => Effect.void },
    }
    yield* ShellTool.Plugin.effect(ctx).pipe(
      Effect.provideService(Shell.Service, adaptedShell),
      Effect.provideService(Session.Service, {
        synthetic: () => Effect.die(new Error("background notification forbidden")),
      }),
      Effect.provideService(Job.Service, jobs),
      Effect.provideService(ShellSelect.Service, { resolve: () => Effect.succeed("/bin/sh") }),
      Effect.provideService(Config.Service, {
        entries: () =>
          Effect.succeed([
            { type: "document", info: { experimental: { portable_shell_scanner: true } } },
          ]),
      }),
      Effect.provideService(Environment.Service, { files, spawner }),
      Effect.provideService(FileAccess.Service, {
        resolve: ({ path }) => Effect.succeed({ absolute: path }),
        authorizeExternal: () => Effect.void,
      }),
      Effect.provideService(Permission.Service, { assert: () => Effect.void }),
    )
    const execute = (input) =>
      input.background === true
        ? Effect.fail(new Error("Foreground-only session: background execution is unavailable"))
        : definition.execute(input, {
            sessionID: "ses_fixture",
            messageID: "msg_fixture",
            id: "call_fixture",
            agent: "fixture",
            progress: () => Effect.void,
          })
    const denied = yield* execute({ command: "touch forbidden-background", background: true }).pipe(
      Effect.result,
    )
    if (denied._tag !== "Failure" || captureCount !== 0)
      throw new Error("background request was not rejected before execution")
    const response = yield* execute({
      command: "head -c 100000 /dev/zero | tr '\\0' z",
      workdir: cwd,
      timeout: 5000,
    })
    if (
      response.output.status !== "completed" ||
      !response.output.truncated ||
      !response.output.output.includes(`${cwd}/tool-capture-`)
    )
      throw new Error(JSON.stringify(response))
    const path = response.output.output.match(/full output saved to: (.+)\]/)?.[1]
    const captured = yield* files.read(path)
    if (captured.bytes.length !== 100000 || captured.bytes.some((byte) => byte !== 122))
      throw new Error("native tool output path does not read complete capture")
    const listing = yield* files.list(cwd)
    if (listing.some((entry) => entry.name === "forbidden-background"))
      throw new Error("background command ran")
    return {
      nativeToolTested: true,
      backgroundRejectedBeforeExecution: true,
      nativeJobRegistryUsed: true,
      rewrittenOutputReadable: true,
      captureBytes: captured.bytes.length,
      permissionsAreFixtureStubs: true,
    }
  })
