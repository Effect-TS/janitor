import { probeNativeTool } from "./native-tool.mjs"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Shell } from "@opencode/core/shell"
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/core/location"
import { Environment } from "@opencode/core/environment/index"
import { SessionEnvironment } from "@opencode/core/session/environment"
import { Config } from "@opencode/core/config"
import { readFile } from "node:fs/promises"

// Actual pinned Shell implementation. Conversation, config, and event delivery
// are fixture dependencies; this is not the native tool or a full SDK session.
export const probeNativeShell = (spawner, cwd, files, rpc) => {
  const events = []
  const layer = AppNodeBuilder.build(Shell.node, [
    Bus.node.replace(
      Layer.succeed(Bus.Service, {
        publish: (type, data) =>
          Effect.sync(() => {
            events.push({ type, data })
          }),
      }),
    ),
    Location.node.replace(
      Layer.succeed(Location.Service, {
        directory: cwd,
        workspaceID: "fixture",
        project: { id: "fixture" },
      }),
    ),
    Environment.node.replace(Layer.succeed(Environment.Service, { spawner })),
    SessionEnvironment.node.replace(
      Layer.succeed(SessionEnvironment.Service, { get: () => Effect.succeed({}) }),
    ),
    Config.node.replace(Layer.succeed(Config.Service, { entries: () => Effect.succeed([]) })),
  ])
  return Effect.gen(function* () {
    const shell = yield* Shell.Service
    const info = yield* shell.create({
      shell: "/bin/sh",
      command: "printf native-out; printf native-err >&2; exit 7",
      cwd,
      timeout: 2000,
    })
    if (!Number.isInteger(info.pid) || info.pid <= 0) throw new Error("missing remote PID")
    const result = yield* shell.result(info)
    if (
      result.info.exit !== 7 ||
      !result.capture?.output.includes("native-out") ||
      !result.capture?.output.includes("native-err")
    )
      throw new Error(JSON.stringify(result))
    const slow = yield* shell.create({ shell: "/bin/sh", command: "sleep 10", cwd, timeout: 100 })
    const timed = yield* shell.result(slow)
    if (timed.info.status !== "timeout") throw new Error(JSON.stringify(timed))
    const cancelled = yield* shell.create({
      shell: "/bin/sh",
      command: "sleep 10",
      cwd,
      timeout: 0,
    })
    yield* shell.remove(cancelled.id)
    const removed = yield* shell.result(cancelled)
    if (removed.info.status !== "killed" || removed.capture !== undefined)
      throw new Error("removed command result changed")
    // Removal releases the command scope asynchronously. Admission must remain
    // fenced until the external bridge observes all processes closed.
    yield* Effect.tryPromise(async () => {
      const deadline = Date.now() + 3000
      for (;;) {
        try {
          await rpc("/freeze", {})
          break
        } catch (error) {
          if (Date.now() >= deadline) throw error
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      await rpc("/thaw", {})
    })
    const large = yield* shell.create({
      shell: "/bin/sh",
      command: "head -c 100000 /dev/zero | tr '\\0' x",
      cwd,
      timeout: 2000,
    })
    const largeResult = yield* shell.result(large)
    if (!largeResult.capture?.truncated || !largeResult.capture.output.includes(large.file))
      throw new Error("large output did not reference capture file")
    const externalRead = yield* files.read(large.file).pipe(Effect.result)
    if (externalRead._tag !== "Failure")
      throw new Error("expected isolated Workerd capture to be unavailable in external workspace")
    // Candidate integration, not a replacement Shell service: copy a settled
    // capture into checkpointed workspace storage before exposing its path.
    // A production adapter must coordinate this with operation completion.
    const capturePath = `${cwd}/fixture-shell-output.out`
    const captureBytes = yield* Effect.tryPromise(() => readFile(large.file))
    yield* files.write(capturePath, captureBytes)
    const retained = yield* files.read(capturePath)
    if (retained.bytes.length !== 100000 || retained.bytes.some((byte) => byte !== 120))
      throw new Error("capture copy changed output")
    yield* shell.remove(info.id)
    yield* shell.remove(slow.id)
    yield* shell.remove(large.id)
    const tool = yield* probeNativeTool(shell, files, spawner, cwd)
    return {
      tool,
      checks: [
        "native shell combined output capture",
        "native shell exit 7",
        "native shell timeout",
        "native shell removal followed by external freeze",
        "large output points to Workerd-only capture",
        "100000 capture bytes copied into external workspace",
      ],
      result,
      timeoutStatus: timed.info.status,
      cancellationStatus: removed.info.status,
      largeCaptureNotInWorkspace: true,
      copiedCaptureBytes: retained.bytes.length,
      eventCount: events.length,
      nativeToolTested: true,
      durableCaptureVerified: false,
    }
  }).pipe(Effect.provide(layer), Effect.timeout("60 seconds"))
}
