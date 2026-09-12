import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { startBridge } from "./bridge.mjs"

const cwd = mkdtempSync(join(tmpdir(), "janitor-bridge-"))
const token = randomBytes(32).toString("hex")
const bridge = await startBridge({ token, cwd })
const checks = []
async function call(path, input, expected = 200) {
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
  assert.equal(response.status, expected, JSON.stringify(result))
  return result
}
async function finish(id) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await call(`/process/${id}`)
    if (result.closed) return result
    await delay(10)
  }
  throw new Error("process failed to exit within fixture deadline")
}
try {
  assert.equal((await fetch(bridge.url + "/process/echo")).status, 401)
  checks.push("unauthenticated requests rejected")
  const request = {
    id: "echo",
    argv: [
      process.execPath,
      "-e",
      "process.stdin.on('data', b => { process.stdout.write(b); process.stderr.write(b); }); process.stdin.on('end', () => process.exitCode = 7)",
    ],
  }
  await call("/process", request)
  assert.equal((await call("/process", request)).duplicate, true)
  await call("/process", { ...request, argv: ["false"] }, 409)
  const bytes = Buffer.from([0, 255, 10, 13, 128, 65])
  const input = { seq: 0, base64: bytes.toString("base64"), end: true }
  await call("/process/echo/stdin", input)
  assert.equal((await call("/process/echo/stdin", input)).duplicate, true)
  const result = await finish("echo")
  assert.equal(result.code, 7)
  for (const kind of ["stdout", "stderr"])
    assert.deepEqual(
      Buffer.concat(
        result.frames.filter((f) => f.kind === kind).map((f) => Buffer.from(f.base64, "base64")),
      ),
      bytes,
    )
  assert.deepEqual((await call(`/process/echo?after=${result.frames.at(-1).seq}`)).frames, [])
  checks.push(
    "binary stdin/EOF and distinct stdout/stderr preserved; nonzero exit and cursor replay observed",
  )
  checks.push(
    "duplicate spawn and stdin retries do not repeat their effect within one bridge lifetime",
  )
  await call("/process", {
    id: "write",
    argv: ["sh", "-c", 'cat > "$1"', "sh", "file with spaces.bin"],
  })
  await call("/process/write/stdin", input)
  assert.equal((await finish("write")).code, 0)
  assert.deepEqual(readFileSync(join(cwd, "file with spaces.bin")), bytes)
  checks.push("argv process writes binary file through stdin using OpenCode-style shell operation")
  await call("/process", {
    id: "wait",
    argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
  })
  await call("/freeze", {}, 409)
  await call("/process/wait/kill", { signal: "SIGTERM" })
  assert.equal((await finish("wait")).signal, "SIGTERM")
  await call("/freeze", {})
  await call("/process", { id: "frozen", argv: ["true"] }, 409)
  await call("/thaw", {})
  await call("/process", { id: "after-thaw", argv: ["true"] })
  assert.equal((await finish("after-thaw")).code, 0)
  checks.push(
    "active process blocks freeze; cancellation completes; freeze rejects new writers until thaw",
  )
  console.log(
    JSON.stringify(
      {
        kind: "local-http-process-bridge",
        cwd,
        checks,
        cloudflareTested: false,
        effectAdapterTested: false,
        durableProcessJournal: false,
        escapedDescendantContainment: false,
      },
      null,
      2,
    ),
  )
} finally {
  await bridge.close()
}
