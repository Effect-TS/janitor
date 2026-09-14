import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startBridge } from "./server.mjs"

test("isolated workspaces retain binary native process results across lost replies", async () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-inspect-"))
  const bridges = []
  try {
    for (const name of ["one", "two"]) {
      const cwd = join(root, name)
      mkdirSync(cwd)
      writeFileSync(join(cwd, "README.md"), `repository ${name}\n`)
      bridges.push(
        await startBridge({
          token: "test-token",
          generation: 3,
          cwd,
          journalPath: join(root, `${name}.sqlite`),
          isolateProcesses: false,
        }),
      )
    }
    const rpc = async (bridge, path, body, overrides = {}) => {
      const response = await fetch(bridge.url + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: "Bearer test-token",
          "x-bridge-epoch": bridge.epoch,
          "x-janitor-generation": "3",
          ...overrides,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() }
    }
    for (const [index, bridge] of bridges.entries()) {
      const input = { id: "read", argv: ["cat", "README.md"] }
      const first = await rpc(bridge, "/process", input)
      assert.equal(first.status, 200)
      // Discard the first receipt and retrieve by the same immutable operation identity.
      const repeated = await rpc(bridge, "/process", input)
      assert.equal(repeated.body.pid, first.body.pid)
      let output
      do {
        output = await rpc(bridge, "/process/read")
        await new Promise((resolve) => setTimeout(resolve, 10))
      } while (!output.body.closed)
      assert.equal(output.body.code, 0)
      assert.equal(
        Buffer.concat(output.body.frames.map((f) => Buffer.from(f.base64, "base64"))).toString(),
        `repository ${index === 0 ? "one" : "two"}\n`,
      )
      assert.equal((await rpc(bridge, "/process", { ...input, argv: ["pwd"] })).status, 409)
      assert.equal(
        (
          await rpc(
            bridge,
            "/process",
            { id: "stale", argv: ["pwd"] },
            { "x-janitor-generation": "2" },
          )
        ).status,
        409,
      )
      assert.equal(
        (
          await rpc(
            bridge,
            "/process",
            { id: "bad", argv: ["pwd"] },
            { authorization: "Bearer invalid" },
          )
        ).status,
        401,
      )
    }
  } finally {
    await Promise.all(bridges.map((bridge) => bridge.close()))
    rmSync(root, { recursive: true, force: true })
  }
})

test("a new bridge epoch retains evidence and never replays an old operation", async () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-epoch-"))
  const options = {
    token: "epoch-token",
    generation: 1,
    cwd: root,
    journalPath: join(root, "journal.sqlite"),
    isolateProcesses: false,
  }
  let bridge = await startBridge(options)
  const invoke = async (path, input, epoch = bridge.epoch) => {
    const response = await fetch(bridge.url + path, {
      method: input ? "POST" : "GET",
      headers: {
        authorization: "Bearer epoch-token",
        "x-janitor-generation": "1",
        "x-bridge-epoch": epoch,
      },
      body: input ? JSON.stringify(input) : undefined,
    })
    return { status: response.status, body: await response.json() }
  }
  try {
    const command = { id: "retained", argv: ["sh", "-c", "printf evidence; sleep 30"] }
    assert.equal((await invoke("/process", command)).status, 200)
    const oldEpoch = bridge.epoch
    await bridge.close()
    bridge = await startBridge(options)
    assert.equal((await invoke("/process", command, oldEpoch)).status, 409)
    assert.equal((await invoke("/process", command)).status, 409)
    const evidence = await invoke("/process/retained")
    assert.equal(evidence.body.epoch, oldEpoch)
    assert.equal(evidence.body.closed, true)
    assert.equal(evidence.body.signal, "SIGKILL")
  } finally {
    await bridge.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("binary stdin retries and output cursors do not duplicate bytes; cancellation settles the process", async () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-stream-"))
  const bridge = await startBridge({
    token: "stream-token",
    generation: 1,
    cwd: root,
    journalPath: join(root, "journal.sqlite"),
    isolateProcesses: false,
  })
  const rpc = async (path, input) => {
    const response = await fetch(bridge.url + path, {
      method: input ? "POST" : "GET",
      headers: {
        authorization: "Bearer stream-token",
        "x-janitor-generation": "1",
        "x-bridge-epoch": bridge.epoch,
      },
      body: input ? JSON.stringify(input) : undefined,
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  const settled = async (id) => {
    for (let i = 0; i < 100; i++) {
      const result = await rpc(`/process/${id}`)
      if (result.closed) return result
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.fail("process did not settle")
  }
  try {
    await rpc("/process", { id: "binary", argv: ["cat"] })
    const chunk = { seq: 0, base64: "AP8KgA==", end: false }
    await rpc("/process/binary/stdin", chunk)
    assert.equal((await rpc("/process/binary/stdin", chunk)).duplicate, true)
    await rpc("/process/binary/stdin", { seq: 1, base64: "", end: true })
    const result = await settled("binary")
    assert.deepEqual(
      Buffer.concat(result.frames.map((frame) => Buffer.from(frame.base64, "base64"))),
      Buffer.from([0, 255, 10, 128]),
    )
    assert.deepEqual((await rpc(`/process/binary?after=${result.frames.at(-1).seq}`)).frames, [])
    await rpc("/process", { id: "cancel", argv: ["sleep", "30"] })
    await rpc("/process/cancel/kill", { signal: "SIGKILL" })
    assert.equal((await settled("cancel")).signal, "SIGKILL")
  } finally {
    await bridge.close()
    rmSync(root, { recursive: true, force: true })
  }
})
