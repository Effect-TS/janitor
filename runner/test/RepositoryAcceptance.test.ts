import { it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { Harness } from "./support/Harness.ts"

// The built bridge image, runner SQLite, native tools and model protocol are real.
it("native edits and foreground tests checkpoint isolated workspaces and restore after Sandbox loss", async () => {
  const resources = new Map<string, { container: string; url: string }>()
  let dropStart = true
  let oldImage = false
  let ready = true
  let dropProcess = true
  const processRequests = new Map<string, number>()
  const timeouts: number[] = []
  const capturedPaths = new Map<string, string>()
  const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim()
  const image = "localhost/janitor-inspection:ticket05"
  docker("image", "inspect", image)
  const service = async (request: Request) => {
    const path = new URL(request.url).pathname
    if (path === "/start") {
      const input = (await request.json()) as { resource: string; env: Record<string, string> }
      if (!resources.has(input.resource)) {
        const source = `import { mkdirSync, writeFileSync } from 'node:fs';
          import { execFileSync } from 'node:child_process';
          import { startBridge } from '/opt/janitor/server.mjs';
          mkdirSync('/workspace/repository', { recursive: true });
          execFileSync('git', ['init', '/workspace/repository']);
          writeFileSync('/workspace/repository/README.md', ${JSON.stringify(`repository ${input.resource}\n`)});
          await startBridge({ token: process.env.JANITOR_BRIDGE_TOKEN, generation: 1, cwd: '/workspace',
            journalPath: '/tmp/journal.sqlite', port: 8788, host: '0.0.0.0' });`
        const container = docker(
          "run",
          "-d",
          "--rm",
          "-p",
          "127.0.0.1::8788",
          "--entrypoint",
          "node",
          "-e",
          `JANITOR_BRIDGE_TOKEN=${input.env.JANITOR_BRIDGE_TOKEN}`,
          image,
          "--input-type=module",
          "-e",
          source,
        )
        const url = `http://${docker("port", container, "8788")}`
        resources.set(input.resource, { container, url })
        for (let i = 0; i < 100; i++) {
          try {
            await fetch(url + "/meta")
            break
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
        }
      }
      if (dropStart) {
        dropStart = false
        return new Response(null, { status: 503 })
      }
      return Response.json({ started: true })
    }
    if (path === "/destroy") {
      const key = await request.text()
      const resource = resources.get(key)
      if (resource) {
        docker("stop", "-t", "0", resource.container)
        resources.delete(key)
      }
      return Response.json({ destroyed: true })
    }
    const resource = resources.get(request.headers.get("x-test-resource")!)!
    // GitHub repositories are preloaded at this external boundary.
    if (path === "/repository") return Response.json({ ready: true })
    if (path === "/process") {
      const input = (await request.clone().json()) as {
        timeout: number
        env: Record<string, string>
      }
      timeouts.push(input.timeout)
      expect(input.env).not.toHaveProperty("JANITOR_TEST_RUNNER_SECRET")
      expect(input.env).not.toHaveProperty("JANITOR_AGENT_RUNNER_TOKEN")
      expect(input.env).not.toHaveProperty("REPOSITORY_SERVICE_TOKEN")
      expect(input.env).not.toHaveProperty("MODEL_SECRET_TEST")
    }
    const response = await fetch(resource.url + path + new URL(request.url).search, {
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" ? undefined : await request.arrayBuffer(),
    })
    if (path === "/process") {
      const reply = (await response.clone().json()) as { id?: string }
      if (reply.id) processRequests.set(reply.id, (processRequests.get(reply.id) ?? 0) + 1)
      if (dropProcess && response.ok) {
        dropProcess = false
        await response.arrayBuffer()
        return new Response(null, { status: 503 })
      }
    }
    if (path === "/meta" && oldImage)
      return Response.json({ ...((await response.json()) as object), capabilities: [] })
    return response
  }
  const harness = await Harness.start({
    secret: "test-model",
    bindings: { REPOSITORY_SERVICE_TOKEN: "authority-token" },
    serviceBindings: {
      REPOSITORY_TEST_TRANSPORT: service,
      REPOSITORY_AUTHORITY: async (request) => {
        if (request.headers.get("authorization") !== "Bearer authority-token" || !ready)
          return new Response(null, { status: 423 })
        return Response.json({ owner: "fixture", repo: "fixture" })
      },
    },
  })
  try {
    const first = harness.session("inspect-one")
    await first.create({ repositoryId: "123" }, 503)
    await first.create({ repositoryId: "123" })
    expect(resources.size).toBe(1)
    const second = harness.session("inspect-two")
    await second.create({ repositoryId: "123" })
    expect(resources.size).toBe(2)
    for (const session of [first, second]) {
      await session.model({
        mode: "repository-work",
        answers: ["Repository inspected"],
        tools: [
          { name: "read", input: { path: "README.md" } },
          { name: "write", input: { path: "answer.txt", content: "before\n" } },
          { name: "edit", input: { path: "answer.txt", oldString: "before", newString: "after" } },
          {
            name: "shell",
            input: {
              command:
                "if tr '\\0' '\\n' < /proc/1/environ | grep -q JANITOR_BRIDGE_TOKEN; then exit 99; fi; cat answer.txt | tr a-z A-Z; printf preserved > failed.txt; exit 7",
            },
          },
          { name: "shell", input: { command: "seq 1 6000", timeout: 150000 } },
          { name: "shell", input: { command: "truncate -s 40000000 retained.bin" } },
          {
            name: "shell",
            input: {
              command:
                "printf timeout > timed.txt; (sleep 1; printf escaped > timed.txt) & sleep 30",
              timeout: 300,
            },
          },
          { name: "shell", input: { command: "touch forbidden-background", background: true } },
          { name: "shell", input: { command: "touch forbidden-unlimited", timeout: 0 } },
        ],
      })
      await session.admit({
        inputId: "msg_inspect",
        text: "Read README.md and search the repository",
      })
      let events: any[] = []
      for (let i = 0; i < 150; i++) {
        events = (await session.allEvents()).events
        if (
          events.filter((event) => event.type === "session.tool.success").length >= 7 &&
          events.filter((event) => event.type === "session.tool.failed").length === 2
        )
          break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(
        events.filter((event) => event.type === "session.tool.success"),
        JSON.stringify(events),
      ).toHaveLength(7)
      expect(JSON.stringify(events)).toContain("repository janitor-")
      expect(JSON.stringify(events)).toContain("AFTER")
      expect(JSON.stringify(events)).toContain("/workspace/.janitor-captures/")
      capturedPaths.set(
        session.id,
        JSON.stringify(events).match(/\/workspace\/\.janitor-captures\/[A-Za-z0-9_-]+\.out/)![0],
      )
      expect(JSON.stringify(events)).toContain("Command exited with code 7")
    }
    expect(timeouts).toContain(150000)
    expect(timeouts).toContain(120000)
    await harness.restart()
    for (const resource of resources.values()) docker("stop", "-t", "0", resource.container)
    resources.clear()
    for (const session of [first, second]) {
      await session.model({
        mode: "repository-work",
        tools: [
          { name: "read", input: { path: "answer.txt" } },
          { name: "read", input: { path: capturedPaths.get(session.id), offset: 5999, limit: 2 } },
        ],
      })
      await session.admit({ inputId: "msg_restore", text: "Read the saved answer" })
      for (let i = 0; i < 100; i++) {
        const events = (await session.allEvents()).events
        if (events.filter((event: any) => event.type === "session.tool.success").length >= 9) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(JSON.stringify((await session.allEvents()).events)).toContain("1: after")
      expect(JSON.stringify((await session.allEvents()).events)).toContain("6000: 6000")
    }
    expect(resources.size).toBe(2)
    for (const resource of resources.values()) {
      expect(
        docker(
          "exec",
          resource.container,
          "stat",
          "-c",
          "%s",
          "/workspace/repository/retained.bin",
        ),
      ).toBe("40000000")
      expect(docker("exec", resource.container, "cat", "/workspace/repository/answer.txt")).toBe(
        "after",
      )
      expect(docker("exec", resource.container, "cat", "/workspace/repository/failed.txt")).toBe(
        "preserved",
      )
      expect(docker("exec", resource.container, "cat", "/workspace/repository/timed.txt")).toBe(
        "timeout",
      )
      expect(
        docker(
          "exec",
          resource.container,
          "sh",
          "-c",
          "test ! -e /workspace/repository/forbidden-background && test ! -e /workspace/repository/forbidden-unlimited; echo $?",
        ),
      ).toBe("0")
      expect(
        docker("exec", resource.container, "sh", "-c", "cat /workspace/.janitor-captures/*.out"),
      ).toContain("6000")
    }
    await first.create({ repositoryId: "123", generation: 0 }, 409)
    expect([...processRequests.values()].filter((count) => count === 2)).toHaveLength(1)
    ready = false
    await harness.session("not-ready").create({ repositoryId: "123" }, 423)
    expect(resources.size).toBe(2)
    ready = true
    oldImage = true
    await harness.session("old-image").create({ repositoryId: "123" }, 423)
    oldImage = false
    for (const session of [first, second, harness.session("old-image")]) {
      await session.cleanup()
      await session.cleanup()
    }
    expect(resources.size).toBe(0)
    for (const position of ["before", "after"] as const) {
      const session = harness.session(`crash-${position}`)
      await session.create({ repositoryId: "123" })
      const incarnation = (await session.state()).incarnation
      await session.model({
        mode: "repository-work",
        tools: [{ name: "write", input: { path: "crash.txt", content: "durable once" } }],
      })
      const fault = position === "before" ? "abortAfterArchiveUpload" : "abortAfterCheckpointCommit"
      await session.faults({ [fault]: true })
      await session.admit({ inputId: "msg_crash", text: "Write the file" })
      for (let i = 0; i < 100; i++) {
        const state = await session.state()
        if (state.faults[fault] === false && state.incarnation !== incarnation) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect((await session.state()).faults[fault]).toBe(false)
      expect((await session.state()).incarnation).not.toBe(incarnation)
      const processCount = processRequests.size
      await harness.restart()
      for (const resource of resources.values()) docker("stop", "-t", "0", resource.container)
      resources.clear()
      await session.model({
        mode: "repository-work",
        tools: [{ name: "read", input: { path: "crash.txt" } }],
      })
      await session.admit(
        { inputId: "msg_recover", text: "Read the saved file" },
        position === "before" ? 423 : 200,
      )
      if (position === "before") {
        expect((await session.inspect()).execution).toBe("blocked")
        expect(processRequests.size).toBe(processCount)
      } else {
        for (let i = 0; i < 100; i++) {
          if (JSON.stringify((await session.allEvents()).events).includes("1: durable once")) break
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        expect(JSON.stringify((await session.allEvents()).events)).toContain("1: durable once")
      }
      await session.cleanup()
    }
    expect(
      (await (await harness.mf.getR2Bucket("WORKSPACE_CHECKPOINTS")).list()).objects,
    ).toHaveLength(0)
  } finally {
    await harness.dispose()
    for (const resource of resources.values()) docker("stop", "-t", "0", resource.container)
  }
}, 120000)
