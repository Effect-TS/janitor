import { it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { Harness } from "./support/Harness.ts"

// The built bridge image, runner SQLite, native tools and model protocol are real.
it("two sessions inspect isolated repositories and adopt a Sandbox after a lost creation response", async () => {
  const resources = new Map<string, { container: string; url: string }>()
  let dropStart = true
  let oldImage = false
  let ready = true
  let dropProcess = true
  const processRequests = new Map<string, number>()
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
      await session.model({ mode: "repository", answers: ["Repository inspected"] })
      await session.admit({
        inputId: "msg_inspect",
        text: "Read README.md and search the repository",
      })
      let events: any[] = []
      for (let i = 0; i < 150; i++) {
        events = (await session.allEvents()).events
        if (events.filter((event) => event.type === "session.tool.success").length >= 2) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(
        events.filter((event) => event.type === "session.tool.success"),
        JSON.stringify(events),
      ).toHaveLength(2)
      expect(JSON.stringify(events)).toContain("repository janitor-")
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
  } finally {
    await harness.dispose()
    for (const resource of resources.values()) docker("stop", "-t", "0", resource.container)
  }
}, 120000)
