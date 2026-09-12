import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeFixtureSpawner } from "./fixture-spawner.mjs"
import { execDefaults } from "@opencode/core/environment/exec-defaults"
import { startBridge } from "./bridge.mjs"

// Narrow executable adapter experiment for OpenCode's default file operations.
// Deliberately rejects pipelines, custom fds and cwd changes; this is not the
// complete production ChildProcessSpawner implementation or a Workerd test.
const cwd = mkdtempSync(join(tmpdir(), "janitor-opencode-files-"))
const token = randomUUID()
const bridge = await startBridge({ token, cwd })
async function rpc(path, input) {
  const response = await fetch(bridge.url + path, {
    method: input === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-bridge-epoch": bridge.epoch,
      "content-type": "application/json",
    },
    body: input === undefined ? undefined : JSON.stringify(input),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(JSON.stringify(result))
  return result
}
const spawner = makeFixtureSpawner(rpc)
try {
  const files = execDefaults(spawner)
  const bytes = new Uint8Array([0, 255, 128, 65, 10])
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const original = join(cwd, "nested", "file with spaces.bin")
        const moved = join(cwd, "nested", "moved.bin")
        yield* files.write(original, bytes)
        const read = yield* files.read(original)
        assert.deepEqual(Array.from(read.bytes), Array.from(bytes))
        assert.equal(read.info.size, bytes.length)
        yield* files.move(original, moved)
        const entries = yield* files.list(join(cwd, "nested"))
        assert.equal(entries[0].name, "moved.bin")
        yield* files.remove(moved)
        assert.equal((yield* files.list(join(cwd, "nested"))).length, 0)
      }),
    ),
  )
  console.log(
    JSON.stringify(
      {
        kind: "pinned-opencode-default-file-operations-over-local-http",
        cwd,
        checks: ["binary write/read via stdin", "stat size", "move/list/remove"],
        workerdTested: false,
        cloudflareTested: false,
        completeSpawnerContract: false,
      },
      null,
      2,
    ),
  )
} finally {
  await bridge.close()
}
