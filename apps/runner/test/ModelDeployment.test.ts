import { expect, it } from "vite-plus/test"
import { Harness, testConfigurations, uniqueSessionId, waitFor } from "./support/Harness.ts"
import deployment from "../model-configurations/openrouter-llama-3.1-8b.json"
import { modelRepository } from "./support/ModelRepository.ts"

it("redacts credentials split across text and tool argument events before writing files", async () => {
  const repository = modelRepository()
  const secret = "fragmented-credential-value"
  const harness = await Harness.start({
    secret,
    serviceBindings: repository.serviceBindings,
    bindings: repository.bindings,
  })
  try {
    const session = harness.session(uniqueSessionId("fragmented-secret"))
    await session.faults({ intervalMs: 400 })
    await session.model({ mode: "credential-echo" })
    await session.create({ repositoryId: "123" })
    await session.admit({ inputId: "msg_echo", text: "Exercise the controlled provider echo." })
    expect((await settled(session)).lastOutcome).toBe("succeeded")
    const events = (await session.allEvents()).events
    expect(events.filter((event: any) => event.type === "session.tool.success")).toHaveLength(2)
    expect(events.filter((event: any) => event.type === "session.text.ended")[0].data.text).toBe(
      "[REDACTED]",
    )
    expect(JSON.stringify(events).includes(secret)).toBe(false)
    const results = events.filter((event: any) => event.type === "session.tool.success")
    expect(JSON.stringify(results[1])).toContain("[REDACTED]")
  } finally {
    await harness.dispose()
    repository.dispose()
  }
})

const settled = (session: ReturnType<Harness["session"]>) =>
  waitFor(
    () => session.inspect(),
    (state) => ["idle", "failed", "blocked"].includes(state.execution),
    {
      label: "model turn settled",
    },
  )

it("sends the deployment model and explicit output setting through the native resolver", async () => {
  const harness = await Harness.start({
    bindings: {
      JANITOR_AGENT_RUNNER_MODEL_API_KEY: "deployment-test-key",
      JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS: JSON.stringify(deployment),
    },
  })
  try {
    const session = harness.session(uniqueSessionId("deployment-record"))
    await session.faults({ intervalMs: 400 })
    await session.create()
    await session.admit({ inputId: "msg_deployment", text: "hello" })
    expect((await settled(session)).lastOutcome).toBe("succeeded")
    expect(
      (await session.state()).journal.find((entry: any) => entry.kind === "model-call").data,
    ).toMatchObject({ model: "meta-llama/llama-3.1-8b-instruct", maxTokens: 2048 })
  } finally {
    await harness.dispose()
  }
})

it("does not echo malformed configuration or accept credentials in an endpoint", async () => {
  const harness = await Harness.start({
    bindings: {
      JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS: '{"default":"accidentally-pasted-secret",',
    },
  })
  try {
    const session = harness.session(uniqueSessionId("bad-configuration"))
    const error = await session.create({}, 423)
    expect(JSON.stringify(error)).not.toContain("accidentally-pasted-secret")
    const invalid = structuredClone(testConfigurations)
    invalid.records[0].endpoint = "https://user:accidentally-pasted-secret@provider.test/v1/"
    await harness.restart({
      bindings: { JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS: JSON.stringify(invalid) },
    })
    const rejected = await session.create({}, 423)
    expect(JSON.stringify(rejected)).not.toContain("accidentally-pasted-secret")
    expect((await session.state()).modelCalls).toBe(0)
  } finally {
    await harness.dispose()
  }
})

it("refuses a changed model record across activation and preserves the conversation", async () => {
  const harness = await Harness.start({ secret: "original-secret" })
  try {
    const session = harness.session(uniqueSessionId("immutable-model"))
    await session.faults({ intervalMs: 400 })
    await session.create()
    await session.admit({ inputId: "msg_original", text: "remember this work" })
    expect((await settled(session)).lastOutcome).toBe("succeeded")
    const before = await session.allEvents()
    const changed = structuredClone(testConfigurations)
    changed.records[0].apiModelId = "replacement-model"
    await harness.restart({
      bindings: {
        JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS: JSON.stringify(changed),
      },
    })
    expect(await session.inspect()).toMatchObject({
      execution: "blocked",
      reason: expect.stringMatching(/configuration.*changed/i),
    })
    expect((await session.allEvents()).events).toEqual(before.events)
    expect((await session.admit({ inputId: "msg_blocked", text: "continue" }, 423)).code).toBe(
      "blocked",
    )
    await harness.restart({ bindings: {} })
    await session.admit({ inputId: "msg_restored", text: "continue" })
    expect((await settled(session)).lastOutcome).toBe("succeeded")
  } finally {
    await harness.dispose()
  }
})

