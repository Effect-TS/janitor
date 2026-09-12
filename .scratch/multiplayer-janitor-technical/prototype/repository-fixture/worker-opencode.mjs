import { probeNativeShell } from "./native-shell.mjs"
import { Effect } from "effect"
import { execDefaults } from "@opencode/core/environment/exec-defaults"
import { makeFixtureSpawner } from "./fixture-spawner.mjs"

export default {
  async fetch(request, env) {
    const rpc = async (path, input) => {
      const response = await env.BRIDGE.fetch(
        new Request(`http://bridge${path}`, {
          method: input === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          body: input === undefined ? undefined : JSON.stringify(input),
        }),
      )
      const result = await response.json()
      if (!response.ok) throw new Error(JSON.stringify(result))
      return result
    }
    const files = execDefaults(makeFixtureSpawner(rpc))
    const check = (condition, message) => {
      if (!condition) throw new Error(message)
    }
    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const source = `${env.WORKSPACE}/from-workerd.bin`
            const target = `${env.WORKSPACE}/moved-workerd.bin`
            const bytes = new Uint8Array([0, 255, 128, 10, 13, 65])
            yield* files.write(source, bytes)
            const read = yield* files.read(source)
            check(
              JSON.stringify([...read.bytes]) === JSON.stringify([...bytes]),
              "binary data changed",
            )
            check(read.info.size === bytes.length, "size changed")
            yield* files.move(source, target)
            const entries = yield* files.list(env.WORKSPACE)
            check(
              entries.some((entry) => entry.name === "moved-workerd.bin"),
              "moved file missing",
            )
            yield* files.remove(target)
            check(
              !(yield* files.list(env.WORKSPACE)).some(
                (entry) => entry.name === "moved-workerd.bin",
              ),
              "removed file present",
            )
            const shell = yield* probeNativeShell(
              makeFixtureSpawner(rpc),
              env.WORKSPACE,
              files,
              rpc,
            )
            return {
              shell,
              checks: ["binary write/read", "stat", "move/list/remove"],
              workerdTested: true,
              cloudflareSandboxTested: false,
              completeSpawnerContract: false,
            }
          }),
        ),
      )
      return Response.json(result)
    } catch (error) {
      return Response.json(
        { error: String(error), cause: String(error.cause ?? "") },
        { status: 500 },
      )
    }
  },
}
