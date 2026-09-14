import { expect, it } from "vite-plus/test"
import { Harness, uniqueSessionId, waitFor } from "./support/Harness.ts"
import { modelRepository } from "./support/ModelRepository.ts"

it("offers bounded repository tools without shell execution or paths outside the repository", async () => {
  const repository = modelRepository()
  const harness = await Harness.start({ ...repository, secret: "model-secret" })
  try {
    const session = harness.session(uniqueSessionId("files"))
    await session.faults({ intervalMs: 100 })
    await session.model({
      mode: "repository-work",
      tools: [
        { name: "glob", input: { pattern: "*.md" } },
        { name: "grep", input: { pattern: "apricot" } },
        { name: "read", input: { path: "/etc/passwd" } },
        { name: "write", input: { path: "../outside", content: "bad" } },
        { name: "read", input: { path: ".git/config" } },
      ],
    })
    await session.create({ repositoryId: "123" })
    await session.admit({ inputId: "msg_files", text: "Inspect repository files." })
    await waitFor(
      () => session.inspect(),
      (state) => state.execution === "idle",
    )
    const events = JSON.stringify((await session.allEvents()).events)
    expect(events).toContain("README.md")
    expect(events).toContain("apricot-47")
    expect(events).toContain("Path must be inside the repository")
    expect(events).toContain("Repository traversal and Git metadata access are unavailable")
    for (const call of (await session.state()).journal.filter(
      (entry: any) => entry.kind === "model-call",
    )) {
      expect(call.data.tools).not.toContain("shell")
      expect(call.data.tools).not.toContain("bash")
      expect(call.data.tools).not.toContain("task")
    }
  } finally {
    await harness.dispose()
  }
})
