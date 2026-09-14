import { expect, it } from "vite-plus/test"
import { Harness, uniqueSessionId, waitFor } from "./support/Harness.ts"
import { makeRepositoryFixture } from "../dev/RepositoryFixture.ts"

it("edits files without a container and retains the SQLite workspace across object replacement", async () => {
  const repository = await makeRepositoryFixture()
  const harness = await Harness.start({
    secret: "test-key",
    bindings: { REPOSITORY_SERVICE_TOKEN: "test-authority" },
    serviceBindings: {
      REPOSITORY_AUTHORITY: async () =>
        Response.json({ owner: "fixture", repo: "fixture", token: "fixture-token" }),
      GITHUB_API: repository.fetch,
    },
  })
  try {
    const session = harness.session(uniqueSessionId("sqlite-files"))
    await session.faults({ intervalMs: 100 })
    await session.model({
      mode: "repository-work",
      tools: [
        { name: "write", input: { path: "work.txt", content: "before" } },
        { name: "edit", input: { path: "work.txt", oldText: "before", newText: "after" } },
        { name: "read", input: { path: "work.txt" } },
      ],
    })
    await session.create({ repositoryId: "123" })
    await session.admit({ inputId: "msg_sqlite_edit", text: "Edit the fixture." })
    await waitFor(
      () => session.inspect(),
      (state) => state.execution === "idle",
      { label: "SQLite edit completed" },
    )
    expect(JSON.stringify((await session.allEvents()).events)).toContain("after")
    await harness.restart()
    await session.model({
      mode: "repository-work",
      tools: [{ name: "read", input: { path: "work.txt" } }],
    })
    await session.admit({ inputId: "msg_sqlite_restore", text: "Read the saved file." })
    await waitFor(
      () => session.inspect(),
      (state) => state.execution === "idle",
      { label: "SQLite read after replacement" },
    )
    const events = (await session.allEvents()).events.filter(
      (event: any) => event.type === "session.tool.success",
    )
    expect(events).toHaveLength(4)
    expect(JSON.stringify(events.at(-1))).toContain("after")
    expect(
      repository.requests.filter((request) => request.path.startsWith("/git/blobs/")).length,
    ).toBeLessThanOrEqual(2)
  } finally {
    await harness.dispose()
  }
})

it("publishes SQLite edits through GitHub and reconciles a lost reference response", async () => {
  const repository = await makeRepositoryFixture()
  const harness = await Harness.start({
    secret: "test-key",
    bindings: { REPOSITORY_SERVICE_TOKEN: "test-authority" },
    serviceBindings: {
      REPOSITORY_AUTHORITY: async () =>
        Response.json({ owner: "fixture", repo: "fixture", token: "fixture-token", appId: "1" }),
      GITHUB_API: repository.fetch,
    },
  })
  try {
    const session = harness.session(uniqueSessionId("sqlite-publish"))
    await session.faults({ intervalMs: 100 })
    repository.failNext({ method: "POST", path: "/git/refs", status: 503, after: true })
    const publish = {
      name: "publish",
      input: { title: "Update fixture", body: "Edited the fixture. Tests were not executed." },
    }
    await session.model({
      mode: "repository-work",
      tools: [
        { name: "write", input: { path: "work.txt", content: "published SQLite edit" } },
        publish,
        publish,
      ],
    })
    await session.create({ repositoryId: "123" })
    await session.admit({ inputId: "msg_sqlite_publish", text: "Publish the fixture edit." })
    await waitFor(
      () => session.inspect(),
      (state) => state.execution === "idle",
      { label: "SQLite publication" },
    )
    const events = JSON.stringify((await session.allEvents()).events)
    expect(events).toContain("https://github.com/fixture/fixture/pull/1")
    expect(repository.prs).toHaveLength(1)
    expect(
      repository.requests.filter(
        (request) => request.method === "POST" && request.path === "/git/refs",
      ),
    ).toHaveLength(1)
    expect(repository.read("work.txt", repository.prs[0]!.head.ref)).toBe("published SQLite edit")
  } finally {
    await harness.dispose()
  }
})
