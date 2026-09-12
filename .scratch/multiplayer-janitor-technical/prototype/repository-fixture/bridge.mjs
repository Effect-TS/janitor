import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { randomUUID, timingSafeEqual } from "node:crypto"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"

// Bounded protocol experiment. In-memory process records deliberately do not
// claim recovery after bridge/container loss. Never expose without authentication.
export async function startBridge({
  token,
  cwd,
  dropReply = () => false,
  isolateProcesses = false,
}) {
  const processes = new Map()
  const epoch = randomUUID()
  let frozen = false
  const server = createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(value))
    }
    const supplied = Buffer.from(req.headers.authorization ?? "")
    const expected = Buffer.from(`Bearer ${token}`)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      reply(401, { error: "unauthorized" })
      return
    }
    if (req.headers["x-bridge-epoch"] !== epoch) {
      reply(409, { error: "bridge epoch changed; reconcile operation before retry" })
      return
    }
    try {
      let body = ""
      for await (const chunk of req) {
        body += chunk
        if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error("request too large")
      }
      const input = body ? JSON.parse(body) : {}
      const url = new URL(req.url, "http://localhost")
      if (req.method === "POST" && url.pathname === "/process") {
        if (frozen) return reply(409, { error: "workspace frozen" })
        const { id, argv, env = {} } = input
        if (
          !/^[a-zA-Z0-9-]{1,80}$/.test(id ?? "") ||
          !Array.isArray(argv) ||
          !argv.length ||
          !argv.every((s) => typeof s === "string")
        ) {
          return reply(400, { error: "invalid process request" })
        }
        const root = realpathSync(cwd)
        const commandCwd = realpathSync(resolve(cwd, input.cwd ?? cwd))
        if (commandCwd !== root && !commandCwd.startsWith(root + "/"))
          return reply(400, { error: "cwd is outside workspace" })
        const original = JSON.stringify({ argv, env, cwd: input.cwd })
        const previous = processes.get(id)
        if (previous) {
          return reply(previous.original === original ? 200 : 409, {
            id,
            pid: previous.child.pid,
            duplicate: true,
          })
        }
        const executable = isolateProcesses ? "unshare" : argv[0]
        const args = isolateProcesses
          ? ["--user", "--map-root-user", "--pid", "--fork", "--kill-child=SIGKILL", "--", ...argv]
          : argv.slice(1)
        const { FIXTURE_BRIDGE_TOKEN: _controlToken, ...inherited } = process.env
        const child = spawn(executable, args, {
          cwd: commandCwd,
          env: { ...inherited, ...env },
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        })
        const record = {
          id,
          original,
          child,
          frames: [],
          bytes: 0,
          closed: false,
          inputSeq: 0,
          inputs: new Map(),
          ended: false,
        }
        processes.set(id, record)
        const frame = (kind, bytes) => {
          record.bytes += bytes.length
          if (record.bytes > 8 * 1024 * 1024) {
            record.overflow = true
            try {
              process.kill(-child.pid, "SIGKILL")
            } catch {}
            return
          }
          record.frames.push({
            seq: record.frames.length + 1,
            kind,
            base64: bytes.toString("base64"),
          })
        }
        child.stdout.on("data", (bytes) => frame("stdout", bytes))
        child.stderr.on("data", (bytes) => frame("stderr", bytes))
        child.stdin.on("error", () => {})
        child.on("error", (error) => {
          record.error = error.code ?? "spawn failed"
        })
        child.on("close", (code, signal) => {
          Object.assign(record, { closed: true, code, signal })
        })
        if (dropReply({ path: url.pathname, input })) return res.destroy()
        return reply(200, { id, pid: child.pid })
      }
      if (req.method === "POST" && url.pathname === "/freeze") {
        // Check and set in one synchronous section. Process creation is rejected
        // until thaw. Descendant containment still requires remote verification.
        if ([...processes.values()].some((p) => !p.closed))
          return reply(409, { error: "writers still active" })
        frozen = true
        return reply(200, { frozen })
      }
      if (req.method === "POST" && url.pathname === "/thaw") {
        frozen = false
        return reply(200, { frozen })
      }
      const match = /^\/process\/([a-zA-Z0-9-]+)(?:\/(stdin|kill))?$/.exec(url.pathname)
      const record = match && processes.get(match[1])
      if (!record) return reply(404, { error: "unknown process" })
      if (req.method === "GET" && !match[2]) {
        const after = Number(url.searchParams.get("after") ?? 0)
        return reply(200, {
          id: record.id,
          frames: record.frames.filter((f) => f.seq > after),
          closed: record.closed,
          code: record.code,
          signal: record.signal,
          error: record.error,
          overflow: record.overflow ?? false,
        })
      }
      if (req.method === "POST" && match[2] === "stdin") {
        const original = JSON.stringify(input)
        if (record.inputs.has(input.seq)) {
          const previous = record.inputs.get(input.seq)
          if (previous.original !== original) return reply(409, { error: "stdin payload changed" })
          await previous.completion
          return reply(200, { duplicate: true })
        }
        if (record.closed && input.end && !input.base64 && input.seq === record.inputSeq)
          return reply(200, { accepted: true, alreadyClosed: true })
        if (input.seq !== record.inputSeq || record.ended || record.closed)
          return reply(409, { error: "invalid stdin sequence or closed input" })
        // Receipt is remembered before asynchronous write completion. This is an
        // in-process duplicate guard, not durable stdin delivery after a crash.
        let resolveInput, rejectInput
        const completion = new Promise((resolve, reject) => {
          resolveInput = resolve
          rejectInput = reject
        })
        // Attach a rejection handler even when no duplicate request is waiting.
        completion.catch(() => {})
        record.inputs.set(input.seq, { original, completion })
        record.inputSeq++
        const bytes = Buffer.from(input.base64 ?? "", "base64")
        try {
          if (bytes.length)
            await new Promise((resolve, reject) =>
              record.child.stdin.write(bytes, (error) => (error ? reject(error) : resolve())),
            )
          if (input.end) {
            record.ended = true
            record.child.stdin.end()
          }
          resolveInput()
        } catch (error) {
          rejectInput(error)
          throw error
        }
        if (dropReply({ path: url.pathname, input })) return res.destroy()
        return reply(200, { accepted: true })
      }
      if (req.method === "POST" && match[2] === "kill") {
        if (!["SIGTERM", "SIGKILL"].includes(input.signal))
          return reply(400, { error: "unsupported signal" })
        if (!record.closed) process.kill(-record.child.pid, input.signal)
        return reply(200, { accepted: true })
      }
      reply(405, { error: "unsupported operation" })
    } catch (error) {
      reply(500, { error: error.message })
    }
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    epoch,
    close: async () => {
      for (const record of processes.values()) {
        if (!record.closed) {
          try {
            process.kill(-record.child.pid, "SIGKILL")
          } catch {}
        }
      }
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
