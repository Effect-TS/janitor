import { it, expect } from "vitest"
import { Effect } from "effect"
import { execDefaults } from "@opencode/core/environment/exec-defaults"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startBridge } from "../bridge/server.mjs"
import { makeRemoteSpawner, type BridgeRpc } from "../src/RemoteProcess.ts"

it("native filesystem reads and lists repository files through the authenticated process bridge", async () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-native-"))
  const cwd = join(root, "repository")
  mkdirSync(cwd)
  writeFileSync(join(cwd, "README.md"), "Native repository answer\n")
  const bridge = await startBridge({
    token: "native-test",
    generation: 1,
    cwd,
    journalPath: join(root, "journal.sqlite"),
    isolateProcesses: false,
  })
  try {
    const rpc: BridgeRpc = async (path, input) => {
      const response = await fetch(bridge.url + path, {
        method: input === undefined ? "GET" : "POST",
        headers: {
          authorization: "Bearer native-test",
          "x-janitor-generation": "1",
          "x-bridge-epoch": bridge.epoch,
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      })
      if (!response.ok) throw new Error(await response.text())
      return response.json() as never
    }
    const files = execDefaults(makeRemoteSpawner(rpc))
    const read = await Effect.runPromise(files.read(join(cwd, "README.md")))
    expect(new TextDecoder().decode(read.bytes)).toBe("Native repository answer\n")
    const entries = await Effect.runPromise(files.list(cwd))
    expect(entries).toEqual([{ name: "README.md", type: "file" }])
    const binary = new Uint8Array([0, 255, 10, 128, 0, 42])
    await Effect.runPromise(files.write(join(cwd, "binary.dat"), binary))
    expect(
      Array.from((await Effect.runPromise(files.read(join(cwd, "binary.dat")))).bytes),
    ).toEqual(Array.from(binary))
  } finally {
    await bridge.close()
    rmSync(root, { recursive: true, force: true })
  }
})
