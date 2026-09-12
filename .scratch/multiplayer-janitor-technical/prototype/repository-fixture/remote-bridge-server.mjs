import { createServer } from "node:http"
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { startBridge } from "./bridge.mjs"

const cwd = "/workspace/fixture"
mkdirSync(cwd, { recursive: true })
const token = process.env.FIXTURE_BRIDGE_TOKEN
if (!token) throw new Error("missing fixture token")
const bridge = await startBridge({ token, cwd, isolateProcesses: true })
const dropped = new Set()
// Private container port, reached through Sandbox RPC only. Generated archives
// only: this fixture is not an untrusted archive extraction implementation.
createServer(async (req, res) => {
  const respond = (status, value) => {
    res.writeHead(status)
    res.end(JSON.stringify(value))
  }
  if (req.headers.authorization !== `Bearer ${token}`)
    return respond(401, { error: "unauthorized" })
  try {
    if (req.url === "/meta") return respond(200, { epoch: bridge.epoch })
    if (req.url === "/archive" || req.url === "/restore") {
      if (req.headers["x-bridge-epoch"] !== bridge.epoch)
        return respond(409, { error: "stale epoch" })
      const frozen = await fetch(bridge.url + "/freeze", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-bridge-epoch": bridge.epoch },
      })
      if (!frozen.ok) return respond(409, { error: "writers active" })
      if (req.url === "/archive") {
        execFileSync("tar", ["-cf", "/tmp/fixture-checkpoint.tar", "-C", cwd, "."])
        const bytes = readFileSync("/tmp/fixture-checkpoint.tar")
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": bytes.length,
        })
        res.end(bytes)
      } else {
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > 32 * 1024 * 1024) throw new Error("fixture archive limit")
          chunks.push(chunk)
        }
        writeFileSync("/tmp/fixture-restore.tar", Buffer.concat(chunks))
        rmSync(cwd, { recursive: true })
        mkdirSync(cwd)
        execFileSync("tar", ["-xf", "/tmp/fixture-restore.tar", "-C", cwd])
        respond(200, { restored: size })
      }
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const response = await fetch(bridge.url + req.url, {
      method: req.method,
      headers: {
        authorization: `Bearer ${token}`,
        "x-bridge-epoch": req.headers["x-bridge-epoch"] ?? "",
      },
      body: req.method === "GET" ? undefined : Buffer.concat(chunks),
    })
    if (req.headers["x-fixture-drop-reply"] === "once" && !dropped.has(req.url)) {
      dropped.add(req.url)
      await response.arrayBuffer()
      req.socket.destroy()
      return
    }
    res.writeHead(response.status, { "content-type": "application/json" })
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch (error) {
    respond(500, { error: String(error) })
  }
}).listen(8788, "0.0.0.0")
