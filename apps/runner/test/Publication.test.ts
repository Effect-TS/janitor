import { expect, it } from "vite-plus/test"
import { Harness, uniqueSessionId, waitFor } from "./support/Harness.ts"
import { makeRepositoryFixture } from "../dev/RepositoryFixture.ts"

it("updates the same PR across turns, preserves unrelated human changes, and blocks overlapping edits", async () => {
  const repository = await makeRepositoryFixture()
  const harness = await Harness.start({
    secret: "model-key",
    bindings: { REPOSITORY_SERVICE_TOKEN: "authority" },
    serviceBindings: {
      REPOSITORY_AUTHORITY: async () =>
        Response.json({ owner: "fixture", repo: "fixture", token: "fixture-token", appId: "1" }),
      GITHUB_API: repository.fetch,
    },
  })
  try {
    const session = harness.session(uniqueSessionId("publication"))
    await session.faults({ intervalMs: 100 })
    await session.create({ repositoryId: "123" })
    const turn = async (id: string, content: string) => {
      await session.model({
        mode: "repository-work",
        tools: [
          { name: "write", input: { path: "work.txt", content } },
          {
            name: "publish",
            input: {
              title: "Improve the fixture",
              body: "Changed the fixture. Tests were not executed.",
            },
          },
        ],
      })
      await session.admit({ inputId: id, text: "Publish the requested edit." })
      await waitFor(
        () => session.inspect(),
        (state) => state.execution === "idle",
      )
    }
    await turn("msg_publish_first", "first")
    expect(repository.prs).toHaveLength(1)
    const branch = repository.prs[0]!.head.ref
    await repository.advance({ "human.txt": "preserve me" }, branch)
    await harness.restart()
    await turn("msg_publish_second", "second")
    expect(repository.prs).toHaveLength(1)
    expect(repository.read("work.txt", branch)).toBe("second")
    expect(repository.read("human.txt", branch)).toBe("preserve me")
    await repository.advance({ "work.txt": "human decision" }, branch)
    await turn("msg_publish_conflict", "third")
    expect(repository.read("work.txt", branch)).toBe("human decision")
    expect(repository.prs).toHaveLength(1)
    expect(JSON.stringify((await session.allEvents()).events)).toContain(
      "Human changes overlap work.txt",
    )
  } finally {
    await harness.dispose()
  }
})

it("reconciles a lost PR creation response after restart without posting a second PR", async () => {
  const repository = await makeRepositoryFixture()
  const harness = await Harness.start({
    secret: "model-key",
    bindings: { REPOSITORY_SERVICE_TOKEN: "authority" },
    serviceBindings: {
      REPOSITORY_AUTHORITY: async () =>
        Response.json({ owner: "fixture", repo: "fixture", token: "fixture-token" }),
      GITHUB_API: repository.fetch,
    },
  })
  try {
    const session = harness.session(uniqueSessionId("lost-pr"))
    await session.faults({ intervalMs: 100 })
    await session.create({ repositoryId: "123" })
    const publish = {
      name: "publish",
      input: { title: "Fixture edit", body: "No tests executed." },
    }
    repository.failNext({ method: "POST", path: "/pulls", status: 503, after: true })
    await session.model({
      mode: "repository-work",
      tools: [{ name: "write", input: { path: "new.txt", content: "saved" } }, publish],
    })
    await session.admit({ inputId: "msg_lost_pr", text: "Publish the edit." })
    await waitFor(
      () => session.inspect(),
      (state) => state.execution === "idle",
    )
    await harness.restart()
    await session.model({ mode: "repository-work", tools: [publish] })
    await session.admit({ inputId: "msg_recover_pr", text: "Reconcile publication." })
    await waitFor(
      () => session.inspect(),
      (state) => state.execution === "idle",
    )
    expect(
      repository.requests.filter(
        (request) => request.method === "POST" && request.path === "/pulls",
      ),
    ).toHaveLength(1)
    expect(JSON.stringify((await session.allEvents()).events)).toContain(
      "https://github.com/fixture/fixture/pull/1",
    )
  } finally {
    await harness.dispose()
  }
})

it("retains edits when write permission is unavailable and publishes after access is restored", async () => {
  const repository = await makeRepositoryFixture()
  let writable = false
  const harness = await Harness.start({
    secret: "model-key",
    bindings: { REPOSITORY_SERVICE_TOKEN: "authority" },
    serviceBindings: {
      REPOSITORY_AUTHORITY: async (request) => {
        const body = (await request.json()) as { permission: string }
        if (body.permission === "push" && !writable)
          return Response.json(
            { message: "Repository write permission is unavailable" },
            { status: 403 },
          )
        return Response.json({
          owner: "fixture",
          repo: "fixture",
          token: writable ? "rotated-fixture-token" : "fixture-token",
        })
      },
      GITHUB_API: repository.fetch,
    },
  })
  try {
    const session = harness.session(uniqueSessionId("write-permission"))
    await session.faults({ intervalMs: 100 })
    await session.create({ repositoryId: "123" })
    const publish = {
      name: "publish",
      input: { title: "Retained edit", body: "No project tests executed." },
    }
    await session.model({
      mode: "repository-work",
      tools: [
        { name: "write", input: { path: "retained.txt", content: "keep this edit" } },
        publish,
      ],
    })
    await session.admit({ inputId: "msg_denied", text: "Publish the edit." })
    await waitFor(
      () => session.inspect(),
      (state) => state.execution === "idle",
    )
    expect(repository.requests.filter((request) => request.method !== "GET")).toHaveLength(0)
    expect(JSON.stringify((await session.allEvents()).events)).toContain(
      "Repository write permission is unavailable",
    )
    writable = true
    await harness.restart()
    await session.model({ mode: "repository-work", tools: [publish] })
    await session.admit({ inputId: "msg_restored", text: "Retry with restored permission." })
    await waitFor(
      () => session.inspect(),
      (state) => state.execution === "idle",
    )
    expect(repository.prs).toHaveLength(1)
    expect(repository.read("retained.txt", repository.prs[0]!.head.ref)).toBe("keep this edit")
  } finally {
    await harness.dispose()
  }
})
