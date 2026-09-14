import { createHash } from "node:crypto"
import { expect, it } from "vite-plus/test"
import { Harness, uniqueSessionId, waitFor } from "./support/Harness.ts"
import { makeRepositoryFixture } from "../dev/RepositoryFixture.ts"

it("imports confirmed legacy files and deletions into SQLite while preserving the source archive", async () => {
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
    const session = harness.session(uniqueSessionId("legacy"))
    await session.faults({ intervalMs: 100 })
    await session.create({ repositoryId: "123" })
    const records: unknown[] = [{ format: "janitor-workspace-2" }]
    for (const [path, content] of Object.entries({
      "repository/.git/refs/remotes/origin/main": repository.refs.get("main")!,
      "repository/README.md": "unpublished legacy edit",
      "repository/new.txt": "legacy new file",
    })) {
      records.push(
        { path, type: "file", mode: 420 },
        { data: Buffer.from(content).toString("base64") },
        { end: true },
      )
    }
    const archive = records.map((record) => JSON.stringify(record)).join("\n") + "\n"
    await harness.call("POST", `/__test/sessions/${session.id}/legacy-workspace`, {
      archive,
      sha256: createHash("sha256").update(archive).digest("hex"),
    })
    await harness.restart()
    await session.model({
      mode: "repository-work",
      tools: [
        { name: "read", input: { path: "README.md" } },
        { name: "glob", input: { pattern: "*" } },
        { name: "diff", input: {} },
      ],
    })
    await session.admit({ inputId: "msg_legacy", text: "Inspect preserved edits." })
    await waitFor(
      () => session.inspect(),
      (state) => state.execution === "idle",
    )
    const events = JSON.stringify((await session.allEvents()).events)
    expect(events).toContain("unpublished legacy edit")
    expect(events).toContain("legacy new file")
    expect(events).toContain("--- a/NOTES.md")
    expect((await session.state()).checkpoint.key).toBe("legacy-fixture")
  } finally {
    await harness.dispose()
  }
})

it("refuses corrupt archives and unknown legacy outcomes without replacing their recovery pointer", async () => {
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
    for (const uncertain of [false, true]) {
      const session = harness.session(
        uniqueSessionId(uncertain ? "unknown-legacy" : "corrupt-legacy"),
      )
      await session.create({ repositoryId: "123" })
      const archive = JSON.stringify({ format: "janitor-workspace-2" }) + "\n"
      await harness.call("POST", `/__test/sessions/${session.id}/legacy-workspace`, {
        archive,
        sha256: "0".repeat(64),
        uncertain,
      })
      await harness.restart()
      const refused = await session.admit(
        { inputId: "msg_legacy_refused", text: "Resume preserved work." },
        423,
      )
      expect(refused.message).toContain(uncertain ? "unknown outcome" : "checksum")
      expect((await session.state()).checkpoint.key).toBe("legacy-fixture")
    }
  } finally {
    await harness.dispose()
  }
})
