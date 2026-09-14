import { expect, it } from "vite-plus/test"
import { Harness, uniqueSessionId, waitFor } from "./support/Harness.ts"
import { makeRepositoryFixture } from "../dev/RepositoryFixture.ts"

it("drains an in-flight repository read before releasing maintenance and retains workspace edits", async () => {
  const fixture = await makeRepositoryFixture()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let reading = false
  const harness = await Harness.start({
    secret: "model-secret",
    bindings: { REPOSITORY_SERVICE_TOKEN: "authority" },
    serviceBindings: {
      REPOSITORY_AUTHORITY: async () =>
        Response.json({ owner: "fixture", repo: "fixture", token: "fixture-token" }),
      GITHUB_API: async (request) => {
        if (new URL(request.url).pathname.includes("/git/blobs/")) {
          reading = true
          await gate
        }
        return fixture.fetch(request)
      },
    },
  })
  try {
    const session = harness.session(uniqueSessionId("workspace-maintenance"))
    await session.faults({ intervalMs: 100 })
    await session.model({
      mode: "repository-work",
      tools: [{ name: "read", input: { path: "README.md" } }],
    })
    await session.create({ repositoryId: "123" })
    await session.admit({ inputId: "msg_read", text: "Read the repository." })
    await waitFor(async () => reading, Boolean)
    const held = await session.maintenance({ hold: true, epoch: 1 })
    expect(held.held).toBe(true)
    expect(held.quiescent).toBe(false)
    release()
    await waitFor(
      () => session.maintenance({ hold: true, epoch: 1 }),
      (state) => state.quiescent,
    )
    await harness.restart()
    const resumed = await session.maintenance({ hold: false, epoch: 1 })
    expect(resumed.held).toBe(false)
    expect(resumed.checks).toContainEqual({
      name: "workspace",
      ok: true,
      detail: "SQLite workspace is compatible or not yet initialized",
    })
    await waitFor(
      () => session.inspect(),
      (state) => state.execution === "idle",
    )
    expect(JSON.stringify((await session.allEvents()).events)).toContain("apricot-47")
  } finally {
    release()
    await harness.dispose()
  }
})