it("rotates runtime credentials while only new sessions take the new default", async () => {
  const harness = await Harness.start({
    secret: "old-key",
    bindings: { JANITOR_TEST_EXPECTED_AUTH: "old-key" },
  })
  try {
    const existing = harness.session(uniqueSessionId("rotation"))
    await existing.faults({ intervalMs: 400 })
    await existing.create()
    await existing.admit({ inputId: "msg_before", text: "remember the plan" })
    expect((await settled(existing)).lastOutcome).toBe("succeeded")
    const before = await existing.allEvents()
    await harness.restart({
      secret: "new-key",
      bindings: {
        JANITOR_TEST_EXPECTED_AUTH: "new-key",
        JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS: JSON.stringify({
          ...testConfigurations,
          default: "test-alternate",
        }),
      },
    })
    await existing.admit({ inputId: "msg_after", text: "continue the plan" })
    expect((await settled(existing)).modelConfigurationId).toBe("test-default")
    const calls = (await existing.state()).journal.filter(
      (entry: any) => entry.kind === "model-call",
    )
    expect(calls.map((entry: any) => [entry.data.model, entry.data.credentialMatches])).toEqual([
      ["scripted-1", true],
      ["scripted-1", true],
    ])
    expect(calls[1].data.messages).toBeGreaterThan(calls[0].data.messages)
    const after = await existing.allEvents()
    expect(after.events.slice(0, before.events.length)).toEqual(before.events)
    expect(JSON.stringify(after)).not.toMatch(/old-key|new-key/)
    const fresh = harness.session(uniqueSessionId("new-default"))
    await fresh.faults({ intervalMs: 400 })
    expect((await fresh.create()).modelConfigurationId).toBe("test-alternate")
    await fresh.admit({ inputId: "msg_fresh", text: "start" })
    expect((await settled(fresh)).lastOutcome).toBe("succeeded")
    expect(
      (await fresh.state()).journal.find((entry: any) => entry.kind === "model-call").data,
    ).toMatchObject({ model: "scripted-2", credentialMatches: true })
  } finally {
    await harness.dispose()
  }
})

it("preserves a retired session until its original record is restored", async () => {
  const harness = await Harness.start({ secret: "retirement-key" })
  try {
    const session = harness.session(uniqueSessionId("retired-model"))
    await session.faults({ intervalMs: 400 })
    await session.create()
    await session.admit({ inputId: "msg_retained", text: "Retain this work." })
    await settled(session)
    const before = await session.allEvents()
    await harness.restart({
      bindings: {
        JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS: JSON.stringify({
          default: "test-alternate",
          records: [testConfigurations.records[1]],
        }),
      },
    })
    expect(await session.inspect()).toMatchObject({
      execution: "blocked",
      reason: expect.stringMatching(/retired/),
      modelConfigurationId: "test-default",
    })
    expect((await session.allEvents()).events).toEqual(before.events)
    expect((await session.admit({ inputId: "msg_no_migration", text: "continue" }, 423)).code).toBe(
      "blocked",
    )
    await harness.restart({ bindings: {} })
    await session.admit({ inputId: "msg_restore", text: "Continue on the original model." })
    expect((await settled(session)).lastOutcome).toBe("succeeded")
  } finally {
    await harness.dispose()
  }
})

for (const status of [401, 403, 404]) {
  it(`preserves history and redacts an echoed credential on HTTP ${status} without retries`, async () => {
    const harness = await Harness.start({ secret: "do-not-persist-this-key" })
    try {
      const session = harness.session(uniqueSessionId(`http-${status}`))
      await session.faults({ intervalMs: 400 })
      await session.model({ mode: "http-error", status })
      await session.create()
      await session.admit({ inputId: "msg_denied", text: "preserve this request" })
      const failed = await settled(session)
      expect(failed.execution).toBe("failed")
      const events = await session.allEvents()
      expect(events.events.some((event: any) => event.type === "session.inbox.enqueued")).toBe(true)
      expect((await session.state()).modelCalls).toBe(1)
      expect(JSON.stringify({ failed, events, state: await session.state() })).not.toContain(
        "do-not-persist-this-key",
      )
      await session.model({ mode: "text" })
      await session.admit({ inputId: "msg_recovered", text: "retry after fixing provider access" })
      expect((await settled(session)).lastOutcome).toBe("succeeded")
    } finally {
      await harness.dispose()
    }
  })
}

it("compacts locally with the pinned deployment model and retained multi-tool history", async () => {
  const repository = modelRepository()
  const harness = await Harness.start({
    serviceBindings: repository.serviceBindings,
    bindings: {
      ...repository.bindings,
      JANITOR_AGENT_RUNNER_MODEL_API_KEY: "compaction-test-key",
      JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS: JSON.stringify(deployment),
    },
  })
  try {
    const session = harness.session(uniqueSessionId("compaction"))
    await session.faults({ intervalMs: 400 })
    await session.model({ mode: "deployment-history" })
    await session.create({ repositoryId: "123" })
    await session.admit({ inputId: "msg_seed", text: "Remember earlier work." })
    expect((await settled(session)).lastOutcome).toBe("succeeded")
    await session.admit({
      inputId: "msg_tools",
      text: "Try both tool calls and retain their results.",
    })
    expect((await settled(session)).lastOutcome).toBe("succeeded")
    await session.admit({ inputId: "msg_compact", text: "Continue after those tool results." })
    expect((await settled(session)).lastOutcome).toBe("succeeded")
    const read = await session.allEvents()
    expect(read.events.filter((event: any) => event.type === "session.tool.success")).toHaveLength(
      2,
    )
    expect(read.events.filter((event: any) => event.type === "session.tool.failed")).toHaveLength(0)
    expect(read.events.some((event: any) => event.type === "session.compaction.ended")).toBe(true)
    const calls = (await session.state()).journal.filter(
      (entry: any) => entry.kind === "model-call",
    )
    expect(
      calls.every((entry: any) => entry.data.model === "meta-llama/llama-3.1-8b-instruct"),
    ).toBe(true)
    expect(
      calls.some((entry: any) => entry.data.toolResults === 2 || entry.data.retainedTool),
    ).toBe(true)
    const summaryIndex = calls.findIndex((entry: any) => entry.data.compaction)
    expect(summaryIndex).toBeGreaterThan(0)
    expect(calls.slice(summaryIndex + 1).some((entry: any) => entry.data.retainedTool)).toBe(true)
    expect(read.usage.input).toBeGreaterThan(120000)
  } finally {
    await harness.dispose()
    repository.dispose()
  }
})
