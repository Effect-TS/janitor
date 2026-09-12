import { createServer } from "node:http"
import { createReadStream } from "node:fs"
import { spawn } from "node:child_process"
import { randomUUID, timingSafeEqual, createHash } from "node:crypto"
import {
  realpathSync,
  renameSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  lstatSync,
  constants,
  readdirSync,
  lchownSync,
} from "node:fs"
import { archive, restore } from "./archive.mjs"
import { resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"

export const protocol = 1
export const capabilities = [
  "process-v1",
  "binary-stdin-v1",
  "cursor-output-v1",
  "journal-v1",
  "generation-v1",
  "repository-clone-v1",
  "path-resolution-v1",
  "checkpoint-stream-v2",
]
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status })
}

// This port is reachable only through Sandbox.containerFetch, never a public preview URL.
export async function startBridge({
  token,
  generation,
  cwd,
  journalPath,
  isolateProcesses = true,
  port = 0,
  host = "127.0.0.1",
  cloneOrigin = "https://github.com",
}) {
  if (!token || !Number.isSafeInteger(generation) || generation < 0)
    throw new Error("Invalid bridge identity")
  const root = realpathSync(cwd)
  const ownWorkspace = (directory = root) => {
    if (!isolateProcesses) return
    lchownSync(directory, 1000, 1000)
    if (lstatSync(directory).isDirectory())
      for (const name of readdirSync(directory)) ownWorkspace(`${directory}/${name}`)
  }
  ownWorkspace()
  const epoch = randomUUID()
  const db = new DatabaseSync(journalPath)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS operation (id TEXT PRIMARY KEY, epoch TEXT NOT NULL,
      generation INTEGER NOT NULL, payload_hash TEXT NOT NULL, payload TEXT NOT NULL,
      pid INTEGER, closed INTEGER NOT NULL DEFAULT 0, code INTEGER, signal TEXT, error TEXT);
    CREATE TABLE IF NOT EXISTS frame (operation TEXT, seq INTEGER, kind TEXT, base64 TEXT,
      PRIMARY KEY (operation, seq));
    CREATE TABLE IF NOT EXISTS input (operation TEXT, seq INTEGER, payload_hash TEXT, state TEXT,
      PRIMARY KEY (operation, seq));
    CREATE TABLE IF NOT EXISTS repository (id INTEGER PRIMARY KEY, identity TEXT, state TEXT);`)
  // A new process cannot establish the fate of the old owner. Retain evidence and refuse replay.
  db.prepare("UPDATE operation SET error = 'uncertain after bridge restart' WHERE closed = 0").run()
  const children = new Map()
  let frozen = false
  const row = (id) => db.prepare("SELECT * FROM operation WHERE id = ?").get(id)
  const stop = (record, signal = "SIGKILL") => {
    if (record && !record.closed) {
      try {
        process.kill(-record.child.pid, signal)
      } catch (error) {
        if (error.code !== "ESRCH") throw error
      }
    }
  }
  const server = createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(value))
    }
    try {
      const supplied = Buffer.from(req.headers.authorization ?? "")
      const expected = Buffer.from(`Bearer ${token}`)
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        fail(401, "unauthorized")
      if (req.headers["x-janitor-generation"] !== String(generation)) fail(409, "stale generation")
      const url = new URL(req.url, "http://bridge")
      if (url.pathname === "/meta" && req.method === "GET")
        return reply(200, {
          epoch,
          generation,
          protocol,
          capabilities: [
            ...capabilities,
            ...(isolateProcesses ? ["pid-namespace-v1", "workspace-user-v1"] : []),
          ],
        })
      if (req.headers["x-bridge-epoch"] !== epoch) fail(409, "stale epoch; reconcile before retry")
      if (url.pathname === "/restore" && req.method === "POST") {
        if ([...children.values()].some((record) => !record.closed)) fail(409, "processes active")
        frozen = true
        await restore(root, req, req.headers["x-archive-sha256"])
        ownWorkspace()
        db.prepare("INSERT OR REPLACE INTO repository VALUES (1, 'restored', 'ready')").run()
        return reply(200, { restored: true })
      }
      let size = 0
      const chunks = []
      for await (const chunk of req) {
        size += chunk.length
        if (size > 128 * 1024 * 1024) fail(413, "request too large")
        chunks.push(chunk)
      }
      const input = size ? JSON.parse(Buffer.concat(chunks).toString()) : {}
      if (url.pathname === "/checkpoint" && req.method === "POST") {
        frozen = true
        for (const record of children.values()) stop(record)
        await Promise.all([...children.values()].map((record) => record.done))
        for (const capture of input.captures ?? []) {
          if (!/^[A-Za-z0-9_-]+\.out$/.test(capture.name) || typeof capture.base64 !== "string")
            fail(400, "invalid capture")
          mkdirSync(`${root}/.janitor-captures`, { recursive: true })
          if (!lstatSync(`${root}/.janitor-captures`).isDirectory())
            fail(409, "capture directory was replaced")
          writeFileSync(
            `${root}/.janitor-captures/${capture.name}`,
            Buffer.from(capture.base64, "base64"),
            {
              flag:
                constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
              mode: 0o600,
            },
          )
          ownWorkspace(`${root}/.janitor-captures`)
        }
        const saved = archive(root)
        res.writeHead(200, {
          "content-type": "application/x-ndjson",
          "content-length": saved.size,
          "x-archive-sha256": saved.sha256,
        })
        const stream = createReadStream(saved.file)
        res.once("close", () => {
          stream.destroy()
          saved.cleanup()
        })
        stream.once("error", () => res.destroy())
        stream.pipe(res)
        return
      }
      if (url.pathname === "/thaw" && req.method === "POST") {
        frozen = false
        return reply(200, { frozen })
      }
      if (url.pathname === "/repository" && req.method === "GET")
        return reply(200, {
          ready: db.prepare("SELECT state FROM repository WHERE id = 1").get()?.state === "ready",
        })
      if (url.pathname === "/resolve" && req.method === "POST") {
        if (typeof input.path !== "string") fail(400, "invalid path")
        const path = realpathSync(resolve(root, input.path))
        if (path !== root && !path.startsWith(root + "/")) fail(403, "path outside workspace")
        return reply(200, { path })
      }
      if (url.pathname === "/clone" && req.method === "POST") {
        if (
          !/^[A-Za-z0-9_.-]+$/.test(input.owner ?? "") ||
          !/^[A-Za-z0-9_.-]+$/.test(input.repo ?? "") ||
          typeof input.token !== "string" ||
          !input.token
        )
          fail(400, "invalid repository credential")
        const identity = `${input.owner}/${input.repo}`
        const previous = db.prepare("SELECT * FROM repository WHERE id = 1").get()
        if (previous) {
          if (previous.identity !== identity || previous.state !== "ready")
            fail(409, "clone outcome requires reconciliation")
          return reply(200, { ready: true, duplicate: true })
        }
        db.prepare("INSERT INTO repository VALUES (1, ?, 'admitted')").run(identity)
        // Only this controlled Git process receives the scoped short-lived credential.
        // The constant helper reads its environment; neither URL nor config file contains it.
        const target = `${root}/.janitor-clone`
        const child = spawn(
          "git",
          [
            "-c",
            "credential.helper=",
            "-c",
            'credential.helper=!f() { printf "username=x-access-token\\npassword=%s\\n" "$JANITOR_GIT_TOKEN"; }; f',
            "clone",
            "--",
            `${cloneOrigin}/${identity}.git`,
            target,
          ],
          {
            env: {
              PATH: process.env.PATH,
              HOME: "/nonexistent",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_TERMINAL_PROMPT: "0",
              JANITOR_GIT_TOKEN: input.token,
            },
            stdio: ["ignore", "ignore", "ignore"],
            detached: true,
          },
        )
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL")
          } catch {}
        }, 120000)
        const code = await new Promise((resolveClone) => {
          child.once("error", () => resolveClone(-1))
          child.once("close", resolveClone)
        })
        clearTimeout(timer)
        if (code !== 0) {
          rmSync(target, { recursive: true, force: true })
          db.prepare("UPDATE repository SET state = 'failed' WHERE id = 1").run()
          fail(403, "repository clone failed")
        }
        // The repository directory is the native session's cwd. Atomic rename avoids partial adoption.
        if (existsSync(`${root}/repository`)) fail(409, "repository destination exists")
        renameSync(target, `${root}/repository`)
        ownWorkspace(`${root}/repository`)
        db.prepare("UPDATE repository SET state = 'ready' WHERE id = 1").run()
        return reply(200, { ready: true })
      }
      if (url.pathname === "/process" && req.method === "POST") {
        if (frozen) fail(409, "workspace frozen")
        const { id, argv, env = {}, timeout = 120000, extendEnv = true } = input
        if (
          !/^[A-Za-z0-9_-]{1,120}$/.test(id ?? "") ||
          !Array.isArray(argv) ||
          !argv.length ||
          !argv.every((arg) => typeof arg === "string" && !arg.includes("\0")) ||
          !Number.isFinite(timeout) ||
          timeout <= 0 ||
          typeof extendEnv !== "boolean" ||
          typeof env !== "object" ||
          env === null ||
          Array.isArray(env) ||
          !Object.entries(env).every(
            ([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === "string",
          )
        )
          fail(400, "invalid process request")
        const commandCwd = realpathSync(resolve(root, input.cwd ?? root))
        if (commandCwd !== root && !commandCwd.startsWith(root + "/"))
          fail(400, "cwd outside workspace")
        const payload = {
          argv,
          env: Object.fromEntries(Object.entries(env).sort()),
          cwd: commandCwd,
          timeout,
          extendEnv,
        }
        const identity = hash(payload)
        const previous = row(id)
        if (previous) {
          if (previous.payload_hash !== identity || previous.epoch !== epoch || previous.error)
            fail(409, "operation identity changed or outcome uncertain")
          return reply(200, { id, pid: previous.pid, duplicate: true })
        }
        // Synchronous FULL SQLite commit precedes spawn. No credentials are accepted on this endpoint.
        db.prepare(
          "INSERT INTO operation (id, epoch, generation, payload_hash, payload) VALUES (?, ?, ?, ?, ?)",
        ).run(id, epoch, generation, identity, JSON.stringify(payload))
        const publicEnv = {
          PATH: isolateProcesses ? "/usr/local/bin:/usr/bin:/bin" : process.env.PATH,
          HOME: root,
          LANG: "C.UTF-8",
        }
        const commandEnv = { ...(extendEnv ? publicEnv : {}), ...env }
        const child = spawn(
          isolateProcesses ? "/usr/bin/unshare" : argv[0],
          isolateProcesses
            ? [
                "--user",
                "--map-root-user",
                "--pid",
                "--fork",
                "--kill-child=SIGKILL",
                "--",
                "/usr/bin/env",
                "-i",
                "--",
                ...Object.entries(commandEnv).map(([key, value]) => `${key}=${value}`),
                "/bin/bash",
                "-c",
                'exec -- "$@"',
                "janitor",
                ...argv,
              ]
            : argv.slice(1),
          {
            cwd: commandCwd,
            // Drop identity before loading the launcher; caller environment applies only inside
            // the PID namespace so loader hooks cannot run with bridge access or escape cleanup.
            ...(isolateProcesses ? { uid: 1000, gid: 1000 } : {}),
            env: isolateProcesses ? publicEnv : commandEnv,
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
          },
        )
        const record = {
          child,
          closed: false,
          bytes: 0,
          seq: 0,
          inputSeq: 0,
          ended: false,
          writes: new Map(),
        }
        children.set(id, record)
        db.prepare("UPDATE operation SET pid = ? WHERE id = ?").run(child.pid ?? null, id)
        const deadline = Date.now() + timeout
        let timer
        const expire = () => {
          const remaining = deadline - Date.now()
          if (remaining > 0) timer = setTimeout(expire, Math.min(remaining, 2147483647))
          else {
            db.prepare("UPDATE operation SET error = 'process timeout' WHERE id = ?").run(id)
            stop(record)
          }
        }
        expire()
        const frame = (kind, bytes) => {
          record.bytes += bytes.length
          if (record.bytes > 8 * 1024 * 1024) {
            db.prepare("UPDATE operation SET error = 'output limit exceeded' WHERE id = ?").run(id)
            stop(record)
            return
          }
          db.prepare("INSERT INTO frame VALUES (?, ?, ?, ?)").run(
            id,
            ++record.seq,
            kind,
            bytes.toString("base64"),
          )
        }
        child.stdout.on("data", (bytes) => frame("stdout", bytes))
        child.stderr.on("data", (bytes) => frame("stderr", bytes))
        child.stdin.on("error", () => {})
        child.on("error", (error) =>
          db
            .prepare("UPDATE operation SET error = ? WHERE id = ?")
            .run(error.code ?? "spawn failed", id),
        )
        record.done = new Promise((resolveDone) =>
          child.on("close", (code, signal) => {
            stop(record)
            record.closed = true
            clearTimeout(timer)
            db.prepare("UPDATE operation SET closed = 1, code = ?, signal = ? WHERE id = ?").run(
              code,
              signal,
              id,
            )
            resolveDone()
          }),
        )
        return reply(200, { id, pid: child.pid })
      }
      if (url.pathname === "/freeze" && req.method === "POST") {
        if ([...children.values()].some((record) => !record.closed)) fail(409, "processes active")
        frozen = true
        return reply(200, { frozen })
      }
      const match = /^\/process\/([A-Za-z0-9_-]+)(?:\/(stdin|kill))?$/.exec(url.pathname)
      const operation = match && row(match[1])
      if (!operation) fail(404, "unknown operation")
      const id = match[1]
      if (req.method === "GET" && !match[2]) {
        const after = Number(url.searchParams.get("after") ?? 0)
        if (!Number.isSafeInteger(after) || after < 0) fail(400, "invalid output cursor")
        return reply(200, {
          ...operation,
          closed: Boolean(operation.closed),
          frames: db
            .prepare(
              "SELECT seq, kind, base64 FROM frame WHERE operation = ? AND seq > ? ORDER BY seq LIMIT 256",
            )
            .all(id, after),
        })
      }
      if (operation.epoch !== epoch) fail(409, "operation uncertain")
      const record = children.get(id)
      if (match[2] === "kill" && req.method === "POST") {
        if (!["SIGTERM", "SIGKILL"].includes(input.signal)) fail(400, "unsupported signal")
        stop(record, input.signal)
        return reply(200, { accepted: true })
      }
      if (operation.error) fail(409, "operation uncertain")
      if (match[2] === "stdin" && req.method === "POST") {
        if (
          !Number.isSafeInteger(input.seq) ||
          input.seq < 0 ||
          typeof input.base64 !== "string" ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64) ||
          typeof input.end !== "boolean"
        )
          fail(400, "invalid stdin")
        const identity = hash(input)
        const previous = db
          .prepare("SELECT * FROM input WHERE operation = ? AND seq = ?")
          .get(id, input.seq)
        if (previous) {
          if (previous.payload_hash !== identity) fail(409, "stdin payload changed")
          if (record?.writes.has(input.seq)) await record.writes.get(input.seq)
          else if (previous.state !== "complete") fail(409, "stdin delivery uncertain")
          return reply(200, { duplicate: true })
        }
        if (!record || record.ended || input.seq !== record.inputSeq)
          fail(409, "invalid stdin sequence")
        if (record.closed && !(input.end && input.base64 === "")) fail(409, "process closed")
        db.prepare("INSERT INTO input VALUES (?, ?, ?, 'admitted')").run(id, input.seq, identity)
        record.inputSeq++
        record.ended = input.end
        const completion = (async () => {
          const bytes = Buffer.from(input.base64, "base64")
          if (bytes.length)
            await new Promise((resolveWrite, reject) =>
              record.child.stdin.write(bytes, (error) => (error ? reject(error) : resolveWrite())),
            )
          if (input.end && !record.closed) record.child.stdin.end()
          db.prepare("UPDATE input SET state = 'complete' WHERE operation = ? AND seq = ?").run(
            id,
            input.seq,
          )
        })()
        record.writes.set(input.seq, completion)
        await completion
        return reply(200, { accepted: true })
      }
      fail(405, "unsupported operation")
    } catch (error) {
      reply(error.status ?? 500, {
        error: error.status ? error.message : "bridge operation failed",
      })
    }
  })
  await new Promise((resolveListen) => server.listen(port, host, resolveListen))
  return {
    url: `http://${host}:${server.address().port}`,
    epoch,
    close: async () => {
      for (const record of children.values()) stop(record)
      await Promise.all([...children.values()].map((record) => record.done))
      server.closeAllConnections()
      await new Promise((resolveClose) => server.close(resolveClose))
      db.close()
    },
  }
}
