// The maintenance hold against real foreground tool work in the built bridge
// image: admitted commands finish and checkpoint before the runtime stops,
// release verifies the bridge actually reached, and checkpoint manifests are
// validated before anything is restored.
import { it, expect } from "vite-plus/test"
import { execFileSync } from "node:child_process"
import { RELEASE_MANIFEST } from "../src/ReleaseManifest.ts"
import { Harness, sleep, waitFor } from "./support/Harness.ts"

it("drains active tool work, verifies the bridge on release and refuses incompatible checkpoints", async () => {
  const resources = new Map<string, { container: string; url: string }>()
  let oldImage = false
  let processes = 0
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
          writeFileSync('/workspace/repository/README.md', 'maintenance fixture\\n');
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
            await sleep(50)
          }
        }
      }
      return Response.json({ started: true })
    }
    if (path === "/running") return Response.json({ running: resources.has(await request.text()) })
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
    if (path === "/repository") return Response.json({ ready: true })
    if (path === "/process") processes++
    const response = await fetch(resource.url + path + new URL(request.url).search, {
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" ? undefined : await request.arrayBuffer(),
    })
    if (path === "/meta" && oldImage)
      return Response.json({
        ...((await response.json()) as object),
        capabilities: [],
        build: null,
      })
    return response
  }
  const harness = await Harness.start({
    secret: "test-model",
    bindings: { REPOSITORY_SERVICE_TOKEN: "authority-token" },
    serviceBindings: {
      REPOSITORY_TEST_TRANSPORT: service,
      REPOSITORY_AUTHORITY: async () => Response.json({ owner: "fixture", repo: "fixture" }),
    },
  })
  try {
    const session = harness.session("maintenance-repo")
    await session.faults({ intervalMs: 500 })
    await session.create({ repositoryId: "123" })
    await session.model({
      mode: "repository-work",
      answers: ["Finished"],
      tools: [
        { name: "shell", input: { command: "sleep 3; printf slow > slow.txt", timeout: 10000 } },
      ],
    })
    await session.admit({ inputId: "msg_slow", text: "Run a slow command" })
    await waitFor(
      async () => processes,
      (count) => count >= 1,
      { label: "command dispatched" },
    )

    // 1. The hold persists first and reports that admitted work is still finishing.
    const holding = await session.maintenance({ hold: true, epoch: 1 })
    expect(holding).toMatchObject({ held: true, epoch: 1, quiescent: false })
    expect((await session.inspect()).reason).toBe("maintenance hold epoch 1")
    const quiescent = await waitFor(
      () => session.maintenance({ hold: true, epoch: 1 }),
      (status) => status.quiescent,
      { label: "quiescence", timeoutMs: 30_000 },
    )
    expect(quiescent).toMatchObject({ held: true, uncertain: false })
    const state = await session.state()
    const drained = state.journal.find((entry: any) => entry.kind === "maintenance-quiescent")
    expect(drained?.data).toMatchObject({ settled: true })
    expect(drained.data.waitedMs).toBeGreaterThan(1000)
    // The command's result and checkpoint committed together before the runtime stopped.
    const manifest = JSON.parse(state.checkpoint.manifest)
    expect(manifest).toMatchObject({
      manifestVersion: RELEASE_MANIFEST.checkpoint.manifest,
      format: "janitor-workspace-2",
      sessionId: "maintenance-repo",
      generation: 1,
      repositoryId: "123",
      sha256: state.checkpoint.sha256,
      key: state.checkpoint.key,
    })
    expect(manifest.operationId).toMatch(/:/)
    // The tool's result went back to the turn, but no fresh model request left the object.
    const kinds = state.journal.map((entry: any) => entry.kind)
    expect(kinds.filter((kind: string) => kind === "model-call")).toHaveLength(1)
    expect(kinds).toContain("model-request-held")
    expect(kinds).not.toContain("model-response")
    expect(kinds.filter((kind: string) => kind === "maintenance-quiescent")).toHaveLength(1)
    const processesAtHold = processes

    // 2. Release verifies the running bridge; an old image keeps the hold.
    oldImage = true
    const refused = await session.maintenance({ hold: false, epoch: 1 })
    expect(refused.held).toBe(true)
    expect(refused.checks.find((check: any) => check.name === "bridge")).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/bridge capabilities/),
    })
    oldImage = false
    const released = await session.maintenance({ hold: false, epoch: 1 })
    expect(released.held).toBe(false)
    expect(released.checks.find((check: any) => check.name === "bridge")).toMatchObject({
      ok: true,
      detail: expect.stringContaining(RELEASE_MANIFEST.bridge.sourceHash.slice(0, 12)),
    })
    const done = await waitFor(
      () => session.inspect(),
      (current) => current.execution === "idle",
      { label: "turn completes after release" },
    )
    expect(done.lastOutcome).toBe("succeeded")
    // Recovery resumed the turn from its committed tool result: no second execution.
    expect(processes).toBe(processesAtHold)
    expect(JSON.stringify((await session.allEvents()).events)).toContain("Finished")

    // 3. An incompatible or foreign checkpoint blocks before any restore, untouched.
    await harness.call("POST", `/__test/sessions/${session.id}/checkpoint-manifest`, {
      ...manifest,
      generation: 7,
    })
    const foreign = await session.inspect()
    expect(foreign.execution).toBe("blocked")
    expect(foreign.reason).toMatch(/belongs to session maintenance-repo generation 7/)
    await harness.call("POST", `/__test/sessions/${session.id}/checkpoint-manifest`, {
      ...manifest,
      format: "janitor-workspace-9",
    })
    expect((await session.inspect()).reason).toMatch(/format janitor-workspace-9/)
    await harness.call("POST", `/__test/sessions/${session.id}/checkpoint-manifest`, null)
    expect((await session.inspect()).reason).toMatch(/no manifest/)
    expect((await session.admit({ inputId: "msg_blocked", text: "held" }, 423)).code).toBe(
      "blocked",
    )
    expect(JSON.parse((await session.state()).checkpoint.manifest ?? "null")).toBeNull()
    await harness.call("POST", `/__test/sessions/${session.id}/checkpoint-manifest`, manifest)
    expect((await session.inspect()).execution).toBe("idle")

    // 4. After Sandbox loss the validated manifest restores the same workspace.
    await harness.restart()
    for (const resource of resources.values()) docker("stop", "-t", "0", resource.container)
    resources.clear()
    await session.model({
      mode: "repository-work",
      answers: ["Restored"],
      tools: [{ name: "read", input: { path: "slow.txt" } }],
    })
    await session.admit({ inputId: "msg_restored", text: "Read the saved file" })
    await waitFor(
      async () => JSON.stringify((await session.allEvents()).events),
      (events) => events.includes("1: slow"),
      { label: "restored read", timeoutMs: 30_000 },
    )
    await session.cleanup()
  } finally {
    await harness.dispose()
    for (const resource of resources.values()) docker("stop", "-t", "0", resource.container)
  }
}, 180_000)
