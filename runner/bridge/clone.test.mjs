import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { startBridge } from "./server.mjs"

test("controlled Git clone authenticates without saving credentials and adopts its completed result", async () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-clone-"))
  const remote = join(root, "remote")
  mkdirSync(join(remote, "test"), { recursive: true })
  execFileSync("git", ["init", "--bare", join(remote, "test", "example.git")], { stdio: "ignore" })
  let authorized = 0
  const git = createServer((req, res) => {
    if (
      req.headers.authorization !==
      `Basic ${Buffer.from("x-access-token:private-test-token").toString("base64")}`
    ) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="fixture"' })
      res.end()
      return
    }
    authorized++
    const url = new URL(req.url, "http://localhost")
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: remote,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method,
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        REMOTE_USER: "fixture",
      },
      stdio: ["pipe", "pipe", "ignore"],
    })
    req.pipe(child.stdin)
    const chunks = []
    child.stdout.on("data", (chunk) => chunks.push(chunk))
    child.on("close", () => {
      const output = Buffer.concat(chunks)
      const boundary = output.indexOf("\r\n\r\n")
      const headers = Object.fromEntries(
        output
          .subarray(0, boundary)
          .toString()
          .split("\r\n")
          .map((line) => {
            const index = line.indexOf(":")
            return [line.slice(0, index), line.slice(index + 1).trim()]
          }),
      )
      res.writeHead(200, headers)
      res.end(output.subarray(boundary + 4))
    })
  })
  await new Promise((resolve) => git.listen(0, "127.0.0.1", resolve))
  const cwd = join(root, "workspace")
  mkdirSync(cwd)
  const journalPath = join(root, "operations.sqlite")
  const bridge = await startBridge({
    token: "bridge-token",
    generation: 1,
    cwd,
    journalPath,
    isolateProcesses: false,
    cloneOrigin: `http://127.0.0.1:${git.address().port}`,
  })
  const clone = async (token) => {
    const response = await fetch(bridge.url + "/clone", {
      method: "POST",
      headers: {
        authorization: "Bearer bridge-token",
        "x-janitor-generation": "1",
        "x-bridge-epoch": bridge.epoch,
      },
      body: JSON.stringify({ owner: "test", repo: "example", token }),
    })
    return { status: response.status, body: await response.json() }
  }
  try {
    assert.equal((await clone("private-test-token")).status, 200)
    assert.ok(authorized > 0)
    const count = authorized
    assert.equal((await clone("different-token")).body.duplicate, true)
    assert.equal(authorized, count)
    const config = readFileSync(join(cwd, "repository/.git/config"), "utf8")
    assert.ok(!config.includes("credential"))
    const visit = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) visit(path)
        else assert.ok(!readFileSync(path).includes(Buffer.from("private-test-token")), path)
      }
    }
    visit(cwd)
    assert.ok(!readFileSync(journalPath).includes(Buffer.from("private-test-token")))
  } finally {
    await bridge.close()
    git.closeAllConnections()
    await new Promise((resolve) => git.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
})
