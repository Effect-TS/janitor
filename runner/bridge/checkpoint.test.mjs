import { test } from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readlinkSync,
  statSync,
  existsSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { startBridge } from "./server.mjs"

test("checkpoint restores failed command edits, index, commits, ignored data, binary files, modes and links into a clean workspace", async () => {
  const temp = mkdtempSync(join(tmpdir(), "janitor-checkpoint-"))
  const root = join(temp, "workspace")
  mkdirSync(root)
  const repository = join(root, "repository")
  mkdirSync(repository)
  const git = (...args) =>
    execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim()
  git("init")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "Checkpoint test")
  const monitor = join(temp, "monitor.sh")
  writeFileSync(monitor, `#!/bin/sh\ntouch '${join(root, "unexpected-hook")}'\n`, { mode: 0o755 })
  git("config", "core.fsmonitor", monitor)
  const options = {
    token: "test",
    generation: 1,
    cwd: root,
    journalPath: join(temp, "journal.sqlite"),
    isolateProcesses: false,
  }
  let bridge = await startBridge(options)
  const rpc = async (path, input) => {
    const response = await fetch(bridge.url + path, {
      method: input ? "POST" : "GET",
      headers: {
        authorization: "Bearer test",
        "x-bridge-epoch": bridge.epoch,
        "x-janitor-generation": "1",
        ...(path === "/restore" ? { "x-archive-sha256": input.sha256 } : {}),
      },
      body: path === "/restore" ? input.bytes : input ? JSON.stringify(input) : undefined,
    })
    if (path === "/checkpoint" && response.ok)
      return {
        status: response.status,
        value: {
          bytes: new Uint8Array(await response.arrayBuffer()),
          sha256: response.headers.get("x-archive-sha256"),
        },
      }
    return { status: response.status, value: await response.json() }
  }
  try {
    writeFileSync(join(repository, ".env.example"), "PORT=3000")
    mkdirSync(join(repository, ".cache"))
    writeFileSync(join(repository, ".cache/required"), "tracked data")
    git("add", ".env.example", ".cache/required")
    await rpc("/process", {
      id: "edit",
      cwd: repository,
      argv: [
        "sh",
        "-c",
        "printf initial > work; git add work; git commit -qm initial; printf staged > work; git add work; printf unstaged > work; printf 'required.dat\\nnode_modules/\\n.env\\n' > .gitignore; printf required > required.dat; mkdir node_modules; printf cache > node_modules/cache; printf secret > .env; printf '#!/bin/sh\\necho yes\\n' > executable; chmod 755 executable; ln -s work link; printf '\\000\\377\\012' > binary; exit 7",
      ],
    })
    let result
    do {
      result = await rpc("/process/edit")
      await new Promise((resolve) => setTimeout(resolve, 10))
    } while (!result.value.closed)
    assert.equal(result.value.code, 7)
    const head = git("rev-parse", "HEAD")
    rmSync(join(root, "unexpected-hook"), { force: true })
    const saved = await rpc("/checkpoint", {
      captures: [{ name: "test.out", base64: Buffer.from("complete output").toString("base64") }],
    })
    assert.equal(saved.status, 200)
    assert.equal(existsSync(join(root, "unexpected-hook")), false)
    assert.equal((await rpc("/process", { id: "frozen", argv: ["true"] })).status, 409)
    await bridge.close()
    rmSync(root, { recursive: true })
    mkdirSync(root)
    writeFileSync(join(root, "stale"), "must disappear")
    bridge = await startBridge(options)
    assert.equal((await rpc("/restore", { ...saved.value, sha256: "bad" })).status, 500)
    assert.equal(readFileSync(join(root, "stale"), "utf8"), "must disappear")
    for (const data of [
      '{"format":"unknown"}\n',
      '{"format":"janitor-workspace-2"}\n{"path":"../escaped","type":"file","mode":420}\n{"end":true}\n',
    ]) {
      assert.equal(
        (
          await rpc("/restore", {
            bytes: Buffer.from(data),
            sha256: createHash("sha256").update(data).digest("hex"),
          })
        ).status,
        500,
      )
      assert.equal(readFileSync(join(root, "stale"), "utf8"), "must disappear")
      assert.equal(existsSync(join(temp, "escaped")), false)
    }
    assert.equal((await rpc("/restore", saved.value)).status, 200)
    assert.equal(existsSync(join(root, "stale")), false)
    assert.equal(git("rev-parse", "HEAD"), head)
    assert.equal(git("show", ":work"), "staged")
    assert.equal(readFileSync(join(repository, "work"), "utf8"), "unstaged")
    assert.equal(readFileSync(join(repository, "required.dat"), "utf8"), "required")
    assert.equal(existsSync(join(repository, "node_modules")), false)
    assert.equal(existsSync(join(repository, ".env")), false)
    assert.equal(readFileSync(join(repository, ".env.example"), "utf8"), "PORT=3000")
    assert.equal(readFileSync(join(repository, ".cache/required"), "utf8"), "tracked data")
    assert.equal(statSync(join(repository, "executable")).mode & 0o777, 0o755)
    assert.equal(readlinkSync(join(repository, "link")), "work")
    assert.deepEqual([...readFileSync(join(repository, "binary"))], [0, 255, 10])
    assert.equal(readFileSync(join(root, ".janitor-captures/test.out"), "utf8"), "complete output")
  } finally {
    await bridge.close()
    rmSync(temp, { recursive: true, force: true })
  }
})

test("checkpoint capture transfer rejects a redirected capture directory before writing outside the workspace", async () => {
  const temp = mkdtempSync(join(tmpdir(), "janitor-capture-"))
  const root = join(temp, "workspace")
  mkdirSync(root)
  const bridge = await startBridge({
    token: "test",
    generation: 1,
    cwd: root,
    journalPath: join(temp, "journal.sqlite"),
    isolateProcesses: false,
  })
  const rpc = async (path, input) => {
    const response = await fetch(bridge.url + path, {
      method: input ? "POST" : "GET",
      headers: {
        authorization: "Bearer test",
        "x-bridge-epoch": bridge.epoch,
        "x-janitor-generation": "1",
      },
      body: input ? JSON.stringify(input) : undefined,
    })
    return { status: response.status, value: await response.json() }
  }
  try {
    await rpc("/process", { id: "redirect", argv: ["ln", "-s", temp, ".janitor-captures"] })
    while (!(await rpc("/process/redirect")).value.closed)
      await new Promise((resolve) => setTimeout(resolve, 10))
    const result = await rpc("/checkpoint", {
      captures: [{ name: "escape.out", base64: "c2VjcmV0" }],
    })
    assert.notEqual(result.status, 200)
    assert.equal(existsSync(join(temp, "escape.out")), false)
  } finally {
    await bridge.close()
    rmSync(temp, { recursive: true, force: true })
  }
})
