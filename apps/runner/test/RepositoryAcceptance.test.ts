import { expect, it } from "vite-plus/test"
import { Harness, uniqueSessionId, waitFor } from "./support/Harness.ts"
import { modelRepository } from "./support/ModelRepository.ts"

it("recovers a committed edit after interruption before its native result, without applying it twice", async () => {
  const harness = await Harness.start({ ...modelRepository(), secret: "test-key" })
  try {
    const session = harness.session(uniqueSessionId("atomic-edit"))
    await session.faults({ intervalMs: 100 })
    await session.model({
      mode: "repository-work",
      tools: [{ name: "write", input: { path: "counter.txt", content: "x" } }],
    })
    await session.create({ repositoryId: "123" })
    await session.admit({ inputId: "msg_initial", text: "Initialize the file." })
    await waitFor(
      () => session.inspect(),
      (state) => state.execution === "idle",
    )
    await session.faults({ abortAfterWorkspaceCommit: true })
    await session.model({
      mode: "repository-work",
      tools: [{ name: "edit", input: { path: "counter.txt", oldText: "x", newText: "xx" } }],
    })
    await session.admit({ inputId: "msg_interrupted", text: "Append one x." })
    await waitFor(
      () => session.inspect(),
      (state) => state.execution === "idle",
      { label: "recovered native edit" },
    )
    await harness.restart()
    await session.model({
      mode: "repository-work",
      tools: [{ name: "read", input: { path: "counter.txt" } }],
    })
    await session.admit({ inputId: "msg_verify", text: "Read the result." })
    await waitFor(
      () => session.inspect(),
      (state) => state.execution === "idle",
    )
    const successes = (await session.allEvents()).events.filter(
      (event: any) => event.type === "session.tool.success",
    )
    expect(JSON.stringify(successes.at(-1))).toContain("xx")
    expect(JSON.stringify(successes.at(-1))).not.toContain("xxx")
    expect((await session.state()).faults.abortAfterWorkspaceCommit).toBe(false)
  } finally {
    await harness.dispose()
  }
})
